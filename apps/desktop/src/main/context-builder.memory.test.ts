import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ContextBuilder } from './context-builder';

describe('ContextBuilder private memory recall', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE memory_records (
        id TEXT PRIMARY KEY, project_id TEXT, agent_instance_id TEXT, scope TEXT, type TEXT,
        content TEXT, confidence REAL, importance REAL, pinned INTEGER, topic_key TEXT,
        source_refs_json TEXT, metadata_json TEXT, status TEXT, expires_at TEXT,
        last_reinforced_at TEXT, last_accessed_at TEXT, access_count INTEGER,
        consolidated_into_id TEXT, supersedes_id TEXT, created_at TEXT, updated_at TEXT
      );
    `);
  });

  afterEach(() => db.close());

  it('keeps recall private, decays stale episodes and always includes explicit pinned rules', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1_000).toISOString();
    const old = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1_000).toISOString();
    const insert = db.prepare(`
      INSERT INTO memory_records VALUES (?, 'project-1', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'active', NULL, ?, NULL, 0, NULL, NULL, ?, ?)
    `);
    insert.run('recent', 'agent-1', 'short-term', 'task-episode', 'alpha 当前任务结论', 0.9, 0.8, 0, 'alpha', recent, recent, recent);
    insert.run('stale', 'agent-1', 'short-term', 'task-episode', '旧任务中的无关内容', 0.9, 0.8, 0, 'old', old, old, old);
    insert.run('private-other', 'agent-2', 'short-term', 'task-episode', 'alpha 另一个智能体私有信息', 1, 1, 0, 'alpha', recent, recent, recent);
    insert.run('pinned', 'agent-1', 'long-term', 'project-constraint', '所有成果仅保存在本地', 1, 1, 1, 'local-only', old, old, old);

    const recalled = (new ContextBuilder(db) as unknown as {
      buildMemory(projectId: string, agentInstanceId: string, role: string, query: string): { shortTerm: string[]; longTerm: string[] };
    }).buildMemory('project-1', 'agent-1', 'teammate', 'alpha');

    expect(recalled.shortTerm.join('\n')).toContain('当前任务结论');
    expect(recalled.shortTerm.join('\n')).not.toContain('旧任务');
    expect(recalled.shortTerm.join('\n')).not.toContain('另一个智能体');
    expect(recalled.longTerm.join('\n')).toContain('所有成果仅保存在本地');
    expect((db.prepare("SELECT access_count as count FROM memory_records WHERE id = 'recent'").get() as { count: number }).count).toBe(1);
  });
});
