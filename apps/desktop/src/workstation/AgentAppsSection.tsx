import { ArrowRight, Cpu, MessageSquarePlus, Pencil, Plus, Search, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runtimeApi, type RuntimeAgent } from '../api/runtime';
import { agentDescription, avatarTone } from './RuntimeManagement';

// 应用展示顺序：三一规划置顶，其余按既定顺序；群聊秘书是内部协调角色，不作为应用
export const AGENT_APP_ORDER = ['建潘-三一规划智能体', '代码分析助手', 'PPT助手', '统筹智能体', '路线规划助手', '经营分析助手', '家居 AI 机会诊断', '本地执行智能体'];
const HIDDEN_AGENTS = new Set(['群聊秘书']);

type AppFilter = 'all' | 'official' | 'custom';

function sortApps(agents: RuntimeAgent[]): RuntimeAgent[] {
  return [...agents].sort((left, right) => {
    const leftIndex = AGENT_APP_ORDER.indexOf(left.name);
    const rightIndex = AGENT_APP_ORDER.indexOf(right.name);
    const leftRank = leftIndex >= 0 ? leftIndex : AGENT_APP_ORDER.length;
    const rightRank = rightIndex >= 0 ? rightIndex : AGENT_APP_ORDER.length;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.name.localeCompare(right.name, 'zh-Hans-CN');
  });
}

/** 供首页「我的智能体」模块与左侧应用列表复用：过滤内部角色后按应用顺序排列。 */
export function sortAgentApps(agents: RuntimeAgent[]): RuntimeAgent[] {
  return sortApps(agents.filter(agent => !HIDDEN_AGENTS.has(agent.name)));
}

/** 应用中心主内容：与「智能体管理」同构（左侧列表由 Workstation 子导航承载，此处只渲染应用卡片网格）。 */
export function AgentAppsSection({ identityId, notify, onOpenApp, onOpenSettings, focusRequest }: {
  identityId: string;
  notify: (message: string) => void;
  onOpenApp: (agent: RuntimeAgent) => void;
  onOpenSettings: (agent: RuntimeAgent) => void;
  focusRequest?: { id: string; nonce: number } | null;
}): React.JSX.Element {
  const [agents, setAgents] = useState<RuntimeAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AppFilter>('all');
  const [focusId, setFocusId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const load = useCallback(async () => {
    try {
      const result = await runtimeApi.agents();
      if (result.ok) setAgents(result.data);
      else setAgents([]);
    } catch { setAgents([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load, identityId]);

  // 左侧应用列表带 focusRequest 进入时，定位到对应应用卡片
  useEffect(() => {
    if (!focusRequest) return;
    setFocusId(focusRequest.id);
    window.setTimeout(() => cardRefs.current.get(focusRequest.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
  }, [focusRequest]);

  const apps = useMemo(() => sortAgentApps(agents), [agents]);
  const officialCount = apps.filter(agent => agent.type === 'official').length;

  const visible = useMemo(() => apps.filter(agent => {
    const matchesFilter = filter === 'all'
      || (filter === 'official' && agent.type === 'official')
      || (filter === 'custom' && agent.type !== 'official');
    const keyword = query.trim().toLowerCase();
    const matchesQuery = !keyword || agent.name.toLowerCase().includes(keyword) || agent.role.toLowerCase().includes(keyword);
    return matchesFilter && matchesQuery;
  }), [apps, filter, query]);

  const toggle = useCallback(async (agent: RuntimeAgent) => {
    try {
      const result = await runtimeApi.toggleAgent(agent.id, !agent.enabled);
      if (result.ok) { notify(`${agent.name} 已${agent.enabled ? '停用' : '启用'}`); void load(); }
      else notify(result.message ?? '操作失败');
    } catch { notify('操作失败'); }
  }, [load, notify]);

  const badgeKind = (agent: RuntimeAgent): 'official' | 'external' | 'custom' =>
    agent.type === 'external' || agent.type === 'external-cli' ? 'external' : agent.type === 'official' ? 'official' : 'custom';
  const badgeLabel = { official: '官方内置', external: '外接三方', custom: '自定义' } as const;
  const runtimeLabel = (agent: RuntimeAgent): string => (agent.executionLocation ?? agent.execution_location) === 'local' ? '本地执行智能体' : '服务端智能体';
  const modelLabel = (agent: RuntimeAgent): string => agent.modelId ?? agent.model_id ?? '未挂载模型';

  return (
    <section className="apps-main" aria-labelledby="agent-apps-title">
      <header className="ws-agent-heading">
        <div>
          <h1 id="agent-apps-title">应用</h1>
          <p>应用由「我的智能体」封装而来：左侧列出我的应用，点击即可定位到右侧对应应用。V1.2 仅做数据打通与定位跳转，应用编辑与发布能力在后续版本开放。</p>
        </div>
        <div className="apps-heading-actions">
          <button type="button" className="apps-ghost-button" onClick={() => notify('应用市场将在后续版本开放')}><Sparkles size={15} /> 应用市场</button>
          <button type="button" className="apps-primary-button" onClick={() => notify('新建应用：请在「智能体管理」中创建并挂载技能')}><Plus size={15} /> 新建应用</button>
        </div>
      </header>

      <div className="apps-toolbar">
        <div className="apps-tabs" role="tablist" aria-label="应用分类">
          <button type="button" className="apps-tab is-active" aria-current="true">我的应用 · {apps.length}</button>
        </div>
        <div className="apps-toolbar__actions">
          <label className="apps-search">
            <Search size={15} />
            <input placeholder="搜索应用或智能体…" value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索应用" />
          </label>
        </div>
      </div>

      <div className="apps-chips" role="group" aria-label="应用筛选">
        <button type="button" className={`apps-chip${filter === 'all' ? ' is-active' : ''}`} onClick={() => setFilter('all')}>全部 {apps.length}</button>
        <button type="button" className={`apps-chip${filter === 'official' ? ' is-active' : ''}`} onClick={() => setFilter('official')}>官方内置 {officialCount}</button>
        <button type="button" className={`apps-chip${filter === 'custom' ? ' is-active' : ''}`} onClick={() => setFilter('custom')}>自定义 {apps.length - officialCount}</button>
      </div>

      {loading ? (
        <p className="apps-empty">正在加载应用…</p>
      ) : visible.length === 0 ? (
        <p className="apps-empty">没有匹配的应用；调整搜索关键词或筛选条件。</p>
      ) : (
        <div className="apps-grid">
          {visible.map(agent => (
            <article key={agent.id} ref={node => { if (node) cardRefs.current.set(agent.id, node); else cardRefs.current.delete(agent.id); }} className={`apps-card${focusId === agent.id ? ' is-focused' : ''}`}>
              <header className="apps-card__head">
                <span className={`apps-avatar apps-avatar--lg is-${avatarTone(agent.name)}`}>{agent.name.slice(0, 1)}</span>
                <div className="apps-card__title">
                  <h3>{agent.name}</h3>
                  <div className="apps-card__badges">
                    <span className={`apps-badge apps-badge--${badgeKind(agent)}`}>{badgeLabel[badgeKind(agent)]}</span>
                    <span className={`apps-badge apps-badge--publish${agent.enabled ? ' is-on' : ''}`}>{agent.enabled ? '已发布' : '未发布'}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className={`apps-switch${agent.enabled ? ' is-on' : ''}`}
                  role="switch"
                  aria-checked={agent.enabled}
                  aria-label={`${agent.enabled ? '停用' : '启用'} ${agent.name}`}
                  disabled={agent.name === '统筹智能体'}
                  title={agent.name === '统筹智能体' ? '统筹智能体为平台必需，不可停用' : undefined}
                  onClick={() => void toggle(agent)}
                >
                  <span />
                </button>
              </header>
              <dl className="apps-card__meta">
                <div><dt>运行方式</dt><dd>{runtimeLabel(agent)}</dd></div>
                <div><dt>推理模型</dt><dd>{modelLabel(agent)} <Cpu size={13} /></dd></div>
                <div><dt>已启用技能</dt><dd>{agent.enabled ? '随「技能管理」实时生效' : '已停用，技能调用暂停'}</dd></div>
                <div><dt>应用说明</dt><dd className="apps-card__desc">{agentDescription(agent)}</dd></div>
              </dl>
              <footer className="apps-card__actions">
                <button type="button" onClick={() => onOpenApp(agent)}><MessageSquarePlus size={14} /> 打开应用</button>
                <button type="button" onClick={() => onOpenSettings(agent)}><Pencil size={14} /> 应用设置</button>
                <button type="button" onClick={() => notify(`运行记录：${agent.name}（后续版本开放）`)}><ArrowRight size={14} /> 运行记录</button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
