import Fastify from 'fastify';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE_UPLOAD_NOTICE_VERSION } from '@kla-workstation/contracts/knowledge';
import type { AccountRepository } from '../repositories/types.js';
import { registerKnowledgeRoutes } from './routes.js';
import { createScope, inScope, MemoryKnowledgeStore } from './context.js';
import { acceptUploadConsent, configureConnection, serviceUrl } from './config.js';
import { saveBinding } from './documents.js';
import { beginSubmission } from './submissions.js';

const owner = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const libraryId = '20000000-0000-4000-8000-000000000001';
const otherLibraryId = '20000000-0000-4000-8000-000000000002';
const clientId = '30000000-0000-4000-8000-000000000001';
const collection = 'shared-collection';
const physicalName = 'upload-40000000-0000-4000-8000-000000000001.pdf';
const storedPath = '/private/uploads/' + physicalName;
const docId = 'document/id+with=encoding';
const jobId = 'job-owned';
const doc = { doc_id: docId, knowledge_base_id: libraryId, name: physicalName, ext: 'pdf', category: '上传文档',
  size: 100, modified: '2026-10-10T10:00:00Z', readable: true, stale: false, abs_path: storedPath };
const job = { job_id: jobId, type: 'process', filename: physicalName, params: { collection, ingest: true },
  state: 'done', stage: 'ingest', created_at: '2026-10-10T10:00:00Z', updated_at: '2026-10-10T10:01:00Z',
  artifacts: { slices_path: '/private/slices.json', ingest: { collection, chunks: 1 } } };
const slices = { doc_id: docId, knowledge_base_id: libraryId, collection, source: physicalName, count: 1,
  slices: [{ id: 0, title: '标题', content: '内容' }], slices_path: '/private/slices.json' };

let fixture: Awaited<ReturnType<typeof setup>>;
let upstreamDocs: Array<typeof doc>;
let snapshot: typeof job;
let pending: boolean;
let permissions: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

async function setup(legacyBinding = true) {
  const store = new MemoryKnowledgeStore();
  const scope = createScope(owner, 1, store, 'test-key');
  const connection = await inScope(scope, async () => {
    const config = await configureConnection({ baseUrl: serviceUrl, collection, clearCredential: true });
    await acceptUploadConsent(config.serviceInstanceId, KNOWLEDGE_UPLOAD_NOTICE_VERSION);
    if (legacyBinding) await saveBinding({ clientUploadId: clientId, displayName: '制度.pdf', physicalName,
      serviceInstanceId: config.serviceInstanceId, serverOrigin: config.baseUrl, collection, credentialRef: null,
      jobId, storedPath, submittedAt: '2026-10-10T10:00:00Z' });
    return config;
  });
  const documents = new Map<string, { knowledge_base_id: string; chunk_count: number }>();
  const uploads: unknown[][] = [];
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('FROM knowledge_bases WHERE id')) return { rows: [{ id: args[0], name: '知识库', description: '', collection,
      scope: 'personal', organization_id: null, project_id: null, owner_identity_id: args[0] === libraryId ? owner : other,
      status: 'active', updated_at: '2026-10-10T10:00:00Z' }] };
    if (sql.includes('SELECT k.* FROM knowledge_bases')) return { rows: [{ id: libraryId, name: '知识库', description: '', collection,
      scope: 'personal', organization_id: null, project_id: null, owner_identity_id: owner, status: 'active', updated_at: '2026-10-10T10:00:00Z' }] };
    if (sql.includes('SELECT i.type,i.organization_id')) return { rows: [{ type: 'personal', organization_id: null }] };
    if (sql.includes('INSERT INTO knowledge_documents')) {
      const previous = documents.get(String(args[0]));
      if (previous && previous.knowledge_base_id !== args[1]) return { rows: [] };
      const value = { knowledge_base_id: String(args[1]), chunk_count: previous?.chunk_count ?? 0 };
      documents.set(String(args[0]), value);
      return { rows: [value] };
    }
    if (sql.includes('SELECT knowledge_base_id FROM knowledge_documents')) return { rows: documents.has(String(args[0])) ? [documents.get(String(args[0]))] : [] };
    if (sql.includes('UPDATE knowledge_documents SET chunk_count')) {
      documents.get(String(args[0]))!.chunk_count = Number(args[2]);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO knowledge_uploads')) { uploads.push(args); return { rows: [{ id: 'upload-row' }] }; }
    return { rows: [] };
  });
  const pool = { query, connect: async () => ({ query, release: vi.fn() }), hasPermission: () => permissions } as unknown as Pool;
  const accounts = {
    getSession: async () => ({ userId: 'account-id' }),
    listIdentities: async () => [owner, other].map(id => ({ id, userId: 'account-id', status: 'active', isDefault: id === owner })),
  } as unknown as AccountRepository;
  const app = Fastify();
  await registerKnowledgeRoutes(app, { accounts, store, pool });
  const request = (operation: string, payload: Record<string, unknown> = {}, identity = owner) => app.inject({ method: 'POST',
    url: '/api/v1/knowledge-library/' + operation, headers: { authorization: 'Bearer test', 'x-identity-id': identity },
    payload: { serviceInstanceId: connection.serviceInstanceId, ...payload } });
  return { app, request, connection, store, documents, uploads, query };
}

beforeEach(async () => {
  upstreamDocs = [structuredClone(doc)]; snapshot = structuredClone(job); pending = false; permissions = true;
  fetchMock = vi.fn(async (raw: string, init: RequestInit) => {
    const url = new URL(raw);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/knowledge-scope/capabilities') return json({ scoped_upload: true });
    if (url.pathname === '/v1/knowledge-scope/statistics') return json({ permission_filtered: true, collections: [{
      knowledge_base_id: libraryId, collection: '', file_count: 4, chunk_count: 0,
      source_names: ['通知.pdf', '管理办法.pdf', '绩效办法.pdf', '政策.pdf'],
    }] });
    if (url.pathname === '/v1/process/async') {
      const form = init.body as FormData;
      const filename = (form.get('file') as File).name;
      return json({ job_id: 'new-job', state: 'queued', filename, stored_path: '/private/' + filename, scope_accepted: true });
    }
    if (url.pathname === '/v1/documents') return json({ count: upstreamDocs.length, documents: upstreamDocs,
      permission_filtered: true, by_category: { 上传文档: upstreamDocs.length }, pending: 0 });
    if (url.pathname === '/v1/jobs') return json({ count: 1, jobs: [snapshot] });
    if (url.pathname.startsWith('/v1/jobs/')) {
      if (url.pathname.endsWith('/events')) return new Response('data: ' + JSON.stringify({ ...snapshot, state: 'done' }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
      return json(url.pathname.endsWith('/cancel') ? { ...snapshot, state: 'cancelled' } : snapshot);
    }
    if (url.pathname.endsWith('/slices')) return json(pending ? { detail: '先执行重建' } : slices, pending ? 404 : 200);
    if (url.pathname.endsWith('/content')) {
      return json({ doc_id: docId, name: physicalName, para: Number(url.searchParams.get('para')), limit: Number(url.searchParams.get('limit')),
        returned: 1, total_paragraphs: 1, total_chars: 2, next_para: null, has_more: false, paragraphs: ['正文'] });
    }
    return json({ ...doc, editable: false });
  });
  vi.stubGlobal('fetch', fetchMock);
  fixture = await setup();
});
afterEach(async () => { await fixture.app.close(); vi.unstubAllGlobals(); });

describe('真实知识库路由的归属与读取回归', () => {
  it('统计按授权库 ID 展示未产生切片的文件，兼容上游空集合名', async () => {
    const result = await fixture.request('getStatistics');
    expect(result.statusCode).toBe(200);
    expect(result.json().data).toEqual({ collections: [{ knowledgeBaseId: libraryId, collection,
      fileCount: 4, chunkCount: 0, sourceNames: ['通知.pdf', '管理办法.pdf', '绩效办法.pdf', '政策.pdf'] }], unclassifiedCount: 0 });
    const [, request] = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/knowledge-scope/statistics'))!;
    expect(JSON.parse(request.body)).toEqual({ knowledge_base_ids: [libraryId] });
    expect(fixture.uploads).toHaveLength(0);
    expect(fixture.documents.size).toBe(0);
  });

  it('旧上传通过精确路径补齐归属，任务和切片能够读取且不外泄路径', async () => {
    const sources = await fixture.request('listSources', { collection, knowledgeBaseId: libraryId });
    expect(sources.statusCode).toBe(200);
    expect(sources.json().data.bindings[0]).toMatchObject({ docId, knowledgeBaseId: libraryId, displayName: '制度.pdf' });
    expect(sources.json().data.verifiedServerDocIds).toEqual([]);
    expect(sources.body).not.toContain('/private/');
    const task = await fixture.request('getJob', { jobId });
    expect(task.statusCode).toBe(200);
    expect(task.json().data.state).toBe('done');
    expect(task.body).not.toContain('/private/');
    const history = await fixture.request('listJobs');
    expect(history.statusCode).toBe(200);
    expect(history.json().data.jobs).toHaveLength(1);
    expect(history.body).not.toContain('/private/');
    const result = await fixture.request('contentRequest', { endpoint: 'slices', docId, knowledgeBaseId: libraryId });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.count).toBe(1);
    expect(result.body).not.toContain('/private/');
    expect(fixture.documents.get(docId)).toEqual({ knowledge_base_id: libraryId, chunk_count: 1 });
    expect(fixture.query.mock.calls.some(([sql, args]) => sql.includes('UPDATE knowledge_uploads') && args?.[3] === 'completed')).toBe(true);
  });

  it('未先加载列表也能恢复旧任务归属并读取 SSE 状态', async () => {
    snapshot.state = 'running';
    const events = await fixture.app.inject({ method: 'GET', url: '/api/v1/knowledge-library/job-events?' + new URLSearchParams({
      serviceInstanceId: fixture.connection.serviceInstanceId, jobId, subscriptionId: 'subscription' }),
      headers: { authorization: 'Bearer test', 'x-identity-id': owner } });
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain('"state":"running"');
    expect(events.body).toContain('"state":"done"');
    expect(events.body).not.toContain('/private/');
  });

  it('正文使用 GET 分页参数，切片请求可按指定知识库补齐文档归属', async () => {
    const response = await fixture.request('contentRequest', { endpoint: 'content', knowledgeBaseId: libraryId, docId, para: 0, limit: 5 });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.paragraphs).toEqual(['正文']);
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/content?'))!;
    expect(new URL(call[0]).searchParams.get('limit')).toBe('5');
    expect(call[1].body).toBeUndefined();
  });

  it('其他身份即使知道知识库和文档 ID 也不能读取', async () => {
    await fixture.store.write(other, 'connection.json', await fixture.store.read(owner, 'connection.json'));
    const response = await fixture.request('contentRequest', { endpoint: 'slices', knowledgeBaseId: libraryId, docId }, other);
    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('当前知识库无法读取其他已归属库的文档', async () => {
    fixture.documents.set(docId, { knowledge_base_id: otherLibraryId, chunk_count: 1 });
    const result = await fixture.request('contentRequest', { endpoint: 'slices', knowledgeBaseId: libraryId, docId });
    expect(result.statusCode).toBe(409);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/slices'))).toBe(false);
    expect(fixture.documents.get(docId)?.knowledge_base_id).toBe(otherLibraryId);
  });

  it('不按显示名或集合猜任务归属，也不能读取任意任务', async () => {
    upstreamDocs[0]!.abs_path = '/another/' + physicalName;
    expect((await fixture.request('getJob', { jobId })).statusCode).toBe(403);
    expect((await fixture.request('getJob', { jobId: 'arbitrary-job' })).statusCode).toBe(403);
  });

  it.each(['filename', 'collection'])('拒绝上游任务的 %s 与上传记录不一致', async field => {
    if (field === 'filename') snapshot.filename = 'another.pdf';
    else snapshot.params.collection = 'other-collection';
    expect((await fixture.request('getJob', { jobId })).statusCode).toBe(502);
  });

  it('拒绝上游列表返回其他知识库的文件', async () => {
    upstreamDocs[0]!.knowledge_base_id = otherLibraryId;
    const response = await fixture.request('listSources', { collection, knowledgeBaseId: libraryId });
    expect(response.statusCode).toBe(502);
    expect(fixture.documents.size).toBe(0);
  });

  it('原件存在但切片暂未生成时返回可重试的处理中状态', async () => {
    pending = true;
    const result = await fixture.request('contentRequest', { endpoint: 'slices', knowledgeBaseId: libraryId, docId });
    expect(result.statusCode).toBe(404);
    expect(result.json().error).toMatchObject({ retryable: true, details: { kind: 'slices_pending' } });
  });

  it('新上传保存知识库与身份意图，并将权限范围传给知识服务', async () => {
    const response = await fixture.app.inject({ method: 'POST', url: '/api/v1/knowledge-library/submit?' + new URLSearchParams({
      serviceInstanceId: fixture.connection.serviceInstanceId, collection, knowledgeBaseId: libraryId,
      clientUploadId: '30000000-0000-4000-8000-000000000002', name: '新制度.pdf', mime: 'application/pdf' }),
      headers: { authorization: 'Bearer test', 'x-identity-id': owner, 'content-type': 'application/octet-stream' }, payload: Buffer.from('pdf-data') });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ knowledgeBaseId: libraryId, jobId: 'new-job' });
    expect(fixture.uploads[0]?.slice(1, 4)).toEqual([libraryId, owner, collection]);
    const form = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/process/async'))![1].body as FormData;
    expect(form.get('knowledge_base_id')).toBe(libraryId);
    expect(form.get('personal_identity_id')).toBe(owner);
    expect(form.get('organization_id')).toBe('');
    expect(form.get('project_id')).toBe('');
    expect(form.get('save_slices')).toBe('true');
    expect(form.get('ingest')).toBe('true');
  });

  it('权限撤回后不能取消任务，删除终态记录仍保留来源关联', async () => {
    const deleted = await fixture.request('deleteJobRecord', { jobId });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data).toMatchObject({ docId, knowledgeBaseId: libraryId, taskRecordDeletedAt: expect.any(String) });
    permissions = false; fetchMock.mockClear();
    expect((await fixture.request('cancelJob', { jobId })).statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('运行中的任务可以取消，但不能删除仍在运行的记录', async () => {
    snapshot.state = 'running';
    expect((await fixture.request('deleteJobRecord', { jobId })).statusCode).toBe(409);
    const cancelled = await fixture.request('cancelJob', { jobId });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data.state).toBe('cancelled');
  });

  it('恢复中断的提交只关联当前知识库的随机上传标识，并持久化归属', async () => {
    await fixture.app.close();
    fixture = await setup(false);
    await inScope(createScope(owner, 1, fixture.store, 'test-key'), () => beginSubmission({
      clientUploadId: clientId, knowledgeBaseId: libraryId, displayName: '制度.pdf', physicalName, collection,
      serverOrigin: serviceUrl, credentialRef: null, submittedAt: '2026-10-10T10:00:00Z',
    }));
    const input = { collection, knowledgeBaseId: libraryId };
    expect((await fixture.request('getUnconfirmed', input)).json().data).toHaveLength(1);
    const recovery = await fixture.request('recoverSubmissions', input);
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json().data).toEqual({ recovered: 1, unresolved: 0 });
    expect(fixture.uploads[0]?.slice(1, 4)).toEqual([libraryId, owner, collection]);
    expect((await fixture.request('getJob', { jobId })).statusCode).toBe(200);
  });
});
