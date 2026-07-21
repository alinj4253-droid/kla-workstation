// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from './memory-manager';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_instance_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'short-term',
      type TEXT NOT NULL DEFAULT 'interaction',
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      source_refs_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_memory_lookup ON memory_records(project_id, agent_instance_id);
  `);
  return db;
}

function insertRecord(
  db: Database.Database,
  overrides: { projectId: string; agentInstanceId: string; scope?: string; type?: string; content: string; confidence?: number; status?: string; sourceRefsJson?: string | null },
) {
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_records (id, project_id, agent_instance_id, scope, type, content, confidence, source_refs_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    id, overrides.projectId, overrides.agentInstanceId,
    overrides.scope ?? 'short-term', overrides.type ?? 'fact',
    overrides.content, overrides.confidence ?? 1.0,
    overrides.sourceRefsJson ?? null, now, now,
  );
}

describe('MemoryManager', () => {
  let db: Database.Database;
  let manager: MemoryManager;

  beforeEach(() => {
    db = createDb();
    manager = new MemoryManager(db);
  });

  it('stores and retrieves short-term memories', () => {
    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', '用户询问了项目进度');
    const ctx = manager.buildMemoryContext('proj-1', 'agent-1');
    expect(ctx).toContain('用户询问了项目进度');
  });

  it('returns empty context when no memories', () => {
    const ctx = manager.buildMemoryContext('proj-1', 'agent-1');
    expect(ctx).toBe('');
  });

  it('includes both short-term and long-term in context', () => {
    insertRecord(db, { projectId: 'proj-1', agentInstanceId: 'agent-1', scope: 'long-term', type: 'fact', content: '项目截止日期是下周五' });
    insertRecord(db, { projectId: 'proj-1', agentInstanceId: 'agent-1', scope: 'short-term', type: 'interaction', content: '用户同意方案A' });

    const ctx = manager.buildMemoryContext('proj-1', 'agent-1');
    expect(ctx).toContain('项目截止日期是下周五');
    expect(ctx).toContain('用户同意方案A');
  });

  it('consolidates short-term memories when threshold exceeded', () => {
    for (let i = 0; i < 12; i++) {
      manager.storeShortTerm('proj-1', 'agent-1', 'progress', `进度更新 ${i}: 完成了任务${i}`);
    }
    const consolidated = manager.consolidateShortTerm('proj-1', 'agent-1');
    expect(consolidated).toBeGreaterThanOrEqual(1);

    const active = db.prepare(
      "SELECT * FROM memory_records WHERE project_id = 'proj-1' AND agent_instance_id = 'agent-1' AND status = 'active'",
    ).all() as Array<{ type: string; content: string }>;
    const mergedRecords = active.filter((r) => r.type.startsWith('merged:'));
    expect(mergedRecords.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts high-confidence short-term to long-term', () => {
    insertRecord(db, { projectId: 'proj-1', agentInstanceId: 'agent-1', type: 'fact', content: '重要知识：系统使用Node.js开发', confidence: 0.85 });
    insertRecord(db, { projectId: 'proj-1', agentInstanceId: 'agent-1', type: 'fact', content: '不重要知识：今天天气不错', confidence: 0.3 });

    const extracted = manager.extractLongTerm('proj-1', 'agent-1');
    expect(extracted).toBe(1);

    const longTerm = db.prepare(
      "SELECT * FROM memory_records WHERE project_id = 'proj-1' AND agent_instance_id = 'agent-1' AND scope = 'long-term'",
    ).all();
    expect(longTerm).toHaveLength(1);
    expect((longTerm[0] as { content: string }).content).toContain('Node.js');
  });

  it('recalls relevant memories by keyword matching', () => {
    insertRecord(db, { projectId: 'proj-1', agentInstanceId: 'agent-1', scope: 'long-term', type: 'fact', content: '数据库使用 SQLite' });
    insertRecord(db, { projectId: 'proj-1', agentInstanceId: 'agent-1', scope: 'short-term', type: 'interaction', content: '前端框架使用 React' });

    const results = manager.recallRelevant('数据库', 'proj-1', 'agent-1');
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('SQLite');
  });

  it('returns empty array when no keywords match', () => {
    manager.storeShortTerm('proj-1', 'agent-1', 'test', 'something unrelated');
    const results = manager.recallRelevant('nonexistent', 'proj-1', 'agent-1');
    expect(results).toHaveLength(0);
  });

  it('prevents duplicate long-term extraction', () => {
    insertRecord(db, { projectId: 'proj-1', agentInstanceId: 'agent-1', type: 'fact', content: '重要知识：使用TypeScript', confidence: 0.9 });

    manager.extractLongTerm('proj-1', 'agent-1');
    const first = manager.extractLongTerm('proj-1', 'agent-1');
    expect(first).toBe(0);
  });

  it('does not consolidate when below threshold', () => {
    for (let i = 0; i < 5; i++) {
      manager.storeShortTerm('proj-1', 'agent-1', 'test', `memory ${i}`);
    }
    const result = manager.consolidateShortTerm('proj-1', 'agent-1');
    expect(result).toBe(0);
  });
});
