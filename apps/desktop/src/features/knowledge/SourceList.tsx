import { useState } from 'react';
import { FileText, Search, Upload, ArrowUpRight } from 'lucide-react';
import type { JobSnapshot, KnowledgeContext, RemoteDocument, SourceJobBinding, SourceRef } from '@kla-workstation/contracts/knowledge';
import { JobStatus, jobLabels } from './JobStatus';

export function formatBytes(size: number): string {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
export function SourceList({ context, documents, bindings, jobs, jobErrors, loading, error, onRefresh, onUpload, onOpenDocument, previewAvailable, cancelling, onCancelJob, verifiedServerDocIds = [], unclassifiedCount = 0 }: {
  context: KnowledgeContext; documents: RemoteDocument[]; bindings: SourceJobBinding[]; jobs: Map<string, JobSnapshot>; jobErrors: Set<string>;
  loading: boolean; error?: string | undefined; onRefresh: () => void; onUpload: () => void; onOpenDocument: (source: SourceRef) => void; previewAvailable: boolean;
  cancelling: ReadonlySet<string>; onCancelJob: (id: string) => Promise<void>;
  verifiedServerDocIds?: string[]; unclassifiedCount?: number;
}): React.JSX.Element {
  const [search, setSearch] = useState(''); const [type, setType] = useState('all'); const [state, setState] = useState('all'); const [sort, setSort] = useState('latest');
  const [dateFrom, setDateFrom] = useState(''); const [dateTo, setDateTo] = useState('');
  const invalidDates = Boolean(dateFrom && dateTo && dateFrom > dateTo);
  const bindingFor = (docId: string) => bindings.filter(b => b.docId === docId).sort((a,b) => b.submittedAt.localeCompare(a.submittedAt))[0];
  const nameFor = (doc: RemoteDocument) => bindingFor(doc.doc_id)?.displayName ?? doc.name;
  const types = Array.from(new Set(documents.map(d => d.ext))).sort();
  const verified = new Set(verifiedServerDocIds);
  const list = documents.filter(doc => {
    const binding = bindingFor(doc.doc_id); const job = binding && jobs.get(binding.jobId);
    const day = doc.modified.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    return !invalidDates && nameFor(doc).toLowerCase().includes(search.trim().toLowerCase()) && (type === 'all' || doc.ext === type) && (state === 'all' || (job?.state ?? (verified.has(doc.doc_id) ? 'sliced' : 'unbound')) === state) && (!dateFrom || Boolean(day && day >= dateFrom)) && (!dateTo || Boolean(day && day <= dateTo));
  }).sort((a,b) => sort === 'name' ? nameFor(a).localeCompare(nameFor(b), 'zh-CN') : sort === 'oldest' ? a.modified.localeCompare(b.modified) : b.modified.localeCompare(a.modified));
  return <section className="kl-source-panel">
    <div className="kl-toolbar"><label className="kl-search"><Search size={16}/><input placeholder="搜索文件名称……" aria-label="搜索文件" value={search} onChange={e => setSearch(e.target.value)}/></label><select aria-label="文件类型" value={type} onChange={e => setType(e.target.value)}><option value="all">全部类型</option>{types.map(ext => <option key={ext} value={ext}>{ext.toUpperCase()}</option>)}</select><select aria-label="文件状态" value={state} onChange={e => setState(e.target.value)}><option value="all">全部状态</option>{Object.entries(jobLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}<option value="sliced">已生成切片（未关联任务）</option><option value="unbound">状态未关联</option></select><select aria-label="文件排序" value={sort} onChange={e => setSort(e.target.value)}><option value="latest">最近更新</option><option value="oldest">最早更新</option><option value="name">名称顺序</option></select><button className="kl-primary" onClick={onUpload} disabled={!context.capabilities.canUpload}><Upload size={15}/>上传文件</button></div>
    <div className="kl-date-filter"><span>更新时间</span><label>开始日期<input type="date" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)}/></label><span>至</span><label>结束日期<input type="date" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)}/></label><small>按服务返回日期筛选，包含起止日期。</small>{(search || type !== 'all' || state !== 'all' || dateFrom || dateTo || sort !== 'latest') && <button onClick={() => { setSearch(''); setType('all'); setState('all'); setSort('latest'); setDateFrom(''); setDateTo(''); }}>重置筛选</button>}</div>
    {invalidDates && <p role="alert" className="kl-notice kl-error-text">开始日期不能晚于结束日期。</p>}
    {/* 「集合归属尚未确认」提示先隐藏（产品要求）；prop 保留，恢复时重新渲染即可 */}
    {unclassifiedCount > 0 && <p className="kl-notice">{unclassifiedCount} 个服务器原件的归属尚未确认，当前列表仅显示已确认属于此知识库的文件；可稍后刷新重试。</p>}
    {error ? <div className="kl-empty" role="alert"><h2>文件列表加载失败</h2><p>{error}</p><button onClick={onRefresh}>重新加载</button></div> : loading ? <div className="kl-empty" aria-busy="true">正在加载原始文件……</div> : !list.length ? <div className="kl-empty"><FilesEmpty/><h2>{documents.length ? '没有匹配的文件' : '暂无已关联的原始文件'}</h2><p>{documents.length ? '请调整搜索和筛选条件。' : '上传文件完成处理后将显示在这里；已有服务器原件仅在接口确认属于当前集合后关联。'}</p></div> : <div className="kl-table-scroll"><table><thead><tr><th>文件名</th><th>类型</th><th>大小</th><th>处理状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{list.map(doc => {
      const binding = bindingFor(doc.doc_id); const job = binding && jobs.get(binding.jobId); const active = job && ['queued','running'].includes(job.state);
      return <tr key={doc.doc_id}><td><div className="kl-file-name"><span className="kl-file-icon"><FileText size={19}/></span><div><strong>{nameFor(doc)}</strong>{nameFor(doc) !== doc.name && <small title={doc.name}>服务存储名：{doc.name}</small>}</div></div></td><td><span className="kl-file-type">{doc.ext.toUpperCase()}</span></td><td>{formatBytes(doc.size)}</td><td>{!job && verified.has(doc.doc_id) ? <span className={`kl-badge kl-${doc.stale ? 'running' : 'done'}`}>{doc.stale ? '切片待更新' : '切片已生成'}</span> : <JobStatus job={job} missing={Boolean(binding && jobErrors.has(binding.jobId))}/>}</td><td>{doc.modified}<small className="kl-block kl-muted">服务时间</small></td><td><div className="kl-row-actions"><button disabled={!previewAvailable} title={previewAvailable ? '查看文件' : '文档预览由 B 接入'} onClick={() => onOpenDocument({ docId: doc.doc_id, displayName: nameFor(doc), version: doc.modified, ...(context.knowledgeBaseId ? { knowledgeBaseId: context.knowledgeBaseId } : {}) })}>查看 <ArrowUpRight size={13}/></button>{active && <button disabled={cancelling.has(job.job_id)} onClick={() => void onCancelJob(job.job_id)}>{cancelling.has(job.job_id) ? '等待取消' : '取消'}</button>}{job && ['failed','interrupted','cancelled'].includes(job.state) && <button title="重新选择原件提交新任务；不会自动重放旧请求" onClick={onUpload}>重新选择原件</button>}</div></td></tr>;
    })}</tbody></table></div>}
    <footer className="kl-table-footer">显示 {list.length} 个原始文件 <button onClick={onRefresh}>刷新列表</button></footer>
  </section>;
}
function FilesEmpty() { return <FileText size={32}/>; }
