import type Database from 'better-sqlite3';
import { AgentRunRepository } from '@kunqing/database';
import { getLogger } from './logger';
import { ManagedCopyService } from './managed-copy';
import { resolve as resolvePath } from 'node:path';

// ─── Agent Roles ─────────────────────────────────────────────────────────────
export type AgentRole = 'orchestrator' | 'knowledge-manager' | 'external-cli';

// ─── Capabilities ────────────────────────────────────────────────────────────
export type ToolCapability =
  | 'read:message'       // 读本群聊消息
  | 'read:file'          // 读本群聊原始文件
  | 'read:knowledge'     // 读本群聊知识
  | 'read:shared-knowledge' // 读共享知识
  | 'write:memory'       // 写自身记忆
  | 'write:knowledge'    // 写群聊知识/图谱
  | 'write:output'       // 写 outputs
  | 'delete:file'        // 删除原始文件
  | 'shell:execute';     // 任意 shell

// ─── Permission Level ────────────────────────────────────────────────────────
export type PermissionLevel = 'allow' | 'deny' | 'task-only' | 'mcp-only' | 'report-only' | 'managed-copy';

// ─── Permission Matrix (10.9 规范) ────────────────────────────────────────────
const PERMISSION_MATRIX: Record<AgentRole, Record<ToolCapability, PermissionLevel>> = {
  orchestrator: {
    'read:message': 'allow',
    'read:file': 'allow',
    'read:knowledge': 'allow',
    'read:shared-knowledge': 'task-only',
    'write:memory': 'allow',
    'write:knowledge': 'deny',
    'write:output': 'allow',
    'delete:file': 'deny',
    'shell:execute': 'deny',
  },
  'knowledge-manager': {
    'read:message': 'task-only',
    'read:file': 'allow',
    'read:knowledge': 'allow',
    'read:shared-knowledge': 'allow',
    'write:memory': 'allow',
    'write:knowledge': 'allow',
    'write:output': 'report-only',
    'delete:file': 'deny',
    'shell:execute': 'deny',
  },
  'external-cli': {
    'read:message': 'managed-copy',
    'read:file': 'managed-copy',
    'read:knowledge': 'mcp-only',
    'read:shared-knowledge': 'mcp-only',
    'write:memory': 'mcp-only',
    'write:knowledge': 'deny',
    'write:output': 'managed-copy',
    'delete:file': 'deny',
    'shell:execute': 'allow',
  },
};

// ─── Tool Registration ───────────────────────────────────────────────────────
export interface ToolRegistration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiredCapabilities: ToolCapability[];
  /** 路径检查白名单，只有以这些前缀开头的路径才允许访问 */
  allowedPathPrefixes?: string[];
  /** 最大内容长度（字节） */
  maxContentLength?: number;
  /** 执行函数 */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// ─── ToolRegistry ────────────────────────────────────────────────────────────
export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();
  private runRepo: AgentRunRepository;
  private db: Database.Database;
  private managedCopy: ManagedCopyService | null = null;

  constructor(db: Database.Database, workspaceRoot?: string) {
    this.db = db;
    this.runRepo = new AgentRunRepository(db);
    if (workspaceRoot) {
      this.managedCopy = new ManagedCopyService(workspaceRoot);
    }
  }

  /** 清理指定 Run 的所有受控拷贝 */
  async cleanupRun(runId: string): Promise<void> {
    await this.managedCopy?.cleanup(runId);
  }

  register(tool: ToolRegistration): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: ToolRegistration[]): void {
    for (const t of tools) {
      this.register(t);
    }
  }

  getTool(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  /** 获取某角色可见的工具定义（用于 AI SDK tool calling） */
  getDefinitionsForRole(role: AgentRole): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    const result: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
    for (const [, tool] of this.tools) {
      // 检查角色是否有权限使用该工具（至少一个 capability 为 allow）
      const hasAccess = tool.requiredCapabilities.some((cap) => {
        const level = PERMISSION_MATRIX[role]?.[cap];
        return level === 'allow' || level === 'task-only' || level === 'report-only';
      });
      if (hasAccess) {
        result.push({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        });
      }
    }
    return result;
  }

  /** 执行工具，经过完整权限检查链 */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: { role: AgentRole; runId?: string; projectId?: string },
  ): Promise<string> {
    const logger = getLogger();
    const tool = this.tools.get(name);
    if (!tool) {
      return `未知工具: ${name}`;
    }

    // 1. Schema validation（基础参数校验）
    const schemaErrors = this.validateArgs(tool, args);
    if (schemaErrors.length > 0) {
      const msg = `工具 ${name} 参数校验失败: ${schemaErrors.join('; ')}`;
      this.audit(context.runId, name, args, msg, true);
      return msg;
    }

    // 2. Instance effective permission
    for (const cap of tool.requiredCapabilities) {
      const level = PERMISSION_MATRIX[context.role]?.[cap];
      if (level === 'deny') {
        const msg = `权限不足: ${context.role} 不具备 ${cap} 能力，无法使用工具 ${name}`;
        this.audit(context.runId, name, args, msg, true);
        return msg;
      }
      if (level === 'mcp-only') {
        const msg = `权限不足: ${context.role} 的 ${cap} 仅限 MCP Tool 使用，不能直接调用`;
        this.audit(context.runId, name, args, msg, true);
        return msg;
      }
      if (level === 'managed-copy') {
        // 路径重写由 resolveManagedCopyArgs 处理，此处继续执行
      }
    }

    // 3. Project/shared scope check
    if (tool.requiredCapabilities.includes('read:shared-knowledge') && context.projectId) {
      const sharedEnabled = this.checkSharedKnowledgeEnabled(context.projectId);
      if (!sharedEnabled) {
        const msg = '共享知识未开启，无法使用该工具';
        this.audit(context.runId, name, args, msg, true);
        return msg;
      }
    }

    // 4. Path/size/rate limit
    if (tool.allowedPathPrefixes) {
      const pathArg = args['relativePath'] as string | undefined;
      if (pathArg) {
        const allowed = tool.allowedPathPrefixes.some((prefix) => pathArg.startsWith(prefix));
        if (!allowed) {
          const msg = `路径权限不足: ${pathArg} 不在允许路径白名单中`;
          this.audit(context.runId, name, args, msg, true);
          return msg;
        }
        // 路径穿越防护
        if (pathArg.includes('..')) {
          const msg = `路径包含非法字符: ${pathArg}`;
          this.audit(context.runId, name, args, msg, true);
          return msg;
        }
      }
    }

    // 5. Managed-copy 路径重写
    const resolvedArgs = await this.resolveManagedCopyArgs(tool, args, context);

    // 6. Execute
    try {
      const result = await tool.execute(resolvedArgs);

      // 内容长度限制
      if (tool.maxContentLength && result.length > tool.maxContentLength) {
        const truncated = result.slice(0, tool.maxContentLength) + '\n\n...(结果已截断)';
        this.audit(context.runId, name, args, truncated.slice(0, 500));
        return truncated;
      }

      // 6. Audit + normalized result
      this.audit(context.runId, name, args, result.slice(0, 500));
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.audit(context.runId, name, args, errMsg, true);
      return `工具执行失败: ${errMsg}`;
    }
  }

  /** 检查角色的默认能力是否允许使用某个工具（简单判断） */
  canRoleUseTool(role: AgentRole, toolName: string): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;
    return tool.requiredCapabilities.some((cap) => {
      const level = PERMISSION_MATRIX[role]?.[cap];
      return level === 'allow' || level === 'task-only' || level === 'report-only';
    });
  }

  /**
   * 当角色某 capability 的权限为 managed-copy 时，
   * 将所有路径参数改写为受控拷贝路径
   */
  private async resolveManagedCopyArgs(
    tool: ToolRegistration,
    args: Record<string, unknown>,
    context: { role: AgentRole; runId?: string; projectId?: string },
  ): Promise<Record<string, unknown>> {
    if (!this.managedCopy || !context.runId) return args;

    const hasManaged = tool.requiredCapabilities.some((cap) => {
      const level = PERMISSION_MATRIX[context.role]?.[cap];
      return level === 'managed-copy';
    });
    if (!hasManaged) return args;

    const RESOLVE_KEY_MAP: Record<string, (mc: ManagedCopyService, runId: string, val: string) => Promise<string>> = {
      path: (mc, runId, v) => mc.copyFile(v, runId),
      filePath: (mc, runId, v) => mc.copyFile(v, runId),
      relativePath: (mc, runId, v) => mc.copyFile(v, runId),
      directory: () => Promise.resolve(''), // 跳过目录参数
    };

    const result: Record<string, unknown> = { ...args };
    for (const [key, val] of Object.entries(result)) {
      if (typeof val === 'string' && RESOLVE_KEY_MAP[key]) {
        result[key] = await RESOLVE_KEY_MAP[key](this.managedCopy, context.runId, val);
      }
    }

    // 对于 write:output，将 content 写入受控文件
    const hasWriteOutput = tool.requiredCapabilities.includes('write:output');
    const writeLevel = PERMISSION_MATRIX[context.role]?.['write:output'];
    if (hasWriteOutput && writeLevel === 'managed-copy' && typeof result['content'] === 'string') {
      const managedPath = await this.managedCopy.writeContent(
        result['content'] as string,
        `output_${Date.now()}.txt`,
        context.runId,
      );
      result['content'] = managedPath;
      result['_managedOutputPath'] = managedPath;
    }

    return result;
  }

  private validateArgs(tool: ToolRegistration, args: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const schema = tool.parameters as Record<string, unknown>;
    const properties = (schema as any)?.properties as Record<string, { type: string }> | undefined;
    const required = (schema as any)?.required as string[] | undefined;

    if (required) {
      for (const field of required) {
        if (args[field] === undefined || args[field] === null) {
          errors.push(`缺少必填参数: ${field}`);
        }
      }
    }

    if (properties) {
      for (const [key, value] of Object.entries(args)) {
        const prop = properties[key];
        if (prop && value !== undefined && value !== null) {
          const expectedType = prop.type;
          if (expectedType === 'string' && typeof value !== 'string') {
            errors.push(`参数 ${key} 应为字符串，实际为 ${typeof value}`);
          } else if (expectedType === 'number' && typeof value !== 'number') {
            errors.push(`参数 ${key} 应为数字，实际为 ${typeof value}`);
          }
        }
      }
    }

    return errors;
  }

  private checkSharedKnowledgeEnabled(projectId: string): boolean {
    try {
      const row = this.db.prepare('SELECT shared_knowledge_enabled as enabled FROM projects WHERE id = ?').get(projectId) as { enabled: number } | undefined;
      return row ? row.enabled === 1 : false;
    } catch {
      return false;
    }
  }

  private audit(runId: string | undefined, tool: string, args: Record<string, unknown>, result: string, isError = false): void {
    if (!runId) return;
    try {
      this.runRepo.addEvent(runId, isError ? 'tool_call_error' : 'tool_call', {
        tool,
        args: this.sanitizeArgs(args),
        result: result.slice(0, 500),
      });
    } catch {
      // 审计日志写入失败不阻塞执行
    }
  }

  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...args };
    // 避免在审计日志中记录敏感内容
    if (sanitized['content'] && typeof sanitized['content'] === 'string' && sanitized['content'].length > 200) {
      sanitized['content'] = sanitized['content'].slice(0, 200) + '...(truncated)';
    }
    return sanitized;
  }
}