// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/app/path') },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: class { static fromWebContents = vi.fn(); webContents = { send: vi.fn() } },
}));

import type Database from 'better-sqlite3';
import DatabaseLib from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectTools, registerProjectTools } from './agent-tools';
import { setStudioRoot } from './paths';
import { ToolRegistry } from './tool-registry';

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
      content_md5 TEXT,
      parser_id TEXT,
      metadata_json TEXT,
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
    CREATE TABLE knowledge_chunk_embeddings (
      chunk_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE wiki_pages (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body_md TEXT
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
    CREATE TABLE project_resource_links (
      project_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE project_fts USING fts5(id, name, summary);
    CREATE VIRTUAL TABLE message_fts USING fts5(id UNINDEXED, project_id UNINDEXED, content_json);
    CREATE VIRTUAL TABLE knowledge_chunk_fts USING fts5(id UNINDEXED, text);
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

  it('returns all project tools', () => {
    expect(tools).toHaveLength(17);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['temp:save', 'temp:read', 'temp:list', 'temp:promote']));
    expect(names).toContain('knowledge:process');
    expect(names).toContain('knowledge:search');
    expect(names).toContain('knowledge:readDocument');
    expect(names).toContain('template:list');
    expect(names).toContain('template:read');
    expect(names).toContain('template:materialize');
    expect(names).toContain('web:search');
    expect(names).toContain('workspace:readFile');
    expect(names).toContain('project:search');
    expect(names).toContain('knowledge:listGraph');
    expect(names).toContain('list_project_agents');
    expect(names).toContain('delegate_tasks');
    expect(names).toContain('publish_artifact');
  });

  it('exposes delegation only to the orchestrator while keeping the roster readable', () => {
    const registry = new ToolRegistry(db);
    registerProjectTools(registry, db);

    const orchestratorTools = registry.getDefinitionsForRole('orchestrator').map((tool) => tool.name);
    expect(orchestratorTools).toContain('delegate_tasks');
    expect(orchestratorTools).toContain('list_project_agents');

    for (const role of ['knowledge-manager', 'researcher', 'material-writer', 'acceptance-reviewer'] as const) {
      const names = registry.getDefinitionsForRole(role).map((tool) => tool.name);
      expect(names).not.toContain('delegate_tasks');
      expect(names).toContain('list_project_agents');
    }

    const knowledgeTools = registry.getDefinitionsForRole('knowledge-manager').map((tool) => tool.name);
    const writerTools = registry.getDefinitionsForRole('material-writer').map((tool) => tool.name);
    const reviewerTools = registry.getDefinitionsForRole('acceptance-reviewer').map((tool) => tool.name);
    expect(knowledgeTools).not.toContain('knowledge:search');
    expect(knowledgeTools).not.toContain('knowledge:readDocument');
    expect(knowledgeTools).not.toContain('template:list');
    expect(knowledgeTools).not.toContain('template:read');
    expect(writerTools).toEqual(expect.arrayContaining(['knowledge:search', 'knowledge:readDocument', 'template:list', 'template:read', 'template:materialize']));
    expect(reviewerTools).toEqual(expect.arrayContaining(['knowledge:search', 'knowledge:readDocument', 'template:list', 'template:read']));
    expect(registry.getDefinitionsForRole('orchestrator').map((tool) => tool.name)).not.toContain('knowledge:readDocument');
    expect(registry.getDefinitionsForRole('researcher').map((tool) => tool.name)).not.toContain('knowledge:readDocument');
  });

  it('lists templates across personal, associated project and enterprise workspaces and reads long templates by cursor', async () => {
    const studioRoot = await mkdtemp(join(tmpdir(), 'kunqing-template-tools-'));
    setStudioRoot(studioRoot);
    try {
      const groupId = 'group-template-test';
      const enterpriseProjectId = 'enterprise-project-test';
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO project_resource_links
        (project_id, resource_type, resource_id, permission, status, created_at, updated_at)
        VALUES (?, 'group', ?, 'read-write', 'active', ?, ?)`)
        .run(enterpriseProjectId, groupId, now, now);
      await Promise.all([
        mkdir(join(studioRoot, 'group-chats', `${groupId}-workspace`, 'templates'), { recursive: true }),
        mkdir(join(studioRoot, 'projects', enterpriseProjectId, 'templates'), { recursive: true }),
        mkdir(join(studioRoot, 'shared-knowledge', 'templates'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(studioRoot, 'group-chats', `${groupId}-workspace`, 'templates', '个人报告模板.md'), '个人模板', 'utf8'),
        writeFile(join(studioRoot, 'projects', enterpriseProjectId, 'templates', '项目报告模板.md'), '项目模板', 'utf8'),
        writeFile(join(studioRoot, 'shared-knowledge', 'templates', '企业报告模板.md'), `企业模板-${'正文'.repeat(900)}`, 'utf8'),
      ]);

      const listTool = tools.find((tool) => tool.name === 'template:list')!;
      const listed = await listTool.execute({ projectId: groupId });
      expect(listed).toContain('[个人模板] 个人报告模板.md');
      expect(listed).toContain('[项目模板] 项目报告模板.md');
      expect(listed).toContain('[企业模板] 企业报告模板.md');

      const readTool = tools.find((tool) => tool.name === 'template:read')!;
      const first = await readTool.execute({ projectId: groupId, template: 'enterprise:企业报告模板.md', cursor: 0, maxChars: 1000 });
      expect(first).toContain('READ_COMPLETE: false');
      expect(first).toContain('NEXT_CURSOR: 1000');
      const second = await readTool.execute({ projectId: groupId, template: 'enterprise:企业报告模板.md', cursor: 1000, maxChars: 1000 });
      expect(second).toContain('READ_COMPLETE: true');
      expect(second).toContain('企业');
    } finally {
      setStudioRoot('');
      await rm(studioRoot, { recursive: true, force: true });
    }
  });

  it('knowledge:search returns no results for empty DB', async () => {
    const tool = tools.find((t) => t.name === 'knowledge:search')!;
    const result = await tool.execute({ query: 'test', projectId: 'proj-1' });
    expect(result).toBe('未找到相关知识');
  });

  it('materializes content into an HTML template while preserving the shell', async () => {
    const studioRoot = await mkdtemp(join(tmpdir(), 'kunqing-template-materialize-'));
    setStudioRoot(studioRoot);
    try {
      const groupId = 'group-materialize-test';
      const templateDir = join(studioRoot, 'group-chats', `${groupId}-workspace`, 'templates');
      await mkdir(templateDir, { recursive: true });
      await writeFile(join(templateDir, 'brand.html'), '<!doctype html><html><head><style>.brand-shell{color:red}</style></head><body><header>HEADER</header><main class="brand-shell body">OLD BODY</main><footer>FOOTER</footer></body></html>', 'utf8');
      const tool = tools.find((item) => item.name === 'template:materialize')!;
      const result = await tool.execute({
        projectId: groupId,
        template: 'group:brand.html',
        content: '<h1>新正文</h1>',
        runId: 'materialize-run',
        fileName: 'material-draft.html',
      });
      expect(result).toContain('TEMP_SAVED: material-draft.html');
      const output = await readFile(join(studioRoot, 'group-chats', `${groupId}-workspace`, 'temp', 'materialize-run', 'material-draft.html'), 'utf8');
      expect(output).toContain('<style>.brand-shell{color:red}</style>');
      expect(output).toContain('HEADER');
      expect(output).toContain('<h1>新正文</h1>');
      expect(output).not.toContain('OLD BODY');
      expect(output).toContain('FOOTER');
    } finally {
      setStudioRoot('');
      await rm(studioRoot, { recursive: true, force: true });
    }
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

  it('saves and promotes only real temporary files using file names', async () => {
    const studioRoot = await mkdtemp(join(tmpdir(), 'kunqing-temp-tools-'));
    setStudioRoot(studioRoot);
    try {
      const groupId = 'group-temp-test';
      const runId = 'root-temp-test';
      const save = tools.find((item) => item.name === 'temp:save')!;
      const read = tools.find((item) => item.name === 'temp:read')!;
      const list = tools.find((item) => item.name === 'temp:list')!;
      const promote = tools.find((item) => item.name === 'temp:promote')!;

      expect(await promote.execute({ projectId: groupId, runId, fileName: 'missing.html' })).toContain('失败');
      expect(await save.execute({ projectId: groupId, runId, fileName: '../escape.html', content: 'nope' })).toContain('不合法');
      expect(await save.execute({ projectId: groupId, runId, fileName: 'draft.html', content: '<html>draft</html>' })).toContain('TEMP_SAVED: draft.html');
      expect(await list.execute({ projectId: groupId, runId })).toContain('draft.html');
      expect(await read.execute({ projectId: groupId, runId, fileName: 'draft.html' })).toContain('<html>draft</html>');
      expect(await promote.execute({ projectId: groupId, runId, fileName: 'draft.html', outputName: 'final.html' })).toContain('TEMP_PROMOTED: draft.html -> outputs/final.html');
      expect(await readFile(join(studioRoot, 'group-chats', `${groupId}-workspace`, 'outputs', 'final.html'), 'utf8')).toBe('<html>draft</html>');
    } finally {
      setStudioRoot('');
      await rm(studioRoot, { recursive: true, force: true });
    }
  });
});
