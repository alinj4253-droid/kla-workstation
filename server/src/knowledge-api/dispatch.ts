
import { z } from 'zod';
import { connectionInputSchema, jobInputSchema, serviceInputSchema, documentRequestSchema, searchRequestSchema, KNOWLEDGE_UPLOAD_NOTICE_VERSION, type UploadInput } from '@kla-workstation/contracts/knowledge';
import { acceptUploadConsent, assertService, configureConnection, loadConnection, publicConnection } from './config.js';
import { assertBoundResource, loadBindings, listSources, getBindings, verifyDocumentScope } from './documents.js';
import { submit, cancelUpload, abortUploads } from './process.js';
import { listJobs, getJob, cancelJob, deleteJobRecord } from './jobs.js';

import { abortRequests, jsonRequest, KnowledgeError } from './transport.js';
import { loadSubmissions, getUnconfirmed } from './submissions.js';
import { recoverSubmissions } from './recovery.js';
import { publicKnowledgeData } from './public-data.js';
import { readKnowledgeContent } from '../knowledge-b/api.js';
import { KnowledgeBFailure, type KnowledgeTransport } from '../knowledge-b/transport.js';

const collectionInput = serviceInputSchema.extend({ collection: z.string().trim().min(1).max(200) });

const uploadSchema = collectionInput.extend({ knowledgeBaseId: z.string().uuid(), clientUploadId: z.string().uuid(), name: z.string().min(1).max(255), mime: z.string().max(200), bytes: z.instanceof(ArrayBuffer),
  resourceScope: z.object({ organizationId: z.string().uuid().nullable(), projectId: z.string().uuid().nullable(), personalIdentityId: z.string().uuid().nullable() }) });
const contentSchema = serviceInputSchema.extend({
  endpoint: z.enum(['document', 'meta', 'content', 'slices', 'search']), docId: documentRequestSchema.shape.docId.optional(),
  para: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional(),
  search: searchRequestSchema.optional(),
});

import { currentScope } from './context.js';
const handlers = new Map<string, (owner: unknown, raw: unknown) => unknown>();
function register(name: string, work: (owner: unknown, raw: unknown) => unknown) { handlers.set(name, work); }
  register('getConnection', () => publicConnection());
  register('acceptUploadConsent', (_event, raw) => {
    const input = serviceInputSchema.extend({ noticeVersion: z.literal(KNOWLEDGE_UPLOAD_NOTICE_VERSION) }).parse(raw);
    return acceptUploadConsent(input.serviceInstanceId, input.noticeVersion);
  });
  register('configure', async (_owner, raw) => { const result = await configureConnection(connectionInputSchema.parse(raw)); abortUploads(currentScope().ownerNumber); abortRequests(currentScope().ownerNumber); return result; });
  register('health', (event, raw) => { const input = serviceInputSchema.parse(raw); return jsonRequest(currentScope().ownerNumber, input.serviceInstanceId, '/health', z.object({ status: z.string(), jobs_running: z.number().optional() })); });
  register('listSources', (event, raw) => { const input = collectionInput.parse(raw); const config = assertService(input.serviceInstanceId); if (input.collection !== config.collection) throw new KnowledgeError('CONFLICT', '目标集合已变更。'); return listSources(currentScope().ownerNumber, input.serviceInstanceId, input.collection, config.baseUrl, config.secretRef); });
  register('getBindings', (_event, raw) => { const input = collectionInput.parse(raw); const config = assertService(input.serviceInstanceId); if (input.collection !== config.collection) throw new KnowledgeError('CONFLICT', '目标集合已变更。'); return getBindings(input.serviceInstanceId, input.collection, config.baseUrl, config.secretRef); });
  register('getUnconfirmed', (_event, raw) => { const input = collectionInput.parse(raw); const config = assertService(input.serviceInstanceId); if (input.collection !== config.collection) throw new KnowledgeError('CONFLICT', '目标集合已变更。'); return getUnconfirmed(config.baseUrl, input.collection, config.secretRef); });
  register('submit', (event, raw) => submit(currentScope().ownerNumber, uploadSchema.parse(raw)));
  register('recoverSubmissions', (event, raw) => { const input = collectionInput.parse(raw); return recoverSubmissions(currentScope().ownerNumber, input.serviceInstanceId, input.collection); });
  register('cancelUpload', (event, raw) => cancelUpload(currentScope().ownerNumber, z.object({ clientUploadId: z.string().uuid() }).parse(raw).clientUploadId));
  register('listJobs', async (event, raw) => {
    const input = serviceInputSchema.parse(raw); const config = assertService(input.serviceInstanceId);
    const result = await listJobs(currentScope().ownerNumber, input.serviceInstanceId);
    const ids = new Set(getBindings(input.serviceInstanceId, config.collection, config.baseUrl, config.secretRef).map(binding => binding.jobId));
    const jobs = result.jobs.filter(job => ids.has(job.job_id));
    return { count: jobs.length, jobs };
  });
  register('getJob', (event, raw) => { const input = jobInputSchema.parse(raw); return getJob(currentScope().ownerNumber, input.serviceInstanceId, input.jobId); });
  register('cancelJob', (event, raw) => { const input = jobInputSchema.parse(raw); return cancelJob(currentScope().ownerNumber, input.serviceInstanceId, input.jobId); });
  register('deleteJobRecord', (event, raw) => { const input = jobInputSchema.parse(raw); return deleteJobRecord(currentScope().ownerNumber, input.serviceInstanceId, input.jobId); });
  // One privileged calling chain; B's endpoint validation runs after A's access checks.
  register('contentRequest', async (event, raw) => {
    const input = contentSchema.parse(raw);
    const config = assertService(input.serviceInstanceId);
    if (input.endpoint !== 'search') {
      if (!input.docId) throw new KnowledgeError('VALIDATION_FAILED', '缺少稳定文档引用。');
      try { assertBoundResource(input.serviceInstanceId, { docId: input.docId }); }
      catch (error) {
        // 只对「尚未确认归属」做实时补验：服务器上由其他端上传的文件不在本地绑定表，
        // 原先仅靠 listSources 的 2 分钟验证窗口放行，窗口一过读取就整片 403。
        // 这里按需向远端确认一次归属（确认属于当前集合才放行并延长缓存），
        // 其他错误（服务未配置等）原样抛出。
        if (!(error instanceof KnowledgeError) || error.code !== 'PERMISSION_DENIED' || error.details?.notSubmitted !== true) throw error;
        const verified = await verifyDocumentScope(currentScope().ownerNumber, input.serviceInstanceId, input.docId);
        if (!verified) throw error;
      }
    }
    const transport: KnowledgeTransport = async request => {
      const query = request.query ? `?${new URLSearchParams({ para: String(request.query.para), limit: String(request.query.limit) })}` : '';
      try {
        return await jsonRequest(currentScope().ownerNumber, input.serviceInstanceId, `${request.path}${query}`, z.unknown(),
          request.method === 'POST' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) } : {});
      } catch (error) {
        if (!(error instanceof KnowledgeError)) throw new KnowledgeBFailure('server');
        if (error.code === 'NOT_FOUND' && input.endpoint === 'slices') {
          try { await jsonRequest(currentScope().ownerNumber, input.serviceInstanceId, request.path.replace(/\/slices$/, ''), z.unknown()); }
          catch (detailError) {
            if (detailError instanceof KnowledgeError && detailError.code === 'NOT_FOUND') throw new KnowledgeBFailure('not_found');
            throw new KnowledgeBFailure('network');
          }
          throw new KnowledgeBFailure('slices_pending');
        }
        throw new KnowledgeBFailure(error.code === 'PERMISSION_DENIED' ? error.details?.status === 401 ? 'unauthorized' : 'forbidden'
          : error.code === 'NOT_FOUND' ? 'not_found' : error.code === 'VALIDATION_FAILED' ? 'validation'
          : error.code === 'RUN_CANCELLED' || error.code === 'CONFLICT' ? 'cancelled'
          : error.code === 'CHANNEL_CONNECTION_FAILED' ? 'network' : 'server');
      }
    };
    try { return await readKnowledgeContent(transport, { serviceInstanceId: input.serviceInstanceId, endpoint: input.endpoint,
      ...(input.docId !== undefined ? { docId: input.docId } : {}), ...(input.para !== undefined ? { para: input.para } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}), ...(input.search !== undefined ? { search: input.search } : {}),
    }, config.collection); }
    catch (error) {
      if (!(error instanceof KnowledgeBFailure)) throw error;
      throw new KnowledgeError(error.kind === 'forbidden' || error.kind === 'unauthorized' ? 'PERMISSION_DENIED'
        : error.kind === 'not_found' || error.kind === 'slices_pending' ? 'NOT_FOUND'
        : error.kind === 'validation' ? 'VALIDATION_FAILED' : error.kind === 'cancelled' ? 'RUN_CANCELLED' : 'KNOWLEDGE_INGEST_FAILED',
      '知识内容读取失败，请重试或检查服务权限。', ['network', 'timeout', 'server'].includes(error.kind), { kind: error.kind });
    }
  });
export async function initializeKnowledge() { await loadConnection(); await loadBindings(); await loadSubmissions(); }
export async function dispatchKnowledge(operation: string, raw: unknown) {
 const handler = handlers.get(operation); if (!handler) throw new KnowledgeError('NOT_FOUND', '未知知识库操作。');
 return publicKnowledgeData(await handler(null, raw));
}
