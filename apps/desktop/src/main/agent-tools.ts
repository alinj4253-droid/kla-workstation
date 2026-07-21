import type Database from 'better-sqlite3';
import { KnowledgeRepository, SearchRepository } from '@kunqing/database';
import { getProjectRoot } from './paths';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export function createProjectTools(db: Database.Database): ToolDefinition[] {
  const kRepo = new KnowledgeRepository(db);
  const sRepo = new SearchRepository(db);

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
  ];
}
