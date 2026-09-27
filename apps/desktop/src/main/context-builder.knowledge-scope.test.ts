// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => process.cwd()), getAppPath: vi.fn(() => process.cwd()) },
}));

import Database from 'better-sqlite3';
import { ContextBuilder, type ContextSnapshot } from './context-builder';

type KnowledgeContextMethods = {
  buildKnowledgeAccess(groupId: string): ContextSnapshot['knowledgeAccess'];
  buildKnowledgeChunks(groupId: string, recallQuery: string): ContextSnapshot['knowledgeChunks'];
};

describe('ContextBuilder project knowledge scope', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT);
      CREATE TABLE enterprise_projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', token_used INTEGER NOT NULL DEFAULT 0,
        completed_nodes INTEGER NOT NULL DEFAULT 0, total_nodes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_resource_links (
        project_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        permission TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE knowledge_sources (
        id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE knowledge_chunks (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO enterprise_projects VALUES (?, ?, ?, 0, 0, 0, ?, ?)')
      .run('enterprise-project-1', '客户交付项目', '', now, now);
    db.prepare("INSERT INTO project_resource_links VALUES (?, 'group', ?, 'read-write', 'active', ?, ?)")
      .run('enterprise-project-1', 'group-1', now, now);
    db.prepare("INSERT INTO knowledge_sources VALUES ('source-personal', 'project', 'group-1', 'ready')").run();
    db.prepare("INSERT INTO knowledge_sources VALUES ('source-project', 'project', 'enterprise-project-1', 'ready')").run();
    db.prepare("INSERT INTO knowledge_sources VALUES ('source-enterprise', 'shared', 'shared-knowledge', 'ready')").run();
    db.prepare("INSERT INTO knowledge_sources VALUES ('source-unlinked', 'project', 'enterprise-project-2', 'ready')").run();
    db.prepare("INSERT INTO knowledge_chunks VALUES ('chunk-personal', 'source-personal', '群聊个人证据', '2026-01-04')").run();
    db.prepare("INSERT INTO knowledge_chunks VALUES ('chunk-project', 'source-project', '关联项目证据', '2026-01-03')").run();
    db.prepare("INSERT INTO knowledge_chunks VALUES ('chunk-enterprise', 'source-enterprise', '企业证据', '2026-01-02')").run();
    db.prepare("INSERT INTO knowledge_chunks VALUES ('chunk-unlinked', 'source-unlinked', '未关联项目机密证据', '2026-01-01')").run();
  });

  afterEach(() => db.close());

  it('injects personal, linked-project, and enterprise knowledge with explicit labels', () => {
    const methods = new ContextBuilder(db) as unknown as KnowledgeContextMethods;
    const access = methods.buildKnowledgeAccess('group-1');
    const chunks = methods.buildKnowledgeChunks('group-1', '证据');

    expect(access.project).toMatchObject({ scopeId: 'enterprise-project-1', name: '客户交付项目' });
    expect(chunks.map((chunk) => chunk.text)).toEqual(expect.arrayContaining(['群聊个人证据', '关联项目证据', '企业证据']));
    expect(chunks.map((chunk) => chunk.text)).not.toContain('未关联项目机密证据');
    expect(chunks.find((chunk) => chunk.text === '关联项目证据')?.sourceLabel).toContain('客户交付项目');
  });

  it('drops project knowledge immediately after the group association is revoked', () => {
    db.prepare("UPDATE project_resource_links SET status = 'revoked' WHERE resource_type = 'group' AND resource_id = 'group-1'").run();
    const methods = new ContextBuilder(db) as unknown as KnowledgeContextMethods;

    expect(methods.buildKnowledgeAccess('group-1').project).toBeNull();
    expect(methods.buildKnowledgeChunks('group-1', '证据').map((chunk) => chunk.text)).toEqual(expect.arrayContaining(['群聊个人证据', '企业证据']));
    expect(methods.buildKnowledgeChunks('group-1', '证据').map((chunk) => chunk.text)).not.toContain('关联项目证据');
  });
});
