import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { knowledgeCatalogSchema, initialKnowledgeCatalog, KNOWLEDGE_UPLOAD_LIMIT, jobInputSchema, jobSnapshotSchema, isTerminalJobState, type JobEvent } from '@kla-workstation/contracts/knowledge';
import type { AccountRepository } from '../repositories/types.js';
import { requirePermission } from '../auth/permission-service.js';
import { createScope, inScope, readStored, atomicStored, type KnowledgeStore } from './context.js';
import { initializeKnowledge, dispatchKnowledge } from './dispatch.js';
import { getJob, jobPath } from './jobs.js';
import { publicKnowledgeData } from './public-data.js';
import { KnowledgeError, withResponse } from './transport.js';
import { publicConnection } from './config.js';
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
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: KNOWLEDGE_UPLOAD_LIMIT }, (_request, body, done) => done(null, body));
  const reads = new Set(['getConnection', 'health', 'listSources', 'getBindings', 'getUnconfirmed', 'listJobs', 'getJob', 'contentRequest', 'getCatalog']);
  app.post('/api/v1/knowledge-library/:operation', { bodyLimit: KNOWLEDGE_UPLOAD_LIMIT }, async (request, reply) => {
    try {
      const operation = (request.params as { operation: string }).operation;
      const scope = await auth(request, reply, !reads.has(operation)); if (!scope) return;
      const data = await inScope(scope, async () => {
        if (operation === 'getCatalog') {
          try { return knowledgeCatalogSchema.parse(await readStored('catalog.json')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await atomicStored('catalog.json', initialKnowledgeCatalog); return initialKnowledgeCatalog; }
        }
        if (operation === 'saveCatalog') {
          const entries = knowledgeCatalogSchema.parse(request.body);
          await atomicStored('catalog.json', entries); return entries;
        }
        let input = request.body;
        if (operation === 'submit') {
          if (!Buffer.isBuffer(request.body)) throw new KnowledgeError('VALIDATION_FAILED', '上传必须为原始文件内容。');
          const query = request.query as Record<string, string>;
          input = { ...query, bytes: Uint8Array.from(request.body).buffer };
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
