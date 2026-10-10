import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { toolArguments, runtimeSkillCatalog, type RuntimeSkillCode } from '@kla-workstation/contracts';
import { requirePermission } from '../auth/permission-service.js';
import type { AccountRepository } from '../repositories/types.js';
import type { ShortTermMemoryService } from '../memories/short-term.js';
import { resolveSearchTargets, searchScopedKnowledge, scopedSearchInputSchema } from '../auth/knowledge-search.js';
import { serviceUrl } from '../knowledge-api/config.js';
import type { RegisteredAgent } from './registry.js';

const string = { type: 'string' }, integer = { type: 'integer' };
const properties: Record<RuntimeSkillCode, Record<string, unknown>> = {
  knowledge_search: { query: string, topK: integer },
  knowledge_read: { serviceInstanceId: string, docId: string, offset: integer, limit: integer },
  memory_recall: { query: string }, artifact_write: { fileName: string, content: string, mimeType: string },
  artifact_read: { artifactId: string }, local_read: { path: string, offset: integer, maxChars: integer },
  local_list: { path: string }, local_write: { fileName: string, content: string, path: string },
  local_code: { fileName: string, content: string, path: string },
  local_bat: { script: string, cwd: string, timeoutMs: integer },
  local_cli: { executable: string, args: { type: 'array', items: string }, cwd: string, timeoutMs: integer },
  local_ppt_doctor: {},
  local_ppt_build: { specJson: { type: 'string', description: '完整 DeckSpec JSON 字符串；必须有 cover 和语义块，禁止几何字段' }, fileName: string, render: { type: 'boolean', description: '默认 true，调用真实 PPTX 渲染器' } },
  local_ppt_inspect: { path: string, documentId: string },
  local_ppt_render: { path: string, documentId: string },
};
const required: Record<RuntimeSkillCode, string[]> = {
  knowledge_search: ['query'], knowledge_read: ['serviceInstanceId','docId'], memory_recall: ['query'],
  artifact_write: ['fileName','content'], artifact_read: ['artifactId'], local_read: ['path'], local_list: ['path'],
  local_write: ['fileName','content'], local_code: ['fileName','content'], local_bat: ['script'], local_cli: ['executable'],
  local_ppt_doctor: [], local_ppt_build: ['specJson'], local_ppt_inspect: [], local_ppt_render: [],
};
export function agentTools(agent: RegisteredAgent) {
  return runtimeSkillCatalog.filter(s => agent.skills.includes(s.code) && (s.location === 'server' || agent.execution_location === 'local'))
    .map(s => ({ type: 'function', function: { name: s.code, description: s.description, parameters: { type: 'object', properties: properties[s.code], required: required[s.code], additionalProperties: false } } }));
}
export function parseToolArguments(name: string, raw: unknown): Record<string, unknown> {
  if (!(name in toolArguments)) throw new Error(`未知技能：${name}`);
  return toolArguments[name as RuntimeSkillCode].parse(raw);
}
export class RuntimeTools {
  constructor(private readonly pool: Pool, private readonly accounts: AccountRepository, private readonly memory: ShortTermMemoryService, private readonly encryptionKey: string) {}
  async knowledgeInfo(identityId:string, conversationId:string):Promise<unknown> {
    try { const targets = await resolveSearchTargets(this.pool, identityId, { conversationId });
      return targets?.libraries.length ? { libraries: targets.libraries.map(item => ({ id: item.id, name: item.name, scope: item.scope })) } : null; }
    catch { return null; }
  }
  async execute(name: string, raw: unknown, scope: { identityId: string; conversationId: string; agentId: string; toolCallId?: string }): Promise<unknown> {
    const args = parseToolArguments(name, raw);
    await requirePermission(this.pool, scope.identityId, name === 'artifact_write' ? 'write' : 'read');
    if (name === 'memory_recall') return { memories: await this.memory.recall(scope, String(args.query)), longTermApplied: false };
    if (name === 'artifact_read') {
      const artifact = await this.accounts.getArtifact(scope.identityId, String(args.artifactId));
      if (!artifact) throw new Error('成果不存在或当前身份无权访问');
      if (artifact.contentEncoding === 'base64') return { id: artifact.id, name: artifact.name, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes, binary: true, hint: '二进制内容不进入模型上下文。PPTX 请使用 local_ppt_inspect 读取本地 documentId；PDF/PNG 可在成果抽屉查看。' };
      return artifact;
    }
    if (name === 'artifact_write') {
      const content = String(args.content);
      const checksum = createHash('sha256').update(content).digest('hex');
      const {rows} = await this.pool.query(`INSERT INTO artifacts(identity_id,conversation_id,name,mime_type,content,size_bytes,checksum,tool_call_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tool_call_id) WHERE tool_call_id IS NOT NULL DO UPDATE SET tool_call_id=EXCLUDED.tool_call_id RETURNING *`,
      [scope.identityId,scope.conversationId,args.fileName,args.mimeType,content,Buffer.byteLength(content),checksum,scope.toolCallId??null]);
      return { artifactId: rows[0].id, fileName: rows[0].name, sizeBytes: Number(rows[0].size_bytes), checksum, stored: true };
    }
    if (name.startsWith('knowledge_')) {
      if (name === 'knowledge_read') throw new Error('文档归属尚未验证，暂不可读取原文');
      const search = scopedSearchInputSchema.parse({ conversationId: scope.conversationId,
        query: args.query, mode: 'hybrid', topK: args.topK });
      return searchScopedKnowledge(this.pool, scope.identityId, search, async (_collection, payload) => {
        const response = await fetch(`${serviceUrl}/v1/search`, { method: 'POST', headers: {
          'content-type': 'application/json', ...(process.env.KB_API_KEY ? { 'x-api-key': process.env.KB_API_KEY } : {}),
        }, body: JSON.stringify(payload) });
        if (!response.ok) throw new Error(`知识服务返回 HTTP ${response.status}`);
        return response.json();
      });
    }
    throw new Error('本地技能必须路由到已认证桌面设备');
  }
}
