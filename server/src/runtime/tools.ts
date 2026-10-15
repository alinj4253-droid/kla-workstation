import { loadConfig } from '../config.js';
import { createWeKnoraClient } from '../tools/weknora-client.js';
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
import { assertKnowledgeToolPolicy, isHomeAiDiagnosis, type KnowledgeToolScope } from './home-ai/knowledge-policy.js';
import { HomeAiSessionContext, type HomeAiContextScope } from './home-ai/session-context.js';
import type { HomeAiToolCode } from '@kla-workstation/contracts';

function defaultWeKnoraClient() {
  const config = loadConfig().weknora;
  return config ? createWeKnoraClient(config) : undefined;
}

const string = { type: 'string' }, integer = { type: 'integer' };
const matrixOfNumbers = { type: 'array', items: { type: 'array', items: { type: 'number' } } };
const arrayOfIntegers = { type: 'array', items: integer };
const pointList = { type: 'array', items: { type: 'object', properties: { name: string, lat: { type: 'number' }, lon: { type: 'number' } }, required: ['lat', 'lon'], additionalProperties: false } };
// 枚举参数显式列出合法值，引导模型传英文枚举而非「年报」等自然语言值
const periodTypeEnum = { type: 'string', enum: ['year', 'quarter', 'month'] };
const detailKindEnum = { type: 'string', enum: ['heatmap', 'category_yoy', 'shift', 'unit_category', 'unit_vs_avg'] };
const bizActionEnum = { type: 'string', enum: ['set', 'activate', 'remove', 'list'] };
const routeKindEnum = { type: 'string', enum: ['distance', 'toll'] };
const routeStrategyEnum = { type: 'string', enum: ['mileage', 'time', 'cost'] };
const routeAlgorithmEnum = { type: 'string', enum: ['balanced', 'kmeans'] };
const coordSystemEnum = { type: 'string', enum: ['gcj02', 'wgs84'] };
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
  weknora_search: { query: { type: 'string', minLength: 1, maxLength: 240 } },
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
    coordSystem: coordSystemEnum, kind: routeKindEnum,
  },
  local_route_optimize: {
    routeName: string,
    points: pointList,
    coordSystem: coordSystemEnum, strategy: routeStrategyEnum,
    distanceMatrix: matrixOfNumbers, timeMatrix: matrixOfNumbers, tollMatrix: matrixOfNumbers,
  },
  local_route_replan: {
    points: pointList,
    numRoutes: integer, algorithm: routeAlgorithmEnum, coordSystem: coordSystemEnum,
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
  local_waste_status: {},
  local_waste_report: {
    scope: string, periodType: periodTypeEnum,
    year: integer, quarter: integer, month: integer,
  },
  local_waste_detail: {
    kind: detailKindEnum, start: string, end: string,
    pStart: string, pEnd: string, unit: string,
  },
  local_biz_configure: {
    action: bizActionEnum, name: string,
    host: string, port: integer, user: string, password: string, database: string,
  },
  local_biz_schema: {},
  local_biz_query: {
    sql: string, maxRows: integer,
  },
  local_excel_doctor: {},
  local_excel_profile: {
    path: string, sheets: { type: 'array', items: string }, maxEnum: integer,
  },
  local_excel_validate: {
    path: string, sheet: string, sum: { type: 'array', items: string }, count: { type: 'boolean' },
    filterCol: string, filterExclude: string,
    reconcileDetail: string, reconcileDKeys: string, reconcileDValue: string,
    reconcileSummary: string, reconcileSKeys: string, reconcileSValue: string,
  },
  local_excel_report: {
    jsonPath: string, content: string, theme: { type: 'string', enum: ['light', 'dark'] }, fileName: string,
  },
};
const required: Record<RuntimeSkillCode, string[]> = {
  home_ai_session_open:[],home_ai_interview_update:['sessionId','expectedRevision','answerId','answer'],
  home_ai_opportunity_discover:['sessionId'],home_ai_conditions_update:['sessionId','expectedRevision','stageId'],
  home_ai_value_estimate:['sessionId','expectedRevision','stageId','numbers'],home_ai_report_build:['sessionId','stageId'],
  home_ai_materials_add:['sessionId','expectedRevision','fileId'],
  weknora_search: ['query'], knowledge_search: ['query'], knowledge_read: ['knowledgeBaseId','docId'], knowledge_ocr: ['artifactId'],
  web_search: ['query'], memory_recall: ['query'],
  artifact_write: ['fileName','content'], artifact_compose: ['fileName','artifactIds'], artifact_read: ['artifactId'], local_read: ['path'], local_list: ['path'],
  file_read: ['fileId'], local_file_fetch: [],
  local_file_publish: ['path'],
  local_write: ['fileName','content'], local_code: ['fileName','content'], local_bat: ['script'], local_cli: ['executable'],
  local_ppt_doctor: [], local_ppt_build: ['specJson'], local_ppt_inspect: [], local_ppt_render: [],
  local_route_matrix: ['points'], local_route_optimize: ['points'], local_route_replan: ['points', 'numRoutes'],
  local_route_map: ['points', 'optimizedOrder'],
  local_business_metrics: [], local_business_goal_decompose: [], local_business_deviation: [], local_business_plan: [], local_business_ppt: [],
  local_waste_status: [], local_waste_report: [], local_waste_detail: ['kind', 'start', 'end'],
  local_biz_configure: [], local_biz_schema: [], local_biz_query: ['sql'],
  local_excel_doctor: [], local_excel_profile: ['path'], local_excel_validate: ['path'], local_excel_report: [],
};
export function agentTools(agent: RegisteredAgent) {
  return runtimeSkillCatalog.filter(s => agent.skills.includes(s.code) && (s.location === 'server' || agent.execution_location === 'local'))
    .map(s => ({ type: 'function', function: { name: s.code, description: s.description, parameters: { type: 'object', properties: properties[s.code], required: required[s.code], additionalProperties: false } } }));
}
export function parseToolArguments(name: string, raw: unknown): Record<string, unknown> {
  if (!(name in toolArguments)) throw new Error(`未知技能：${name}`);
  try { return toolArguments[name as RuntimeSkillCode].parse(raw); }
  catch(error) {
    if(error instanceof z.ZodError) {
      // 参数错误转中文并附合法值，模型才能自纠重试（enum 类错误必须列出 options）
      const detail = error.issues.map(issue => {
        const path = issue.path.join('.') || '参数';
        const options = 'options' in issue && Array.isArray(issue.options) ? `（可选值：${(issue.options as string[]).join(' / ')}）` : '';
        return `${path}：${issue.message}${options}`;
      }).join('；');
      throw new Error(name.startsWith('home_ai_')
        ? `诊断参数无效：${detail}。请按工具参数格式修正；revision请重新读取会话获取。`
        : `工具参数无效：${detail}。请按工具参数格式修正后重试。`, { cause: error });
    }
    throw error;
  }
}
export class RuntimeTools {
  constructor(private readonly pool: Pool, private readonly accounts: AccountRepository, private readonly memory: ShortTermMemoryService, private readonly encryptionKey: string, private readonly objectStore?: ObjectStore, private readonly weknora: { search(query: string, signal?: AbortSignal): Promise<unknown> } | undefined = defaultWeKnoraClient()) {}
  private async assertArtifactAgentAccess(artifactId: string, agentId: string) {
    const row = (await this.pool.query('SELECT source_agent_id,agent_private FROM artifacts WHERE id=$1', [artifactId])).rows[0];
    if (!row || (row.agent_private && row.source_agent_id !== agentId)) throw new Error('诊断私有成果仅允许来源诊断智能体读取；协作请委派诊断智能体并使用受控交接。');
  }
  async knowledgeInfo(identityId:string, conversationId:string):Promise<unknown> {
    try { const targets = await resolveSearchTargets(this.pool, identityId, { conversationId });
      return targets?.libraries.length ? { libraries: targets.libraries.map(item => ({ id: item.id, name: item.name, scope: item.scope })) } : null; }
    catch { return null; }
  }
  async execute(name: string, raw: unknown, scope: KnowledgeToolScope & { signal?: AbortSignal }): Promise<unknown> {
    const args = parseToolArguments(name, raw);
    await assertKnowledgeToolPolicy(this.pool, name, scope, true);
    await requirePermission(this.pool, scope.identityId, homeAiWriteTools.has(name) || name === 'artifact_write' || name === 'artifact_compose' ? 'write'
      : name === 'knowledge_ocr' || name === 'web_search' ? 'execute' : 'read');
    const diagnostic = await isHomeAiDiagnosis(this.pool, scope.identityId, scope.agentId);
    const diagnosticContext = diagnostic ? new HomeAiSessionContext(this.pool) : null;
    if(diagnostic&&!scope.stepId)throw new Error('诊断工具缺少可信任务步骤，请通过平台执行机制继续当前诊断。');
    const diagnosticScope:HomeAiContextScope|null=diagnostic?{identityId:scope.identityId,conversationId:scope.conversationId,stepId:scope.stepId!,agentId:scope.agentId,runId:scope.runId}:null;
    const currentBinding=diagnosticContext&&diagnosticScope?await diagnosticContext.assertCurrent(diagnosticScope):null;
    if(diagnostic&&!currentBinding?.sessionId)throw new Error('尚未选择当前诊断，请在诊断核对面板选择历史诊断或新建空白诊断。');
    if(diagnosticContext&&diagnosticScope){
      if(name==='file_read'||name==='home_ai_materials_add'||(name==='local_file_fetch'&&args.fileId))await diagnosticContext.assertFile(diagnosticScope,String(args.fileId));
      if(name==='artifact_read'||name==='knowledge_ocr'||(name==='local_file_fetch'&&args.artifactId))await diagnosticContext.assertArtifact(diagnosticScope,String(args.artifactId));
      if(name==='artifact_compose')for(const id of args.artifactIds as string[])await diagnosticContext.assertArtifact(diagnosticScope,id);
    }
    if (name === 'weknora_search') {
      if (!this.weknora) throw new Error('WeKnora 服务未配置，请在工作站服务端配置独立地址、凭据及授权库范围。');
      return this.weknora.search(String(args.query), scope.signal);
    }
    if(name.startsWith('home_ai_')){
      const result=await new HomeAiService(this.pool,this.objectStore).execute(name as HomeAiToolCode,args,{...scope,bindingVersion:currentBinding?.bindingVersion});
      // Historical session summaries belong to the human picker, never the model context.
      if(name==='home_ai_session_open'&&result&&typeof result==='object')return Object.fromEntries(Object.entries(result).filter(([key])=>key!=='sessions'));
      return result;
    }
    if (name === 'web_search') {
      const results = await createBochaClient({ apiKey: process.env.BOCHA_API_KEY ?? '' }).searchWeb({
        query: String(args.query), count: Number(args.count), freshness: String(args.freshness),
        include: args.include as string[] | undefined, exclude: args.exclude as string[] | undefined,
      });
      return { results, text: formatBochaSearchResults(results) };
    }
    if (name === 'memory_recall') return { memories: diagnosticContext&&diagnosticScope?await diagnosticContext.recall(diagnosticScope,String(args.query)):await this.memory.recall(scope, String(args.query)), longTermApplied: false };
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
      await this.assertArtifactAgentAccess(artifact.id, scope.agentId);
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
        await this.assertArtifactAgentAccess(artifact.id, scope.agentId);
        const content = artifact.storageKey ? await this.objectStore?.get(artifact.storageKey) : null;
        if (artifact.storageKey && !content) throw new Error('章节成果对象不可用');
        parts.push(content ? content.toString('utf8') : artifact.content);
      }
      const merged = String(args.prefix) + parts.join(String(args.separator)) + String(args.suffix);
      if (merged.length > 1_000_000) throw new Error('合并结果超过 100 万字符，请分批合并');
      return this.execute('artifact_write', { fileName: args.fileName, content: merged, mimeType: args.mimeType }, scope);
    }
    if (name === 'artifact_write') {
      const agentPrivate = diagnostic;
      const content = String(args.content);
      const checksum = createHash('sha256').update(content).digest('hex');
      const bytes = Buffer.from(content, 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        if(diagnosticContext&&diagnosticScope)await diagnosticContext.assertCurrent(diagnosticScope,client);
        const {rows} = await client.query(`INSERT INTO artifacts(identity_id,conversation_id,name,mime_type,content,size_bytes,checksum,tool_call_id,source_agent_id,agent_private)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tool_call_id) WHERE tool_call_id IS NOT NULL DO UPDATE SET tool_call_id=EXCLUDED.tool_call_id RETURNING *`,
        [scope.identityId,scope.conversationId,args.fileName,args.mimeType,content,bytes.byteLength,checksum,scope.toolCallId??null,scope.agentId,agentPrivate]);
        const artifact = rows[0];
        if (artifact.identity_id !== scope.identityId || artifact.conversation_id !== scope.conversationId) throw new Error('成果调用不属于当前身份或群聊');
        if (artifact.checksum !== checksum || artifact.name !== args.fileName || artifact.mime_type !== args.mimeType) throw new Error('同一工具调用不可覆盖已有成果');
        let storageKey: string | undefined = artifact.storage_key ?? undefined;
        if (this.objectStore && bytes.byteLength > 256 * 1024 && !storageKey) {
          storageKey = `artifacts/${scope.identityId}/${artifact.id}/content`;
          await this.objectStore.put(storageKey, bytes);
          await client.query("UPDATE artifacts SET storage_key=$2,storage_status='stored',content='' WHERE id=$1", [artifact.id, storageKey]);
        }
        if(diagnosticContext&&diagnosticScope)await diagnosticContext.recordArtifact(diagnosticScope,artifact.id,client);
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
      await this.assertArtifactAgentAccess(artifact.id, scope.agentId);
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
