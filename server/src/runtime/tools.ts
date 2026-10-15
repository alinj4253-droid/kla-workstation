import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { toolArguments, runtimeSkillCatalog, type RuntimeSkillCode } from '@kla-workstation/contracts';
import { z } from 'zod';
import { requirePermission } from '../auth/permission-service.js';
import type { AccountRepository } from '../repositories/types.js';
import type { ShortTermMemoryService } from '../memories/short-term.js';
import { resolveSearchTargets, searchScopedKnowledge, scopedSearchInputSchema } from '../auth/knowledge-search.js';
import { getAccessibleLibrary } from '../auth/knowledge-libraries.js';
import { createBochaClient, formatBochaSearchResults } from '../tools/bocha-client.js';
import type { RegisteredAgent } from './registry.js';
import type { ObjectStore } from '../storage/object-store.js';
import { knowledgeRequest } from './knowledge-transport.js';
import { accessibleFile } from '../storage/file-access.js';
import { HomeAiService, homeAiWriteTools } from './home-ai/service.js';
import type { HomeAiToolCode } from '@kla-workstation/contracts';

const string = { type: 'string' }, integer = { type: 'integer' };
const matrixOfNumbers = { type: 'array', items: { type: 'array', items: { type: 'number' } } };
const arrayOfIntegers = { type: 'array', items: integer };
const pointList = { type: 'array', items: { type: 'object', properties: { name: string, lat: { type: 'number' }, lon: { type: 'number' } }, required: ['lat', 'lon'], additionalProperties: false } };
const properties: Record<RuntimeSkillCode, Record<string, unknown>> = {
  home_ai_session_open: { sessionId: string },
  home_ai_interview_update: { sessionId:string, expectedRevision:integer, answerId:{type:'string',enum:['role','mission','handoff','workflow','capability','kpi','idea','success','constraints','materials']}, answer:string },
  home_ai_opportunity_discover: {sessionId:string},
  home_ai_conditions_update: {sessionId:string,expectedRevision:integer,stageId:string,
    checks:{type:'object',properties:Object.fromEntries(['data','rules','review','access','evidence'].map(k=>[k,{type:'string',enum:['yes','no','unknown']}])),additionalProperties:false},
    notes:{type:'object',properties:Object.fromEntries(['data','rules','review','access','evidence'].map(k=>[k,string])),additionalProperties:false},
    reportEdits:{type:'object',properties:Object.fromEntries(['customTitle','action','goal','conditions','form','route','metric','trial'].map(k=>[k,string])),additionalProperties:false}},
  home_ai_value_estimate: {sessionId:string,expectedRevision:integer,stageId:string,
    numbers:{type:'object',properties:Object.fromEntries(['volume','before','after','coverage','hourly','cash','cost','setup'].map(k=>[k,{anyOf:[{type:'number',minimum:0,maximum:['coverage','cash'].includes(k)?100:1e9},{type:'string',enum:['']}]}])),additionalProperties:false},
    source:{type:'string',enum:['estimate','measured']},targetHours:{anyOf:[{type:'number',minimum:0,maximum:1e9},{type:'string',enum:['']}]}},
  home_ai_report_build:{sessionId:string,stageId:string},
  home_ai_materials_add:{sessionId:string,expectedRevision:integer,fileId:string},
  knowledge_search: { query: string, topK: integer },
  knowledge_read: { knowledgeBaseId: string, docId: string, offset: integer, limit: integer },
  knowledge_ocr: { artifactId: string, maxPages: integer },
  web_search: { query: string, count: integer, freshness: string,
    include: { type: 'array', items: string }, exclude: { type: 'array', items: string } },
  memory_recall: { query: string }, artifact_write: { fileName: string, content: string, mimeType: string },
  artifact_compose: { fileName: string, artifactIds: { type: 'array', items: string }, prefix: string, separator: string, suffix: string, mimeType: string },
  artifact_read: { artifactId: string }, local_read: { path: string, offset: integer, maxChars: integer },
  file_read: { fileId: string, offset: integer, maxChars: integer }, local_file_fetch: { fileId: string, artifactId: string },
  local_file_publish: { path: string, fileName: string },
  local_list: { path: string }, local_write: { fileName: string, content: string, path: string },
  local_code: { fileName: string, content: string, path: string },
  local_bat: { script: string, cwd: string, timeoutMs: integer },
  local_cli: { executable: string, args: { type: 'array', items: string }, cwd: string, timeoutMs: integer },
  local_ppt_doctor: {},
  local_ppt_build: { specJson: { type: 'string', description: '完整 DeckSpec JSON 字符串；必须有 cover 和语义块，禁止几何字段' }, fileName: string, render: { type: 'boolean', description: '默认 true，调用真实 PPTX 渲染器' } },
  local_ppt_inspect: { path: string, documentId: string },
  local_ppt_render: { path: string, documentId: string },
  local_route_matrix: {
    points: pointList,
    coordSystem: string, kind: string,
  },
  local_route_optimize: {
    routeName: string,
    points: pointList,
    coordSystem: string, strategy: string,
    distanceMatrix: matrixOfNumbers, timeMatrix: matrixOfNumbers, tollMatrix: matrixOfNumbers,
  },
  local_route_replan: {
    points: pointList,
    numRoutes: integer, algorithm: string, coordSystem: string,
  },
  local_route_map: {
    routeName: string,
    points: pointList,
    coordSystem: string,
    optimizedOrder: arrayOfIntegers, originalOrder: arrayOfIntegers,
    strategy: string, distanceKm: { type: 'number' }, savedPercent: { type: 'number' },
  },
  local_business_metrics: {},
  local_business_goal_decompose: { year: integer, half: { type: 'string', enum: ['H1', 'H2'] } },
  local_business_deviation: { scope: { type: 'string', enum: ['all', 'revenue', 'h1', 'project'] } },
  local_business_plan: { type: { type: 'string', enum: ['company', 'department', 'all'] }, department: string, year: integer },
  local_business_ppt: { type: { type: 'string', enum: ['company', 'department'] }, department: string, fileName: string },
};
const required: Record<RuntimeSkillCode, string[]> = {
  home_ai_session_open:[],home_ai_interview_update:['sessionId','expectedRevision','answerId','answer'],
  home_ai_opportunity_discover:['sessionId'],home_ai_conditions_update:['sessionId','expectedRevision','stageId'],
  home_ai_value_estimate:['sessionId','expectedRevision','stageId','numbers'],home_ai_report_build:['sessionId','stageId'],
  home_ai_materials_add:['sessionId','expectedRevision','fileId'],
  knowledge_search: ['query'], knowledge_read: ['knowledgeBaseId','docId'], knowledge_ocr: ['artifactId'],
  web_search: ['query'], memory_recall: ['query'],
  artifact_write: ['fileName','content'], artifact_compose: ['fileName','artifactIds'], artifact_read: ['artifactId'], local_read: ['path'], local_list: ['path'],
  file_read: ['fileId'], local_file_fetch: [],
  local_file_publish: ['path'],
  local_write: ['fileName','content'], local_code: ['fileName','content'], local_bat: ['script'], local_cli: ['executable'],
  local_ppt_doctor: [], local_ppt_build: ['specJson'], local_ppt_inspect: [], local_ppt_render: [],
  local_route_matrix: ['points'], local_route_optimize: ['points'], local_route_replan: ['points', 'numRoutes'],
  local_route_map: ['points', 'optimizedOrder'],
  local_business_metrics: [], local_business_goal_decompose: [], local_business_deviation: [], local_business_plan: [], local_business_ppt: [],
};
export function agentTools(agent: RegisteredAgent) {
  return runtimeSkillCatalog.filter(s => agent.skills.includes(s.code) && (s.location === 'server' || agent.execution_location === 'local'))
    .map(s => ({ type: 'function', function: { name: s.code, description: s.description, parameters: { type: 'object', properties: properties[s.code], required: required[s.code], additionalProperties: false } } }));
}
export function parseToolArguments(name: string, raw: unknown): Record<string, unknown> {
  if (!(name in toolArguments)) throw new Error(`未知技能：${name}`);
  try { return toolArguments[name as RuntimeSkillCode].parse(raw); }
  catch(error) {
    if(name.startsWith('home_ai_')&&error instanceof z.ZodError) throw new Error(`诊断参数无效：${error.issues.map(issue=>`${issue.path.join('.')||'参数'}：${issue.message}`).join('；')}。请按工具参数格式修正；revision请重新读取会话获取。`,{cause:error});
    throw error;
  }
}
export class RuntimeTools {
  constructor(private readonly pool: Pool, private readonly accounts: AccountRepository, private readonly memory: ShortTermMemoryService, private readonly encryptionKey: string, private readonly objectStore?: ObjectStore) {}
  async knowledgeInfo(identityId:string, conversationId:string):Promise<unknown> {
    try { const targets = await resolveSearchTargets(this.pool, identityId, { conversationId });
      return targets?.libraries.length ? { libraries: targets.libraries.map(item => ({ id: item.id, name: item.name, scope: item.scope })) } : null; }
    catch { return null; }
  }
  async execute(name: string, raw: unknown, scope: { identityId: string; conversationId: string; agentId: string; toolCallId?: string }): Promise<unknown> {
    const args = parseToolArguments(name, raw);
    await requirePermission(this.pool, scope.identityId, homeAiWriteTools.has(name) || name === 'artifact_write' || name === 'artifact_compose' ? 'write'
      : name === 'knowledge_ocr' || name === 'web_search' ? 'execute' : 'read');
    if(name.startsWith('home_ai_')) return new HomeAiService(this.pool,this.objectStore).execute(name as HomeAiToolCode,args,scope);
    if (name === 'web_search') {
      const results = await createBochaClient({ apiKey: process.env.BOCHA_API_KEY ?? '' }).searchWeb({
        query: String(args.query), count: Number(args.count), freshness: String(args.freshness),
        include: args.include as string[] | undefined, exclude: args.exclude as string[] | undefined,
      });
      return { results, text: formatBochaSearchResults(results) };
    }
    if (name === 'memory_recall') return { memories: await this.memory.recall(scope, String(args.query)), longTermApplied: false };
    if (name === 'file_read') {
      const file = await accessibleFile(this.pool, scope.identityId, String(args.fileId));
      if (!file || file.conversation_id !== scope.conversationId) throw new Error('文件不存在或不属于当前群聊');
      const info = { fileId: file.id, name: file.name, contentType: file.content_type, sizeBytes: Number(file.size_bytes) };
      if (!/^text\//i.test(file.content_type ?? '') && !/\.(txt|md|csv|json|xml|html|log|js|ts|py|css)$/i.test(file.name)) return { ...info, binary: true, hint: '使用 local_file_fetch 下载到执行设备，再调用专用解析工具；read 不负责 OCR。' };
      if (Number(file.size_bytes) > 10_000_000) throw new Error('文本附件超过 10 MB，请下载后分段处理');
      const bytes = await this.objectStore?.get(file.storage_key);
      if (!bytes) throw new Error('文件对象不可用');
      const text = bytes.toString('utf8'), offset = Number(args.offset), limit = Number(args.maxChars);
      return { ...info, content: text.slice(offset, offset + limit), truncated: text.length > offset + limit };
    }
    if (name === 'artifact_read') {
      const artifact = await this.accounts.getArtifact(scope.identityId, String(args.artifactId));
      if (!artifact) throw new Error('成果不存在或当前身份无权访问');
      if (artifact.conversationId !== scope.conversationId) throw new Error('成果不属于当前群聊');
      if (artifact.storageKey && !this.objectStore) throw new Error('对象存储未配置');
      if (artifact.storageKey && this.objectStore) {
        const bytes = await this.objectStore.get(artifact.storageKey);
        if (!bytes) throw new Error('成果对象已被清理');
        if (artifact.contentEncoding === 'base64') return { id: artifact.id, name: artifact.name, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes, binary: true, storageKey: artifact.storageKey, hint: '二进制内容不进入模型上下文。PPTX 请使用 local_ppt_inspect 读取本地 documentId；PDF/PNG 可在成果抽屉查看。' };
        return { ...artifact, content: bytes.toString('utf8') };
      }
      if (artifact.contentEncoding === 'base64') return { id: artifact.id, name: artifact.name, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes, binary: true, hint: '二进制内容不进入模型上下文。PPTX 请使用 local_ppt_inspect 读取本地 documentId；PDF/PNG 可在成果抽屉查看。' };
      return artifact;
    }
    if (name === 'artifact_compose') {
      const parts: string[] = [];
      for (const id of args.artifactIds as string[]) {
        const artifact = await this.accounts.getArtifact(scope.identityId, id);
        if (!artifact || artifact.conversationId !== scope.conversationId || artifact.contentEncoding === 'base64')
          throw new Error('章节成果不存在、无权访问或不是文本文件');
        const content = artifact.storageKey ? await this.objectStore?.get(artifact.storageKey) : null;
        if (artifact.storageKey && !content) throw new Error('章节成果对象不可用');
        parts.push(content ? content.toString('utf8') : artifact.content);
      }
      const merged = String(args.prefix) + parts.join(String(args.separator)) + String(args.suffix);
      if (merged.length > 1_000_000) throw new Error('合并结果超过 100 万字符，请分批合并');
      return this.execute('artifact_write', { fileName: args.fileName, content: merged, mimeType: args.mimeType }, scope);
    }
    if (name === 'artifact_write') {
      const content = String(args.content);
      const checksum = createHash('sha256').update(content).digest('hex');
      const bytes = Buffer.from(content, 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const {rows} = await client.query(`INSERT INTO artifacts(identity_id,conversation_id,name,mime_type,content,size_bytes,checksum,tool_call_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tool_call_id) WHERE tool_call_id IS NOT NULL DO UPDATE SET tool_call_id=EXCLUDED.tool_call_id RETURNING *`,
        [scope.identityId,scope.conversationId,args.fileName,args.mimeType,content,bytes.byteLength,checksum,scope.toolCallId??null]);
        const artifact = rows[0];
        if (artifact.identity_id !== scope.identityId || artifact.conversation_id !== scope.conversationId) throw new Error('成果调用不属于当前身份或群聊');
        if (artifact.checksum !== checksum || artifact.name !== args.fileName || artifact.mime_type !== args.mimeType) throw new Error('同一工具调用不可覆盖已有成果');
        let storageKey: string | undefined = artifact.storage_key ?? undefined;
        if (this.objectStore && bytes.byteLength > 256 * 1024 && !storageKey) {
          storageKey = `artifacts/${scope.identityId}/${artifact.id}/content`;
          await this.objectStore.put(storageKey, bytes);
          await client.query("UPDATE artifacts SET storage_key=$2,storage_status='stored',content='' WHERE id=$1", [artifact.id, storageKey]);
        }
        await client.query('COMMIT');
        return { artifactId: artifact.id, fileName: artifact.name, sizeBytes: Number(artifact.size_bytes), checksum: artifact.checksum, stored: true, ...(storageKey ? { storageKey } : {}) };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    if (name === 'knowledge_ocr') {
      const artifact = await this.accounts.getArtifact(scope.identityId, String(args.artifactId));
      if (!artifact) throw new Error('成果不存在或当前身份无权访问');
      if (artifact.conversationId !== scope.conversationId) throw new Error('成果不属于当前群聊');
      if (artifact.mimeType !== 'application/pdf' || artifact.sizeBytes > 16 * 1024 * 1024)
        throw new Error('OCR 仅支持不超过 16 MiB 的 PDF 成果');
      const bytes = artifact.storageKey
        ? await this.objectStore?.get(artifact.storageKey)
        : Buffer.from(artifact.content, artifact.contentEncoding === 'base64' ? 'base64' : 'utf8');
      if (!bytes || bytes.length !== artifact.sizeBytes || bytes.subarray(0, 5).toString() !== '%PDF-')
        throw new Error('PDF 成果内容不可用或格式不正确');
      const form = new FormData();
      form.set('file', new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' }), artifact.name);
      form.set('display_name', artifact.name);
      form.set('max_pages', String(args.maxPages));
      const response = await knowledgeRequest(this.pool, scope.identityId, this.encryptionKey,
        '/v1/ocr', { method: 'POST', body: form });
      return z.object({ filename: z.string(), pages: z.number().int().nonnegative(),
        chars: z.number().int().nonnegative(), markdown: z.string().max(1_000_000) }).parse(response);
    }
    if (name === 'knowledge_read') {
      const library = await getAccessibleLibrary(this.pool, scope.identityId, String(args.knowledgeBaseId), 'read');
      const targets = await resolveSearchTargets(this.pool, scope.identityId, { conversationId: scope.conversationId });
      if (!library || !targets?.libraries.some(item => item.id === library.entry.id)) throw new Error('KNOWLEDGE_SCOPE_DENIED');
      const path = `/v1/documents/${encodeURIComponent(String(args.docId))}/content?knowledge_base_id=${library.entry.id}&para=${args.offset}&limit=${args.limit}`;
      const response = z.object({ permission_filtered: z.literal(true), knowledge_base_id: z.string().uuid(),
        doc_id: z.union([z.string(), z.number()]) }).passthrough().safeParse(
          await knowledgeRequest(this.pool, scope.identityId, this.encryptionKey, path));
      if (!response.success || response.data.knowledge_base_id !== library.entry.id || String(response.data.doc_id) !== String(args.docId))
        throw new Error('KNOWLEDGE_SCOPE_PROTOCOL');
      return response.data;
    }
    if (name === 'knowledge_search') {
      const search = scopedSearchInputSchema.parse({ conversationId: scope.conversationId,
        query: args.query, mode: 'hybrid', topK: args.topK });
      return searchScopedKnowledge(this.pool, scope.identityId, search, (_collection, payload) =>
        knowledgeRequest(this.pool, scope.identityId, this.encryptionKey, '/v1/search',
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
    }
    throw new Error('本地技能必须路由到已认证桌面设备');
  }
}
