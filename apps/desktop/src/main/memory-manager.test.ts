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
        importance REAL NOT NULL DEFAULT 0.5,
        pinned INTEGER NOT NULL DEFAULT 0,
        topic_key TEXT,
        source_refs_json TEXT,
        metadata_json TEXT,
        status TEXT NOT NULL,
        expires_at TEXT,
        last_reinforced_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        consolidated_into_id TEXT,
        supersedes_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE memory_tombstones (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        source_message_id TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
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
      reflection: {
        topic: '项目首页',
        taskSummary: '完成项目首页并通过验收。',
        decisions: ['采用单页交付'],
        reusableInsights: ['先校验页面再发布'],
        confidence: 0.84,
        importance: 0.7,
        longTermWorth: true,
        longTermSummary: '项目首页交付应先完成页面校验，再发布成果文件。',
      },
    });

    const record = db.prepare(`SELECT scope, type, content FROM memory_records WHERE agent_instance_id = 'worker-1' AND scope = 'short-term'`).get() as { scope: string; type: string; content: string };
    expect(record.scope).toBe('short-term');
    expect(record.type).toBe('task-episode');
    expect(record.content).toContain('完成项目首页并通过验收');
    expect(record.content).toContain('成果文件：outputs/home.html');

    const longTerm = db.prepare(`SELECT type, confidence, content FROM memory_records WHERE agent_instance_id = 'worker-1' AND scope = 'long-term'`).get() as { type: string; confidence: number; content: string };
    expect(longTerm.type).toBe('semantic-summary');
    expect(longTerm.confidence).toBe(0.84);
    expect(longTerm.content).toContain('先完成页面校验');

    const current = await readFile(join(studioRoot, 'group-chats', 'project-1-workspace', 'agent-memories', 'worker-1', 'short-term', 'current.md'), 'utf8');
    const session = await readFile(join(studioRoot, 'group-chats', 'project-1-workspace', 'agent-memories', 'worker-1', 'sessions', 'message-1-run-1.md'), 'utf8');
    expect(current).toContain('完成项目首页并通过验收');
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
    expect((db.prepare('SELECT COUNT(*) as count FROM memory_tombstones').get() as { count: number }).count).toBe(2);
  });

  it('prevents forgotten semantic content from being resurrected and explicit remember clears the tombstone', async () => {
    await memory.applyUserDirective('project-1', '忘记：旧版营销口径', 'message-forget');
    const skipped = await memory.captureTurn({
      projectId: 'project-1', agentInstanceId: 'worker-1', triggerMessageId: 'message-4', runId: 'run-4',
      request: '继续旧版营销口径', result: '沿用旧版营销口径',
      reflection: { topic: '旧版营销口径', taskSummary: '沿用旧版营销口径', confidence: 0.9, importance: 0.9, longTermWorth: true },
    });
    expect(skipped).toBeNull();

    await memory.applyUserDirective('project-1', '记住：旧版营销口径', 'message-remember');
    const workerTombstones = db.prepare("SELECT COUNT(*) as count FROM memory_tombstones WHERE agent_instance_id = 'worker-1'").get() as { count: number };
    expect(workerTombstones.count).toBe(0);
    const pinned = db.prepare("SELECT pinned, confidence FROM memory_records WHERE agent_instance_id = 'worker-1' AND type = 'project-constraint' AND status = 'active'").get() as { pinned: number; confidence: number };
    expect(pinned).toEqual({ pinned: 1, confidence: 1 });
  });
});
