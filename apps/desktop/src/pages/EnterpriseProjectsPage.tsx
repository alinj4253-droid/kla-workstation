import {
  BarChart3, Bot, CalendarDays, CheckCircle2, Clock3, Coins, Ellipsis,
  FolderKanban, Gauge, KanbanSquare, Link2, Maximize2, PanelLeftClose,
  PanelLeftOpen, Pencil, Plus, Target, Trash2, Users, X, Zap,
} from 'lucide-react';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { NameAvatar } from '../components/NameAvatar';
import {
  associationKey,
  normalizeEnterpriseProjects,
  normalizeProjectAssociations,
  type EnterpriseProject,
  type EnterpriseProjectAssociations,
} from '../enterprise-projects';

type EnterpriseProjectView = 'board' | 'details' | 'progress' | 'nodes';
type GroupItem = { id: string; name: string; status?: string };
type OperationItem = { id: string; name: string; agentName?: string };
type AgentItem = { id: string; agentName: string };
type AssociatedNode = { id: string; kind: 'group' | 'operation' | 'meeting'; name: string; detail: string };

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `enterprise-${Date.now().toString(36)}`;
}

export function EnterpriseProjectsPage(): React.JSX.Element {
  const [projects, setProjects] = useState<EnterpriseProject[]>([]);
  const [associations, setAssociations] = useState<EnterpriseProjectAssociations>({});
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [operations, setOperations] = useState<OperationItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [nickname, setNickname] = useState('项目负责人');
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<EnterpriseProjectView>('board');
  const [fullscreenView, setFullscreenView] = useState<EnterpriseProjectView | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(286);
  const resizingRef = useRef(false);

  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const [settingsResult, groupResult] = await Promise.all([
          window.kunqing?.settings.getAll() as Promise<{ ok?: boolean; data?: Record<string, unknown> }> | undefined,
          window.kunqing?.projects.list({}) as Promise<{ ok?: boolean; data?: GroupItem[] }> | undefined,
        ]);
        const items = normalizeEnterpriseProjects(settingsResult?.data?.enterpriseProjects);
        setProjects(items);
        setAssociations(normalizeProjectAssociations(settingsResult?.data?.enterpriseProjectAssociations));
        setOperations(Array.isArray(settingsResult?.data?.operationPlatforms) ? settingsResult.data.operationPlatforms as OperationItem[] : []);
        setNickname(String(settingsResult?.data?.personalNickname ?? '').trim() || '项目负责人');
        setGroups(groupResult?.ok ? groupResult.data ?? [] : []);
        setSelectedId(items[0]?.id ?? '');
      } finally { setLoading(false); }
    })();
  }, []);

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? projects[0] ?? null,
    [projects, selectedId],
  );

  const associatedNodes = useMemo<AssociatedNode[]>(() => {
    if (!selected) return [];
    const groupNodes = groups
      .filter((group) => associations[associationKey('group', group.id)] === selected.id)
      .map((group) => ({ id: group.id, kind: 'group' as const, name: group.name, detail: group.status === 'active' ? '协作进行中' : '协作群聊' }));
    const operationNodes = operations
      .filter((operation) => associations[associationKey('operation', operation.id)] === selected.id)
      .map((operation) => ({ id: operation.id, kind: 'operation' as const, name: operation.name, detail: operation.agentName || '操作平台智能体' }));
    return [...groupNodes, ...operationNodes];
  }, [associations, groups, operations, selected]);

  useEffect(() => {
    const groupIds = associatedNodes.filter((node) => node.kind === 'group').map((node) => node.id);
    if (groupIds.length === 0) { setAgents([]); return; }
    void Promise.all(groupIds.map(async (projectId) => {
      const result = await window.kunqing?.agents.getProjectInstances({ projectId }) as { ok?: boolean; data?: AgentItem[] } | undefined;
      return result?.ok ? result.data ?? [] : [];
    })).then((collections) => {
      const byName = new Map(collections.flat().map((agent) => [agent.agentName, agent]));
      setAgents([...byName.values()]);
    });
  }, [associatedNodes]);

  useEffect(() => {
    if (!fullscreenView) return;
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setFullscreenView(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreenView]);

  const persistProjects = async (next: EnterpriseProject[]): Promise<boolean> => {
    const result = await window.kunqing?.settings.update({ enterpriseProjects: next }) as { ok?: boolean } | undefined;
    if (!result?.ok) { setNotice('项目保存失败，请稍后重试'); return false; }
    setProjects(next); setNotice(''); return true;
  };

  const createProject = async (name: string): Promise<boolean> => {
    const now = new Date().toISOString();
    const project: EnterpriseProject = {
      id: createId(), name, description: `${name}的目标、范围、协作节点与执行成果统一在此管理。`,
      tokenUsed: 128_640, completedNodes: 8, totalNodes: 12, createdAt: now, updatedAt: now,
    };
    if (!await persistProjects([project, ...projects])) return false;
    setSelectedId(project.id); setCreateOpen(false); setView('board'); return true;
  };

  const renameProject = async (name: string): Promise<boolean> => {
    if (!selected) return false;
    const next = projects.map((project) => project.id === selected.id ? { ...project, name, updatedAt: new Date().toISOString() } : project);
    const saved = await persistProjects(next);
    if (saved) setRenameOpen(false);
    return saved;
  };

  const deleteProject = async (): Promise<void> => {
    if (!selected) return;
    const nextProjects = projects.filter((project) => project.id !== selected.id);
    const nextAssociations = Object.fromEntries(Object.entries(associations).filter(([, projectId]) => projectId !== selected.id));
    const result = await window.kunqing?.settings.update({ enterpriseProjects: nextProjects, enterpriseProjectAssociations: nextAssociations }) as { ok?: boolean } | undefined;
    if (!result?.ok) { setNotice('项目删除失败，请稍后重试'); return; }
    setProjects(nextProjects); setAssociations(nextAssociations); setSelectedId(nextProjects[0]?.id ?? ''); setDeleteOpen(false); setView('board');
  };

  const startResize = (event: React.MouseEvent): void => {
    event.preventDefault(); resizingRef.current = true;
    const startX = event.clientX; const startWidth = sidebarWidth;
    const onMove = (move: MouseEvent): void => { if (resizingRef.current) setSidebarWidth(Math.max(220, Math.min(480, startWidth + move.clientX - startX))); };
    const onUp = (): void => { resizingRef.current = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  };

  const content = selected ? <ProjectContent
    project={selected}
    view={fullscreenView ?? view}
    fullscreen={!!fullscreenView}
    nodes={associatedNodes}
    nickname={nickname}
    agents={agents}
    onFullscreen={(nextView) => setFullscreenView(nextView)}
    onExitFullscreen={() => setFullscreenView(null)}
  /> : null;

  return <div className={`operation-workspace enterprise-project-workspace${sidebarOpen ? '' : ' operation-workspace--sidebar-closed'}`} style={{ '--operation-sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
    {sidebarOpen && <aside className="operation-platform-sidebar" aria-label="企业项目列表">
      <header><button type="button" className="icon-button operation-sidebar-toggle" aria-label="收起企业项目栏" title="收起企业项目栏" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={18} /></button><h2>企业项目</h2><button type="button" className="icon-button" aria-label="创建项目" title="创建项目" onClick={() => setCreateOpen(true)}><Plus size={18} /></button></header>
      <div className="operation-platform-list">{loading ? <p className="operation-platform-list__empty">加载中...</p> : projects.length === 0 ? <p className="operation-platform-list__empty">暂无企业项目</p> : projects.map((project) => <button type="button" key={project.id} className={`operation-platform-item${selected?.id === project.id ? ' operation-platform-item--active' : ''}`} onClick={() => { setSelectedId(project.id); setView('board'); }}><NameAvatar name={project.name} /><span className="operation-platform-item__body"><span className="operation-platform-item__title">{project.name}</span></span></button>)}</div>
      <div className="operation-sidebar-resize-handle" onMouseDown={startResize} />
    </aside>}
    <section className="operation-platform-main">
      {!sidebarOpen && <button type="button" className="icon-button operation-sidebar-expand" aria-label="展开企业项目栏" title="展开企业项目栏" onClick={() => setSidebarOpen(true)}><PanelLeftOpen size={18} /></button>}
      {selected ? <>
        <header className="operation-platform-header"><div className="operation-platform-title"><span><FolderKanban size={19} /></span><div><h1>{selected.name}</h1><small>{associatedNodes.length} 个关联节点</small></div></div><nav aria-label="企业项目工具"><button type="button" className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><KanbanSquare size={16} /><span>项目看板</span></button><button type="button" className={view === 'details' ? 'active' : ''} onClick={() => setView('details')}><Target size={16} /><span>项目详情</span></button><button type="button" className={view === 'progress' ? 'active' : ''} onClick={() => setView('progress')}><BarChart3 size={16} /><span>项目进度</span></button><button type="button" className={view === 'nodes' ? 'active' : ''} onClick={() => setView('nodes')}><Link2 size={16} /><span>关联节点</span></button><div className="operation-platform-more"><button type="button" aria-label="更多操作" className={moreOpen ? 'active' : ''} onClick={() => setMoreOpen((open) => !open)}><Ellipsis size={18} /></button>{moreOpen && <div className="operation-platform-more__menu"><button type="button" onClick={() => { setMoreOpen(false); setRenameOpen(true); }}><Pencil size={15} />重命名</button><button type="button" className="danger" onClick={() => { setMoreOpen(false); setDeleteOpen(true); }}><Trash2 size={15} />删除</button></div>}</div></nav></header>
        {!fullscreenView && content}
      </> : <div className="operation-platform-empty"><span><FolderKanban size={28} /></span><h1>创建企业项目</h1><p>建立独立项目空间，统一挂载群聊、操作平台和未来会议。</p><button type="button" className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={16} />创建项目</button></div>}
      {notice && <div className="operation-platform-notice">{notice}</div>}
    </section>
    {fullscreenView && selected && <div className="enterprise-project-fullscreen">{content}</div>}
    {createOpen && <CreateEnterpriseProjectDialog onClose={() => setCreateOpen(false)} onSubmit={createProject} />}
    {renameOpen && selected && <RenameEnterpriseProjectDialog project={selected} onClose={() => setRenameOpen(false)} onSubmit={renameProject} />}
    {deleteOpen && selected && <DeleteEnterpriseProjectDialog project={selected} onClose={() => setDeleteOpen(false)} onConfirm={() => void deleteProject()} />}
  </div>;
}

function ProjectContent({ project, view, fullscreen, nodes, nickname, agents, onFullscreen, onExitFullscreen }: { project: EnterpriseProject; view: EnterpriseProjectView; fullscreen: boolean; nodes: AssociatedNode[]; nickname: string; agents: AgentItem[]; onFullscreen: (view: EnterpriseProjectView) => void; onExitFullscreen: () => void }): React.JSX.Element {
  if (view === 'board') return <ProjectBoard project={project} fullscreen={fullscreen} onFullscreen={() => onFullscreen('board')} onExitFullscreen={onExitFullscreen} />;
  if (view === 'details') return <ProjectDetails project={project} nickname={nickname} agents={agents} nodes={nodes} />;
  if (view === 'progress') return <ProjectProgress project={project} fullscreen={fullscreen} onFullscreen={() => onFullscreen('progress')} onExitFullscreen={onExitFullscreen} />;
  return <ProjectNodes project={project} nodes={nodes} fullscreen={fullscreen} onFullscreen={() => onFullscreen('nodes')} onExitFullscreen={onExitFullscreen} />;
}

function ViewHeading({ title, subtitle, fullscreen, onFullscreen, onExitFullscreen }: { title: string; subtitle: string; fullscreen: boolean; onFullscreen: () => void; onExitFullscreen: () => void }): React.JSX.Element {
  return <header className="enterprise-view-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><button type="button" className="icon-button" aria-label={fullscreen ? '退出全屏' : `${title}全屏`} title={fullscreen ? '退出全屏（Esc）' : '全屏'} onClick={fullscreen ? onExitFullscreen : onFullscreen}>{fullscreen ? <X size={17} /> : <Maximize2 size={17} />}</button></header>;
}

function ProjectBoard({ project, fullscreen, onFullscreen, onExitFullscreen }: { project: EnterpriseProject; fullscreen: boolean; onFullscreen: () => void; onExitFullscreen: () => void }): React.JSX.Element {
  const completion = project.totalNodes > 0 ? Math.round(project.completedNodes / project.totalNodes * 100) : 0;
  return <div className="enterprise-project-view enterprise-bi-view"><ViewHeading title="项目看板" subtitle="项目执行、资源与成本的综合 BI 概览" fullscreen={fullscreen} onFullscreen={onFullscreen} onExitFullscreen={onExitFullscreen} /><div className="enterprise-bi-kpis"><BiKpi icon={<Gauge size={18} />} label="整体完成度" value={`${completion}%`} delta="较上周 +12%" tone="primary" /><BiKpi icon={<CheckCircle2 size={18} />} label="已完成节点" value={`${project.completedNodes} / ${project.totalNodes}`} delta="本周完成 3 项" tone="success" /><BiKpi icon={<Zap size={18} />} label="智能体任务" value="26" delta="5 项执行中" tone="violet" /><BiKpi icon={<Coins size={18} />} label="Token 成本" value={project.tokenUsed.toLocaleString('zh-CN')} delta="预算使用 42%" tone="amber" /></div><div className="enterprise-bi-grid"><section className="enterprise-bi-panel enterprise-bi-panel--wide"><BiPanelHeading title="执行趋势" meta="最近 7 天" /><TrendChart chartId="board-trend" values={[16, 24, 22, 38, 49, 61, 67]} labels={['08/11', '08/12', '08/13', '08/14', '08/15', '08/16', '08/17']} /></section><section className="enterprise-bi-panel"><BiPanelHeading title="节点完成率" meta={`${project.completedNodes}/${project.totalNodes}`} /><DonutChart value={completion} label="节点完成" /></section><section className="enterprise-bi-panel"><BiPanelHeading title="任务状态分布" meta="共 26 项" /><HorizontalBars items={[['已完成', 12, 46], ['执行中', 8, 31], ['待开始', 4, 15], ['有风险', 2, 8]]} /></section><section className="enterprise-bi-panel enterprise-bi-panel--wide"><BiPanelHeading title="成员负载" meta="活跃智能体" /><AgentLoadChart /></section></div></div>;
}

function BiKpi({ icon, label, value, delta, tone }: { icon: React.ReactNode; label: string; value: string; delta: string; tone: string }): React.JSX.Element {
  return <article className={`enterprise-bi-kpi enterprise-bi-kpi--${tone}`}><span>{icon}</span><div><small>{label}</small><strong>{value}</strong><em>{delta}</em></div></article>;
}

function BiPanelHeading({ title, meta }: { title: string; meta: string }): React.JSX.Element {
  return <header className="enterprise-bi-panel-heading"><strong>{title}</strong><span>{meta}</span></header>;
}

function TrendChart({ chartId, values, labels }: { chartId: string; values: number[]; labels: string[] }): React.JSX.Element {
  const points = values.map((value, index) => `${44 + index * 65},${142 - value * 1.45}`).join(' ');
  const area = `44,142 ${points} ${44 + (values.length - 1) * 65},142`;
  return <div className="enterprise-trend-chart"><svg viewBox="0 0 480 174" role="img" aria-label="项目执行趋势图"><defs><linearGradient id={chartId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".24" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>{[32, 68, 104, 140].map((y) => <line key={y} x1="44" x2="444" y1={y} y2={y} className="enterprise-chart-grid" />)}<polygon points={area} fill={`url(#${chartId})`} /><polyline points={points} className="enterprise-chart-line" />{values.map((value, index) => <circle key={`${labels[index]}-${value}`} cx={44 + index * 65} cy={142 - value * 1.45} r="3.5" className="enterprise-chart-point" />)}{labels.map((label, index) => <text key={label} x={44 + index * 65} y="164" textAnchor="middle">{label}</text>)}</svg></div>;
}

function DonutChart({ value, label }: { value: number; label: string }): React.JSX.Element {
  return <div className="enterprise-donut-wrap"><div className="enterprise-bi-donut" style={{ '--bi-progress': `${value * 3.6}deg` } as React.CSSProperties}><span><strong>{value}%</strong><small>{label}</small></span></div><div className="enterprise-donut-legend"><span><i />已完成 <strong>{value}%</strong></span><span><i />待完成 <strong>{100 - value}%</strong></span></div></div>;
}

function HorizontalBars({ items }: { items: Array<[string, number, number]> }): React.JSX.Element {
  return <div className="enterprise-horizontal-bars">{items.map(([label, count, value], index) => <div key={label}><header><span><i data-tone={index} />{label}</span><strong>{count}</strong></header><div><span style={{ width: `${value}%` }} data-tone={index} /></div></div>)}</div>;
}

function AgentLoadChart(): React.JSX.Element {
  const items = [['统筹规划', 86], ['知识管理', 72], ['资料调研', 64], ['材料编写', 58], ['验收', 41]] as const;
  return <div className="enterprise-agent-load"><div className="enterprise-agent-load__scale"><span>100%</span><span>50%</span><span>0</span></div><div className="enterprise-agent-load__bars">{items.map(([label, value]) => <div key={label}><span style={{ height: `${value}%` }}><i>{value}%</i></span><small>{label}</small></div>)}</div></div>;
}

function ProjectDetails({ project, nickname, agents, nodes }: { project: EnterpriseProject; nickname: string; agents: AgentItem[]; nodes: AssociatedNode[] }): React.JSX.Element {
  const agentNames = [...new Set([
    ...agents.map((agent) => agent.agentName),
    ...nodes.filter((node) => node.kind === 'operation').map((node) => node.detail),
  ])];
  return <div className="enterprise-project-view enterprise-project-document-view"><article className="enterprise-project-document"><header><span>项目立项文档</span><h2>{project.name}</h2><p>项目编号：KLA-{project.id.slice(-6).toUpperCase()} · 当前版本 V1.0</p></header><section><h3>一、项目详情</h3><p>{project.description}</p><dl><div><dt>项目状态</dt><dd>进行中</dd></div><div><dt>立项时间</dt><dd>{new Date(project.createdAt).toLocaleDateString('zh-CN')}</dd></div><div><dt>项目负责人</dt><dd>{nickname}</dd></div><div><dt>计划完成</dt><dd>2026年08月23日</dd></div><div><dt>Token 成本</dt><dd>{project.tokenUsed.toLocaleString('zh-CN')}</dd></div><div><dt>完成节点</dt><dd>{project.completedNodes} / {project.totalNodes}</dd></div></dl></section><section><h3>二、项目目标与范围</h3><ul><li>围绕项目目标建立清晰的任务拆解、负责人和交付节点。</li><li>统一管理群聊协作、操作平台和后续会议产生的工作成果。</li><li>通过智能体协同执行、知识沉淀和阶段验收保障最终交付质量。</li></ul></section><section><h3>三、项目关联人员</h3><div className="enterprise-document-members"><div className="enterprise-member-list"><span className="enterprise-member-avatar">{nickname.slice(0, 1)}</span><div><strong>{nickname}</strong><small>项目负责人 · 已关联全部项目节点</small></div></div>{nodes.length > 0 && <div className="enterprise-node-participation">{nodes.map((node) => <span key={`${node.kind}:${node.id}`}>{node.name}</span>)}</div>}</div></section><section><h3>四、项目智能体</h3>{agentNames.length ? <div className="enterprise-agent-tags">{agentNames.map((name) => <span key={name}>{name}</span>)}</div> : <p className="enterprise-document-empty">关联群聊或操作平台后，智能体成员将在此自动更新。</p>}</section></article></div>;
}

function ProjectProgress({ project, fullscreen, onFullscreen, onExitFullscreen }: { project: EnterpriseProject; fullscreen: boolean; onFullscreen: () => void; onExitFullscreen: () => void }): React.JSX.Element {
  const tasks = [
    { name: '项目启动与范围确认', owner: '统筹规划智能体', start: 1, span: 2, progress: 100, status: '已完成' },
    { name: '内部资料检索与知识整理', owner: '知识管理智能体', start: 2, span: 4, progress: 82, status: '进行中' },
    { name: '外部市场信息调研', owner: '资料调研智能体', start: 3, span: 4, progress: 64, status: '进行中' },
    { name: '成果框架与材料编写', owner: '材料编写智能体', start: 6, span: 4, progress: 42, status: '进行中' },
    { name: '事实核验与成果验收', owner: '验收智能体', start: 9, span: 3, progress: 0, status: '待开始' },
    { name: '终版交付与经验归档', owner: '统筹规划智能体', start: 11, span: 2, progress: 0, status: '待开始' },
  ];
  const dates = ['8/18', '8/19', '8/20', '8/21', '8/22', '8/23', '8/24', '8/25', '8/26', '8/27', '8/28', '8/29'];
  return <div className="enterprise-project-view enterprise-bi-view"><ViewHeading title="项目进度" subtitle="任务计划、执行周期与完成情况" fullscreen={fullscreen} onFullscreen={onFullscreen} onExitFullscreen={onExitFullscreen} /><section className="enterprise-gantt"><header><div>任务列表</div><div>{dates.map((date) => <span key={date}>{date}</span>)}</div></header>{tasks.map((task, index) => <div className="enterprise-gantt-row" key={task.name}><div className="enterprise-gantt-task"><strong>{task.name}</strong><span>{task.owner}</span><small data-status={task.status}>{task.status}</small></div><div className="enterprise-gantt-timeline">{dates.map((date) => <i key={date} />)}<span className="enterprise-gantt-bar" data-status={task.status} style={{ gridColumn: `${task.start} / span ${task.span}` }}><b style={{ width: `${task.progress}%` }} /><em>{task.progress}%</em></span>{index === 3 && <u title="今天" />}</div></div>)}</section><div className="enterprise-progress-dashboard"><div className="enterprise-bi-kpis"><BiKpi icon={<BarChart3 size={18} />} label="任务总数" value="26" delta="6 项关键任务" tone="primary" /><BiKpi icon={<CheckCircle2 size={18} />} label="已完成任务" value="12" delta="完成占比 46%" tone="success" /><BiKpi icon={<Clock3 size={18} />} label="执行中任务" value="8" delta="3 项临近节点" tone="violet" /><BiKpi icon={<CalendarDays size={18} />} label="计划偏差" value="-5%" delta="整体轻微落后" tone="amber" /></div><div className="enterprise-progress-summary"><section className="enterprise-bi-panel"><BiPanelHeading title="任务完成占比" meta="共 26 项" /><DonutChart value={46} label="任务完成" /></section><section className="enterprise-bi-panel enterprise-bi-panel--wide"><BiPanelHeading title="未来 7 天完成趋势" meta="实际 / 计划" /><TrendChart chartId="gantt-progress" values={[18, 27, 34, 46, 52, 61, 67]} labels={['8/18', '8/19', '8/20', '8/21', '8/22', '8/23', '8/24']} /></section></div></div></div>;
}

function ProjectNodes({ project, nodes, fullscreen, onFullscreen, onExitFullscreen }: { project: EnterpriseProject; nodes: AssociatedNode[]; fullscreen: boolean; onFullscreen: () => void; onExitFullscreen: () => void }): React.JSX.Element {
  const groups = nodes.filter((node) => node.kind === 'group');
  const operations = nodes.filter((node) => node.kind === 'operation');
  return <div className="enterprise-project-view"><ViewHeading title="关联节点" subtitle={`查看挂载在“${project.name}”下的群聊、操作平台与未来协作节点`} fullscreen={fullscreen} onFullscreen={onFullscreen} onExitFullscreen={onExitFullscreen} /><div className="enterprise-node-sections"><NodeSection title="协作群聊" icon={<Users size={16} />} nodes={groups} empty="暂未关联群聊" /><NodeSection title="操作平台" icon={<Bot size={16} />} nodes={operations} empty="暂未关联操作平台" /><NodeSection title="会议节点" icon={<CalendarDays size={16} />} nodes={[]} empty="会议能力即将上线" /></div></div>;
}

function NodeSection({ title, icon, nodes, empty }: { title: string; icon: React.ReactNode; nodes: AssociatedNode[]; empty: string }): React.JSX.Element {
  return <section className="enterprise-node-section"><header><span>{icon}{title}</span><small>{nodes.length}</small></header>{nodes.length ? <div>{nodes.map((node) => <article key={`${node.kind}:${node.id}`}><span>{node.kind === 'group' ? <Users size={16} /> : <Bot size={16} />}</span><div><strong>{node.name}</strong><small>{node.detail}</small></div></article>)}</div> : <p>{empty}</p>}</section>;
}

function CreateEnterpriseProjectDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (name: string) => Promise<boolean> }): React.JSX.Element {
  const [name, setName] = useState(''); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); const trimmed = name.trim(); if (!trimmed) { setError('请输入项目名称'); return; } setSaving(true); const saved = await onSubmit(trimmed); setSaving(false); if (!saved) setError('保存失败，请稍后重试'); };
  return <div className="modal-backdrop modal-backdrop--nested" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="operation-platform-dialog operation-platform-dialog--compact" role="dialog" aria-modal="true" onSubmit={(event) => void submit(event)}><header><div><h2>创建项目</h2><p>填写企业项目名称</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header><label><span>项目名称</span><input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(''); }} placeholder="请输入项目名称" maxLength={80} /></label>{error && <small className="operation-platform-dialog__error">{error}</small>}<footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={saving}>{saving ? '创建中...' : '确定创建'}</button></footer></form></div>;
}

function RenameEnterpriseProjectDialog({ project, onClose, onSubmit }: { project: EnterpriseProject; onClose: () => void; onSubmit: (name: string) => Promise<boolean> }): React.JSX.Element {
  const [name, setName] = useState(project.name); const [error, setError] = useState('');
  return <div className="modal-backdrop modal-backdrop--nested" role="presentation"><form className="operation-platform-dialog operation-platform-dialog--compact" onSubmit={(event) => { event.preventDefault(); if (!name.trim()) { setError('请输入项目名称'); return; } void onSubmit(name.trim()); }}><header><h2>重命名项目</h2><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header><label><span>项目名称</span><input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(''); }} /></label>{error && <small className="operation-platform-dialog__error">{error}</small>}<footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button">保存</button></footer></form></div>;
}

function DeleteEnterpriseProjectDialog({ project, onClose, onConfirm }: { project: EnterpriseProject; onClose: () => void; onConfirm: () => void }): React.JSX.Element {
  return <div className="modal-backdrop modal-backdrop--nested" role="presentation"><div className="operation-platform-dialog operation-platform-dialog--compact"><header><div><h2>删除项目</h2><p>删除“{project.name}”后，已挂载节点将变为未关联状态。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header><footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="danger-button" onClick={onConfirm}><Trash2 size={15} />确认删除</button></footer></div></div>;
}
