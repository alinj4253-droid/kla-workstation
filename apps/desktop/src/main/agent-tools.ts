import type Database from 'better-sqlite3';
import { KnowledgeRepository, SearchRepository, AgentRunRepository } from '@kunqing/database';
import { getProjectRoot } from './paths';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Scheduler } from './scheduler';
import { ToolRegistry } from './tool-registry';
import { buildModelProfileSnapshot } from './project-creator';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export function createProjectTools(db: Database.Database, scheduler?: Scheduler): ToolDefinition[] {
  const kRepo = new KnowledgeRepository(db);
  const sRepo = new SearchRepository(db);
  const runRepo = new AgentRunRepository(db);

  return [
    {
      name: 'knowledge:search',
      description: '搜索项目知识库中的文档内容，返回匹配的片段',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          projectId: { type: 'string', description: '项目 ID' },
          limit: { type: 'number', description: '最大返回条数，默认 5' },
        },
        required: ['query', 'projectId'],
      },
      async execute(args) {
        const { query, projectId, limit } = args as { query: string; projectId: string; limit?: number };
        try {
          const results = kRepo.search(query, 'project', projectId, limit ?? 5);
          const parts: string[] = [];
          for (const n of results.nodes) {
            parts.push(`[节点] ${n.summary ?? n.canonicalName}`);
          }
          for (const c of results.chunks) {
            parts.push(`[片段] ${c.text.slice(0, 500)}`);
          }
          if (parts.length === 0) return '未找到相关知识';
          return parts.join('\n\n');
        } catch (err) {
          return `搜索错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'workspace:readFile',
      description: '读取工作区文件内容',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          relativePath: { type: 'string', description: '文件相对路径' },
        },
        required: ['projectId', 'relativePath'],
      },
      async execute(args) {
        const { projectId, relativePath } = args as { projectId: string; relativePath: string };
        try {
          const projectRoot = getProjectRoot(projectId);
          const filePath = join(projectRoot, relativePath);
          const content = await readFile(filePath, 'utf8');
          return content.slice(0, 10000);
        } catch (err) {
          return `读取失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'project:search',
      description: '跨项目全文搜索，返回匹配的消息和文件',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '最大返回条数，默认 5' },
        },
        required: ['query'],
      },
      async execute(args) {
        const { query, limit } = args as { query: string; limit?: number };
        try {
          const results = sRepo.search(query, limit ?? 5);
          if (results.length === 0) return '未找到匹配结果';
          return results.map((r) => `[${r.kind}] ${r.title}: ${r.snippet.slice(0, 500)}`).join('\n\n');
        } catch (err) {
          return `搜索错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'knowledge:listGraph',
      description: '列出知识图谱中的所有节点',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          graphId: { type: 'string', description: '图谱 ID（可选，留空则列出所有图谱）' },
        },
        required: ['projectId'],
      },
      async execute(args) {
        const { projectId, graphId } = args as { projectId: string; graphId?: string };
        try {
          if (graphId) {
            const nodes = db.prepare(
              'SELECT id, canonical_name as title, node_type as type FROM knowledge_nodes WHERE project_id = ? AND graph_id = ? ORDER BY canonical_name',
            ).all(projectId, graphId) as Array<{ id: string; title: string; type: string }>;
            if (nodes.length === 0) return '该图谱中无节点';
            return nodes.map((n) => `- ${n.title} (${n.type})`).join('\n');
          }
          const graphs = db.prepare(
            'SELECT id, name, description FROM knowledge_graphs WHERE project_id = ? ORDER BY name',
          ).all(projectId) as Array<{ id: string; name: string; description: string | null }>;
          if (graphs.length === 0) return '该项目无知识图谱';
          return graphs.map((g) => `图谱: ${g.name}${g.description ? ` - ${g.description}` : ''}`).join('\n');
        } catch (err) {
          return `查询错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    // ---- Team MCP 工具 ----
    {
      name: 'list_project_agents',
      description: '列出当前项目中的所有可委派智能体成员',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
        },
        required: ['projectId'],
      },
      async execute(args) {
        const { projectId } = args as { projectId: string };
        try {
          const agents = db.prepare(
            `SELECT pai.id, ap.name, pai.role, ap.definition_id as definitionId
             FROM project_agent_instances pai
             JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
             WHERE pai.project_id = ? AND ap.enabled = 1 ORDER BY pai.ordinal`,
          ).all(projectId) as Array<{ id: string; name: string; role: string; definitionId: string }>;
          if (agents.length === 0) return '该项目无可用的智能体';
          return agents.map((a) => `- ${a.name} (${a.role}, ${a.definitionId})`).join('\n');
        } catch (err) {
          return `查询错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'delegate_tasks',
      description: '向子智能体委派任务，等待结果返回',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          agentInstanceId: { type: 'string', description: '目标智能体实例 ID' },
          instruction: { type: 'string', description: '委派指令' },
          parentRunId: { type: 'string', description: '当前 Run ID' },
        },
        required: ['projectId', 'agentInstanceId', 'instruction', 'parentRunId'],
      },
      async execute(args) {
        const { projectId, agentInstanceId, instruction, parentRunId } = args as {
          projectId: string; agentInstanceId: string; instruction: string; parentRunId: string;
        };

        try {
          // 安全限制 1: 目标智能体必须已启用（AC-SET-03）
          const targetProfile = db.prepare(
            `SELECT ap.enabled FROM project_agent_instances pai
             JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
             WHERE pai.id = ?`,
          ).get(agentInstanceId) as { enabled: number } | undefined;
          if (!targetProfile) {
            return `智能体实例 ${agentInstanceId} 不存在`;
          }
          if (!targetProfile.enabled) {
            const msg = `智能体实例 ${agentInstanceId} 已被禁用，无法委派任务`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'agent_disabled', agentInstanceId });
            return msg;
          }

          // 安全限制 2: 委派深度最多 2 层
          const ancestorChain = runRepo.getAncestorChain(parentRunId);
          const depth = ancestorChain.length;
          if (depth >= 2) {
            const msg = `委派深度 ${depth} 已达到上限 2 层，已禁止继续向下委派`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'max_depth', depth, agentInstanceId });
            return msg;
          }

          // 安全限制 3: 禁止循环委派（目标智能体已在祖先链中）
          const ancestorInstanceIds = new Set(ancestorChain.map((r) => r.agentInstanceId));
          if (ancestorInstanceIds.has(agentInstanceId)) {
            const msg = `循环委派检测: 智能体 ${agentInstanceId} 已在当前 Run 的祖先链中，已禁止`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'cycle_detected', agentInstanceId });
            return msg;
          }

          // 安全限制 4: 每条 triggerMessage 最多 20 个 Run
          const triggerMessageId = ancestorChain.length > 0 ? ancestorChain[ancestorChain.length - 1]!.triggerMessageId : null;
          if (triggerMessageId) {
            const runCount = runRepo.countRunsByTrigger(triggerMessageId);
            if (runCount >= 20) {
              const msg = `消息 ${triggerMessageId} 已产生 ${runCount} 个 Run，达到上限 20，禁止继续委派`;
              runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'max_runs_per_message', count: runCount, triggerMessageId });
              return msg;
            }
          }

          const subRun = runRepo.create({
            projectId,
            agentInstanceId,
            requestedByType: 'agent',
            requestedById: parentRunId,
            instruction,
            parentRunId,
            modelProfileSnapshotJson: buildModelProfileSnapshot(db, agentInstanceId),
          });
          runRepo.addEvent(parentRunId, 'delegate', {
            subRunId: subRun.id,
            agentInstanceId,
            instruction: instruction.slice(0, 200),
          });

          if (scheduler) {
            scheduler.enqueue({
              runId: subRun.id,
              projectId,
              agentInstanceId,
              instruction,
              triggerMessageId: triggerMessageId ?? '',
            });
            return `任务已委派给智能体 ${agentInstanceId}，子 Run ID: ${subRun.id}（深度 ${depth + 1}）`;
          }
          return `子 Run 已创建 (${subRun.id})，但调度器未连接，需手动触发`;
        } catch (err) {
          return `委派失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'publish_artifact',
      description: '将生成的成果文件发布到工作区',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          relativePath: { type: 'string', description: '文件相对路径（如 docs/report.md）' },
          content: { type: 'string', description: '文件内容' },
          note: { type: 'string', description: '成果说明（可选）' },
        },
        required: ['projectId', 'relativePath', 'content'],
      },
      async execute(args) {
        const { projectId, relativePath, content, note } = args as {
          projectId: string; relativePath: string; content: string; note?: string;
        };
        try {
          const projectRoot = getProjectRoot(projectId);
          const filePath = join(projectRoot, relativePath);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, content, 'utf8');
          const result = `成果已发布到 ${relativePath}${note ? ` (说明: ${note})` : ''}`;
          return result;
        } catch (err) {
          return `发布失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

/** 将项目工具注册到 ToolRegistry，附加权限元数据 */
export function registerProjectTools(registry: ToolRegistry, db: Database.Database, scheduler?: Scheduler): void {
  const kRepo = new KnowledgeRepository(db);
  const sRepo = new SearchRepository(db);
  const runRepo = new AgentRunRepository(db);

  registry.registerAll([
    {
      name: 'knowledge:search',
      description: '搜索项目知识库中的文档内容，返回匹配的片段',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          projectId: { type: 'string', description: '项目 ID' },
          limit: { type: 'number', description: '最大返回条数，默认 5' },
        },
        required: ['query', 'projectId'],
      },
      requiredCapabilities: ['read:knowledge'],
      maxContentLength: 10000,
      async execute(args) {
        const { query, projectId, limit } = args as { query: string; projectId: string; limit?: number };
        try {
          const results = kRepo.search(query, 'project', projectId, limit ?? 5);
          const parts: string[] = [];
          for (const n of results.nodes) {
            parts.push(`[节点] ${n.summary ?? n.canonicalName}`);
          }
          for (const c of results.chunks) {
            parts.push(`[片段] ${c.text.slice(0, 500)}`);
          }
          if (parts.length === 0) return '未找到相关知识';
          return parts.join('\n\n');
        } catch (err) {
          return `搜索错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'workspace:readFile',
      description: '读取工作区文件内容',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          relativePath: { type: 'string', description: '文件相对路径' },
        },
        required: ['projectId', 'relativePath'],
      },
      requiredCapabilities: ['read:file'],
      allowedPathPrefixes: ['original-files/', 'outputs/', 'wiki/', 'agent-memories/', 'agent-identities/'],
      maxContentLength: 10000,
      async execute(args) {
        const { projectId, relativePath } = args as { projectId: string; relativePath: string };
        try {
          const projectRoot = getProjectRoot(projectId);
          const filePath = join(projectRoot, relativePath);
          const content = await readFile(filePath, 'utf8');
          return content.slice(0, 10000);
        } catch (err) {
          return `读取失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'project:search',
      description: '跨项目全文搜索，返回匹配的消息和文件',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '最大返回条数，默认 5' },
        },
        required: ['query'],
      },
      requiredCapabilities: ['read:message', 'read:file'],
      maxContentLength: 10000,
      async execute(args) {
        const { query, limit } = args as { query: string; limit?: number };
        try {
          const results = sRepo.search(query, limit ?? 5);
          if (results.length === 0) return '未找到匹配结果';
          return results.map((r) => `[${r.kind}] ${r.title}: ${r.snippet.slice(0, 500)}`).join('\n\n');
        } catch (err) {
          return `搜索错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'knowledge:listGraph',
      description: '列出知识图谱中的所有节点',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          graphId: { type: 'string', description: '图谱 ID（可选，留空则列出所有图谱）' },
        },
        required: ['projectId'],
      },
      requiredCapabilities: ['read:knowledge'],
      async execute(args) {
        const { projectId, graphId } = args as { projectId: string; graphId?: string };
        try {
          if (graphId) {
            const nodes = db.prepare(
              'SELECT id, canonical_name as title, node_type as type FROM knowledge_nodes WHERE project_id = ? AND graph_id = ? ORDER BY canonical_name',
            ).all(projectId, graphId) as Array<{ id: string; title: string; type: string }>;
            if (nodes.length === 0) return '该图谱中无节点';
            return nodes.map((n) => `- ${n.title} (${n.type})`).join('\n');
          }
          const graphs = db.prepare(
            'SELECT id, name, description FROM knowledge_graphs WHERE project_id = ? ORDER BY name',
          ).all(projectId) as Array<{ id: string; name: string; description: string | null }>;
          if (graphs.length === 0) return '该项目无知识图谱';
          return graphs.map((g) => `图谱: ${g.name}${g.description ? ` - ${g.description}` : ''}`).join('\n');
        } catch (err) {
          return `查询错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'list_project_agents',
      description: '列出当前项目中的所有可委派智能体成员',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
        },
        required: ['projectId'],
      },
      requiredCapabilities: ['read:message'],
      async execute(args) {
        const { projectId } = args as { projectId: string };
        try {
          const agents = db.prepare(
            `SELECT pai.id, ap.name, pai.role, ap.definition_id as definitionId
             FROM project_agent_instances pai
             JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
             WHERE pai.project_id = ? AND ap.enabled = 1 ORDER BY pai.ordinal`,
          ).all(projectId) as Array<{ id: string; name: string; role: string; definitionId: string }>;
          if (agents.length === 0) return '该项目无可用的智能体';
          return agents.map((a) => `- ${a.name} (${a.role}, ${a.definitionId})`).join('\n');
        } catch (err) {
          return `查询错误: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'delegate_tasks',
      description: '向子智能体委派任务，等待结果返回',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          agentInstanceId: { type: 'string', description: '目标智能体实例 ID' },
          instruction: { type: 'string', description: '委派指令' },
          parentRunId: { type: 'string', description: '当前 Run ID' },
        },
        required: ['projectId', 'agentInstanceId', 'instruction', 'parentRunId'],
      },
      requiredCapabilities: ['read:message'],
      async execute(args) {
        const { projectId, agentInstanceId, instruction, parentRunId } = args as {
          projectId: string; agentInstanceId: string; instruction: string; parentRunId: string;
        };

        try {
          // 安全限制 1: 目标智能体必须已启用（AC-SET-03）
          const targetProfile = db.prepare(
            `SELECT ap.enabled FROM project_agent_instances pai
             JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
             WHERE pai.id = ?`,
          ).get(agentInstanceId) as { enabled: number } | undefined;
          if (!targetProfile) {
            return `智能体实例 ${agentInstanceId} 不存在`;
          }
          if (!targetProfile.enabled) {
            const msg = `智能体实例 ${agentInstanceId} 已被禁用，无法委派任务`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'agent_disabled', agentInstanceId });
            return msg;
          }

          // 安全限制 2: 委派深度最多 2 层
          const ancestorChain = runRepo.getAncestorChain(parentRunId);
          const depth = ancestorChain.length;
          if (depth >= 2) {
            const msg = `委派深度 ${depth} 已达到上限 2 层，已禁止继续向下委派`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'max_depth', depth, agentInstanceId });
            return msg;
          }

          // 安全限制 3: 禁止循环委派（目标智能体已在祖先链中）
          const ancestorInstanceIds = new Set(ancestorChain.map((r) => r.agentInstanceId));
          if (ancestorInstanceIds.has(agentInstanceId)) {
            const msg = `循环委派检测: 智能体 ${agentInstanceId} 已在当前 Run 的祖先链中，已禁止`;
            runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'cycle_detected', agentInstanceId });
            return msg;
          }

          // 安全限制 4: 每条 triggerMessage 最多 20 个 Run
          const triggerMessageId = ancestorChain.length > 0 ? ancestorChain[ancestorChain.length - 1]!.triggerMessageId : null;
          if (triggerMessageId) {
            const runCount = runRepo.countRunsByTrigger(triggerMessageId);
            if (runCount >= 20) {
              const msg = `消息 ${triggerMessageId} 已产生 ${runCount} 个 Run，达到上限 20，禁止继续委派`;
              runRepo.addEvent(parentRunId, 'delegate.rejected', { reason: 'max_runs_per_message', count: runCount, triggerMessageId });
              return msg;
            }
          }

          const subRun = runRepo.create({
            projectId,
            agentInstanceId,
            requestedByType: 'agent',
            requestedById: parentRunId,
            instruction,
            parentRunId,
            modelProfileSnapshotJson: buildModelProfileSnapshot(db, agentInstanceId),
          });
          runRepo.addEvent(parentRunId, 'delegate', {
            subRunId: subRun.id,
            agentInstanceId,
            instruction: instruction.slice(0, 200),
          });

          if (scheduler) {
            scheduler.enqueue({
              runId: subRun.id,
              projectId,
              agentInstanceId,
              instruction,
              triggerMessageId: triggerMessageId ?? '',
            });
            return `任务已委派给智能体 ${agentInstanceId}，子 Run ID: ${subRun.id}（深度 ${depth + 1}）`;
          }
          return `子 Run 已创建 (${subRun.id})，但调度器未连接，需手动触发`;
        } catch (err) {
          return `委派失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'publish_artifact',
      description: '将生成的成果文件发布到工作区',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          relativePath: { type: 'string', description: '文件相对路径（如 docs/report.md）' },
          content: { type: 'string', description: '文件内容' },
          note: { type: 'string', description: '成果说明（可选）' },
        },
        required: ['projectId', 'relativePath', 'content'],
      },
      requiredCapabilities: ['write:output'],
      allowedPathPrefixes: ['outputs/'],
      maxContentLength: 50000,
      async execute(args) {
        const { projectId, relativePath, content, note } = args as {
          projectId: string; relativePath: string; content: string; note?: string;
        };
        try {
          const projectRoot = getProjectRoot(projectId);
          const filePath = join(projectRoot, relativePath);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, content, 'utf8');
          const result = `成果已发布到 ${relativePath}${note ? ` (说明: ${note})` : ''}`;
          return result;
        } catch (err) {
          return `发布失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ]);
}
