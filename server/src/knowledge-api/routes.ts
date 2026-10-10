import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { knowledgeCatalogSchema, initialKnowledgeCatalog, normalizeKnowledgeCatalog, uploadNameCheckSchema, uploadSliceNameKey, KNOWLEDGE_UPLOAD_LIMIT, jobInputSchema, jobSnapshotSchema, isTerminalJobState, type JobEvent } from '@kla-workstation/contracts/knowledge';
import type { AccountRepository } from '../repositories/types.js';
import { requirePermission } from '../auth/permission-service.js';
import { createScope, inScope, readStored, atomicStored, type KnowledgeStore } from './context.js';
import { initializeKnowledge, dispatchKnowledge } from './dispatch.js';
import { getJob, cancelJob, jobPath } from './jobs.js';
import { markJobRecordDeleted, storedBindings } from './documents.js';
import { assertService } from './config.js';
import { getUnconfirmed } from './submissions.js';
import { cancelUpload } from './process.js';
import { recoverSubmissions } from './recovery.js';
import { authorizeScopedJob, getScopedJob, readScopedDocument, resolveScopedLibrary, scopedCollectionSchema, scopedContentSchema, syncScopedSources, verifyScopedJob } from './scoped-resources.js';
import { publicKnowledgeData } from './public-data.js';
import { KnowledgeError, jsonRequest, withResponse } from './transport.js';
import { publicConnection } from './config.js';
import { createLibrary, disableLibrary, getAccessibleLibrary, libraryInputSchema, libraryUpdateSchema, listAccessibleLibraries, updateLibrary } from '../auth/knowledge-libraries.js';
import { scopedSearchInputSchema, searchScopedKnowledge } from '../auth/knowledge-search.js';
import { libraryStatistics, scopedLibraryStatistics } from './statistics.js';
import { serviceInputSchema } from '@kla-workstation/contracts/knowledge';

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
      const scope = createScope(identity.id, ++sequence, deps.store, deps.encryptionKey ?? '', deps.mock ? undefined : deps.pool);
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
          const body = scopedContentSchema.parse(input);
          if (body.endpoint !== 'search') return readScopedDocument(deps.pool, body);
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
        if (deps.pool && !deps.mock && ['listSources', 'getBindings'].includes(operation)) {
          const result = await syncScopedSources(deps.pool, scopedCollectionSchema.parse(input));
          return operation === 'getBindings' ? result.bindings : result;
        }
        if (deps.pool && !deps.mock && operation === 'checkUploadNames') {
          const body = uploadNameCheckSchema.extend({ knowledgeBaseId: z.string().uuid() }).parse(input);
          await resolveScopedLibrary(deps.pool, body, 'write');
          const result = await syncScopedSources(deps.pool, body);
          const existing = new Set(result.documents.map(doc => uploadSliceNameKey(doc.name)));
          for (const binding of result.bindings) existing.add(uploadSliceNameKey(binding.displayName));
          const config = assertService(body.serviceInstanceId);
          for (const pending of getUnconfirmed(config.baseUrl, body.collection, config.secretRef)) {
            if (pending.knowledgeBaseId === body.knowledgeBaseId) existing.add(uploadSliceNameKey(pending.displayName));
          }
          return { conflicts: body.names.filter(name => existing.has(uploadSliceNameKey(name))) };
        }
        if (deps.pool && !deps.mock && ['getUnconfirmed', 'recoverSubmissions'].includes(operation)) {
          const body = scopedCollectionSchema.parse(input);
          const library = await resolveScopedLibrary(deps.pool, body, operation === 'recoverSubmissions' ? 'write' : 'read');
          if (operation === 'recoverSubmissions') return recoverSubmissions(scope.ownerNumber, body.serviceInstanceId, body.collection, library.entry.id);
          const config = assertService(body.serviceInstanceId);
          return getUnconfirmed(config.baseUrl, body.collection, config.secretRef).filter(record => record.knowledgeBaseId === library.entry.id);
        }
        if (deps.pool && !deps.mock && operation === 'listJobs') {
          const { serviceInstanceId } = serviceInputSchema.parse(input);
          const config = assertService(serviceInstanceId);
          const jobs = [];
          for (const binding of storedBindings(serviceInstanceId, config.collection).filter(item => !item.taskRecordDeletedAt)) {
            try { jobs.push((await getScopedJob(deps.pool, serviceInstanceId, binding.jobId)).snapshot); }
            catch (error) { if (!(error instanceof KnowledgeError) || error.code !== 'PERMISSION_DENIED') throw error; }
          }
          return publicKnowledgeData({ count: jobs.length, jobs });
        }
        if (deps.pool && !deps.mock && ['getJob', 'cancelJob', 'deleteJobRecord'].includes(operation)) {
          const body = jobInputSchema.parse(input);
          const action = operation === 'getJob' ? 'read' : 'write';
          const { binding, snapshot } = await getScopedJob(deps.pool, body.serviceInstanceId, body.jobId, action);
          if (operation === 'getJob') return publicKnowledgeData(snapshot);
          if (operation === 'cancelJob') {
            const cancelled = await cancelJob(scope.ownerNumber, body.serviceInstanceId, body.jobId);
            return publicKnowledgeData(await verifyScopedJob(deps.pool, body.serviceInstanceId, binding, cancelled, 'write'));
          }
          if (!isTerminalJobState(snapshot.state)) throw new KnowledgeError('CONFLICT', '任务仍在排队或处理中，请等待结束后删除记录。');
          return markJobRecordDeleted(body.serviceInstanceId, body.jobId);
        }
        if (deps.pool && !deps.mock && operation === 'cancelUpload') {
          const { clientUploadId } = z.object({ clientUploadId: z.string().uuid() }).parse(input);
          const record = (await deps.pool.query<{ knowledge_base_id: string }>(
            'SELECT knowledge_base_id FROM knowledge_uploads WHERE client_upload_id=$1 AND uploader_identity_id=$2', [clientUploadId, scope.owner])).rows[0];
          if (!record || !(await getAccessibleLibrary(deps.pool, scope.owner, record.knowledge_base_id, 'write')))
            throw new KnowledgeError('PERMISSION_DENIED', '当前身份无权取消该上传。');
          return cancelUpload(scope.ownerNumber, clientUploadId);
        }
        return dispatchKnowledge(operation, input ?? {});
      });
      return reply.send({ ok: true, data, meta: { requestId: request.id } });
    } catch (error) { return fail(error, request, reply); }
  });
  app.get('/api/v1/knowledge-library/job-events', async (request, reply) => {
    try {
      const scope = await auth(request, reply, false); if (!scope) return;
      const input = jobInputSchema.extend({ subscriptionId: z.string().min(1).max(100) }).parse(request.query);
      const binding = deps.pool && !deps.mock
        ? await inScope(scope, () => authorizeScopedJob(deps.pool!, input.serviceInstanceId, input.jobId)) : undefined;
      const first = await inScope(scope, async () => {
        const snapshot = await getJob(scope.ownerNumber, input.serviceInstanceId, input.jobId);
        return binding ? verifyScopedJob(deps.pool!, input.serviceInstanceId, binding, snapshot) : snapshot;
      });
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
                  if (binding) await verifyScopedJob(deps.pool!, input.serviceInstanceId, binding, snapshot);
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
