import type Database from 'better-sqlite3';
import { AgentRunRepository } from '@kunqing/database';
import { getLogger } from './logger';
import { ManagedCopyService } from './managed-copy';
import { resolve as resolvePath } from 'node:path';

// ─── Agent Roles ─────────────────────────────────────────────────────────────
export type AgentRole = 'orchestrator' | 'local-executor' | 'knowledge-manager' | 'researcher' | 'material-writer' | 'acceptance-reviewer' | 'external-cli';

// ─── Capabilities ────────────────────────────────────────────────────────────
export type ToolCapability =
  | 'spawn:parallel'
  | 'read:message'       // 读本群聊消息
  | 'read:file'          // 读本群聊原始文件
  | 'read:knowledge'     // 读本群聊知识
  | 'read:document'      // 分段读取授权范围内的标准化完整正文
  | 'read:template'      // 发现并读取个人、关联项目和企业模板
  | 'read:shared-knowledge' // 读关联项目与企业知识（历史能力名保留兼容）
  | 'read:skill'         // 读当前 Agent Definition 绑定的技能
  | 'read:workflow'      // 读当前 Agent Definition 绑定的协同工作流
  | 'write:memory'       // 写自身记忆
  | 'write:knowledge'    // 写群聊知识/图谱
  | 'write:output'       // 写 outputs
  | 'write:review-draft' // 写本次材料验收暂存稿
  | 'write:temp'         // 写当前根 Run 的个人工作区临时产物
  | 'read:temp'          // 读取当前根 Run 的个人工作区临时产物
  | 'promote:reviewed-output' // 将验收通过的暂存稿提升为正式成果
  | 'delete:file'        // 删除原始文件
  | 'network:search'     // 访问受控网页搜索服务
  | 'shell:execute';     // 任意 shell

// ─── Permission Level ────────────────────────────────────────────────────────
export type PermissionLevel = 'allow' | 'deny' | 'task-only' | 'mcp-only' | 'report-only' | 'managed-copy';

// ─── Permission Matrix (10.9 规范) ────────────────────────────────────────────
const PERMISSION_MATRIX: Record<AgentRole, Record<ToolCapability, PermissionLevel>> = {
  orchestrator: {
    'spawn:parallel': 'deny',
    'read:message': 'allow',
    'read:file': 'allow',
    'read:knowledge': 'allow',
    'read:document': 'deny',
    'read:template': 'deny',
    'read:shared-knowledge': 'task-only',
    'read:skill': 'allow',
    'read:workflow': 'allow',
    'write:memory': 'allow',
    'write:knowledge': 'deny',
    'write:output': 'allow',
    'write:review-draft': 'deny',
    'write:temp': 'allow',
    'read:temp': 'allow',
    'promote:reviewed-output': 'allow',
    'delete:file': 'deny',
    'network:search': 'deny',
    'shell:execute': 'deny',
  },
  'knowledge-manager': {
    'spawn:parallel': 'allow',
    'read:message': 'task-only',
    'read:file': 'allow',
    'read:knowledge': 'deny',
    'read:document': 'deny',
    'read:template': 'deny',
    'read:shared-knowledge': 'deny',
    'read:skill': 'allow',
    'read:workflow': 'deny',
    'write:memory': 'allow',
    'write:knowledge': 'allow',
    'write:output': 'report-only',
    'write:review-draft': 'deny',
    'write:temp': 'allow',
    'read:temp': 'allow',
    'promote:reviewed-output': 'deny',
    'delete:file': 'deny',
    'network:search': 'deny',
    'shell:execute': 'deny',
  },
  'local-executor': {
    'spawn:parallel': 'allow',
    'read:message': 'task-only',
    'read:file': 'allow',
    'read:knowledge': 'allow',
    'read:document': 'allow',
    'read:template': 'allow',
    'read:shared-knowledge': 'allow',
    'read:skill': 'allow',
    'read:workflow': 'deny',
    'write:memory': 'allow',
    'write:knowledge': 'allow',
    'write:output': 'allow',
    'write:review-draft': 'allow',
    'write:temp': 'allow',
    'read:temp': 'allow',
    'promote:reviewed-output': 'allow',
    'delete:file': 'deny',
    'network:search': 'allow',
    'shell:execute': 'deny',
  },
  researcher: {
    'spawn:parallel': 'allow',
    'read:message': 'task-only',
    'read:file': 'allow',
    'read:knowledge': 'allow',
    'read:document': 'deny',
    'read:template': 'deny',
    'read:shared-knowledge': 'task-only',
    'read:skill': 'allow',
    'read:workflow': 'deny',
    'write:memory': 'allow',
    'write:knowledge': 'deny',
    'write:output': 'deny',
    'write:review-draft': 'deny',
    'write:temp': 'allow',
    'read:temp': 'allow',
    'promote:reviewed-output': 'deny',
    'delete:file': 'deny',
    'network:search': 'allow',
    'shell:execute': 'deny',
  },
  'material-writer': {
    'spawn:parallel': 'allow',
    'read:message': 'task-only',
    'read:file': 'allow',
    'read:knowledge': 'allow',
    'read:document': 'allow',
    'read:template': 'allow',
    'read:shared-knowledge': 'allow',
    'read:skill': 'allow',
    'read:workflow': 'deny',
    'write:memory': 'allow',
    'write:knowledge': 'deny',
    'write:output': 'deny',
    'write:review-draft': 'allow',
    'write:temp': 'allow',
    'read:temp': 'allow',
    'promote:reviewed-output': 'deny',
    'delete:file': 'deny',
    'network:search': 'deny',
    'shell:execute': 'deny',
  },
  'acceptance-reviewer': {
    'spawn:parallel': 'allow',
    'read:message': 'task-only',
    'read:file': 'allow',
    'read:knowledge': 'allow',
    'read:document': 'allow',
    'read:template': 'allow',
    'read:shared-knowledge': 'allow',
    'read:skill': 'allow',
    'read:workflow': 'deny',
    'write:memory': 'allow',
    'write:knowledge': 'deny',
    'write:output': 'deny',
    'write:review-draft': 'deny',
    'write:temp': 'deny',
    'read:temp': 'allow',
    'promote:reviewed-output': 'deny',
    'delete:file': 'deny',
    'network:search': 'deny',
    'shell:execute': 'deny',
  },
  'external-cli': {
    'spawn:parallel': 'deny',
    'read:message': 'managed-copy',
    'read:file': 'managed-copy',
    'read:knowledge': 'mcp-only',
    'read:document': 'deny',
    'read:template': 'deny',
    'read:shared-knowledge': 'mcp-only',
    'read:skill': 'mcp-only',
    'read:workflow': 'mcp-only',
    'write:memory': 'mcp-only',
    'write:knowledge': 'deny',
    'write:output': 'managed-copy',
    'write:review-draft': 'deny',
    'write:temp': 'deny',
    'read:temp': 'deny',
    'promote:reviewed-output': 'deny',
    'delete:file': 'deny',
    'network:search': 'deny',
    'shell:execute': 'allow',
  },
};

function canRoleSpawnParallel(role: AgentRole): boolean {
  return role === 'local-executor'
    || role === 'knowledge-manager'
    || role === 'researcher'
    || role === 'material-writer'
    || role === 'acceptance-reviewer';
}

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
      const hasAccess = tool.name === 'agent:spawn_parallel'
        ? canRoleSpawnParallel(role)
        : tool.requiredCapabilities.some((cap) => {
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
    if (name === 'agent:spawn_parallel' && !canRoleSpawnParallel(context.role)) {
      const msg = `权限不足：${context.role} 不允许创建分身任务`;
      this.audit(context.runId, name, args, msg, true);
      return msg;
    }
    if (!tool) {
      return `未知工具: ${name}`;
    }

    // Context-bound identifiers and artifact locations are execution authority,
    // not model input. Always replace model-provided values before validation.
    args = this.bindExecutionContext(name, tool, args, context);

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

    // 3. 关联项目/企业知识范围检查。实际项目关联权限由知识范围解析器校验。
    if (tool.requiredCapabilities.includes('read:shared-knowledge') && context.projectId) {
      const sharedEnabled = this.checkSharedKnowledgeEnabled(context.projectId);
      if (!sharedEnabled) {
        const msg = '当前群聊没有可用的扩展知识范围，无法使用该工具';
        this.audit(context.runId, name, args, msg, true);
        return msg;
      }
    }

    // 4. Path/size/rate limit
    if (tool.allowedPathPrefixes) {
      const pathArg = args['relativePath'] as string | undefined;
      if (pathArg) {
        const normalizedPath = pathArg.replaceAll('\\', '/').replace(/^\.\//, '');
        if (normalizedPath.startsWith('agent-memories/') || normalizedPath.startsWith('agent-identities/')) {
          const owner = context.runId
            ? this.db.prepare('SELECT agent_instance_id as agentInstanceId FROM agent_runs WHERE id = ?').get(context.runId) as { agentInstanceId: string } | undefined
            : undefined;
          const ownMemoryPrefix = owner ? `agent-memories/${owner.agentInstanceId}/` : '';
          const ownIdentityPrefix = owner ? `agent-identities/${owner.agentInstanceId}/` : '';
          if (!owner || (!normalizedPath.startsWith(ownMemoryPrefix) && !normalizedPath.startsWith(ownIdentityPrefix))) {
            const msg = '身份与记忆文件仅允许所属智能体自己读取';
            this.audit(context.runId, name, args, msg, true);
            return msg;
          }
        }
        const allowed = tool.allowedPathPrefixes.some((prefix) => normalizedPath.startsWith(prefix));
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
    if (toolName === 'agent:spawn_parallel') return canRoleSpawnParallel(role);
    return tool.requiredCapabilities.some((cap) => {
      const level = PERMISSION_MATRIX[role]?.[cap];
      return level === 'allow' || level === 'task-only' || level === 'report-only';
    });
  }

  private bindExecutionContext(
    name: string,
    tool: ToolRegistration,
    input: Record<string, unknown>,
    context: { role: AgentRole; runId?: string; projectId?: string },
  ): Record<string, unknown> {
    const args = { ...input };
    const schema = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
    const reviewTool = name === 'review:writeDraft' || name === 'review:promoteArtifact';
    const tempTool = name === 'temp:save' || name === 'temp:read' || name === 'temp:list' || name === 'temp:promote';
    const hasProjectBinding = reviewTool
      || tempTool
      || Boolean(schema.properties?.projectId || schema.required?.includes('projectId'));
    const hasRunBinding = Boolean(schema.properties?.runId || schema.required?.includes('runId'));
    if (context.projectId && hasProjectBinding) args.projectId = context.projectId;
    if (context.runId && hasRunBinding) args.runId = context.runId;

    // Temporary artifacts are always scoped to the root Run.  A child agent
    // cannot select another task directory by passing a forged runId.
    if (context.runId && tempTool) {
      let rootRunId = context.runId;
      try { rootRunId = this.runRepo.getAncestorChain(context.runId).at(-1)?.id ?? context.runId; } catch { /* use current Run */ }
      args.runId = rootRunId;
      if (name === 'temp:promote') args.runId = rootRunId;
    }

    if (context.runId && reviewTool) {
      let rootRunId = context.runId;
      try { rootRunId = this.runRepo.getAncestorChain(context.runId).at(-1)?.id ?? context.runId; } catch { /* use current Run */ }
      const runSegment = rootRunId.replace(/[^a-zA-Z0-9-]/g, '').slice(-24) || context.runId.replace(/[^a-zA-Z0-9-]/g, '').slice(-24) || 'current-run';
      const draftPath = `.runtime/review-drafts/${runSegment}/material-draft.html`;
      if (name === 'review:writeDraft') {
        args.relativePath = draftPath;
      } else {
        args.draftRelativePath = draftPath;
        args.outputRelativePath = `outputs/task-delivery-${runSegment}.html`;
      }
    }
    return args;
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
    return Boolean(projectId);
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
