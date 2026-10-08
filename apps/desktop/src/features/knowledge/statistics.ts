import type { DocumentSlices, JobSnapshot, RemoteDocument, SourceJobBinding } from '@kla-workstation/contracts/knowledge';

export function summarizeKnowledgeFiles(documents: RemoteDocument[], bindings: SourceJobBinding[], jobs: ReadonlyMap<string, JobSnapshot>, jobErrors: ReadonlySet<string>, slices: ReadonlyArray<{ data: DocumentSlices | undefined; isSuccess: boolean }>) {
  const result = { done: 0, processing: 0, failed: 0, unknown: 0 };
  for (const [index, doc] of documents.entries()) {
    const binding = bindings.filter(item => item.docId === doc.doc_id).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
    const job = binding && jobs.get(binding.jobId);
    if (job && !jobErrors.has(job.job_id)) {
      if (job.state === 'done') result.done++;
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
