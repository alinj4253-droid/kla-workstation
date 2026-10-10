import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { knowledgeCatalogSchema, initialKnowledgeCatalog, normalizeKnowledgeCatalog, documentListSchema, uploadNameCheckSchema, uploadSliceNameKey, KNOWLEDGE_UPLOAD_LIMIT, jobInputSchema, jobSnapshotSchema, isTerminalJobState, type JobEvent } from '@kla-workstation/contracts/knowledge';
import { documentContentSchema, documentDetailSchema, documentMetaSchema, documentSlicesSchema } from '@kla-workstation/contracts/knowledge';
import type { AccountRepository } from '../repositories/types.js';
import { requirePermission } from '../auth/permission-service.js';
import { createScope, inScope, readStored, atomicStored, type KnowledgeStore } from './context.js';
import { initializeKnowledge, dispatchKnowledge } from './dispatch.js';
import { getJob, jobPath } from './jobs.js';
import { publicKnowledgeData } from './public-data.js';
import { KnowledgeError, jsonRequest, withResponse } from './transport.js';
import { publicConnection } from './config.js';
import { createLibrary, disableLibrary, findReadableLibraryByDocId, getAccessibleLibrary, libraryInputSchema, libraryUpdateSchema, listAccessibleLibraries, updateLibrary } from '../auth/knowledge-libraries.js';
import { scopedSearchInputSchema, searchScopedKnowledge } from '../auth/knowledge-search.js';
import { libraryStatistics, scopedLibraryStatistics } from './statistics.js';
import { serviceInputSchema } from '@kla-workstation/contracts/knowledge';

/** 读取类端点 → 远端路径后缀（''表示直接是 /v1/documents/{id}）与前端契约校验。 */
const READ_ENDPOINTS = {
  document: { suffix: '', schema: documentDetailSchema },
  meta: { suffix: 'meta', schema: documentMetaSchema },
  content: { suffix: 'content', schema: documentContentSchema },
  slices: { suffix: 'slices', schema: documentSlicesSchema },
} as const;
type ReadEndpoint = keyof typeof READ_ENDPOINTS;

interface ReadRequestBody { endpoint: string; serviceInstanceId: string; docId?: unknown; para?: unknown; limit?: unknown }

/**
 * 读取单个文档的授权读取：详情 / 元信息 / 正文 / 切片。
 *
 * 三道关，缺一不可：
 *  ① 文档须有归属记录，且所属库当前身份可读（findReadableLibraryByDocId 内部按 access() 判权）
 *  ② 远端响应里的 knowledge_base_id 必须与该文档所属库一致 —— 防止上游返回别的库的内容
 *  ③ 归属缺失按未授权处理（fail-closed），不「查不到就放行」
 *
 * 响应必须经前端契约 schema 校验再返回：远端会带 slices_path / knowledge_base_id 等
 * 服务端专有字段，直接透传会让前端的 documentSlicesSchema 校验失败（表现为
 * 「知识切片加载失败」这种无信息量的报错），schema.parse 同时起到白名单裁剪作用。
 *
 * 此前 contentRequest 只放行 search，读取类端点一律 403，界面读不到任何切片；此处补齐。
 */
async function readAuthorizedDocument(pool: Pool, ownerNumber: number, identityId: string, body: ReadRequestBody) {
  const endpoint = body.endpoint as ReadEndpoint;
  if (!(endpoint in READ_ENDPOINTS)) throw new KnowledgeError('PERMISSION_DENIED', '文档归属尚未由知识服务验证，暂不可读取。');
  const docId = typeof body.docId === 'string' ? body.docId.trim() : '';
  if (!docId) throw new KnowledgeError('VALIDATION_FAILED', '缺少文档 ID。');
  const library = await findReadableLibraryByDocId(pool, identityId, docId);
  if (!library) throw new KnowledgeError('PERMISSION_DENIED', '当前身份无权读取该文档。');

  const target = READ_ENDPOINTS[endpoint];
  const path = `/v1/documents/${encodeURIComponent(docId)}${target.suffix ? `/${target.suffix}` : ''}`;
  const query = new URLSearchParams({ knowledge_base_id: library.entry.id });
  const init: RequestInit = endpoint === 'content'
    ? { headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ para: Number(body.para ?? 0), limit: Number(body.limit ?? 20) }) }
    : {};
  // 先按宽松结构取回以核对归属，再交给契约 schema 校验裁剪字段
  const raw = await jsonRequest<Record<string, unknown>>(ownerNumber, body.serviceInstanceId, `${path}?${query}`,
    z.record(z.string(), z.unknown()), init);
  const declared = raw.knowledge_base_id;
  if (declared !== undefined && declared !== library.entry.id)
    throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回了其他知识库的内容。');
  const parsed = target.schema.safeParse(raw);
  if (!parsed.success)
    throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回的内容与约定不一致，请确认部署版本。');
  return parsed.data;
}

export async function registerKnowledgeRoutes(app: FastifyInstance, deps: { accounts: AccountRepository; store: KnowledgeStore; pool?: Pool; encryptionKey?: string; mock?: boolean }) {
  const sessions = new Map<string, { scope: ReturnType<typeof createScope>; initialized: Promise<void> }>();
  let sequence = 0;
  const auth = async (request: FastifyRequest, reply: FastifyReply, write: boolean) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const session = await deps.accounts.getSession(token);
    if (!session) { reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录。', retryable: false }, meta: { requestId: request.id } }); return; }
    const identities = await deps.accounts.listIdentities(session.userId);
    const requested = request.headers['x-identity-id'];
    const identity = typeof requested === 'string' ? identities.find(item => item.id === requested && item.status === 'active') : identities.find(item => item.isDefault && item.status === 'active') ?? identities.find(item => item.status === 'active');
    if (!identity) { reply.code(403).send({ ok: false, error: { code: 'PERMISSION_DENIED', message: '当前身份不可用。', retryable: false } }); return; }
    if (deps.pool && !deps.mock) {
      try { await requirePermission(deps.pool, identity.id, write ? 'write' : 'read'); }
      catch { reply.code(403).send({ ok: false, error: { code: 'PERMISSION_DENIED', message: '当前身份没有知识库操作权限。', retryable: false } }); return; }
    }
    let entry = sessions.get(identity.id);
    if (!entry) {
      const scope = createScope(identity.id, ++sequence, deps.store, deps.encryptionKey ?? '');
      entry = { scope, initialized: inScope(scope, initializeKnowledge) };
      sessions.set(identity.id, entry);
      entry.initialized.catch(() => sessions.delete(identity.id));
    }
    await entry.initialized;
    return entry.scope;
  };
  const fail = (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const mapped = error instanceof KnowledgeError ? error : error instanceof z.ZodError ? new KnowledgeError('VALIDATION_FAILED', '请求参数不正确。') : new KnowledgeError('INTERNAL_ERROR', '知识库操作失败，请刷新后确认结果。');
    const status = mapped.code === 'PERMISSION_DENIED' ? 403 : mapped.code === 'NOT_FOUND' ? 404 : mapped.code === 'CONFLICT' ? 409 : mapped.code === 'VALIDATION_FAILED' ? 400 : 502;
    return reply.code(status).send({ ok: false, error: { code: mapped.code, message: mapped.message, retryable: mapped.retryable, details: mapped.details }, meta: { requestId: request.id } });
  };
  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: KNOWLEDGE_UPLOAD_LIMIT }, (_request, body, done) => done(null, body));
  }
  const reads = new Set(['getConnection', 'health', 'listSources', 'getBindings', 'getUnconfirmed', 'listJobs', 'getJob', 'contentRequest', 'getCatalog', 'getStatistics', 'checkUploadNames']);
  app.post('/api/v1/knowledge-library/:operation', { bodyLimit: KNOWLEDGE_UPLOAD_LIMIT }, async (request, reply) => {
    try {
      const operation = (request.params as { operation: string }).operation;
      const scope = await auth(request, reply, !reads.has(operation)); if (!scope) return;
      const data = await inScope(scope, async () => {
        if (operation === 'getCatalog') {
          if (deps.pool && !deps.mock) return listAccessibleLibraries(deps.pool, scope.owner);
          let entries;
          try { entries = knowledgeCatalogSchema.parse(await readStored('catalog.json')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await atomicStored('catalog.json', initialKnowledgeCatalog); return initialKnowledgeCatalog; }
          // 集合名规范化：存量目录里的旧集合名自动升级并回写（拉代码重启即生效）
          const normalized = normalizeKnowledgeCatalog(entries);
          if (normalized.changed) { await atomicStored('catalog.json', normalized.entries); console.log('[knowledge] catalog 集合名已自动升级为当前约定名'); }
          return normalized.entries;
        }
        if (operation === 'getStatistics') {
          const input = serviceInputSchema.parse(request.body);
          if (deps.pool && !deps.mock) {
            const entries = await listAccessibleLibraries(deps.pool, scope.owner);
            return scopedLibraryStatistics(scope.ownerNumber, input.serviceInstanceId, entries);
          }
          let entries;
          try { entries = knowledgeCatalogSchema.parse(await readStored('catalog.json')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entries = initialKnowledgeCatalog; }
          return libraryStatistics(scope.ownerNumber, input.serviceInstanceId, normalizeKnowledgeCatalog(entries).entries);
        }
        if (operation === 'saveCatalog') {
          if (deps.pool && !deps.mock) throw new KnowledgeError('PERMISSION_DENIED', '请使用知识库创建和编辑接口。');
          const entries = normalizeKnowledgeCatalog(knowledgeCatalogSchema.parse(request.body)).entries;
          await atomicStored('catalog.json', entries); return entries;
        }
        if (deps.pool && !deps.mock && operation === 'createLibrary') {
          const created = await createLibrary(deps.pool, scope.owner, libraryInputSchema.parse(request.body));
          if (!created) throw new KnowledgeError('PERMISSION_DENIED', '当前身份无权创建该知识库。');
          return created;
        }
        if (deps.pool && !deps.mock && operation === 'updateLibrary') {
          const updated = await updateLibrary(deps.pool, scope.owner, libraryUpdateSchema.parse(request.body));
          if (!updated) throw new KnowledgeError('PERMISSION_DENIED', '当前身份无权修改该知识库。');
          return updated;
        }
        if (deps.pool && !deps.mock && operation === 'deleteLibrary') {
          const { id } = z.object({ id: z.string().uuid() }).parse(request.body);
          if (!(await disableLibrary(deps.pool, scope.owner, id))) throw new KnowledgeError('PERMISSION_DENIED', '当前身份无权停用该知识库。');
          return true;
        }
        let input = request.body;
        if (operation === 'submit') {
          if (!Buffer.isBuffer(request.body)) throw new KnowledgeError('VALIDATION_FAILED', '上传必须为原始文件内容。');
          const query = request.query as Record<string, string>;
          input = { ...query, bytes: Uint8Array.from(request.body).buffer };
          if (!deps.pool || deps.mock) throw new KnowledgeError('PERMISSION_DENIED', '知识库权限服务尚未就绪。');
          const { knowledgeBaseId, collection } = z.object({ knowledgeBaseId: z.string().uuid(), collection: z.string().min(1) }).parse(query);
          const library = await getAccessibleLibrary(deps.pool, scope.owner, knowledgeBaseId, 'write');
          if (!library) throw new KnowledgeError('PERMISSION_DENIED', '当前身份无权向该知识库上传。');
          if (library.entry.collection !== collection) throw new KnowledgeError('CONFLICT', '目标知识库集合已变更。');
          input = { ...query, bytes: Uint8Array.from(request.body).buffer, resourceScope: library.scope };
        }
        if (deps.pool && !deps.mock && operation === 'contentRequest') {
          const body = z.object({ serviceInstanceId: z.string(), endpoint: z.string(), knowledgeBaseId: z.string().uuid().optional(),
            search: z.object({ query: z.string(), mode: z.enum(['hybrid', 'vector', 'keyword']), top_k: z.number().int(),
              expand: z.number().int().optional(), fold_adjacent: z.boolean().optional() }).optional() }).parse(input);
          if (body.endpoint !== 'search') {
            // 读取类端点（切片/正文/元信息）前端只带 docId，必须先反查该文档所属库并判权，
            // 再向远端取数并复核归属——不能因为知道一个 docId 就放行。
            return readAuthorizedDocument(deps.pool, scope.ownerNumber, scope.owner, body);
          }
          if (!body.knowledgeBaseId || !body.search) {
            throw new KnowledgeError('PERMISSION_DENIED', '检索需要指定知识库或群聊上下文。');
          }
          const search = scopedSearchInputSchema.parse({ knowledgeBaseId: body.knowledgeBaseId,
            query: body.search.query, mode: body.search.mode, topK: body.search.top_k,
            expand: body.search.expand, foldAdjacent: body.search.fold_adjacent });
          return searchScopedKnowledge(deps.pool, scope.owner, search, (_collection, payload) =>
            jsonRequest(scope.ownerNumber, body.serviceInstanceId, '/v1/search', z.unknown(),
              { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
        }
        if (deps.pool && !deps.mock && operation === 'listSources') {
          const body = z.object({ serviceInstanceId: z.string(), collection: z.string(), knowledgeBaseId: z.string().uuid() }).parse(input);
          const library = await getAccessibleLibrary(deps.pool, scope.owner, body.knowledgeBaseId, 'read');
          if (!library) throw new KnowledgeError('PERMISSION_DENIED', '当前身份无权查看该知识库。');
          if (library.entry.collection !== body.collection) throw new KnowledgeError('CONFLICT', '目标知识库集合已变更。');
          const upstreamSchema = documentListSchema.extend({ permission_filtered: z.literal(true),
            documents: z.array(documentListSchema.shape.documents.element.extend({ knowledge_base_id: z.string().uuid() })) });
          const result = await jsonRequest(scope.ownerNumber, body.serviceInstanceId,
            `/v1/documents?knowledge_base_id=${encodeURIComponent(body.knowledgeBaseId)}`, upstreamSchema);
          if (result.documents.some(doc => doc.knowledge_base_id !== body.knowledgeBaseId))
            throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回了其他知识库的文档。');
          return { documents: result.documents.map(({ abs_path: _path, knowledge_base_id: _id, ...doc }) => doc),
            bindings: [], totalWorkspaceCount: result.count, verifiedServerDocIds: result.documents.map(doc => doc.doc_id), unclassifiedCount: 0 };
        }
        if (deps.pool && !deps.mock && operation === 'checkUploadNames') {
          const body = uploadNameCheckSchema.extend({ knowledgeBaseId: z.string().uuid() }).parse(input);
          const library = await getAccessibleLibrary(deps.pool, scope.owner, body.knowledgeBaseId, 'write');
          if (!library) throw new KnowledgeError('PERMISSION_DENIED', '当前身份无权向该知识库上传。');
          if (library.entry.collection !== body.collection) throw new KnowledgeError('CONFLICT', '目标知识库集合已变更。');
          const upstreamSchema = documentListSchema.extend({ permission_filtered: z.literal(true),
            documents: z.array(documentListSchema.shape.documents.element.extend({ knowledge_base_id: z.string().uuid() })) });
          const result = await jsonRequest(scope.ownerNumber, body.serviceInstanceId,
            `/v1/documents?knowledge_base_id=${encodeURIComponent(body.knowledgeBaseId)}`, upstreamSchema);
          if (result.count !== result.documents.length || result.documents.some(doc => doc.knowledge_base_id !== body.knowledgeBaseId))
            throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回的文件范围不完整或不属于当前知识库。');
          const existing = new Set(result.documents.map(doc => uploadSliceNameKey(doc.name)));
          return { conflicts: body.names.filter(name => existing.has(uploadSliceNameKey(name))) };
        }
        if (deps.pool && !deps.mock && operation === 'getBindings') return [];
        if (deps.pool && !deps.mock && operation === 'getUnconfirmed') return [];
        if (deps.pool && !deps.mock && operation === 'listJobs') return { count: 0, jobs: [] };
        if (deps.pool && !deps.mock && ['recoverSubmissions', 'getJob', 'cancelJob', 'deleteJobRecord', 'cancelUpload'].includes(operation)) {
          throw new KnowledgeError('PERMISSION_DENIED', '任务归属尚未由知识服务验证，暂不可读取或操作。');
        }
        return dispatchKnowledge(operation, input ?? {});
      });
      return reply.send({ ok: true, data, meta: { requestId: request.id } });
    } catch (error) { return fail(error, request, reply); }
  });
  app.get('/api/v1/knowledge-library/job-events', async (request, reply) => {
    try {
      const scope = await auth(request, reply, false); if (!scope) return;
      if (deps.pool && !deps.mock) throw new KnowledgeError('PERMISSION_DENIED', '任务归属尚未由知识服务验证。');
      const input = jobInputSchema.extend({ subscriptionId: z.string().min(1).max(100) }).parse(request.query);
      const first = await inScope(scope, () => getJob(scope.ownerNumber, input.serviceInstanceId, input.jobId));
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': request.headers.origin ?? '*' });
      const send = (event: JobEvent) => { if (!reply.raw.destroyed) reply.raw.write('data: ' + JSON.stringify(publicKnowledgeData(event)) + '\n\n'); };
      send({ ...input, snapshot: first });
      let closed = false;
      const controller = new AbortController();
      reply.raw.once('close', () => { closed = true; controller.abort(); });
      if (isTerminalJobState(first.state)) { reply.raw.end(); return; }
      await inScope(scope, async () => {
        try {
          await withResponse(scope.ownerNumber, input.serviceInstanceId, jobPath(input.jobId) + '/events', {}, async response => {
            const reader = response.body?.getReader(); if (!reader) throw new Error('Missing job stream');
            const decoder = new TextDecoder(); let buffer = ''; let terminal = false;
            try {
              while (!controller.signal.aborted && !terminal) {
                const part = await reader.read(); if (part.done) break;
                buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, '\n');
                if (buffer.length > 1024 * 1024) throw new Error('Event too large');
                let end: number;
                while ((end = buffer.indexOf('\n\n')) !== -1) {
                  const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
                  const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                  if (!data) continue;
                  const snapshot = jobSnapshotSchema.parse(JSON.parse(data));
                  if (snapshot.job_id !== input.jobId) throw new Error('Mismatched job event');
                  send({ ...input, snapshot });
                  if (isTerminalJobState(snapshot.state)) { terminal = true; break; }
                }
              }
              if (!terminal && !closed) send({ ...input, disconnected: true });
            } finally { await reader.cancel().catch(() => undefined); }
          }, controller);
        } catch { if (!closed) send({ ...input, disconnected: true }); }
        finally { if (!closed) reply.raw.end(); }
      });
    } catch (error) { return fail(error, request, reply); }
  });
}
