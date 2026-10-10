import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { KnowledgeBase, KnowledgeConnection, KnowledgeContext } from '@kla-workstation/contracts/knowledge';
import { knowledgeApi, knowledgeKeys } from './api';
import { KnowledgeOverview, type LibraryOverviewData } from './KnowledgeOverview';
import { KnowledgeDetail } from './KnowledgeDetail';
import { ConnectionDialog } from './ConnectionDialog';
import type { KnowledgeSlots } from './slots';
import { KNOWLEDGE_SERVICE_URL, useLibraryCatalog, type LibraryEntry } from './catalog';
import { LibraryDialog } from './LibraryDialog';
import { DeleteLibraryDialog } from './DeleteLibraryDialog';
import { useLibraryConnection } from './useLibraryConnection';
import { knowledgeReadingSlots } from './ReadingSlots';
import { useSources } from './queries/sources';
import { useKnowledgeSlices } from './queries/slices';
import { latestJobHistory } from './queries/jobs';
import './overview.css';

export interface KnowledgePageProps { view?: 'overview' | 'detail' | 'uploads'; slots?: KnowledgeSlots; libraries?: LibraryOverviewData; loadingLibraries?: boolean; libraryError?: string; onRetryLibraries?: () => void }
export function KnowledgePage({ view = 'overview', slots = {}, libraries, loadingLibraries, libraryError, onRetryLibraries }: KnowledgePageProps): React.JSX.Element {
  const client = useQueryClient(); const { id } = useParams(); const navigate = useNavigate(); const [configuring, setConfiguring] = useState(false);
  const catalog = useLibraryCatalog();
  const [editing, setEditing] = useState<LibraryEntry | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LibraryEntry | null>(null);
  const [notice, setNotice] = useState('');
  const connection = useQuery({ queryKey: knowledgeKeys.connection, queryFn: knowledgeApi.connection, retry: false });
  const health = useQuery({ queryKey: [...knowledgeKeys.all, connection.data?.serviceInstanceId, 'health'], queryFn: () => knowledgeApi.health(connection.data!.serviceInstanceId), enabled: connection.data?.baseUrl === KNOWLEDGE_SERVICE_URL, retry: false, refetchInterval: 30000 });
  const config = connection.data;
  const listedCollection = catalog.entries.some(entry => entry.collection === config?.collection);
  const activeCollection = config && config.baseUrl === KNOWLEDGE_SERVICE_URL && (view !== 'overview' || listedCollection || libraries) ? config.collection : '';
  const activeEntry = catalog.entries.find(entry => entry.id === id && entry.collection === activeCollection)
    ?? catalog.entries.find(entry => entry.collection === activeCollection);
  const activeContext: KnowledgeContext = { serviceInstanceId: config?.serviceInstanceId ?? '', collection: activeCollection, ...(activeEntry ? { knowledgeBaseId: activeEntry.id } : {}), attribution: 'collection-files', capabilities: { hasLibraryMetadata: false, hasScopeAuthorization: false, canUpload: false, canCancel: true, canRetryText: false, hasPreview: true } };
  const sources = useSources(activeContext);
  const jobs = useQuery({ queryKey: knowledgeKeys.jobs(activeContext.serviceInstanceId, activeContext.collection), queryFn: async () => { const incoming = await knowledgeApi.jobs(activeContext.serviceInstanceId); return latestJobHistory(client.getQueryData(knowledgeKeys.jobs(activeContext.serviceInstanceId, activeContext.collection)), incoming); }, enabled: Boolean(activeCollection), retry: false, refetchInterval: 10000 });
  const records = jobs.data?.jobs ?? [];
  const sliceData = useKnowledgeSlices(activeContext, sources.data?.documents ?? [], { enabled: sources.isSuccess && Boolean(activeCollection), processing: records.some(job => ['queued', 'running'].includes(job.state)), pollIntervalMs: config?.settings.pollIntervalMs ?? 4000 });
  const sliceCount = sliceData.count;
  const names = new Map(sources.data?.bindings.map(binding => [binding.docId, binding.displayName]));
  const localBases: KnowledgeBase[] = catalog.entries.map(entry => {
    const current = entry.id === activeContext.knowledgeBaseId;
    const status = health.isError || (current && (sources.isError || jobs.isError)) ? 'error' : health.data?.status !== 'ok' ? 'pending' : current && records.some(job => ['queued', 'running'].includes(job.state)) ? 'processing' : 'ready';
    return { ...entry, status, context: { ...activeContext, collection: entry.collection, knowledgeBaseId: entry.id, scope: entry.scope, ...(entry.projectId ? { projectId: entry.projectId } : {}), ...(entry.organizationId ? { organizationId: entry.organizationId } : {}), ...(entry.personalIdentityId ? { personalIdentityId: entry.personalIdentityId } : {}), capabilities: { ...activeContext.capabilities, canUpload: current && entry.canWrite === true } }, sourceDocIds: [],
      ...(current && sources.isSuccess ? { fileCount: sources.data.documents.length, sourceNames: sources.data.documents.map(doc => names.get(doc.doc_id) ?? doc.name) } : {}), ...(current && sliceCount !== undefined ? { chunkCount: sliceCount } : {}),
    };
  });
  const overview = libraries ?? { bases: localBases, localCatalog: true, collection: activeCollection, stats: { libraries: localBases.length, ...(sources.isSuccess && activeCollection ? { files: sources.data.documents.length } : {}), ...(sliceCount !== undefined && activeCollection ? { chunks: sliceCount } : {}), ...(jobs.isSuccess && activeCollection ? { processing24h: `${records.filter(job => ['queued', 'running'].includes(job.state)).length} 处理中 · ${records.filter(job => ['failed', 'interrupted'].includes(job.state)).length} 异常` } : {}) } };
  const base = overview.bases.find(item => item.id === id);
  const selectedEntry = catalog.entries.find(entry => entry.id === id);
  const targetCollection = view === 'detail' ? base?.context.collection : view === 'uploads' ? config?.collection || catalog.entries[0]?.collection : listedCollection ? config?.collection : catalog.entries[0]?.collection;
  const autoConnection = useLibraryConnection(config, targetCollection, configuring || Boolean(editing) || Boolean(deleting) || Boolean(catalog.error));
  const resolvedSlots = { ...knowledgeReadingSlots, ...slots };
  const context: KnowledgeContext | undefined = config ? base?.context ?? {
    serviceInstanceId: config.serviceInstanceId, collection: config.collection, attribution: 'client-submissions',
    capabilities: { hasLibraryMetadata: false, hasScopeAuthorization: false, canUpload: false, canCancel: true, canRetryText: false, hasPreview: false },
  } : undefined;
  function saved(next: KnowledgeConnection) {
    void client.cancelQueries({ queryKey: knowledgeKeys.all });
    client.removeQueries({ queryKey: knowledgeKeys.all }); client.setQueryData(knowledgeKeys.connection, next); setConfiguring(false);
  }
  const openConnection = () => { if (!autoConnection.connecting) setConfiguring(true); };
  const editEntry = (entryId: string) => { const entry = catalog.entries.find(item => item.id === entryId); if (entry?.canWrite && !autoConnection.connecting) setEditing(entry); };
  const deleteEntry = (entryId: string) => { const entry = catalog.entries.find(item => item.id === entryId); if (entry?.canWrite && !autoConnection.connecting) setDeleting(entry); };
  const refresh = () => { void client.invalidateQueries({ queryKey: knowledgeKeys.all }); void catalog.refresh(); onRetryLibraries?.(); };
  return <main className="kl-module kl-page">
    {connection.error && <div className="kl-notice kl-error-text" role="alert">{connection.error.message}<button onClick={() => setConfiguring(true)}>配置连接</button></div>}
    {health.error && <div className="kl-notice kl-error-text" role="alert">{health.error.message}</div>}
    {catalog.error && <div className="kl-notice kl-error-text" role="alert">{catalog.error}</div>}
    {autoConnection.error && <div className="kl-notice kl-error-text" role="alert">自动连接失败：{autoConnection.error}<button onClick={autoConnection.retry}>重新连接</button></div>}
    {notice && <div className="kl-notice" role="status">{notice}</div>}
    {view === 'overview' ? <KnowledgeOverview data={overview} loading={loadingLibraries ?? catalog.loading} error={libraryError} onRetry={refresh} onConfigure={openConnection} onCreate={() => { if (!autoConnection.connecting) setEditing('new'); }} onEdit={editEntry} onDelete={deleteEntry}/> : view === 'detail' && !base ? <div className="kl-empty"><h2>{loadingLibraries ? '正在加载知识库……' : '没有找到此知识库'}</h2><p>{libraryError ?? '请从知识库列表选择一个分组。'}</p><Link to="/knowledge">返回集团知识中心</Link></div> : config && targetCollection && !autoConnection.matches ? <><Link className="kl-back" to="/knowledge">← 返回知识库</Link><div className="kl-empty" aria-busy={autoConnection.connecting}><h2>{base?.name ?? '当前身份上传记录'}</h2><p>{autoConnection.error || catalog.error ? '连接未完成，请查看上方提示。' : `正在自动连接 ${KNOWLEDGE_SERVICE_URL} · ${targetCollection}……`}</p>{autoConnection.error && <button className="kl-primary" onClick={autoConnection.retry}>重新连接</button>}</div></> : context && config ? <KnowledgeDetail key={`${context.serviceInstanceId}:${context.collection}:${base?.id ?? 'submissions'}`} context={context} connection={config} base={base} slots={resolvedSlots} onConfigure={openConnection} onEdit={selectedEntry?.canWrite ? () => editEntry(selectedEntry.id) : undefined} onDelete={selectedEntry?.canWrite ? () => deleteEntry(selectedEntry.id) : undefined}/>
      : <div className="kl-empty"><h2>{connection.isPending ? '正在准备HTTP 接口……' : '知识服务尚未就绪'}</h2><button onClick={openConnection}>配置连接</button></div>}
    {editing && <LibraryDialog {...(editing !== 'new' ? { entry: editing } : {})} onClose={() => setEditing(null)} onSave={async entry => { const created = editing === 'new'; await catalog.save(entry); setEditing(null); if (created) navigate(`/knowledge/bases/${encodeURIComponent(entry.id)}`); }}/>}
    {deleting && <DeleteLibraryDialog entry={deleting} onClose={() => setDeleting(null)} onDelete={async () => {
      await catalog.remove(deleting.id); setNotice(`已删除当前身份知识库「${deleting.name}」，服务器数据保留。`); setDeleting(null);
      if (id === deleting.id) navigate('/knowledge');
    }}/>}
    {configuring && <ConnectionDialog connection={config} fixedBaseUrl={KNOWLEDGE_SERVICE_URL} fixedCollection={targetCollection} onClose={() => setConfiguring(false)} onSaved={saved}/>}
  </main>;
}
