import type { DocumentSlices, JobSnapshot, RemoteDocument, SourceJobBinding } from '@kla-workstation/contracts/knowledge';

/**
 * 文件统计口径：作业状态优先，但「作业已 done、且切片结果确认取到 0 条」必须算异常。
 *
 * 上游知识服务存在作业状态与产物不一致的静默失败（`/v1/process/async` 报 done 却没有切片文件），
 * 若只按 `state==='done'` 计入已完成，界面会显示「处理完成」而实际没有任何可检索内容。
 * 只有在切片查询**成功返回**且条数为 0 时才降级；查询尚未成功（加载中、临时 404 slices_pending）
 * 时仍按作业状态计，避免把「还没拿到」误判成失败。
 */
export function summarizeKnowledgeFiles(documents: RemoteDocument[], bindings: SourceJobBinding[], jobs: ReadonlyMap<string, JobSnapshot>, jobErrors: ReadonlySet<string>, slices: ReadonlyArray<{ data: DocumentSlices | undefined; isSuccess: boolean }>) {
  const result = { done: 0, processing: 0, failed: 0, unknown: 0 };
  for (const [index, doc] of documents.entries()) {
    const binding = bindings.filter(item => item.docId === doc.doc_id).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
    const job = binding && jobs.get(binding.jobId);
    if (job && !jobErrors.has(job.job_id)) {
      const slice = slices[index];
      const verifiedEmpty = slice?.isSuccess === true && (slice.data?.count ?? 0) === 0;
      if (job.state === 'done' && verifiedEmpty && !doc.stale) result.failed++;
      else if (job.state === 'done') result.done++;
      else if (job.state === 'queued' || job.state === 'running') result.processing++;
      else if (job.state === 'failed' || job.state === 'interrupted') result.failed++;
      // A known cancelled file is neither processed, running nor a failed file.
    } else if ((!job || jobErrors.has(job.job_id)) && slices[index]?.isSuccess && (slices[index]?.data?.count ?? 0) > 0 && !doc.stale) {
      // Older files may lack a local job record. Current validated slices still
      // establish that processing has produced content, without inventing a job.
      result.done++;
    } else result.unknown++;
  }
  return result;
}
