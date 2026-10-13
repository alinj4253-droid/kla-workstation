import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Download, FileText, Folder, LoaderCircle, RefreshCw, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { klaApi } from '../api/client';

export type RoomArtifact = { id: string; name: string; mimeType: string; content: string; contentEncoding?: 'utf8' | 'base64'; storageKey?: string | null; sourceKind?: 'file' | 'artifact'; sizeBytes: number; createdAt: string };
export type RoomRun = { id: string; status: string; phase?: string; currentAgent?: string; createdAt?: string; updatedAt?: string; result?: { waitingReason?: string; error?: string } };
export type RunStep = { id: string; step_index: number; title: string; instruction: string; status: string; result?: { text?: string; error?: string; agentName?: string }; agent_snapshot?: { name?: string }; updated_at?: string };
export type RunEvent = { sequence: number; run_id: string; kind: string; payload: Record<string, unknown>; created_at: string };
export type ProjectItem = { id: string; name: string; description: string; groupIds?: string[] };
export type RoomItem = { id: string; name: string; projectId?: string };

const done = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
const statusName = (status: string) => ({ queued: '排队中', running: '执行中', waiting_device: '等待本地设备', waiting_tool: '工具调用中', waiting_approval: '等待本地授权', completed: '已完成', failed: '失败', cancelled: '已终止' })[status as 'queued'] ?? status;

export function MarkdownMessage({ text }: { text: string }) {
  return <div className="ws-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  }}>{text}</ReactMarkdown></div>;
}

function eventLabel(event: RunEvent): string {
  const data = event.payload;
  switch (event.kind) {
    case 'plan.created': return '统筹智能体已拆解任务';
    case 'step.running': return `${String(data.agentName ?? '执行智能体')} · ${String(data.title ?? '执行任务')}`;
    case 'step.waiting_device': return '等待本地执行设备上线';
    case 'step.completed': return `${String(data.agentName ?? '执行智能体')}已完成任务`;
    case 'tool.queued': return `准备调用 ${String(data.tool ?? '工具')}`;
    case 'tool.dispatched': return `正在调用 ${String(data.tool ?? '本地工具')}`;
    case 'tool.receipt': return `工具执行${data.status === 'completed' ? '完成' : '结束'}`;
    case 'tool.completed': return `${String(data.tool ?? '服务端工具')}调用${data.status === 'completed' ? '完成' : '失败'}`;
    case 'memory.recalled': return '已读取本群聊短期记忆';
    case 'memory.captured': return '已保存短期记忆';
    case 'run.completed': return '任务已完成';
    case 'message.created': return '智能体已发送回复';
    default: return event.kind.replaceAll('.', ' · ');
  }
}

function eventDetail(event: RunEvent): string {
  const data = event.payload;
  if (event.kind === 'plan.created' && Array.isArray(data.tasks)) return data.tasks.map((task, index) => `${index + 1}. ${String((task as { title?: string }).title ?? '执行任务')}`).join('\n');
  if (event.kind === 'step.waiting_device') return String(data.reason ?? '等待本地执行设备上线');
  if (event.kind.startsWith('tool.')) return [data.tool ? `工具：${String(data.tool)}` : '', data.location ? `位置：${data.location === 'local' ? '本地设备' : '服务端'}` : '', data.status ? `状态：${statusName(String(data.status))}` : '', data.deviceId ? '已分配执行设备' : ''].filter(Boolean).join(' · ') || '工具调用状态已更新';
  if (event.kind === 'memory.recalled') return `命中 ${String(data.count ?? 0)} 条短期记忆`;
  if (event.kind === 'step.running') return `${String(data.agentName ?? '智能体')} · ${String(data.title ?? '执行任务')}`;
  return new Date(event.created_at).toLocaleString('zh-CN');
}

export function RunActivity({ run, steps, events, submitting, onCancel }: { run: RoomRun | null; steps: RunStep[]; events: RunEvent[]; submitting: boolean; onCancel: () => void }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const active = submitting || (run ? !done(run.status) : false);
  useEffect(() => { setOpen(true); setExpanded(null); }, [run?.id]);
  useEffect(() => { if (run && done(run.status)) setOpen(false); }, [run?.status]);
  useEffect(() => { if (open && pinnedRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [open, steps.length, events.length]);
  if (!run && !submitting) return null;
  const phase = submitting ? '正在提交消息' : run?.status === 'failed' ? '执行失败' : run?.status === 'cancelled' ? '已终止' : run?.status === 'completed' ? '已完成' : run?.status === 'waiting_device' ? '等待本地设备' : run?.status === 'waiting_approval' ? '等待本地授权' : run?.status === 'waiting_tool' ? '调用工具中' : run?.phase === 'coordination' ? '统筹智能体 · 正在规划' : run?.phase === 'summary' ? '统筹智能体 · 正在汇总' : '智能体 · 执行中';
  const visibleEvents = events.filter(event => event.run_id === run?.id);
  return <div className="ws-run-activity" aria-live="polite">
    <div className="ws-run-header"><span className="ws-avatar">统</span><strong>{run?.currentAgent ?? '统筹智能体'}</strong><button className={`ws-run-status ${active ? 'is-active' : 'is-done'}`} aria-expanded={open} onClick={() => setOpen(value => !value)}>{active ? <LoaderCircle size={13} /> : <Check size={13} />}<span>{phase}</span><ChevronDown size={13} /></button>{active && !submitting && <button className="ws-run-cancel" onClick={onCancel}>终止生成</button>}</div>
    {open && <div className="ws-run-log" ref={logRef} onScroll={event => { const el = event.currentTarget; pinnedRef.current = el.scrollHeight - el.clientHeight - el.scrollTop < 80; }}>
      {steps.map(step => <button className={`ws-run-row ${step.status === 'running' ? 'is-active' : ''}`} key={step.id} onClick={() => setExpanded(value => value === step.id ? null : step.id)} aria-expanded={expanded === step.id}><span className="ws-run-dot">{step.status === 'completed' ? <Check size={10} /> : null}</span><span className="ws-run-row-main"><span>{step.title}</span>{expanded === step.id && <small>{step.agent_snapshot?.name && `${step.agent_snapshot.name} · `}{step.result?.error ?? step.result?.text ?? step.instruction}</small>}</span><em>{statusName(step.status)}</em></button>)}
      {visibleEvents.map(event => <button className="ws-run-row" key={event.sequence} onClick={() => setExpanded(value => value === `event-${event.sequence}` ? null : `event-${event.sequence}`)} aria-expanded={expanded === `event-${event.sequence}`}><span className="ws-run-dot">{event.kind.endsWith('completed') ? <Check size={10} /> : null}</span><span className="ws-run-row-main"><span>{eventLabel(event)}</span>{expanded === `event-${event.sequence}` && <small>{eventDetail(event)}</small>}</span><em>{new Date(event.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</em></button>)}
      {!steps.length && !visibleEvents.length && <div className="ws-run-empty">{run?.result?.waitingReason ?? '正在等待服务端返回执行步骤…'}</div>}
      {run?.result?.error && <div className="ws-run-error">{run.result.error}</div>}
    </div>}
  </div>;
}

type ProjectTab = 'board' | 'detail' | 'progress' | 'nodes' | 'settings';
export function ProjectWorkspace({ project, rooms, onOpenRoom, onCreateRoom, onCreateProject, notify }: { project: ProjectItem; rooms: RoomItem[]; onOpenRoom: (id: string) => void; onCreateRoom: () => void; onCreateProject?: () => void; notify: (message: string) => void }) {
  const [tab, setTab] = useState<ProjectTab>('board');
  const [runs, setRuns] = useState<Array<RoomRun & { roomId: string; roomName: string }>>([]);
  const [artifacts, setArtifacts] = useState(0);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const projectRooms = useMemo(() => rooms.filter(room => room.projectId === project.id), [rooms, project.id]);
  useEffect(() => { setTab('board'); }, [project.id]);
  useEffect(() => {
    if (!project.id) { setRuns([]); setArtifacts(0); return; }
    let cancelled = false;
    setLoading(true);
    void Promise.all(projectRooms.map(async room => {
      const [runResult, artifactResult] = await Promise.all([klaApi.request<RoomRun[]>(`/v1/conversations/${room.id}/runs`), klaApi.request<RoomArtifact[]>(`/v1/conversations/${room.id}/artifacts`)]);
      return { room, runResult, artifactResult };
    })).then(results => {
      if (cancelled) return;
      setRuns(results.flatMap(({ room, runResult }) => runResult.ok ? runResult.data.map(run => ({ ...run, roomId: room.id, roomName: room.name })) : []));
      setArtifacts(results.reduce((sum, { artifactResult }) => sum + (artifactResult.ok ? artifactResult.data.length : 0), 0));
      if (results.some(({ runResult, artifactResult }) => !runResult.ok || !artifactResult.ok)) notifyRef.current('部分项目执行数据暂不可用');
    }).catch(() => { if (!cancelled) notifyRef.current('项目数据加载失败，请重试'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project.id, projectRooms, revision]);
  const completed = runs.filter(run => run.status === 'completed').length;
  const active = runs.filter(run => !done(run.status)).length;
  const failed = runs.filter(run => run.status === 'failed').length;
  const progress = runs.length ? Math.round(completed / runs.length * 100) : 0;
  const tabNames: Array<[ProjectTab, string]> = [['board', '项目看板'], ['detail', '项目详情'], ['progress', '项目进度'], ['nodes', '项目节点'], ['settings', '项目设置']];
  return <div className="ws-project-workspace">
    <header className="ws-project-intro"><span className="ws-project-icon"><Folder size={23} /></span><div><h1>{project.name} <span>{projectRooms.length} 个关联群组</span></h1><p>{project.description}</p><small>项目执行数据来自关联群聊的真实任务记录</small></div><div className="ws-project-actions"><button onClick={() => setRevision(value => value + 1)} disabled={loading}><RefreshCw size={14} />刷新看板</button><button onClick={onCreateRoom}><Folder size={14} />新建群组</button>{onCreateProject && <button onClick={onCreateProject}><Folder size={14} />创建项目</button>}</div></header>
    <div className="ws-project-groups"><small>本项目关联的群组</small><div>{projectRooms.length ? projectRooms.map(room => <button aria-label="打开项目关联群组" key={room.id} onClick={() => onOpenRoom(room.id)}>{room.name}<ArrowRight size={13} /></button>) : <span>暂无关联群组</span>}<button className="add" onClick={onCreateRoom}>＋ 归入群组</button></div></div>
    <div className="ws-project-tabs" role="tablist" aria-label="项目视图">{tabNames.map(([id, name]) => <button role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>{name}</button>)}</div>
    {loading && <div className="ws-project-loading"><LoaderCircle size={15} /> 正在同步项目执行数据…</div>}
    {tab === 'board' && <><div className="ws-project-metrics"><div><small>整体完成度</small><strong>{progress}%</strong><span>基于已记录的 {runs.length} 项任务</span></div><div><small>已完成任务</small><strong>{completed} / {runs.length}</strong><span>关联群聊任务</span></div><div><small>执行中</small><strong>{active}</strong><span>实时运行任务</span></div><div><small>成果文件</small><strong>{artifacts}</strong><span>已归档到群聊</span></div></div><div className="ws-project-columns"><section><h2>执行趋势</h2><p>最近 7 天 · 关联群聊任务</p><div className="ws-project-bars">{Array.from({ length: 7 }, (_, i) => { const date = new Date(); date.setDate(date.getDate() - 6 + i); const count = runs.filter(run => run.createdAt?.slice(0, 10) === date.toISOString().slice(0, 10)).length; return <div key={i}><i style={{ height: `${Math.max(3, count / Math.max(1, runs.length) * 100)}%` }} /><small>{date.getMonth() + 1}/{date.getDate()}</small></div>; })}</div></section><section><h2>任务状态分布</h2><p>共 {runs.length} 项</p><div className="ws-project-distribution"><i style={{ width: `${progress}%` }} /></div><div className="ws-project-statuses"><span>已完成 <b>{completed}</b></span><span>执行中 <b>{active}</b></span><span>失败 <b>{failed}</b></span><span>其他 <b>{Math.max(0, runs.length - completed - active - failed)}</b></span></div>{!runs.length && <p className="ws-project-empty">关联群组产生执行后，数据会汇总到这里。</p>}</section></div></>}
    {tab === 'detail' && <div className="ws-project-columns"><section><h2>项目信息</h2><dl><dt>项目名称</dt><dd>{project.name}</dd><dt>项目编号</dt><dd>{project.id}</dd><dt>项目说明</dt><dd>{project.description}</dd><dt>关联群组</dt><dd>{projectRooms.length} 个</dd></dl></section><section><h2>协作群组</h2>{projectRooms.length ? projectRooms.map(room => <button className="ws-project-room" key={room.id} onClick={() => onOpenRoom(room.id)}>{room.name}<ArrowRight size={14} /></button>) : <p className="ws-project-empty">暂无协作群组</p>}</section></div>}
    {tab === 'progress' && <div className="ws-project-columns"><section><h2>项目进度</h2><p>按群聊任务实际状态计算</p><strong className="ws-project-progress-value">{progress}%</strong><div className="ws-project-distribution"><i style={{ width: `${progress}%` }} /></div><p>已完成 {completed} 项，剩余 {runs.length - completed} 项</p></section><section><h2>群组执行情况</h2>{projectRooms.map(room => { const tasks = runs.filter(run => run.roomId === room.id); return <button className="ws-project-room" key={room.id} onClick={() => onOpenRoom(room.id)}>{room.name}<small>{tasks.filter(run => run.status === 'completed').length} / {tasks.length} 项完成</small><ArrowRight size={14} /></button>; })}</section></div>}
    {tab === 'nodes' && <section className="ws-project-node-list"><h2>项目节点</h2><p>按最近执行时间排列的真实群聊任务</p>{runs.length ? [...runs].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map(run => <button key={run.id} onClick={() => onOpenRoom(run.roomId)}><span className="ws-run-dot">{run.status === 'completed' ? <Check size={10} /> : null}</span><span>{run.roomName}<small>{run.currentAgent ?? '统筹智能体'} · {run.updatedAt ? new Date(run.updatedAt).toLocaleString('zh-CN') : '等待更新'}</small></span><em>{statusName(run.status)}</em></button>) : <p className="ws-project-empty">暂无执行节点。先进入关联群聊发起任务。</p>}</section>}
    {tab === 'settings' && <section className="ws-project-node-list"><h2>项目设置</h2><dl><dt>项目名称</dt><dd>{project.name}</dd><dt>项目说明</dt><dd>{project.description}</dd><dt>关联群组</dt><dd>{projectRooms.length} 个</dd></dl><p className="ws-project-empty">项目编辑与权限配置接口尚未开放，此处仅展示当前服务端记录。</p></section>}
  </div>;
}

export function ArtifactPane({ artifacts, selected, loading, collapsed, onSelect, onCollapse, onClose, onDownload }: { artifacts: RoomArtifact[]; selected: RoomArtifact | null; loading: boolean; collapsed: boolean; onSelect: (id: string) => void; onCollapse: () => void; onClose: () => void; onDownload: (artifact: RoomArtifact) => void }) {
  if (collapsed) return <button className="ws-artifact-mini" title="展开成果预览" onClick={onCollapse}><FileText size={17} /><span>{artifacts.length}</span></button>;
  const mime = selected?.mimeType ?? '';
  return <aside className="ws-artifact-pane" aria-label="成果预览">
    <header><div className="ws-artifact-tabs">{[...artifacts, ...(selected?.sourceKind === 'file' ? [selected] : [])].map(artifact => <button key={artifact.id} className={artifact.id === selected?.id ? 'active' : ''} onClick={() => onSelect(artifact.id)} title={artifact.name}><FileText size={13} />{artifact.name}</button>)}</div><button title="收起预览" onClick={onCollapse}><ArrowRight size={16} /></button><button title="关闭预览" onClick={onClose}><X size={16} /></button></header>
    <div className="ws-artifact-meta">{selected ? `${selected.name} · 只读预览 · ${Math.max(1, Math.round((selected.sizeBytes ?? selected.content?.length ?? 0) / 1024))} KB` : loading ? '正在加载成果…' : '群组成果'}</div>
    <div className="ws-artifact-body">{loading ? <div className="ws-artifact-loading"><LoaderCircle size={20} />正在加载文件…</div>
      : !selected ? <div className="ws-artifact-loading">{artifacts.length ? '选择上方文件进行预览' : '当前群组还没有成果文件'}</div>
      : /\.pptx$/i.test(selected.name) ? <BinaryArtifactPreview artifact={selected} artifacts={artifacts} onSelect={onSelect} />
      : (selected.storageKey || selected.sourceKind === 'file') ? <StoredFilePreview artifact={selected} />
      : selected.contentEncoding === 'base64' ? <BinaryArtifactPreview artifact={selected} artifacts={artifacts} onSelect={onSelect} />
      : mime.includes('html') || /\.html?$/i.test(selected.name) ? <iframe title={selected.name} srcDoc={selected.content} sandbox="allow-scripts" />
      : /\.md$/i.test(selected.name) || mime.includes('markdown') ? <article><MarkdownMessage text={selected.content} /></article> : <pre>{selected.content}</pre>}</div>
    <footer>{selected && <button onClick={() => onDownload(selected)}><Download size={14} />下载</button>}<small>服务端成果 · 当前身份可见</small></footer>
  </aside>;
}

function StoredFilePreview({ artifact }: { artifact: RoomArtifact }) {
  const [content, setContent] = useState(''); const [url, setUrl] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const image = /^image\/(png|jpeg|gif|webp)$/i.test(artifact.mimeType), pdf = artifact.mimeType === 'application/pdf';
  const text = /^text\//i.test(artifact.mimeType) || /\.(md|txt|json|csv|xml|log|js|ts|py|css)$/i.test(artifact.name);
  const supported = (image || pdf || text) && artifact.sizeBytes <= 10 * 1024 * 1024;
  useEffect(() => {
    let disposed = false, objectUrl = '';
    setContent(''); setUrl(''); setError(''); setLoading(supported);
    if (supported) void klaApi.download(artifact.sourceKind === 'file' ? `/v1/files/${artifact.id}/content` : `/v1/artifacts/${artifact.id}/content`).then(async result => {
      if (!result.ok) throw new Error(result.message);
      if (disposed) return;
      if (text) { const value = await result.blob.text(); if (!disposed) setContent(value); }
      else { objectUrl = URL.createObjectURL(new Blob([result.blob], { type: artifact.mimeType })); setUrl(objectUrl); }
    }).catch((e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : '文件预览加载失败'); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifact.id, artifact.sourceKind, artifact.mimeType, supported, text]);
  if (!supported) return <div className="ws-artifact-loading"><FileText size={28} />此格式或大小暂不支持内嵌预览，可下载后打开。</div>;
  if (error) return <div className="ws-artifact-loading">{error}</div>;
  if (loading) return <div className="ws-artifact-loading"><LoaderCircle size={20} />正在加载文件…</div>;
  if (image) return <img src={url} alt={artifact.name} style={{ width: '100%', height: 'auto' }} />;
  if (pdf) return <iframe title={artifact.name} src={url} />;
  if (/html/i.test(artifact.mimeType)) return <iframe title={artifact.name} srcDoc={content} sandbox="allow-scripts" />;
  if (/markdown/i.test(artifact.mimeType) || /\.md$/i.test(artifact.name)) return <article><MarkdownMessage text={content} /></article>;
  return <pre>{content}</pre>;
}

function BinaryArtifactPreview({ artifact, artifacts, onSelect }: { artifact: RoomArtifact; artifacts: RoomArtifact[]; onSelect: (id: string) => void }): React.JSX.Element {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const previewable = artifact.mimeType === 'application/pdf' || artifact.mimeType === 'image/png';
  useEffect(() => {
    setUrl(''); setError('');
    if (!previewable || !artifact.content) return;
    let objectUrl = '';
    try {
      const decoded = atob(artifact.content);
      const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: artifact.mimeType }));
      setUrl(objectUrl);
    } catch { setError('文件内容无效，请重新加载成果'); }
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifact.id, artifact.content, artifact.mimeType, previewable]);
  if (error) return <div className="ws-artifact-loading">{error}</div>;
  if (previewable && url) return artifact.mimeType === 'image/png' ? <img src={url} alt={artifact.name} style={{ width: '100%', height: 'auto' }} /> : <iframe title={artifact.name} src={url} />;
  if (previewable) return <div className="ws-artifact-loading"><LoaderCircle size={20} />正在加载文件预览…</div>;
  const pdf = artifacts.find(a => a.mimeType === 'application/pdf' && a.createdAt === artifact.createdAt && a.name.replace(/\.pdf$/i, '') === artifact.name.replace(/\.pptx$/i, ''));
  return <div className="ws-artifact-loading"><FileText size={28} /><p>可编辑 PPTX 已保存，可下载后在 PowerPoint / WPS 中打开。</p>{pdf ? <button className="ws-primary" onClick={() => onSelect(pdf.id)}>查看实际渲染的 PDF 预览</button> : <p>此文件暂无真实渲染预览，请查看质检报告与智能体说明。</p>}</div>;
}
