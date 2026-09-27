import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ToolRegistry, type AgentRole, type ToolCapability } from './tool-registry';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/app/path') },
}));

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_instance_id TEXT NOT NULL,
      requested_by_type TEXT NOT NULL,
      requested_by_id TEXT,
      instruction TEXT,
      parent_run_id TEXT,
      trigger_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt INTEGER NOT NULL DEFAULT 1,
      model_profile_snapshot_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      result_message_id TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE agent_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;
  let db: Database.Database;
  let capturedReviewArgs: Record<string, unknown> | undefined;

  beforeEach(() => {
    db = createDb();
    capturedReviewArgs = undefined;
    registry = new ToolRegistry(db);
    registry.registerAll([
      {
        name: 'knowledge:search',
        description: '搜索知识库',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, projectId: { type: 'string' } },
          required: ['query', 'projectId'],
        },
        requiredCapabilities: ['read:knowledge'],
        async execute(args) {
          const { query } = args as { query: string };
          return `搜索 "${query}" 的结果: ...`;
        },
      },
      {
        name: 'workspace:readFile',
        description: '读取文件',
        parameters: {
          type: 'object',
          properties: { relativePath: { type: 'string' }, projectId: { type: 'string' } },
          required: ['relativePath', 'projectId'],
        },
        requiredCapabilities: ['read:file'],
        allowedPathPrefixes: ['original-files/', 'outputs/'],
        async execute(args) {
          const { relativePath } = args as { relativePath: string };
          return `文件内容: ${relativePath}`;
        },
      },
      {
        name: 'publish_artifact',
        description: '发布成果',
        parameters: {
          type: 'object',
          properties: { content: { type: 'string' }, relativePath: { type: 'string' }, projectId: { type: 'string' } },
          required: ['content', 'relativePath', 'projectId'],
        },
        requiredCapabilities: ['write:output'],
        allowedPathPrefixes: ['outputs/'],
        async execute(args) {
          const { relativePath } = args as { relativePath: string };
          return `已发布到 ${relativePath}`;
        },
      },
      {
        name: 'delete:file',
        description: '删除文件（仅测试权限拒绝）',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        requiredCapabilities: ['delete:file'],
        async execute() {
          return '已删除';
        },
      },
      {
        name: 'review:writeDraft',
        description: '写待审稿',
        parameters: { type: 'object', properties: {}, required: [] },
        requiredCapabilities: ['write:review-draft'],
        async execute(args) { capturedReviewArgs = { ...args }; return '待审稿已保存'; },
      },
      {
        name: 'review:promoteArtifact',
        description: '提升已验收成果',
        parameters: { type: 'object', properties: {}, required: [] },
        requiredCapabilities: ['promote:reviewed-output'],
        async execute() { return '正式成果已发布'; },
      },
      {
        name: 'temp:save',
        description: '保存当前任务临时文件',
        parameters: { type: 'object', properties: {}, required: [] },
        requiredCapabilities: ['write:temp'],
        async execute() { return 'TEMP_SAVED: draft.html'; },
      },
      {
        name: 'temp:promote',
        description: '将当前任务临时文件提升为正式成果',
        parameters: { type: 'object', properties: {}, required: [] },
        requiredCapabilities: ['promote:reviewed-output'],
        async execute() { return 'TEMP_PROMOTED: draft.html -> outputs/final.html'; },
      },
    ]);
  });

  describe('getDefinitionsForRole', () => {
    it('orchestrator 可以看到 read:knowledge 和 read:file 工具', () => {
      const defs = registry.getDefinitionsForRole('orchestrator');
      const names = defs.map((d) => d.name);
      expect(names).toContain('knowledge:search');
      expect(names).toContain('workspace:readFile');
      expect(names).toContain('publish_artifact');
    });

    it('orchestrator 看不到 delete:file（deny）', () => {
      const defs = registry.getDefinitionsForRole('orchestrator');
      const names = defs.map((d) => d.name);
      expect(names).not.toContain('delete:file');
    });

    it('local executor receives the combined read, draft, publish and promote permissions', () => {
      const names = registry.getDefinitionsForRole('local-executor').map((item) => item.name);
      expect(names).toEqual(expect.arrayContaining([
        'knowledge:search',
        'workspace:readFile',
        'review:writeDraft',
        'review:promoteArtifact',
        'temp:save',
        'temp:promote',
        'publish_artifact',
      ]));
      expect(names).not.toContain('delete:file');
    });

    it('writer only sees draft writing while reviewer only gets read tools', () => {
      const writerNames = registry.getDefinitionsForRole('material-writer').map((item) => item.name);
      expect(writerNames).toContain('review:writeDraft');
      expect(writerNames).not.toContain('publish_artifact');
      expect(writerNames).not.toContain('review:promoteArtifact');

      const reviewerNames = registry.getDefinitionsForRole('acceptance-reviewer').map((item) => item.name);
      expect(reviewerNames).toContain('knowledge:search');
      expect(reviewerNames).toContain('workspace:readFile');
      expect(reviewerNames).not.toContain('review:writeDraft');
      expect(reviewerNames).not.toContain('publish_artifact');
    });
  });

  describe('execute — 权限检查', () => {
    it('允许 orchestrator 执行 read:knowledge 工具', async () => {
      const result = await registry.execute('knowledge:search', { query: 'test', projectId: 'p1' }, {
        role: 'orchestrator',
        runId: 'r1',
        projectId: 'p1',
      });
      expect(result).toContain('搜索');
    });

    it('拒绝 orchestrator 执行 delete:file 工具', async () => {
      const result = await registry.execute('delete:file', { path: '/etc/passwd' }, {
        role: 'orchestrator',
        runId: 'r1',
      });
      expect(result).toContain('权限不足');
    });
  });

  describe('execute — schema 校验', () => {
    it('缺少必填参数时返回错误', async () => {
      const result = await registry.execute('knowledge:search', { query: 'test' } as any, {
        role: 'orchestrator',
        runId: 'r1',
      });
      expect(result).toContain('参数校验失败');
      expect(result).toContain('projectId');
    });

    it('参数类型错误时返回错误', async () => {
      const result = await registry.execute('knowledge:search', { query: 'test', projectId: 123 } as any, {
        role: 'orchestrator',
        runId: 'r1',
      });
      expect(result).toContain('参数校验失败');
      expect(result).toContain('projectId');
    });
  });

  it('always binds project/run and review paths to the execution context', async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_runs
       (id, project_id, agent_instance_id, requested_by_type, requested_by_id, parent_run_id, status, created_at)
       VALUES ('root-context-1', 'project-context-1', 'orchestrator-1', 'user', 'local-user', NULL, 'running', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO agent_runs
       (id, project_id, agent_instance_id, requested_by_type, requested_by_id, parent_run_id, status, created_at)
       VALUES ('writer-context-1', 'project-context-1', 'writer-1', 'agent', 'orchestrator-1', 'root-context-1', 'running', ?)`,
    ).run(now);
    const result = await registry.execute('review:writeDraft', {
      projectId: '群聊名称而非ID',
      relativePath: '.runtime/review-drafts/model-made-up.html',
      content: '<!doctype html><html></html>',
    }, {
      role: 'material-writer',
      runId: 'writer-context-1',
      projectId: 'project-context-1',
    });

    expect(result).toBe('待审稿已保存');
    expect(capturedReviewArgs).toEqual(expect.objectContaining({
      projectId: 'project-context-1',
      relativePath: '.runtime/review-drafts/root-context-1/material-draft.html',
    }));
  });

  describe('execute — 路径检查', () => {
    it('允许在白名单路径内读取文件', async () => {
      const result = await registry.execute('workspace:readFile', { relativePath: 'original-files/doc.txt', projectId: 'p1' }, {
        role: 'orchestrator',
        runId: 'r1',
      });
      expect(result).toContain('文件内容');
    });

    it('拒绝读取白名单外的路径', async () => {
      const result = await registry.execute('workspace:readFile', { relativePath: '.env', projectId: 'p1' }, {
        role: 'orchestrator',
        runId: 'r1',
      });
      expect(result).toContain('路径权限不足');
    });

    it('拒绝路径穿越', async () => {
      const result = await registry.execute('publish_artifact', {
        content: 'test', relativePath: 'outputs/../../etc/passwd', projectId: 'p1',
      }, {
        role: 'orchestrator',
        runId: 'r1',
      });
      expect(result).toContain('路径包含非法字符');
    });
  });

  describe('canRoleUseTool', () => {
    it('orchestrator 可以使用 knowledge:search', () => {
      expect(registry.canRoleUseTool('orchestrator', 'knowledge:search')).toBe(true);
    });

    it('orchestrator 不能使用 delete:file', () => {
      expect(registry.canRoleUseTool('orchestrator', 'delete:file')).toBe(false);
    });

    it('knowledge-manager 可以使用 publish_artifact（report-only）', () => {
      expect(registry.canRoleUseTool('knowledge-manager', 'publish_artifact')).toBe(true);
    });

    it('researcher 不能越过统筹直接发布 outputs 成果', () => {
      expect(registry.canRoleUseTool('researcher', 'publish_artifact')).toBe(false);
    });

    it('orchestrator and the closed-loop local executor can promote an accepted draft', () => {
      expect(registry.canRoleUseTool('orchestrator', 'review:promoteArtifact')).toBe(true);
      expect(registry.canRoleUseTool('local-executor', 'review:promoteArtifact')).toBe(true);
      expect(registry.canRoleUseTool('material-writer', 'review:promoteArtifact')).toBe(false);
      expect(registry.canRoleUseTool('acceptance-reviewer', 'review:promoteArtifact')).toBe(false);
    });

    it('unknown tool 返回 false', () => {
      expect(registry.canRoleUseTool('orchestrator', 'nonexistent')).toBe(false);
    });
  });

  describe('getTool', () => {
    it('返回已注册的工具', () => {
      const tool = registry.getTool('knowledge:search');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('knowledge:search');
    });

    it('未注册的工具返回 undefined', () => {
      expect(registry.getTool('nonexistent')).toBeUndefined();
    });
  });
});
