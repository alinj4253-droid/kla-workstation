import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ToolRegistry, type AgentRole, type ToolCapability } from './tool-registry';

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

  beforeEach(() => {
    db = createDb();
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