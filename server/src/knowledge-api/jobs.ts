import { z } from 'zod';
import { isTerminalJobState, jobSnapshotSchema } from '@kla-workstation/contracts/knowledge';
import { jsonRequest, KnowledgeError } from './transport.js';
import { assertBoundResource, markJobRecordDeleted } from './documents.js';
export const jobPath = (id: string): string => `/v1/jobs/${encodeURIComponent(id)}`;
export const listJobs = (owner: number, service: string) => jsonRequest(owner, service, '/v1/jobs', z.object({ count: z.number(), jobs: z.array(jobSnapshotSchema) }));
export const getJob = (owner: number, service: string, id: string) => {
  assertBoundResource(service, { jobId: id });
  return jsonRequest(owner, service, jobPath(id), jobSnapshotSchema);
};
export const cancelJob = (owner: number, service: string, id: string) => {
  assertBoundResource(service, { jobId: id });
  return jsonRequest(owner, service, `${jobPath(id)}/cancel`, jobSnapshotSchema, { method: 'POST' });
};
export async function deleteJobRecord(owner: number, service: string, id: string) {
  // Confirm the authoritative state rather than trusting a renderer snapshot.
  const job = await getJob(owner, service, id);
  if (job.job_id !== id) throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '服务返回的任务编号不一致，无法删除记录。');
  if (!isTerminalJobState(job.state)) throw new KnowledgeError('CONFLICT', '任务仍在排队或处理中，请等待结束后删除记录。');
  return markJobRecordDeleted(service, id);
}
