// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentArtifactPublisher, prepareAgentOutput } from './agent-artifact-publisher';
import { getProjectRoot, setStudioRoot } from './paths';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/app/path') },
}));

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
      parent_id TEXT, type TEXT NOT NULL, name TEXT NOT NULL, normalized_path TEXT NOT NULL,
      mime_type TEXT, current_version_id TEXT, origin TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE file_versions (
      id TEXT PRIMARY KEY, file_id TEXT NOT NULL, version_no INTEGER NOT NULL,
      storage_rel_path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      created_by_type TEXT NOT NULL, created_by_id TEXT NOT NULL, run_id TEXT,
      change_note TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sender_type TEXT NOT NULL,
      sender_id TEXT NOT NULL, kind TEXT NOT NULL, content_json TEXT NOT NULL,
      status TEXT NOT NULL, reply_to_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE message_attachments (
      message_id TEXT NOT NULL, file_id TEXT NOT NULL, version_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, PRIMARY KEY (message_id, ordinal)
    );
  `);
  return db;
}

describe('AgentArtifactPublisher', () => {
  let studioRoot: string;
  let db: Database.Database;

  beforeEach(async () => {
    studioRoot = await mkdtemp(join(tmpdir(), 'kunqing-artifacts-'));
    setStudioRoot(studioRoot);
    db = createDb();
  });

  afterEach(async () => {
    db.close();
    await rm(studioRoot, { recursive: true, force: true });
  });

  it('materializes inline HTML and emits a clickable artifact message', async () => {
    const events: unknown[] = [];
    const publisher = new AgentArtifactPublisher(db, (event) => events.push(event));
    const output = `分析完成。\n:::artifact{path="outputs/report.html"}\n<!doctype html><html><body><h1>报告</h1></body></html>\n:::`;

    const result = await publisher.publishFromOutput({
      projectId: 'group-1',
      agentInstanceId: 'group-1-orch',
      runId: 'run-1',
      text: output,
    });

    expect(result.text).toContain('已生成成果文件：outputs/report.html');
    expect(result.text).not.toContain('```html');
    expect(result.publishedPaths).toEqual(['outputs/report.html']);
    expect(await readFile(join(getProjectRoot('group-1'), 'outputs', 'report.html'), 'utf8')).toContain('<h1>报告</h1>');

    const file = db.prepare("SELECT normalized_path as path, mime_type as mimeType, origin FROM files").get() as { path: string; mimeType: string; origin: string };
    expect(file).toEqual({ path: 'outputs/report.html', mimeType: 'text/html', origin: 'artifact' });

    const message = db.prepare("SELECT sender_id as senderId, kind, content_json as contentJson FROM messages").get() as { senderId: string; kind: string; contentJson: string };
    expect(message.senderId).toBe('group-1-orch');
    expect(message.kind).toBe('artifact');
    expect(JSON.parse(message.contentJson).text).toBe('outputs/report.html');
    expect(events).toEqual([expect.objectContaining({ type: 'message.created', projectId: 'group-1' })]);
  });

  it('extracts an existing-file ARTIFACT marker without treating it as inline HTML', () => {
    const prepared = prepareAgentOutput('完成\nARTIFACT: outputs/dashboard.html');
    expect(prepared.inlineHtml).toEqual([]);
    expect(prepared.referencedPaths).toEqual(['outputs/dashboard.html']);
    expect(prepared.text).toBe('完成');
  });

  it('recognizes an existing HTML path mentioned naturally by an external agent', () => {
    const prepared = prepareAgentOutput('页面已经完成，可在 `outputs/doubao-geo-brainstorm.html` 查看。');
    expect(prepared.inlineHtml).toEqual([]);
    expect(prepared.referencedPaths).toEqual(['outputs/doubao-geo-brainstorm.html']);
  });

  it('turns raw HTML into a right-side preview artifact without leaking source', () => {
    const prepared = prepareAgentOutput('<!doctype html><html><body><h1>仪表盘</h1></body></html>');
    expect(prepared.text).toContain('已生成成果文件：');
    expect(prepared.text).not.toContain('```html');
    expect(prepared.text).not.toContain('<h1>仪表盘</h1>');
    expect(prepared.inlineHtml).toHaveLength(1);
    expect(prepared.referencedPaths[0]).toMatch(/^outputs\/generated-[a-f0-9]{10}\.html$/);
  });

  it('rejects artifact paths outside outputs', async () => {
    const publisher = new AgentArtifactPublisher(db);
    await expect(publisher.writeInlineHtml('group-1', '../escape.html', '<html></html>')).rejects.toThrow('outputs/');
  });

  it('publishes discovered output files without a path in the agent reply and deduplicates the card', async () => {
    const events: unknown[] = [];
    const projectRoot = getProjectRoot('group-1');
    await mkdir(join(projectRoot, 'outputs'), { recursive: true });
    await writeFile(join(projectRoot, 'outputs', 'final-report.pdf'), 'pdf-content', 'utf8');
    const publisher = new AgentArtifactPublisher(db, (event) => events.push(event));
    const input = {
      projectId: 'group-1',
      agentInstanceId: 'codebuddy-1',
      runId: 'run-2',
      triggerMessageId: 'message-1',
      text: '报告已完成。',
      additionalPaths: ['outputs/final-report.pdf'],
    };

    const first = await publisher.publishFromOutput(input);
    const second = await publisher.publishFromOutput(input);

    expect(first.publishedPaths).toEqual(['outputs/final-report.pdf']);
    expect(first.text).toContain('outputs/final-report.pdf');
    expect(second.publishedPaths).toEqual(['outputs/final-report.pdf']);
    expect((db.prepare("SELECT COUNT(*) AS count FROM messages WHERE kind = 'artifact'").get() as { count: number }).count).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(expect.objectContaining({ runId: 'run-2', triggerMessageId: 'message-1' }));
  });
});
