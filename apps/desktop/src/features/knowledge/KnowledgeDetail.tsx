import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { ArrowLeft, Search, Trash2, Upload, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isTerminalJobState, type ChunkCountReport, type KnowledgeBase, type KnowledgeConnection, type KnowledgeContext, type SourceJobBinding, type SourceList as SourceListData, type SourceRef, type KnowledgeSlice, type KnowledgeSource } from '@kla-workstation/contracts/knowledge';
import type { KnowledgeSlots } from './slots';
import { useSources } from './queries/sources';
import { useJobs, latestJobSnapshot } from './queries/jobs';
import { knowledgeApi, knowledgeKeys } from './api';
import { SourceList } from './SourceList';
import { UploadDialog } from './UploadDialog';
import { JobStatus } from './JobStatus';
import { LibraryMenu } from './LibraryMenu';
import { DeleteJobRecordDialog } from './DeleteJobRecordDialog';
import { useKnowledgeSlices } from './queries/slices';
import { summarizeKnowledgeFiles } from './statistics';
import { readingSources, readingScope } from './reading-api';
import './sources.css';

export function KnowledgeDetail({ context, connection, base, slots = {}, onConfigure, onEdit, onDelete }: { context: KnowledgeContext; connection: KnowledgeConnection; base?: KnowledgeBase | undefined; slots?: KnowledgeSlots; onConfigure: () => void; onEdit?: (() => void) | undefined; onDelete?: (() => void) | undefined }): React.JSX.Element {
  const client = useQueryClient(); const sourceQuery = useSources(context);
  const savedBindings = useQuery({ queryKey: knowledgeKeys.bindings(context.serviceInstanceId, context.collection, context.knowledgeBaseId), queryFn: () => knowledgeApi.bindings(context.serviceInstanceId, context.collection, context.knowledgeBaseId), enabled: Boolean(context.collection), retry: false });
  const unconfirmed = useQuery({ queryKey: knowledgeKeys.unconfirmed(context.serviceInstanceId, context.collection, context.knowledgeBaseId), queryFn: () => knowledgeApi.unconfirmed(context.serviceInstanceId, context.collection, context.knowledgeBaseId), enabled: Boolean(context.collection), retry: false, refetchInterval: 10000 });
  const [newBindings, setNewBindings] = useState<SourceJobBinding[]>([]);
  const [recordToDelete, setRecordToDelete] = useState<SourceJobBinding | null>(null);
  const [deletedRecordKeys, setDeletedRecordKeys] = useState(new Set<string>());
  const [upload, setUpload] = useState(false); const [drawer, setDrawer] = useState<{ type: 'search' } | { type: 'document'; source: SourceRef; sliceIndex?: number } | { type: 'slice'; slice: KnowledgeSlice; source: KnowledgeSource } | null>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const [chunkReports, setChunkReports] = useState<ChunkCountReport[]>([]); const [cancelRequested, setCancelRequested] = useState(new Set<string>()); const [actionError, setActionError] = useState('');
  const [recovering, setRecovering] = useState(false); const [recoveryNotice, setRecoveryNotice] = useState('');
  const bindingRecords = [...(savedBindings.data ?? []), ...newBindings, ...(sourceQuery.data?.bindings ?? [])];
  const allBindings = Array.from(new Map(bindingRecords.map(binding => [binding.jobId, binding])).values());
  const deletedJobIds = new Set(bindingRecords.filter(binding => binding.taskRecordDeletedAt).map(binding => binding.jobId));
  const documents = (sourceQuery.data?.documents ?? []).filter(doc => !base ? allBindings.some(binding => binding.docId === doc.doc_id) : context.attribution !== 'confirmed-library' || base.sourceDocIds.includes(doc.doc_id));
  const bindings = base && context.attribution === 'confirmed-library' ? allBindings.filter(binding => binding.docId && base.sourceDocIds.includes(binding.docId)) : allBindings;
  const taskBindings = bindings.filter(binding => !deletedJobIds.has(binding.jobId) && !deletedRecordKeys.has(JSON.stringify([context.serviceInstanceId, context.collection, binding.jobId])));
  const sourceChanged = useCallback((binding: SourceJobBinding, snapshot: Parameters<NonNullable<KnowledgeSlots['sourceChanged']>>[1]) => {
    slots.sourceChanged?.(binding, snapshot);
  }, [slots.sourceChanged]);
  const jobs = useJobs(context, bindings, sourceChanged, connection.settings.pollIntervalMs);
  const jobMap = new Map(jobs.queries.flatMap(q => q.data ? [[q.data.job_id, q.data] as const] : []));
  const jobErrors = new Set(jobs.ids.filter((_, i) => jobs.queries[i]?.isError));
  const sliceData = useKnowledgeSlices(context, documents, { enabled: sourceQuery.isSuccess, processing: jobs.queries.some(query => query.data && ['queued', 'running'].includes(query.data.state)), pollIntervalMs: connection.settings.pollIntervalMs });
  const sourceVersion = JSON.stringify({ sourcesValid: sourceQuery.isSuccess, bindingsValid: savedBindings.isSuccess, sources: documents.map(doc => [doc.doc_id, doc.modified, doc.size, doc.stale]).sort(), jobs: jobs.queries.map((query, i) => [jobs.ids[i], query.data?.updated_at, query.data?.state, query.isError]) });
  const sourceMappings = readingSources(context, documents, allBindings);
  const scope = readingScope(context);
  const contentVersion = JSON.stringify([documents.map(doc => [doc.doc_id, doc.modified, doc.size, doc.stale]).sort(), jobs.queries.map((query, i) => [jobs.ids[i], query.data?.updated_at, query.data?.state])]);
  const previousContent = useRef(contentVersion);
  useEffect(() => {
    if (previousContent.current !== contentVersion) {
      previousContent.current = contentVersion;
      // contentVersion 随任务轮询每 4 秒变化，而失效前缀 ['knowledgeLibrary','reading',scope]
      // 会前缀匹配到检索缓存 ['knowledgeLibrary','reading',scope,'search',...]，导致每轮轮询
      // 都把检索标记过期并后台重取（用户看到"待机一会儿又主动检索"）。检索结果只依赖集合与
      // 检索词，不随任务状态变化，这里精确失效 slices/content 等读取缓存，跳过 search。
      void client.invalidateQueries({
        predicate: query => Array.isArray(query.queryKey)
          && query.queryKey[0] === 'knowledgeLibrary'
          && query.queryKey[1] === 'reading'
          && query.queryKey[2] === scope
          && query.queryKey[3] !== 'search',
      });
    }
  }, [client, scope, contentVersion]);
  const previousScope = useRef(scope);
  useEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope; setDrawer(null); setUpload(false); setNewBindings([]); setChunkReports([]);
    }
  }, [scope]);
  useEffect(() => {
    if (drawer && drawer.type !== 'search' && !documents.some(doc => doc.doc_id === drawer.source.docId)) setDrawer(null);
  }, [drawer, sourceVersion]);
  const chunkCount = chunkReports.find(report => report.sourceVersion === sourceVersion);
  const rawError = sourceQuery.error?.message ?? savedBindings.error?.message;
  const refresh = () => { void Promise.all([
    client.invalidateQueries({ queryKey: [...knowledgeKeys.all, 'statistics'] }),
    client.invalidateQueries({ queryKey: knowledgeKeys.collection(context.serviceInstanceId, context.collection) }),
    client.invalidateQueries({ queryKey: knowledgeKeys.reading(context.serviceInstanceId, context.collection, context.knowledgeBaseId) }),
  ]); };
  const refreshing = sourceQuery.isFetching || savedBindings.isFetching || jobs.queries.some(query => query.isFetching) || sliceData.fetching;
  const rememberTrigger = () => { if (!drawer) drawerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };
  const openDocument = (source: SourceRef, sliceIndex?: number) => {
    const trusted = sourceMappings.find(item => item.docId === source.docId);
    if (!trusted) return;
    rememberTrigger();
    setDrawer({ type: 'document', source: { docId: trusted.docId, displayName: trusted.name, ...(trusted.version !== undefined ? { version: trusted.version } : {}), ...(source.locateText !== undefined ? { locateText: source.locateText } : {}) }, ...(sliceIndex !== undefined ? { sliceIndex } : {}) });
  };
  const openSlice = (selection: { slice: KnowledgeSlice; source: KnowledgeSource }) => {
    const trusted = sourceMappings.find(item => item.docId === selection.source.docId);
    if (trusted) { rememberTrigger(); setDrawer({ type: 'slice', slice: selection.slice, source: trusted }); }
  };
  const chunkReport = useCallback((report: ChunkCountReport) => {
    if (Number.isInteger(report.count) && report.count >= 0 && typeof report.sourceVersion === 'string' && report.serviceInstanceId === context.serviceInstanceId && report.collection === context.collection && report.knowledgeBaseId === context.knowledgeBaseId) {
      // Keep reports by version so a child layout effect or a late old response
      // cannot replace the current version's count. Bound history to eight reports.
      setChunkReports(previous => [...previous.filter(item => item.sourceVersion !== report.sourceVersion).slice(-7), report]);
    }
  }, [context.serviceInstanceId, context.collection, context.knowledgeBaseId]);
  async function cancel(jobId: string) {
    setActionError(''); setCancelRequested(old => new Set(old).add(jobId));
    try { const snapshot = await knowledgeApi.cancelJob(context.serviceInstanceId, jobId); client.setQueryData<typeof snapshot>(knowledgeKeys.job(context.serviceInstanceId, context.collection, jobId), current => latestJobSnapshot(current, snapshot)); jobs.refresh(); }
    catch (error) { setActionError((error as Error).message); setCancelRequested(old => { const next = new Set(old); next.delete(jobId); return next; }); }
  }
  function recordDeleted(deleted: SourceJobBinding) {
    // Keep source bindings intact. Update each cache and the local session so an
    // older in-flight refresh cannot bring a removed task row back.
    setDeletedRecordKeys(old => new Set(old).add(JSON.stringify([deleted.serviceInstanceId, deleted.collection, deleted.jobId])));
    const updateBinding = (binding: SourceJobBinding) => binding.jobId === deleted.jobId && deleted.taskRecordDeletedAt ? { ...binding, taskRecordDeletedAt: deleted.taskRecordDeletedAt } : binding;
    setNewBindings(old => old.map(updateBinding));
    client.setQueryData<SourceJobBinding[]>(knowledgeKeys.bindings(deleted.serviceInstanceId, deleted.collection, context.knowledgeBaseId), current => current?.map(updateBinding));
    client.setQueryData<SourceListData>(knowledgeKeys.sources(deleted.serviceInstanceId, deleted.collection, context.knowledgeBaseId), current => current ? { ...current, bindings: current.bindings.map(updateBinding) } : current);
  }
  async function recover() {
    if (recovering) return;
    setRecovering(true); setActionError(''); setRecoveryNotice('');
    try {
      const result = await knowledgeApi.recoverSubmissions(context.serviceInstanceId, context.collection, context.knowledgeBaseId);
      setRecoveryNotice(`已核对并恢复 ${result.recovered} 条提交记录，${result.unresolved} 条仍待确认。无法匹配的记录不会自动重传。`);
      refresh();
    } catch (error) { setActionError((error as Error).message); }
    finally { setRecovering(false); }
  }
  const fileStats = summarizeKnowledgeFiles(documents, bindings, jobMap, jobErrors, sliceData.queries);
  const statesAvailable = sourceQuery.isSuccess;
  const verifiedChunkCount = sliceData.count ?? (sliceData.errors.length === 0 && chunkCount?.complete && !chunkCount.error ? chunkCount.count : undefined);
  const displayedChunkCount = sliceData.complete ? verifiedChunkCount : base?.chunkCount ?? verifiedChunkCount;
  const stats = [['原始文件', sourceQuery.isSuccess ? documents.length : base?.fileCount ?? '—'], ['知识切片', displayedChunkCount ?? '—'], ['已处理文件', statesAvailable ? fileStats.done : '—'], ['处理中', statesAvailable ? fileStats.processing : '—'], ['异常文件', statesAvailable ? fileStats.failed : '—']] as const;
  return <>
    <Link className="kl-back" to="/knowledge"><ArrowLeft size={15}/>返回知识库</Link>
    <header className="kl-page-head"><div><span className="kl-eyebrow">{base ? 'KNOWLEDGE LIBRARY' : 'CLIENT SUBMISSIONS'}</span><h1>{base?.name ?? '当前身份上传记录'}</h1><p>{base?.description ?? `仅展示当前身份向 ${context.collection || '未配置集合'} 提交并成功关联的文件与任务。`}</p></div><div className="kl-actions"><button ref={searchTrigger} disabled={!slots.searchPanel || !context.collection} title={slots.searchPanel ? '检索当前集合' : '检索面板由 B 接入'} onClick={() => { rememberTrigger(); setDrawer({ type: 'search' }); }}><Search size={16}/>知识检索</button><button className="kl-primary" disabled={!context.capabilities.canUpload} onClick={() => setUpload(true)}><Upload size={16}/>上传文件</button>{base && <LibraryMenu name={base.name} onEdit={onEdit} onDelete={onDelete}/>}</div></header>
    {!context.collection ? <div className="kl-empty"><h2>请先配置目标 collection</h2><p>使用服务方提供的明确集合名称后，即可上传和恢复当前身份记录。</p><button className="kl-primary" onClick={onConfigure}>配置服务连接</button></div> : <>
      <section className="kl-stats kl-detail-stats">{stats.map(([label, value]) => <article key={label}><div><span>{label}</span></div><strong>{value}</strong></article>)}</section>
      {unconfirmed.error && <p role="alert" className="kl-notice kl-error-text">提交记录读取失败：{unconfirmed.error.message}</p>}
      {actionError && <p role="alert" className="kl-notice kl-error-text">{actionError}</p>}
      {recoveryNotice && <p role="status" className="kl-notice">{recoveryNotice}</p>}
      {Boolean(unconfirmed.data?.length) && <div className="kl-notice">提交结果中断后可查询服务中的真实任务和原件。<button disabled={recovering} onClick={() => void recover()}>{recovering ? '正在核对……' : '核对并恢复提交记录'}</button></div>}
      {(unconfirmed.data ?? []).filter(item => !allBindings.some(binding => binding.clientUploadId === item.clientUploadId)).map(item => <div className="kl-notice" key={item.clientUploadId}><strong>{item.displayName} · 提交结果待确认</strong><p>尚未取得已确认的任务编号。正在提交时请等待；连接中断后请核对服务记录，避免重复上传。</p><small>服务存储名：{item.physicalName} · {new Date(item.submittedAt).toLocaleString()}</small></div>)}
      <Tabs.Root defaultValue="sources"><Tabs.List className="kl-tabs" aria-label="知识库内容"><Tabs.Trigger value="sources">原始文件</Tabs.Trigger><Tabs.Trigger value="chunks">知识切片</Tabs.Trigger></Tabs.List><Tabs.Content value="sources"><SourceList context={context} documents={documents} bindings={bindings} jobs={jobMap} jobErrors={jobErrors} loading={sourceQuery.isPending} error={rawError} onRefresh={refresh} onUpload={() => setUpload(true)} onOpenDocument={openDocument} previewAvailable={Boolean(slots.documentPanel)} cancelling={cancelRequested} onCancelJob={cancel} verifiedServerDocIds={base ? sourceQuery.data?.verifiedServerDocIds ?? [] : []} unclassifiedCount={base ? sourceQuery.data?.unclassifiedCount ?? 0 : 0}/></Tabs.Content><Tabs.Content value="chunks">{slots.chunksPanel ? slots.chunksPanel({ context, sources: documents, sourceMappings, sourceVersion, onChunkCount: chunkReport, onOpenDocument: openDocument, onOpenSlice: openSlice }) : <div className="kl-empty"><h2>知识切片面板待接入</h2><p>B 可通过 chunksPanel 插槽接入切片列表与详情。</p></div>}</Tabs.Content></Tabs.Root>
      <section className="kl-task-section"><header><div><h2>上传处理任务</h2><p>记录可能被服务清理，缺失时请核对原件和入库结果。服务时间未标注时区。</p></div><button disabled={refreshing} onClick={refresh}>{refreshing ? '正在刷新……' : '刷新任务'}</button></header>{!taskBindings.length ? <p className="kl-muted">暂无处理任务记录</p> : taskBindings.slice().reverse().map(binding => {
        const job = jobMap.get(binding.jobId); const query = jobs.queries[jobs.ids.indexOf(binding.jobId)]; const active = job && ['queued','running'].includes(job.state);
        return <article key={binding.jobId}><div><strong>{binding.displayName}</strong><small>{binding.jobId} · 提交于 {new Date(binding.submittedAt).toLocaleString()}</small>{!binding.docId && <small>原件尚未关联；刷新文件列表后按精确路径核对。</small>}</div><JobStatus job={job} missing={jobErrors.has(binding.jobId)}/>{query?.error && <p className="kl-error-text">{query.error.message}</p>}<div className="kl-task-actions">{active && <button disabled={cancelRequested.has(binding.jobId)} onClick={() => void cancel(binding.jobId)}>{cancelRequested.has(binding.jobId) ? '等待取消生效' : '取消任务'}</button>}{job && ['failed','interrupted','cancelled'].includes(job.state) && <button onClick={() => setUpload(true)}>重新选择原件</button>}{job && isTerminalJobState(job.state) && <button className="kl-delete-task-button" onClick={() => setRecordToDelete(binding)}><Trash2 size={14}/>删除记录</button>}</div></article>;
      })}</section>
    </>}
    {recordToDelete && <DeleteJobRecordDialog key={recordToDelete.jobId} binding={recordToDelete} onClose={() => setRecordToDelete(null)} onDeleted={recordDeleted}/>}
    {upload && <UploadDialog context={context} connection={connection} onClose={() => setUpload(false)} onSubmitted={binding => { setNewBindings(old => [...old, binding]); refresh(); }}/>}
    <Dialog.Root open={Boolean(drawer)} onOpenChange={open => { if (!open) setDrawer(null); }}><Dialog.Portal><Dialog.Overlay className="kl-modal-overlay"/><Dialog.Content className="kl-content-drawer kl-module" onCloseAutoFocus={event => { event.preventDefault(); if (drawerTrigger.current?.isConnected) drawerTrigger.current.focus(); else searchTrigger.current?.focus(); }}><header><Dialog.Title>{drawer?.type === 'document' ? drawer.source.displayName : drawer?.type === 'slice' ? '知识切片详情' : '知识检索'}</Dialog.Title><button className="kl-icon-button" aria-label="关闭内容面板" onClick={() => setDrawer(null)}><X size={20}/></button></header><Dialog.Description className="kl-sr-only">当前知识来源的内容面板</Dialog.Description>{drawer?.type === 'document' ? slots.documentPanel?.({ source: drawer.source, context, sources: sourceMappings, ...(drawer.sliceIndex !== undefined ? { sliceIndex: drawer.sliceIndex } : {}), onClose: () => setDrawer(null) }) : drawer?.type === 'search' ? slots.searchPanel?.({ context, sources: sourceMappings, sourceVersion: contentVersion, onOpenDocument: openDocument, onClose: () => setDrawer(null) }) : drawer?.type === 'slice' ? slots.slicePanel?.({ slice: drawer.slice, source: drawer.source, onOpenDocument: openDocument, onSaveSlice: async input => {
        // 切片正文与向量在上游，KLA 只保存本身份的覆盖内容；保存后刷新该文档相关的全部缓存
        // （切片列表、正文、检索命中都要拿到新内容），因此按 docId 精确失效而不是整表清空。
        await knowledgeApi.updateSlice({ serviceInstanceId: context.serviceInstanceId, docId: drawer.source.docId, sliceId: input.sliceId, title: input.title, content: input.content, collection: context.collection });
        await client.invalidateQueries({ predicate: query => JSON.stringify(query.queryKey ?? '').includes(drawer.source.docId) });
      } }) : null}</Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
