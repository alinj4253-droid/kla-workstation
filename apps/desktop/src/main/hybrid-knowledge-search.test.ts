// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { embedTextLocally, LOCAL_EMBEDDING_MODEL } from '@kunqing/knowledge-core';
import { searchHybridKnowledge } from './hybrid-knowledge-search';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE knowledge_sources (id TEXT PRIMARY KEY, scope_type TEXT, scope_id TEXT, file_id TEXT, status TEXT);
    CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY, source_id TEXT, ordinal INTEGER, text TEXT, location_json TEXT, content_hash TEXT, created_at TEXT);
    CREATE TABLE knowledge_chunk_embeddings (chunk_id TEXT PRIMARY KEY, source_id TEXT, model_id TEXT, dimensions INTEGER, vector_json TEXT, created_at TEXT);
    CREATE TABLE knowledge_nodes (id TEXT PRIMARY KEY, scope_type TEXT, scope_id TEXT, canonical_name TEXT, summary TEXT);
    CREATE TABLE knowledge_edges (id TEXT PRIMARY KEY, scope_type TEXT, scope_id TEXT, source_node_id TEXT, target_node_id TEXT, edge_type TEXT);
    CREATE TABLE wiki_pages (id TEXT PRIMARY KEY, scope_type TEXT, scope_id TEXT, title TEXT, body_md TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT);
    CREATE VIRTUAL TABLE knowledge_chunk_fts USING fts5(id UNINDEXED, text, content='knowledge_chunks', content_rowid='rowid');
    CREATE TRIGGER trg_chunk_fts_insert AFTER INSERT ON knowledge_chunks BEGIN
      INSERT INTO knowledge_chunk_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
    END;
  `);
  return db;
}

describe('hybrid knowledge retrieval', () => {
  it('fuses local project and shared evidence with source attribution', () => {
    const db = createDb();
    db.prepare('INSERT INTO files (id, name) VALUES (?, ?)').run('f1', '经营报告.md');
    db.prepare("INSERT INTO knowledge_sources (id, scope_type, scope_id, file_id, status) VALUES ('s1','project','p1','f1','ready')").run();
    db.prepare("INSERT INTO knowledge_chunks VALUES ('c1','s1',0,'公司经营分析显示收入增长，现金流改善。','{\"section\":\"经营摘要\"}','h1','now')").run();
    const vector = embedTextLocally('公司经营分析显示收入增长，现金流改善。');
    db.prepare('INSERT INTO knowledge_chunk_embeddings VALUES (?, ?, ?, ?, ?, ?)').run('c1', 's1', LOCAL_EMBEDDING_MODEL.id, vector.length, JSON.stringify(vector), 'now');
    db.prepare("INSERT INTO knowledge_nodes VALUES ('n1','project','p1','现金流','经营活动现金流改善')").run();
    db.prepare("INSERT INTO wiki_pages VALUES ('w1','shared','shared-knowledge','经营分析方法','经营分析需要结合收入、利润与现金流。')").run();

    const result = searchHybridKnowledge(db, '如何分析公司经营和现金流？', 'p1', 5);
    expect(result.strategy).toHaveLength(4);
    expect(result.hits.some((hit) => hit.sourceFile === '经营报告.md')).toBe(true);
    expect(result.hits.some((hit) => hit.channels.includes('keyword'))).toBe(true);
    expect(result.hits.some((hit) => hit.channels.includes('wiki'))).toBe(true);
    expect(result.hits[0]?.score).toBe(1);
    db.close();
  });

  it('honors local retrieval tool switches', () => {
    const db = createDb();
    db.prepare('INSERT INTO files (id, name) VALUES (?, ?)').run('f1', '经营报告.md');
    db.prepare("INSERT INTO knowledge_sources (id, scope_type, scope_id, file_id, status) VALUES ('s1','project','p1','f1','ready')").run();
    db.prepare("INSERT INTO knowledge_chunks VALUES ('c1','s1',0,'收入增长与现金流改善','{}','h1','now')").run();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('builtin-tool:tool.fts5-search', JSON.stringify({ enabled: false }), now);
    db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('builtin-tool:tool.local-embedding', JSON.stringify({ enabled: false }), now);

    const result = searchHybridKnowledge(db, '收入增长', 'p1', 5);
    expect(result.strategy).not.toContain('keyword');
    expect(result.strategy).not.toContain('vector');
    expect(result.hits).toHaveLength(0);
    db.close();
  });
});
