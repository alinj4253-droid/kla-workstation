import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryManager } from './memory-manager';
import { setStudioRoot } from './paths';

describe('conversation memory manager', () => {
  let db: Database.Database;
  let studioRoot: string;
  let memory: MemoryManager;

  beforeEach(async () => {
    studioRoot = await mkdtemp(join(tmpdir(), 'kunqing-memory-'));
    setStudioRoot(studioRoot);
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE memory_records (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_refs_json TEXT,
        status TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE project_agent_instances (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        role TEXT NOT NULL,
        ordinal INTEGER NOT NULL
      );
      INSERT INTO project_agent_instances (id, project_id, role, ordinal)
      VALUES ('leader-1', 'project-1', 'leader', 0), ('worker-1', 'project-1', 'member', 1);
    `);
    memory = new MemoryManager(db);
  });

  afterEach(async () => {
    db.close();
    setStudioRoot('');
    await rm(studioRoot, { recursive: true, force: true });
  });

  it('captures a task closure and mirrors it into the agent memory folder', async () => {
    await memory.captureTurn({
      projectId: 'project-1',
      agentInstanceId: 'worker-1',
      triggerMessageId: 'message-1',
      runId: 'run-1',
      request: JSON.stringify({ text: '制作项目首页' }),
      result: '首页已完成并通过验收。',
      artifacts: ['outputs/home.html'],
    });

    const record = db.prepare(`SELECT scope, type, content FROM memory_records WHERE agent_instance_id = 'worker-1'`).get() as { scope: string; type: string; content: string };
    expect(record.scope).toBe('short-term');
    expect(record.type).toBe('task-summary');
    expect(record.content).toContain('用户目标：制作项目首页');
    expect(record.content).toContain('成果文件：outputs/home.html');

    const current = await readFile(join(studioRoot, 'group-chats', 'project-1-workspace', 'agent-memories', 'worker-1', 'short-term', 'current.md'), 'utf8');
    const session = await readFile(join(studioRoot, 'group-chats', 'project-1-workspace', 'agent-memories', 'worker-1', 'sessions', 'message-1-run-1.md'), 'utf8');
    expect(current).toContain('首页已完成并通过验收');
    expect(session).toContain('triggerMessageId: message-1');
  });

  it('stores explicit remember instructions as private copies for every agent and can forget all copies', async () => {
    await memory.applyUserDirective('project-1', '请记住：所有数据只能保存在本地 K_Studio。', 'message-2');

    const remembered = db.prepare(`SELECT agent_instance_id as agentId, scope, type, content, source_refs_json as refs FROM memory_records WHERE status = 'active' ORDER BY agent_instance_id`).all() as Array<{ agentId: string; scope: string; type: string; content: string; refs: string }>;
    expect(remembered).toHaveLength(2);
    expect(remembered.map((item) => item.agentId)).toEqual(['leader-1', 'worker-1']);
    expect(remembered.every((item) => item.scope === 'long-term' && item.type === 'project-constraint')).toBe(true);
    expect(remembered.every((item) => item.refs.includes('"visibility":"agent"'))).toBe(true);

    const leaderSummary = await readFile(join(studioRoot, 'group-chats', 'project-1-workspace', 'agent-memories', 'leader-1', 'long-term', 'summary.md'), 'utf8');
    const workerSummary = await readFile(join(studioRoot, 'group-chats', 'project-1-workspace', 'agent-memories', 'worker-1', 'long-term', 'summary.md'), 'utf8');
    expect(leaderSummary).toContain('所有数据只能保存在本地 K_Studio');
    expect(workerSummary).toContain('所有数据只能保存在本地 K_Studio');

    await memory.applyUserDirective('project-1', '忘记：所有数据只能保存在本地 K_Studio。', 'message-3');
    const forgotten = db.prepare(`SELECT status FROM memory_records ORDER BY agent_instance_id`).all() as Array<{ status: string }>;
    expect(forgotten.every((item) => item.status === 'deleted')).toBe(true);
  });
});
