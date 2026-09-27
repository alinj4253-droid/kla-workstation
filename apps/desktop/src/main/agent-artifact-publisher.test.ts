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

  it('does not materialize inline HTML without a system-confirmed file path', async () => {
    const events: unknown[] = [];
    const publisher = new AgentArtifactPublisher(db, (event) => events.push(event));
    const output = `分析完成。\n:::artifact{path="outputs/report.html"}\n<!doctype html><html><body><h1>报告</h1></body></html>\n:::`;

    const result = await publisher.publishFromOutput({
      projectId: 'group-1',
      agentInstanceId: 'group-1-orch',
      runId: 'run-1',
      text: output,
    });

    expect(result.publishedPaths).toEqual([]);
    expect(result.failedPaths).toEqual(['outputs/report.html']);
    expect(result.text).toContain('未交付');
    expect(events).toEqual([]);
    await expect(readFile(join(getProjectRoot('group-1'), 'outputs', 'report.html'), 'utf8')).rejects.toThrow();
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

  it('does not turn raw HTML into a preview artifact without a file tool call', async () => {
    const publisher = new AgentArtifactPublisher(db);
    const result = await publisher.publishFromOutput({
      projectId: 'group-1',
      agentInstanceId: 'agent-1',
      runId: 'run-inline-html',
      text: '<!doctype html><html><body><h1>仪表盘</h1></body></html>',
    });
    expect(result.publishedPaths).toEqual([]);
    expect(result.failedPaths).toEqual([]);
    expect(result.text).not.toContain('<h1>仪表盘</h1>');
    expect(result.text).toContain('未作为成果交付');
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
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ runId: 'run-2', triggerMessageId: 'message-1' }));
  });

  it('does not claim delivery when an output path does not exist', async () => {
    const publisher = new AgentArtifactPublisher(db);
    const result = await publisher.publishFromOutput({
      projectId: 'group-1',
      agentInstanceId: 'agent-1',
      runId: 'run-missing-output',
      text: '报告已生成，文件位于 outputs/missing.html。',
    });
    expect(result.publishedPaths).toEqual([]);
    expect(result.failedPaths).toEqual(['outputs/missing.html']);
    expect(result.text).toContain('成果文件写入或发布失败，未交付：outputs/missing.html');
    expect(result.text).not.toContain('文件位于 outputs/missing.html');
  });

  it('sanitizes a missing path even when the model only says it is available', async () => {
    const publisher = new AgentArtifactPublisher(db);
    const result = await publisher.publishFromOutput({
      projectId: 'group-1',
      agentInstanceId: 'agent-1',
      runId: 'run-missing-natural-language',
      text: '文件位于 outputs/missing.html，可直接查看。',
    });
    expect(result.failedPaths).toEqual(['outputs/missing.html']);
    expect(result.text).toContain('成果文件写入或发布失败，未交付：outputs/missing.html');
    expect(result.text).not.toContain('可直接查看');
  });
});
