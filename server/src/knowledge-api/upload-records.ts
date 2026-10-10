import { currentScope } from './context.js';
import type { StoredBinding } from './documents.js';
import type { JobSnapshot } from '@kla-workstation/contracts/knowledge';
import { KnowledgeError } from './transport.js';

export async function recordUploadIntent(input: { clientUploadId: string; knowledgeBaseId: string; collection: string; physicalName: string }) {
  const { pool, owner } = currentScope();
  if (!pool) return;
  const result = await pool.query(`INSERT INTO knowledge_uploads
    (client_upload_id,knowledge_base_id,uploader_identity_id,collection,stored_filename)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_upload_id) DO NOTHING RETURNING id`,
  [input.clientUploadId, input.knowledgeBaseId, owner, input.collection, input.physicalName]);
  if (!result.rows.length) throw new KnowledgeError('DUPLICATE_REQUEST', '此提交编号已使用，请先核对现有结果。');
}

export async function recordConfirmedUpload(binding: StoredBinding) {
  const { pool, owner } = currentScope();
  if (!pool || !binding.knowledgeBaseId) return;
  const result = await pool.query(`INSERT INTO knowledge_uploads
    (client_upload_id,knowledge_base_id,uploader_identity_id,collection,remote_job_id,stored_filename,remote_storage_path,doc_id,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitted')
    ON CONFLICT (client_upload_id) DO UPDATE SET remote_job_id=EXCLUDED.remote_job_id,
      stored_filename=EXCLUDED.stored_filename,remote_storage_path=EXCLUDED.remote_storage_path,
      doc_id=COALESCE(EXCLUDED.doc_id,knowledge_uploads.doc_id),
      status=CASE WHEN knowledge_uploads.status='pending' THEN 'submitted' ELSE knowledge_uploads.status END,updated_at=now()
    WHERE knowledge_uploads.knowledge_base_id=EXCLUDED.knowledge_base_id
      AND knowledge_uploads.uploader_identity_id=EXCLUDED.uploader_identity_id
      AND knowledge_uploads.collection=EXCLUDED.collection
      AND (knowledge_uploads.remote_job_id IS NULL OR knowledge_uploads.remote_job_id=EXCLUDED.remote_job_id)
    RETURNING id`, [binding.clientUploadId, binding.knowledgeBaseId, owner, binding.collection, binding.jobId,
    binding.physicalName ?? binding.storedPath.split(/[\\/]/).pop(), binding.storedPath, binding.docId ?? null]);
  if (!result.rows.length) throw new KnowledgeError('CONFLICT', '上传记录归属不一致，请联系管理员核对。');
}

export async function recordJobSnapshot(binding: StoredBinding, job: JobSnapshot) {
  const { pool, owner } = currentScope();
  if (!pool || !binding.knowledgeBaseId) return;
  const status = job.state === 'done' ? 'completed' : job.state === 'running' ? 'processing'
    : job.state === 'queued' ? 'submitted' : job.state === 'cancelled' ? 'cancelled' : 'failed';
  await pool.query(`UPDATE knowledge_uploads SET status=$4,error=$5,updated_at=now()
    WHERE client_upload_id=$1 AND uploader_identity_id=$2 AND knowledge_base_id=$3`,
  [binding.clientUploadId, owner, binding.knowledgeBaseId, status, job.error ?? null]);
}
