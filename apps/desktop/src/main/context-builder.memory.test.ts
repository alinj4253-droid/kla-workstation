import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => process.cwd()), getAppPath: vi.fn(() => process.cwd()) },
}));
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

    const builder = new ContextBuilder(db) as unknown as {
      buildMemory(projectId: string, agentInstanceId: string, role: string, query: string): { memory: { shortTerm: string[]; longTerm: string[] }; touchedMemoryIds: string[] };
      markMemoryAccessed(memoryIds: string[]): void;
    };
    const recalled = builder.buildMemory('project-1', 'agent-1', 'teammate', 'alpha');

    expect(recalled.memory.shortTerm.join('\n')).toContain('当前任务结论');
    expect(recalled.memory.shortTerm.join('\n')).not.toContain('旧任务');
    expect(recalled.memory.shortTerm.join('\n')).not.toContain('另一个智能体');
    expect(recalled.memory.longTerm.join('\n')).toContain('所有成果仅保存在本地');
    // 访问回写与查询分离：buildMemory 保持纯查询，由 markMemoryAccessed 统一回写。
    expect(recalled.touchedMemoryIds).toContain('recent');
    expect(recalled.touchedMemoryIds).not.toContain('private-other');
    builder.markMemoryAccessed(recalled.touchedMemoryIds);
    expect((db.prepare("SELECT access_count as count FROM memory_records WHERE id = 'recent'").get() as { count: number }).count).toBe(1);
  });

  it('exposes other members pinned long-term rules as team-shared memory', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1_000).toISOString();
    const old = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1_000).toISOString();
    const insert = db.prepare(`
      INSERT INTO memory_records VALUES (?, 'project-1', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'active', NULL, ?, NULL, 0, NULL, NULL, ?, ?)
    `);
    insert.run('own-recent', 'agent-1', 'short-term', 'task-episode', 'alpha 当前任务结论', 0.9, 0.8, 0, 'alpha', recent, recent, recent);
    insert.run('lead-pinned', 'agent-2', 'long-term', 'project-constraint', '报告类成果一律先保存为 Markdown 定稿再交付', 1, 1, 1, 'report-pref', old, old, old);
    insert.run('lead-private', 'agent-2', 'short-term', 'task-episode', 'beta 统筹私有过程记录', 1, 1, 0, 'beta', recent, recent, recent);
    insert.run('lead-episode', 'agent-2', 'long-term', 'task-episode', 'beta 统筹任务回顾', 1, 1, 0, 'beta-episode', recent, recent, recent);

    const builder = new ContextBuilder(db) as unknown as {
      buildMemory(projectId: string, agentInstanceId: string, role: string, query: string): { memory: { shortTerm: string[]; longTerm: string[] }; touchedMemoryIds: string[] };
      markMemoryAccessed(memoryIds: string[]): void;
    };
    const recalled = builder.buildMemory('project-1', 'agent-1', 'teammate', '报告 格式');

    const longTermText = recalled.memory.longTerm.join('\n');
    expect(longTermText).toContain('团队共享');
    expect(longTermText).toContain('Markdown 定稿');
    // 共享范围仅限其他成员的固定规则/项目约束；短期过程记忆与普通任务回顾仍保持私有。
    expect(longTermText).not.toContain('统筹私有过程');
    expect(longTermText).not.toContain('统筹任务回顾');
    expect(recalled.touchedMemoryIds).toContain('lead-pinned');
    expect(recalled.touchedMemoryIds).not.toContain('lead-private');
    expect(recalled.touchedMemoryIds).not.toContain('lead-episode');
  });
});
