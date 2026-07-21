// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/app/path') },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: class { static fromWebContents = vi.fn(); webContents = { send: vi.fn() } },
}));

import type Database from 'better-sqlite3';
import DatabaseLib from 'better-sqlite3';
import { createProjectTools } from './agent-tools';

function createDb(): Database.Database {
  const db = new DatabaseLib(':memory:');
  db.exec(`
    CREATE TABLE knowledge_graphs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT
    );
    CREATE TABLE knowledge_nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      graph_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      summary TEXT,
      properties_json TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_sources (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      file_id TEXT,
      version_id TEXT,
      sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      ingested_at TEXT
    );
    CREATE TABLE knowledge_chunks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      location_json TEXT,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_provenance (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      source_id TEXT,
      chunk_id TEXT,
      location_json TEXT,
      quote_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_edges (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      properties_json TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      content_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE project_fts USING fts5(project_id, name, summary);
    CREATE VIRTUAL TABLE message_fts USING fts5(message_id, project_id, content);
    CREATE VIRTUAL TABLE knowledge_chunk_fts USING fts5(chunk_id, source_id, text);
  `);
  return db;
}

describe('createProjectTools', () => {
  let db: Database.Database;
  let tools: ReturnType<typeof createProjectTools>;

  beforeEach(() => {
    db = createDb();
    tools = createProjectTools(db);
  });

  it('returns four tools', () => {
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain('knowledge:search');
    expect(names).toContain('workspace:readFile');
    expect(names).toContain('project:search');
    expect(names).toContain('knowledge:listGraph');
  });

  it('knowledge:search returns no results for empty DB', async () => {
    const tool = tools.find((t) => t.name === 'knowledge:search')!;
    const result = await tool.execute({ query: 'test', projectId: 'proj-1' });
    expect(result).toBe('未找到相关知识');
  });

  it('knowledge:listGraph returns no graphs for empty DB', async () => {
    const tool = tools.find((t) => t.name === 'knowledge:listGraph')!;
    const result = await tool.execute({ projectId: 'proj-1' });
    expect(result).toBe('该项目无知识图谱');
  });

  it('knowledge:listGraph lists graphs and nodes', async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO knowledge_graphs (id, project_id, name, description) VALUES ('g-1', 'proj-1', '测试图谱', '测试用')").run();
    db.prepare("INSERT INTO knowledge_nodes (id, project_id, graph_id, scope_type, scope_id, node_type, canonical_name, confidence, created_at, updated_at) VALUES ('n-1', 'proj-1', 'g-1', 'project', 'proj-1', 'concept', '测试节点', 1.0, ?, ?)").run(now, now);

    const tool = tools.find((t) => t.name === 'knowledge:listGraph')!;
    const graphs = await tool.execute({ projectId: 'proj-1' });
    expect(graphs).toContain('测试图谱');
    expect(graphs).toContain('测试用');

    const nodes = await tool.execute({ projectId: 'proj-1', graphId: 'g-1' });
    expect(nodes).toContain('测试节点');
  });

  it('project:search uses SearchRepository', async () => {
    const tool = tools.find((t) => t.name === 'project:search')!;
    const result = await tool.execute({ query: 'nonexistent' });
    expect(result).toBe('未找到匹配结果');
  });

  it('workspace:readFile returns error for nonexistent file', async () => {
    const tool = tools.find((t) => t.name === 'workspace:readFile')!;
    const result = await tool.execute({ projectId: 'proj-1', relativePath: 'nonexistent.txt' });
    expect(result).toContain('读取失败');
  });
});
