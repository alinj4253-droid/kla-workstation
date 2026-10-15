import type { Pool } from 'pg';
import { z } from 'zod';
import { documentListSchema, documentRequestSchema, documentDetailSchema, documentMetaSchema,
  documentContentSchema, documentSlicesSchema, type JobSnapshot } from '@kla-workstation/contracts/knowledge';
import { findReadableLibraryByDocId, getAccessibleLibrary, listAccessibleLibraries } from '../auth/knowledge-libraries.js';
import { hasPermission } from '../auth/permission-service.js';
import { currentScope } from './context.js';
import { assertService } from './config.js';
import { associateScopedDocuments, publicBinding, storedBindings, type StoredBinding } from './documents.js';
import { getJob } from './jobs.js';
import { jsonRequest, KnowledgeError } from './transport.js';
import { recordConfirmedUpload, recordJobSnapshot } from './upload-records.js';
import { applySliceEdits, loadSliceEdits } from './slice-edits.js';

export const scopedCollectionSchema = z.object({ serviceInstanceId: z.string().min(1), collection: z.string().min(1), knowledgeBaseId: z.string().uuid().optional() });
export const scopedContentSchema = z.object({
  serviceInstanceId: z.string().min(1), endpoint: z.enum(['document', 'meta', 'content', 'slices', 'search']),
  knowledgeBaseId: z.string().uuid().optional(), docId: documentRequestSchema.shape.docId.optional(),
  para: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional(),
  search: z.object({ query: z.string(), mode: z.enum(['hybrid', 'vector', 'keyword']), top_k: z.number().int(),
    expand: z.number().int().optional(), fold_adjacent: z.boolean().optional() }).optional(),
});

export async function resolveScopedLibrary(pool: Pool, input: z.infer<typeof scopedCollectionSchema>, action: 'read' | 'write' = 'read') {
  assertService(input.serviceInstanceId);
  const { owner } = currentScope();
  if (!(await hasPermission(pool, owner, action))) throw new KnowledgeError('PERMISSION_DENIED', '当前身份没有知识库操作权限。');
  let id = input.knowledgeBaseId;
  if (!id) {
    const candidates = (await listAccessibleLibraries(pool, owner)).filter(entry => entry.collection === input.collection);
    if (candidates.length !== 1) throw new KnowledgeError('PERMISSION_DENIED', '请指定可访问的知识库，集合名不能用作权限范围。');
    id = candidates[0]!.id;
  }
  const library = await getAccessibleLibrary(pool, owner, id, action);
  if (!library) throw new KnowledgeError('PERMISSION_DENIED', '当前身份无权访问该知识库。');
  if (library.entry.collection !== input.collection) throw new KnowledgeError('CONFLICT', '目标知识库集合已变更。');
  return library;
}

const scopedDocumentsSchema = documentListSchema.extend({ permission_filtered: z.literal(true),
  documents: z.array(documentListSchema.shape.documents.element.extend({ knowledge_base_id: z.string().uuid() })) });

export async function fetchScopedDocuments(pool: Pool, input: z.infer<typeof scopedCollectionSchema>) {
  const library = await resolveScopedLibrary(pool, input);
  const { ownerNumber } = currentScope();
  const result = await jsonRequest(ownerNumber, input.serviceInstanceId,
    `/v1/documents?knowledge_base_id=${encodeURIComponent(library.entry.id)}`, scopedDocumentsSchema);
  if (result.count !== result.documents.length || new Set(result.documents.map(doc => doc.doc_id)).size !== result.count
    || result.documents.some(doc => doc.knowledge_base_id !== library.entry.id))
    throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回的文件范围不完整或不属于当前知识库。');
  return { library, result };
}

/** Reconcile only explicit upstream library ownership; never classify by collection or display name. */
export async function syncScopedSources(pool: Pool, input: z.infer<typeof scopedCollectionSchema>) {
  const { library, result } = await fetchScopedDocuments(pool, input);
  const client = await pool.connect();
  const verifiedServerDocIds: string[] = [];
  try {
    await client.query('BEGIN');
    for (const doc of result.documents) {
      const updated = await client.query<{ chunk_count: number }>(`INSERT INTO knowledge_documents
        (doc_id,knowledge_base_id,collection,name,ext,abs_path,size_bytes,modified_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (doc_id) DO UPDATE SET knowledge_base_id=EXCLUDED.knowledge_base_id,
          collection=EXCLUDED.collection,name=EXCLUDED.name,ext=EXCLUDED.ext,abs_path=EXCLUDED.abs_path,
          size_bytes=EXCLUDED.size_bytes,modified_at=EXCLUDED.modified_at,last_seen_at=now()
        WHERE knowledge_documents.knowledge_base_id IS NULL OR knowledge_documents.knowledge_base_id=EXCLUDED.knowledge_base_id
        RETURNING chunk_count`, [doc.doc_id, library.entry.id, library.entry.collection, doc.name, doc.ext, doc.abs_path, doc.size, doc.modified]);
      if (!updated.rows.length) throw new KnowledgeError('CONFLICT', '文档已有其他知识库归属，无法自动改动。');
      if (updated.rows[0]!.chunk_count > 0 && !doc.stale) verifiedServerDocIds.push(doc.doc_id);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const bindings = await associateScopedDocuments(input.serviceInstanceId, input.collection, library.entry.id, result.documents);
  for (const binding of bindings) await recordConfirmedUpload(binding);
  return { documents: result.documents.map(({ abs_path: _path, knowledge_base_id: _id, ...doc }) => doc),
    bindings: bindings.map(binding => publicBinding(binding, input.serviceInstanceId)),
    totalWorkspaceCount: result.count, verifiedServerDocIds, unclassifiedCount: 0 };
}

const readEndpoints = {
  document: { suffix: '', schema: documentDetailSchema }, meta: { suffix: 'meta', schema: documentMetaSchema },
  content: { suffix: 'content', schema: documentContentSchema }, slices: { suffix: 'slices', schema: documentSlicesSchema },
} as const;

export async function readScopedDocument(pool: Pool, body: z.infer<typeof scopedContentSchema>) {
  if (body.endpoint === 'search' || !body.docId) throw new KnowledgeError('VALIDATION_FAILED', '缺少文档 ID。');
  const { owner, ownerNumber } = currentScope();
  assertService(body.serviceInstanceId);
  let library = body.knowledgeBaseId ? await getAccessibleLibrary(pool, owner, body.knowledgeBaseId, 'read')
    : await findReadableLibraryByDocId(pool, owner, body.docId);
  if (!library) throw new KnowledgeError('PERMISSION_DENIED', '当前身份无权读取该文档。');
  let attributed = await findReadableLibraryByDocId(pool, owner, body.docId);
  if (!attributed && body.knowledgeBaseId) {
    const files = await syncScopedSources(pool, { serviceInstanceId: body.serviceInstanceId, collection: library.entry.collection, knowledgeBaseId: library.entry.id });
    if (files.documents.some(doc => doc.doc_id === body.docId)) attributed = await findReadableLibraryByDocId(pool, owner, body.docId);
  }
  if (!attributed || attributed.entry.id !== library.entry.id) throw new KnowledgeError('PERMISSION_DENIED', '该文档不属于当前可读知识库。');
  library = attributed;
  const target = readEndpoints[body.endpoint];
  const path = `/v1/documents/${encodeURIComponent(body.docId)}${target.suffix ? `/${target.suffix}` : ''}`;
  const query = new URLSearchParams({ knowledge_base_id: library.entry.id });
  if (body.endpoint === 'content') { query.set('para', String(body.para ?? 0)); query.set('limit', String(body.limit ?? 20)); }
  let raw: Record<string, unknown>;
  try { raw = await jsonRequest(ownerNumber, body.serviceInstanceId, `${path}?${query}`, z.record(z.unknown())); }
  catch (error) {
    if (body.endpoint === 'slices' && error instanceof KnowledgeError && error.code === 'NOT_FOUND') {
      // Only a still-existing, authorized original can be reported as processing.
      const original = await jsonRequest(ownerNumber, body.serviceInstanceId,
        `/v1/documents/${encodeURIComponent(body.docId)}?knowledge_base_id=${encodeURIComponent(library.entry.id)}`,
        documentDetailSchema.extend({ knowledge_base_id: z.string().uuid().optional() }));
      if (original.doc_id !== body.docId || (original.knowledge_base_id !== undefined && original.knowledge_base_id !== library.entry.id))
        throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回的文档归属与请求不一致。');
      throw new KnowledgeError('NOT_FOUND', '切片尚未生成，请查看文件处理状态。', true, { kind: 'slices_pending' });
    }
    throw error;
  }
  if (raw.doc_id !== body.docId || (raw.knowledge_base_id !== undefined && raw.knowledge_base_id !== library.entry.id)
    || (body.endpoint === 'slices' && raw.collection !== library.entry.collection))
    throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回的文档归属与请求不一致。');
  const parsed = target.schema.safeParse(raw);
  if (!parsed.success) throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回的内容与约定不一致，请确认部署版本。');
  if (body.endpoint === 'content' && (raw.para !== (body.para ?? 0) || raw.limit !== (body.limit ?? 20)))
    throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回的正文分页与请求不一致。');
  if (body.endpoint === 'slices') await pool.query('UPDATE knowledge_documents SET chunk_count=$3,last_seen_at=now() WHERE doc_id=$1 AND knowledge_base_id=$2',
    [body.docId, library.entry.id, raw.count]);
  // 切片读取叠加本身份的编辑覆盖（标题/正文），与 mock/local 路径保持同一口径。
  return body.endpoint === 'slices' ? applySliceEdits(parsed.data, await loadSliceEdits(body.docId)) : parsed.data;
}

export async function authorizeScopedJob(pool: Pool, serviceId: string, jobId: string, action: 'read' | 'write' = 'read') {
  const config = assertService(serviceId);
  let binding = storedBindings(serviceId, config.collection).find(item => item.jobId === jobId);
  if (!binding) throw new KnowledgeError('PERMISSION_DENIED', '当前身份没有该任务的上传记录。');
  if (!binding.knowledgeBaseId) {
    const candidates = (await listAccessibleLibraries(pool, currentScope().owner)).filter(entry => entry.collection === binding!.collection);
    for (const library of candidates) {
      await syncScopedSources(pool, { serviceInstanceId: serviceId, collection: library.collection, knowledgeBaseId: library.id });
      binding = storedBindings(serviceId, config.collection).find(item => item.jobId === jobId);
      if (binding?.knowledgeBaseId) break;
    }
  }
  if (!binding?.knowledgeBaseId) throw new KnowledgeError('PERMISSION_DENIED', '该任务尚未确认知识库归属，请刷新文件列表。');
  await resolveScopedLibrary(pool, { serviceInstanceId: serviceId, collection: binding.collection, knowledgeBaseId: binding.knowledgeBaseId }, action);
  await recordConfirmedUpload(binding);
  return binding;
}

export async function verifyScopedJob(pool: Pool, serviceId: string, binding: StoredBinding, snapshot: JobSnapshot, action: 'read' | 'write' = 'read') {
  await resolveScopedLibrary(pool, { serviceInstanceId: serviceId, collection: binding.collection, knowledgeBaseId: binding.knowledgeBaseId }, action);
  const declared = snapshot.params.knowledge_base_id;
  if (snapshot.job_id !== binding.jobId || snapshot.filename !== (binding.physicalName ?? binding.storedPath.split(/[\\/]/).pop())
    || snapshot.params.collection !== binding.collection || (declared !== undefined && declared !== binding.knowledgeBaseId))
    throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回的任务与已确认的上传记录不一致。');
  await recordJobSnapshot(binding, snapshot);
  return snapshot;
}

export async function getScopedJob(pool: Pool, serviceId: string, jobId: string, action: 'read' | 'write' = 'read') {
  const binding = await authorizeScopedJob(pool, serviceId, jobId, action);
  const snapshot = await getJob(currentScope().ownerNumber, serviceId, jobId);
  return { binding, snapshot: await verifyScopedJob(pool, serviceId, binding, snapshot, action) };
}
