import type { JobSnapshot, JobState } from '@kla-workstation/contracts/knowledge';
export const jobLabels: Record<JobState, string> = { queued: '等待处理', running: '处理中', done: '处理完成', failed: '处理失败', cancelled: '已取消', interrupted: '服务中断' };
const stages: Record<string, string> = { upload: '接收文件', parse: '解析', transcribe: '转写', polish: '清洗', slice: '切片', ingest: '向量入库', done: '完成' };
export function JobStatus({ job, missing = false }: { job?: JobSnapshot | undefined; missing?: boolean }): React.JSX.Element {
  if (!job) return <span className="kl-muted">{missing ? '任务记录不可用' : '处理状态未关联'}</span>;
  const ingest = job.artifacts?.ingest as { chunks?: unknown } | undefined;
  const count = ingest?.chunks;
  const progress = job.progress;
  const current = progress?.chunk ?? progress?.segment;
  return <div className="kl-job-status">
    <span className={`kl-badge kl-${job.state}`}>{jobLabels[job.state]}</span>
    {job.state === 'running' && <small>{stages[job.stage ?? ''] ?? job.stage ?? '处理中'}{typeof current === 'number' && typeof progress?.total === 'number' ? ` · ${current}/${progress.total}` : ''}</small>}
    {job.state === 'done' && <small>{typeof count === 'number' && count > 0 ? `入库 ${count} 个切片` : '入库结果待确认'}</small>}
    {job.error && <small className="kl-error-text">{job.error}</small>}
  </div>;
}
