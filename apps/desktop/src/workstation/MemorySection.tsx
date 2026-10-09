import { useEffect, useMemo, useState } from 'react';
import { Archive, Brain, Clock3, Folder, LockKeyhole, RefreshCw, Users } from 'lucide-react';
import type { MemoryBrowserAgent, MemoryBrowserPage, MemoryBrowserScopes } from '@kla-workstation/contracts';
import { MEMORY_DAY_MS } from '@kla-workstation/contracts';
import { memoryApi } from '../api/memories';
import { apiErrorMessage, Badge, Panel, Stat } from './ui';

const emptyPage: MemoryBrowserPage = { items: [], page: { page: 1, pageSize: 20, total: 0 } };
const formatDate = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无记录';
const termLabels = { long_term: '长期记忆', short_term: '短期记忆' };

export function MemorySection({ identityId }: { identityId: string }) {
  const [scopes, setScopes] = useState<MemoryBrowserScopes | null>(null);
  const [scopeLoading, setScopeLoading] = useState(true);
  const [scopeError, setScopeError] = useState('');
  const [projectId, setProjectId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [agentKey, setAgentKey] = useState('');
  const [term, setTerm] = useState<'long_term' | 'short_term'>('long_term');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<MemoryBrowserPage>(emptyPage);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [rangeDays, setRangeDays] = useState(7);

  useEffect(() => {
    const controller = new AbortController();
    setScopeLoading(true); setScopeError('');
    void memoryApi.scopes(identityId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (!result.ok) { setScopes(null); setScopeError(apiErrorMessage(result)); return; }
      setScopes(result.data);
      setProjectId(value => result.data.projects.some(project => project.id === value) ? value : '');
      setConversationId(value => result.data.conversations.some(chat => chat.id === value) ? value : '');
      setAgentKey(value => result.data.agents.some(agent => agent.key === value) ? value : '');
    }).catch(() => { if (!controller.signal.aborted) { setScopes(null); setScopeError('记忆范围加载失败，请检查后端连接'); } })
      .finally(() => { if (!controller.signal.aborted) setScopeLoading(false); });
    return () => controller.abort();
  }, [identityId, revision]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setData(emptyPage);
    if (!scopes || scopeLoading) {
      setLoading(scopeLoading);
      return () => controller.abort();
    }
    void memoryApi.entries(identityId, { projectId: projectId || undefined, conversationId: conversationId || undefined, agentKey: agentKey || undefined, term, page, pageSize: 20,
      ...(term === 'short_term' ? { from: new Date(Date.now() - rangeDays * MEMORY_DAY_MS).toISOString() } : {}),
    }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) setData(result.data);
      else setError(apiErrorMessage(result));
    }).catch(() => { if (!controller.signal.aborted) setError('记忆内容加载失败，请重试'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [identityId, scopes, scopeLoading, projectId, conversationId, agentKey, term, page, revision, rangeDays]);

  const conversations = useMemo(() => scopes?.conversations.filter(chat => !projectId || chat.projectId === projectId) ?? [], [scopes, projectId]);
  const agents = useMemo(() => {
    if (!projectId && !conversationId) return scopes?.agents ?? [];
    const selected = conversations.filter(chat => !conversationId || chat.id === conversationId);
    const pool = new Map<string, MemoryBrowserAgent>();
    selected.forEach(chat => chat.agents.forEach(agent => pool.set(agent.key, agent)));
    // Include only the selected project's sources, including memories without a chat.
    if (!conversationId) scopes?.projects.find(project => project.id === projectId)?.agents.forEach(agent => pool.set(agent.key, agent));
    return Array.from(pool.values());
  }, [scopes, projectId, conversationId, conversations]);
  const currentProject = scopes?.projects.find(project => project.id === projectId);
  const currentChat = conversations.find(chat => chat.id === conversationId);
  const currentAgent = agents.find(agent => agent.key === agentKey);
  const pages = Math.max(1, Math.ceil(data.page.total / data.page.pageSize));
  const refresh = () => { void memoryApi.invalidate(identityId).then(() => { setPage(1); setRevision(value => value + 1); }); };

  return <div className="ws-memory-browser">
    <div className="ws-page-heading"><div><h1>记忆</h1><p>查看由对话和任务产生的记忆与业务上下文。按项目、群组和智能体独立筛选，记忆内容仅供查看。</p></div><button className="ws-memory-refresh" onClick={refresh} disabled={scopeLoading || loading}><RefreshCw size={14} />刷新</button></div>
    <div className="ws-stats three">
      <Stat icon={<Users />} label="可记忆群组" value={scopes ? `${scopes.conversations.length} 个` : '—'} hint={scopes ? `${scopes.projects.length} 个项目 · 当前身份可访问的群组` : '正在读取当前身份的记忆范围'} />
      <Stat icon={<Brain />} label="记忆条目总数" value={scopes ? `${scopes.counts.longTerm + scopes.counts.shortTerm} 条` : '—'} hint={scopes ? `长期 ${scopes.counts.longTerm} 条 · 短期 ${scopes.counts.shortTerm} 条` : '以服务端实际记录统计'} color="teal" />
      <Stat icon={<Clock3 />} label="最近记忆更新" value={formatDate(scopes?.latestUpdatedAt ?? null)} hint="显示真实更新时间" color="orange" />
    </div>
    {scopeError ? <div className="ws-memory-error" role="alert">{scopeError}<button onClick={refresh}>重新加载</button></div> : <>
      <Panel title="选择项目与群组" action={<span className="ws-muted">切换范围只影响当前查看内容</span>}>
        {scopeLoading ? <div className="ws-empty" role="status">正在加载记忆范围…</div> : <>
          <div className="ws-memory-scope-row"><span><Folder size={14} />项目</span><div className="ws-chips" role="group" aria-label="选择项目"><button className={!projectId ? 'active' : ''} aria-pressed={!projectId} onClick={() => { setProjectId(''); setConversationId(''); setAgentKey(''); setPage(1); }}>全部项目</button>{scopes?.projects.map(project => <button key={project.id} className={projectId === project.id ? 'active' : ''} aria-pressed={projectId === project.id} onClick={() => { setProjectId(project.id); setConversationId(''); setAgentKey(''); setPage(1); }}>{project.name}</button>)}</div></div>
          <div className="ws-memory-scope-row"><span><Users size={14} />群组</span><div className="ws-chips" role="group" aria-label="选择群组"><button className={!conversationId ? 'active' : ''} aria-pressed={!conversationId} onClick={() => { setConversationId(''); setAgentKey(''); setPage(1); }}>全部群组</button>{conversations.map(chat => <button key={chat.id} className={conversationId === chat.id ? 'active' : ''} aria-pressed={conversationId === chat.id} onClick={() => { setConversationId(chat.id); setAgentKey(''); setPage(1); }}>{chat.name}</button>)}</div></div>
          {!scopes?.projects.length && <p className="ws-muted">当前身份尚无项目和群组，可先在项目模块中创建。</p>}
        </>}
      </Panel>
      <div className="ws-memory-layout">
        <Panel title={currentChat?.name ?? currentProject?.name ?? '全部记忆'} subtitle={`${currentProject?.name ?? '全部项目'} · ${currentChat ? '群组记忆' : '含项目级和群组记忆'} · ${currentAgent?.name ?? '全部智能体'}`} action={<Badge tone="muted"><LockKeyhole size={12} />只读</Badge>}>
          <div className="ws-memory-filter" role="group" aria-label="按智能体查看"><span>按智能体查看</span><button className={!agentKey ? 'active' : ''} aria-pressed={!agentKey} onClick={() => { setAgentKey(''); setPage(1); }}>全部智能体</button>{agents.map(agent => <button key={agent.key} className={agentKey === agent.key ? 'active' : ''} aria-pressed={agentKey === agent.key} onClick={() => { setAgentKey(agent.key); setPage(1); }}>{agent.name}</button>)}</div>
          <div className="ws-memory-term-tabs" role="tablist" aria-label="记忆周期">{(['long_term', 'short_term'] as const).map(value => <button key={value} role="tab" aria-selected={term === value} className={term === value ? 'active' : ''} onClick={() => { setTerm(value); setPage(1); }}>{value === 'long_term' ? <Archive size={14} /> : <Clock3 size={14} />}{termLabels[value]}</button>)}</div>
          {term === 'short_term' && <div className="ws-memory-filter" role="group" aria-label="短期记忆时间范围"><span>时间范围</span>{[7, 30, 365].map(days => <button key={days} aria-pressed={rangeDays === days} className={rangeDays === days ? 'active' : ''} onClick={() => { setRangeDays(days); setPage(1); }}>{days === 365 ? '最近1年' : `最近${days}天`}</button>)}<span className="ws-muted">{rangeDays === 7 ? '近期记忆优先读取本地缓存' : '历史记忆按需从服务器读取'}</span></div>}
          <div role="tabpanel" aria-label={termLabels[term]} aria-busy={loading}>
            {loading ? <div className="ws-empty" role="status">正在加载{termLabels[term]}…</div> : error ? <div className="ws-memory-error" role="alert">{error}<button onClick={refresh}>重新加载</button></div> : data.items.length ? <div className="ws-memory-list">{data.items.map(entry => <article key={entry.id} className="ws-memory-entry"><div><p>{entry.content}</p><small>来源：{entry.agentName} · {formatDate(entry.updatedAt)}{entry.source === 'conversation_context' ? ' ｜ 对话上下文' : ' ｜ 已保存记忆'}{entry.shared ? ' ｜ 用户输入（共享）' : ''}</small><small>{entry.projectName ?? '当前身份'} / {entry.conversationName ?? '项目级或未关联群组'}{entry.expiresAt ? ` ｜ 有效至 ${formatDate(entry.expiresAt)}` : ''}{entry.term === 'short_term' && entry.timeWeight != null ? ` ｜ 时间权重 ${entry.timeWeight.toFixed(3)}${entry.timeWeight === 0 ? '（仅历史查看）' : ''}` : ''}</small></div></article>)}</div> : <div className="ws-empty">当前筛选范围暂无{termLabels[term]}</div>}
          </div>
          {!loading && !error && <div className="ws-memory-pagination"><span>共 {data.page.total} 条 · 第 {page} / {pages} 页</span><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><button disabled={page >= pages} onClick={() => setPage(value => value + 1)}>下一页</button></div>}
        </Panel>
        <aside className="ws-memory-info">
          <Panel title="记忆使用说明" action={<Badge tone="green">仅查看</Badge>}><div className="ws-memory-help-item"><h4>长期记忆</h4><p>固化记忆可保存和查看，不设时间权重。当前暂不检索或带入智能体对话。</p></div><div className="ws-memory-help-item"><h4>短期记忆</h4><p>客户端缓存最近7天，服务端保留1年。时间权重按72小时半衰期降低，满30天归零；归零后仍可查阅历史。查看不会重置权重。</p></div></Panel>
          <Panel title="记忆作用范围"><div className="ws-memory-help-item"><h4>按身份和群组隔离</h4><p>只展示当前身份有权访问的数据，切换筛选不会改变智能体实际使用记忆的范围。</p></div><div className="ws-memory-help-item"><h4>来源可追溯</h4><p>展示来源智能体、所属项目与群组、实际更新时间；未标注来源的历史记录单独显示。</p></div><div className="ws-memory-help-item"><h4>只读查看</h4><p>此处不提供新增、编辑、删除、重置或导入操作。</p></div></Panel>
        </aside>
      </div>
    </>}
  </div>;
}
