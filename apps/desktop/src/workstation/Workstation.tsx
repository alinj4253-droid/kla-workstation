import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowRight, Bell, BookOpen, Bot, BriefcaseBusiness, CalendarDays, Check, CheckCircle2, ChevronDown, CircleHelp, Clock3, Cloud, Code2, Copy, CreditCard, Database, Download, Eye, EyeOff, FileText, Folder, FolderPlus, Home, KeyRound, LayoutDashboard, Menu, MessageSquare, MoreHorizontal, Paperclip, Plus, Search, Send, Settings, ShieldCheck, Sparkles, Upload, UserCircle, Users, Wallet, X } from 'lucide-react';
import logo from '../assets/kla-sidebar-logo.png';
import { authExpiredEventName, klaApi } from '../api/client';

type Section = 'home' | 'projects' | 'chats' | 'knowledge' | 'compute' | 'settings';
type ComputeView = 'dashboard' | 'keys' | 'usage' | 'market' | 'mine';
type Modal = 'project' | 'chat' | 'key' | 'knowledge' | 'agent' | 'register' | 'identity' | 'create-enterprise' | 'join-enterprise' | null;
type Project = { id: number; name: string; description: string; progress: number; members: number; color: string };
type Chat = { id: number; name: string; project: string; messages: { author: string; text: string; time: string }[] };
type Document = { name: string; group: string; size: string; status: string; date: string };

const initialProjects: Project[] = [
  { id: 1, name: '智能办公平台升级', description: '构建跨团队智能协作与知识处理平台', progress: 72, members: 8, color: '#2779e9' },
  { id: 2, name: '市场洞察与研究', description: '行业趋势分析、竞品研究与报告产出', progress: 48, members: 5, color: '#0d9488' },
  { id: 3, name: '品牌标准化建设', description: '统一资产规范并推进设计资料入库', progress: 86, members: 6, color: '#8b5cf6' },
];
const initialChats: Chat[] = [
  { id: 1, name: '项目协作群组', project: '智能办公平台升级', messages: [{ author: '统筹智能体', text: '大家好，项目材料已经整理完成，可以继续讨论下一步工作。', time: '09:56' }] },
  { id: 2, name: '市场调研讨论', project: '市场洞察与研究', messages: [{ author: '本地执行智能体', text: '已汇总行业趋势与主要竞品的公开资料。', time: '昨天' }] },
  { id: 3, name: '品牌规范评审', project: '品牌标准化建设', messages: [] },
];
const initialDocs: Document[] = [
  { name: '企业知识管理规范.pdf', group: '企业知识', size: '2.4 MB', status: '已完成', date: '2026-09-27' },
  { name: '智能办公需求说明.docx', group: '项目知识', size: '856 KB', status: '已完成', date: '2026-09-26' },
  { name: '市场洞察报告.md', group: '项目知识', size: '48 KB', status: '已完成', date: '2026-09-25' },
  { name: '个人工作笔记.txt', group: '个人知识', size: '12 KB', status: '处理中', date: '2026-09-24' },
];
const models = [
  { name: 'DeepSeek-R1', vendor: 'deepseek-ai / deepseek-reasoner', category: '深度思考', context: '128K', latency: '18ms', cost: '$0.0005/1K', icon: '◈' },
  { name: 'GPT-4o', vendor: 'openai / gpt-4o-2024-11-20', category: '全能旗舰', context: '128K', latency: '22ms', cost: '$0.0025/1K', icon: '◉' },
  { name: 'Claude 3.5 Sonnet', vendor: 'anthropic / claude-3-5-sonnet', category: '编程写作', context: '200K', latency: '26ms', cost: '$0.0030/1K', icon: '✦' },
  { name: 'Gemini 1.5 Pro', vendor: 'google / gemini-1.5-pro', category: '海量上下文', context: '2,000K', latency: '29ms', cost: '$0.00125/1K', icon: '▦' },
  { name: 'GLM-4-Air', vendor: 'zhipu / glm-4-air', category: '中文优选', context: '128K', latency: '15ms', cost: '免费体验', icon: '文' },
  { name: 'Qwen 2.5 72B-Instruct', vendor: 'qwen / qwen-2.5-72b-instruct', category: '企业级', context: '128K', latency: '20ms', cost: '$0.0007/1K', icon: '✣' },
];
const usage = [
  { time: '2026-09-29 14:08', model: 'zhipu/glm-5.3-flash', key: '订阅分组', tokens: '19.24K', cost: '$0.0021', state: '成功' },
  { time: '2026-09-29 13:42', model: 'deepseek-v4-flash', key: '订阅分组', tokens: '14.42K', cost: '$0.0016', state: '成功' },
  { time: '2026-09-29 11:21', model: 'zhipu/glm-5.3-flash', key: '订阅分组', tokens: '10.11K', cost: '$0.0012', state: '成功' },
];
type Agent = { name: string; role: string; type: '官方智能体' | '外接第三方' | '自定义智能体'; model: string; skills: string[]; enabled: boolean; color: string };
const initialAgents: Agent[] = [
  { name: '统筹智能体', role: '识别目标、规划协作任务并调度执行智能体', type: '官方智能体', model: '默认模型槽位', skills: ['任务规划', '智能体调度'], enabled: true, color: '#3b82f6' },
  { name: '文档编写智能体', role: '检索知识、分析资料并编写交付文档', type: '官方智能体', model: '默认模型槽位', skills: ['知识检索', '材料编写'], enabled: true, color: '#10b981' },
  { name: 'PPT 智能体', role: '将内容整理成可编辑的演示文稿', type: '官方智能体', model: '默认模型槽位', skills: ['大纲设计', '幻灯片生成'], enabled: true, color: '#8b5cf6' },
  { name: '数据分析智能体', role: '解析数据并输出图表与分析结论', type: '官方智能体', model: '默认模型槽位', skills: ['数据处理', '图表分析'], enabled: true, color: '#f59e0b' },
  { name: 'Kimi Code', role: '通过外部 CLI 协作完成代码编写任务', type: '外接第三方', model: '外部连接器', skills: ['代码编写'], enabled: false, color: '#0d9488' },
  { name: 'CodeBuddy', role: '对交付文件和代码进行验收', type: '外接第三方', model: '外部连接器', skills: ['成果验收'], enabled: false, color: '#64748b' },
];
const nav = [
  { id: 'home', label: '首页', Icon: Home }, { id: 'projects', label: '项目', Icon: Folder },
  { id: 'chats', label: '群组', Icon: MessageSquare }, { id: 'knowledge', label: '知识库', Icon: BookOpen },
  { id: 'compute', label: '算力', Icon: Settings },
] as const;
const computeNav = [
  { id: 'dashboard', label: '仪表盘', Icon: LayoutDashboard }, { id: 'keys', label: 'API 密钥', Icon: KeyRound },
  { id: 'usage', label: '使用记录', Icon: FileText }, { id: 'market', label: '模型广场', Icon: Database },
  { id: 'mine', label: '我的模型', Icon: Bot },
] as const;

function IconButton({ title, children, onClick }: { title: string; children: React.ReactNode; onClick?: () => void }) {
  return <button className="ws-icon-button" title={title} aria-label={title} onClick={onClick}>{children}</button>;
}
function Badge({ children, tone = 'blue' }: { children: React.ReactNode; tone?: 'blue' | 'green' | 'muted' | 'orange' }) {
  return <span className={`ws-badge ${tone}`}>{children}</span>;
}
function Panel({ title, action, children, className = '' }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`ws-panel ${className}`}><header className="ws-panel-head"><h3>{title}</h3>{action}</header>{children}</section>;
}
function Stat({ icon, label, value, hint, color = 'blue' }: { icon: React.ReactNode; label: string; value: string; hint?: string; color?: string }) {
  return <div className="ws-stat"><span className={`ws-stat-icon ${color}`}>{icon}</span><span className="ws-stat-label">{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}
function Chart({ kind = 'line' }: { kind?: 'line' | 'bars' }) {
  return <div className={`ws-chart ${kind}`} aria-label="模拟趋势图">{kind === 'bars' ? [42, 58, 38, 72, 53, 86, 67, 94].map((n, i) => <i key={i} style={{ height: `${n}%` }} />) : <><div className="ws-chart-grid" /><div className="ws-chart-line" /><div className="ws-chart-line secondary" /></>}</div>;
}

export function Workstation(): React.JSX.Element {
  const [signedIn, setSignedIn] = useState(() => Boolean(sessionStorage.getItem('kla.access-token')));
  const [authChecking, setAuthChecking] = useState(() => Boolean(sessionStorage.getItem('kla.access-token')));
  const [loginType, setLoginType] = useState<'personal' | 'enterprise'>('enterprise');
  const [username, setUsername] = useState('KQ20248866');
  const [password, setPassword] = useState('demo123456');
  const [showPassword, setShowPassword] = useState(false);
  const [section, setSection] = useState<Section>('home');
  const [computeView, setComputeView] = useState<ComputeView>('dashboard');
  const [modal, setModal] = useState<Modal>(null);
  const [identities, setIdentities] = useState<Array<{ id: string; displayName: string; type: string; organizationId: string | null }>>([]);
  const [identityAction, setIdentityAction] = useState<'create' | 'join' | null>(null);
  const [projects, setProjects] = useState(initialProjects);
  const [chats, setChats] = useState(initialChats);
  const [docs, setDocs] = useState(initialDocs);
  const [activeProject, setActiveProject] = useState(1);
  const [activeChat, setActiveChat] = useState(1);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newModel, setNewModel] = useState('DeepSeek-R1');
  const [knowledgeScope, setKnowledgeScope] = useState('全部知识');
  const [marketFilter, setMarketFilter] = useState('全部模型');
  const [selectedModels, setSelectedModels] = useState(['DeepSeek-R1']);
  const [keys, setKeys] = useState([{ name: '订阅分组', value: 'sk-0000...f7E2', created: '2026-09-28 21:58', active: true }]);
  const [notice, setNotice] = useState('');
  const [details, setDetails] = useState<string | null>(null);
  const [agents, setAgents] = useState(initialAgents);
  const [agentFilter, setAgentFilter] = useState('全部');
  const [agentDraft, setAgentDraft] = useState<Agent | null>(null);
  const [authNewName, setAuthNewName] = useState('');
  const [authNewEmail, setAuthNewEmail] = useState('');
  const [authNewPassword, setAuthNewPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const currentProject = projects.find(p => p.id === activeProject) ?? projects[0];
  const currentChat = chats.find(c => c.id === activeChat) ?? chats[0];
  const filteredDocs = useMemo(() => docs.filter(d => (knowledgeScope === '全部知识' || d.group === knowledgeScope) && d.name.toLowerCase().includes(query.toLowerCase())), [docs, knowledgeScope, query]);
  const notify = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 3500); };
  const navigate = (next: Section) => { setSection(next); setQuery(''); };
  useEffect(() => {
    const expire = () => { klaApi.clearAccessToken(); setSignedIn(false); setAuthChecking(false); notify('登录状态已失效，请重新登录'); };
    window.addEventListener(authExpiredEventName, expire);
    if (sessionStorage.getItem('kla.access-token')) {
      klaApi.request('/v1/me').then(result => { setSignedIn(result.ok); setAuthChecking(false); if (!result.ok) expire(); });
    }
    return () => window.removeEventListener(authExpiredEventName, expire);
  }, []);
  const login = async () => {
    const result = await klaApi.request<{ session: { accessToken: string; expiresAt: string } }>('/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ identifier: username.trim(), password }),
    });
    if (!result.ok) { notify(result.message); return; }
    klaApi.setAccessToken(result.data.session.accessToken, result.data.session.expiresAt);
    setSignedIn(true);
    setAuthChecking(false);
    const signed = result.data as { session: { accessToken: string; expiresAt: string }; identities?: typeof identities };
    setIdentities(signed.identities ?? []);
    setModal('identity');
  };
  const register = async () => {
    const result = await klaApi.request<{ session: { accessToken: string; expiresAt: string }; identities?: typeof identities }>('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: authNewEmail.trim(), password: authNewPassword, nickname: authNewName.trim() }) });
    if (!result.ok) { notify(result.message); return; }
    klaApi.setAccessToken(result.data.session.accessToken, result.data.session.expiresAt); setIdentities(result.data.identities ?? []); setSignedIn(true); setAuthChecking(false); setModal('identity');
  };
  const activateIdentity = async (identityId: string) => { const result = await klaApi.request('/v1/me/identities/' + identityId + '/activate', { method: 'POST' }); if (!result.ok) { notify(result.message); return; } setModal(null); notify('已切换身份'); };
  const createEnterprise = async () => { const result = await klaApi.request<{ id: string; displayName: string; type: string; organizationId: string | null }>('/v1/organizations', { method: 'POST', body: JSON.stringify({ name: companyName.trim(), licenseNumber: licenseNumber.trim() }) }); if (!result.ok) { notify(result.message); return; } setIdentities(items => [...items, result.data]); setCompanyName(''); setLicenseNumber(''); setModal('identity'); notify('企业创建成功'); };
  const joinEnterprise = async () => { const result = await klaApi.request<{ id: string; displayName: string; type: string; organizationId: string | null }>('/v1/organizations/join', { method: 'POST', body: JSON.stringify({ inviteCode: inviteCode.trim() }) }); if (!result.ok) { notify(result.message); return; } setIdentities(items => [...items, result.data]); setInviteCode(''); setModal('identity'); notify('已加入企业'); };
  const send = () => {
    if (!draft.trim()) return;
    const message = { author: '我', text: draft.trim(), time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) };
    setChats(items => items.map(c => c.id === activeChat ? { ...c, messages: [...c.messages, message] } : c));
    setDraft('');
  };
  const create = () => {
    if (!newName.trim()) return;
    if (modal === 'project') { const id = Date.now(); setProjects(items => [...items, { id, name: newName.trim(), description: newDescription.trim() || '暂无项目说明', progress: 0, members: 1, color: '#2779e9' }]); setActiveProject(id); navigate('projects'); }
    if (modal === 'chat') { const id = Date.now(); setChats(items => [...items, { id, name: newName.trim(), project: newProject || projects[0].name, messages: [] }]); setActiveChat(id); navigate('chats'); }
    if (modal === 'key') setKeys(items => [...items, { name: newName.trim(), value: `sk-demo...${Math.random().toString(36).slice(2, 6)}`, created: new Date().toLocaleString('zh-CN'), active: true }]);
    if (modal === 'agent') {
      if (agents.some(a => a.name === newName.trim())) { notify('智能体名称已存在'); return; }
      setAgents(items => [...items, { name: newName.trim(), role: newDescription.trim() || '自定义智能体', type: '自定义智能体', model: newModel, skills: [], enabled: true, color: '#2563eb' }]);
    }
    setModal(null); setNewName(''); setNewDescription(''); notify('已在本地预览中创建');
  };
  const downloadCsv = () => {
    const rows = ['时间,模型,密钥,Token,费用,状态', ...usage.map(r => Object.values(r).join(','))];
    const url = URL.createObjectURL(new Blob(['\ufeff', rows.join('\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'kla-usage-preview.csv'; link.click(); URL.revokeObjectURL(url);
  };

  if (authChecking) return <div className="ws-login"><div className="ws-login-card"><h1>正在验证登录状态</h1><p>请稍候…</p></div></div>;
  if (!signedIn) return <div className="ws-login">
    <header className="ws-login-brand"><img src={logo} alt="鲲擎" /><span>鲲擎平台<small>AI INTELLIGENCE · 智能工作站 V2.4.0</small></span><Badge>企业旗舰版</Badge></header>
    <form className="ws-login-card" onSubmit={e => { e.preventDefault(); void login(); }}>
      <img src={logo} alt="鲲擎标识" /><h1>欢迎登录鲲擎平台</h1><p>企业级多智能体协同工作台</p>
      <div className="ws-segment"><button type="button" className={loginType === 'personal' ? 'active' : ''} onClick={() => setLoginType('personal')}>个人登录</button><button type="button" className={loginType === 'enterprise' ? 'active' : ''} onClick={() => setLoginType('enterprise')}>企业登录</button></div>
      <label>企业工号 / 邮箱 / 手机号<input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required placeholder="请输入账号" /></label>
      <label>登录密码<span className="ws-password"><input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required placeholder="请输入密码" /><IconButton title={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</IconButton></span></label>
      <div className="ws-login-options"><label><input type="checkbox" defaultChecked /> 记住登录状态</label><button type="button" onClick={() => notify('密码找回将在认证服务接入后开放')}>忘记密码？</button></div>
      <button className="ws-primary wide" type="submit">立即登录并连接 Agent 网络 <ArrowRight size={15} /></button>
    </form><button className="ws-login-register" onClick={() => { setAuthNewName(''); setAuthNewEmail(''); setAuthNewPassword(''); setModal('register'); }}>创建新账号</button><footer>● 集群所有核心服务已连接正常 · 延迟 12ms <span>© 2026 鲲擎智能 · 保障企业数据与合规隐私安全</span></footer>{notice && <div className="ws-toast">{notice}</div>}
    {modal === 'register' && <div className="ws-modal-backdrop"><div className="ws-modal ws-auth-modal"><header><h2>创建账号</h2><IconButton title="关闭" onClick={() => setModal(null)}><X size={19} /></IconButton></header><form onSubmit={e => { e.preventDefault(); void register(); }}><label>用户名<input required value={authNewName} onChange={e => setAuthNewName(e.target.value)} autoComplete="nickname" /></label><label>邮箱<input required type="email" value={authNewEmail} onChange={e => setAuthNewEmail(e.target.value)} autoComplete="email" /></label><label>密码<input required type="password" minLength={8} value={authNewPassword} onChange={e => setAuthNewPassword(e.target.value)} autoComplete="new-password" /></label><footer><button type="button" onClick={() => setModal(null)}>取消</button><button className="ws-primary">创建账号</button></footer></form></div></div>}
  </div>;

  return <div className="ws-app">
    <aside className="ws-sidebar"><div><div className="ws-brand"><img src={logo} alt="鲲擎" /><span>鲲擎平台<small>AI INTELLIGENCE</small></span></div><nav>{nav.map(({ id, label, Icon }) => <button key={id} className={section === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={19} />{label}</button>)}</nav></div><div className="ws-sidebar-bottom"><button onClick={() => { navigate('compute'); setComputeView('dashboard'); }}><Sparkles size={15} /> 积分余额 <b>1,008.71 ›</b></button><button onClick={() => { setModal('chat'); setNewName(''); }}><Plus size={16} />新建群聊 / New Chat</button><button onClick={() => navigate('settings')}><Settings size={17} /> 设置</button><button onClick={() => { void klaApi.request('/v1/auth/logout', { method: 'POST' }); klaApi.clearAccessToken(); setSignedIn(false); }}><UserCircle size={17} /> 个人中心 · 退出</button></div></aside>
    {(section === 'projects' || section === 'chats' || section === 'compute' || section === 'settings') && <aside className="ws-subnav">
      {section === 'projects' && <><header><strong>项目协作空间</strong><IconButton title="创建项目" onClick={() => setModal('project')}><Plus size={17} /></IconButton></header><div className="ws-sub-search"><Search size={14} /><input placeholder="搜索项目..." value={query} onChange={e => setQuery(e.target.value)} /></div><div className="ws-sub-list">{projects.filter(p => p.name.includes(query)).map(p => <button key={p.id} className={p.id === activeProject ? 'active' : ''} onClick={() => setActiveProject(p.id)}><span className="ws-avatar" style={{ background: p.color }}>{p.name.slice(0, 2)}</span><span>{p.name}<small>{p.members} 位成员 · 进度 {p.progress}%</small></span></button>)}</div></>}
      {section === 'chats' && <><header><strong>项目协作群组</strong><IconButton title="创建群聊" onClick={() => setModal('chat')}><Plus size={17} /></IconButton></header><div className="ws-sub-search"><Search size={14} /><input placeholder="搜索群组名称或关键词..." value={query} onChange={e => setQuery(e.target.value)} /></div><div className="ws-sub-list">{chats.filter(c => c.name.includes(query)).map(c => <button key={c.id} className={c.id === activeChat ? 'active' : ''} onClick={() => setActiveChat(c.id)}><span className="ws-avatar">{c.name.slice(0, 2)}</span><span>{c.name}<small>● 进行中 · {c.project}</small></span><time>{c.messages.at(-1)?.time ?? ''}</time></button>)}</div></>}
      {section === 'compute' && <><header className="ws-compute-title"><span className="ws-tiny-icon"><Activity size={18} /></span><span>算力与计费中心<small>Cluster Mesh v4.8</small></span></header><div className="ws-compute-links">{computeNav.map(({ id, label, Icon }) => <button key={id} className={computeView === id ? 'active' : ''} onClick={() => { setComputeView(id); setQuery(''); }}><Icon size={16} />{label}</button>)}</div><div className="ws-wallet"><small>账户可用算力余额 <b>充足</b></small><strong>$1,000.00</strong><button className="ws-primary" onClick={() => notify('充值服务待接入')}>充值与余额购买</button></div></>}
      {section === 'settings' && <><header className="ws-compute-title"><span className="ws-tiny-icon"><Settings size={18} /></span><span>设置中心<small>智能体与工作站配置</small></span></header><div className="ws-settings-menu"><small>AI 核心</small><button className="active"><Bot size={16} /> 智能体管理</button><button onClick={() => { navigate('compute'); setComputeView('mine'); }}><Database size={16} /> 模型管理</button><small>AI 生产力</small><button onClick={() => notify('技能管理将在后续版本开放')}><Sparkles size={16} /> 技能管理</button><small>扩展设置</small><button onClick={() => notify('权限管理待服务端接入')}><ShieldCheck size={16} /> 权限管理</button></div></>}
    </aside>}
    <main className="ws-main"><div className="ws-topbar"><span>{section === 'home' ? '协同工作台 / 总览主页' : section === 'compute' ? `算力平台 / ${computeNav.find(n => n.id === computeView)?.label}` : section === 'settings' ? '设置 / 智能体管理' : `${nav.find(n => n.id === section)?.label} / 工作空间`}</span><Badge tone="green">● 网关节点运行正常</Badge><div className="ws-top-actions"><button className="ws-top-search" onClick={() => notify('全局搜索将在服务端检索接入后开放')}><Search size={14} /> 快速搜索智能体、任务...</button><IconButton title="通知" onClick={() => notify('暂无新通知')}><Bell size={16} /></IconButton><IconButton title="帮助" onClick={() => notify('帮助中心即将开放')}><CircleHelp size={16} /></IconButton><div className="ws-user">👨🏻‍💻 <span>老K<small>数字化员工</small></span></div></div></div>
      <div className="ws-content">
        {section === 'settings' && <><div className="ws-agent-heading"><div><h1>智能体管理 <Badge>Agent Registry</Badge></h1><p>管理官方智能体、外接三方和自定义智能体的模型、技能与权限。</p></div><button className="ws-primary" onClick={() => { setNewName(''); setNewDescription(''); setModal('agent'); }}><Plus size={15} /> 新建智能体</button></div><div className="ws-agent-toolbar"><div className="ws-segment">{['全部', '官方智能体', '外接第三方', '自定义智能体'].map(t => <button key={t} className={agentFilter === t ? 'active' : ''} onClick={() => setAgentFilter(t)}>{t}</button>)}</div><div className="ws-sub-search"><Search size={14} /><input placeholder="搜索智能体..." value={query} onChange={e => setQuery(e.target.value)} /></div></div><div className="ws-agent-grid">{agents.filter(a => (agentFilter === '全部' || agentFilter === a.type) && `${a.name}${a.role}`.toLowerCase().includes(query.toLowerCase())).map(a => <article className="ws-agent-card" key={a.name}><div className="ws-agent-card-head"><span className="ws-avatar" style={{ background: a.color }}>{a.name.slice(0, 2)}</span><div><h3>{a.name}</h3><small>{a.type}</small></div><Badge tone={a.enabled ? 'green' : 'muted'}>{a.enabled ? '已启用' : '未连接'}</Badge></div><p>{a.role}</p><div className="ws-agent-meta"><span>运行方式: {a.type === '外接第三方' ? '外部连接器' : '本地模型智能体'}</span><span>挂载模型: {a.model}</span></div><div className="ws-agent-skills">{a.skills.map(s => <Badge key={s}>{s}</Badge>)}</div><footer><button onClick={() => setAgentDraft(a)}><Settings size={14} /> 配置</button><button onClick={() => setAgents(items => items.map(x => x.name === a.name ? { ...x, enabled: !x.enabled } : x))}>{a.enabled ? '停用' : '启用'}</button></footer></article>)}</div></>}
        {section === 'home' && <><div className="ws-hero"><div><Badge>已自动识别身份 · 员工目录</Badge><p>早上好，老K · 开启高效多智能体协同的一天</p><div className="ws-hero-tags"><Badge tone="green">● 全域智能调度引擎运行中</Badge><Badge>算力响应正常 · 延迟 &lt; 85ms</Badge><Badge>4 大业务群组在协助你</Badge></div></div><div className="ws-hero-box"><Sparkles size={24} /><strong>已连接 4 个核心模型</strong><small>随时启动智能协同流程</small><button className="ws-primary" onClick={() => { navigate('compute'); setComputeView('market'); }}>查看模型广场 <ArrowRight size={15} /></button></div></div><div className="ws-stats four"><Stat icon={<Wallet />} label="可用 Token" value="0" hint="集团统一额度分配" /><Stat icon={<Bot />} label="已安装应用" value="4 个" hint="可选 4 个" color="green" /><Stat icon={<BookOpen />} label="可访问知识" value={`${docs.length + 8} 份`} hint="按 BG 与权限过滤" color="teal" /><Stat icon={<FileText />} label="工作记忆" value="18 条" hint="员工可查看、可删除" color="orange" /></div><div className="ws-home-grid"><Panel title="今天想完成什么？" action={<Badge tone="green">● 智能调度引擎就绪</Badge>}><textarea className="ws-home-prompt" placeholder="输入问题，鲲擎会自动拆分你的岗位、知识和记忆..." value={draft} onChange={e => setDraft(e.target.value)} /><div className="ws-prompt-actions"><Paperclip size={16} /><span>上传任务资料，开始协作</span><button className="ws-primary" onClick={() => { setActiveChat(chats[0].id); navigate('chats'); send(); }}> <Send size={16} /> </button></div><div className="ws-chip-row">{['总结本周工作', '查询集团制度', '生成项目汇报', '拆解今天的任务'].map(t => <button key={t} onClick={() => setDraft(t)}>{t}</button>)}</div><div className="ws-connection"><Bot size={17} /> 当前已连接 DeepSeek-V3 与高转私有化模型 <button onClick={() => { navigate('compute'); setComputeView('market'); }}>查看模型市场</button></div></Panel><Panel title="我的任务" action={<button className="ws-text-button" onClick={() => notify('任务模块待接入')}>+ 新建任务</button>}><div className="ws-empty"><CheckCircle2 size={28} /><strong>今天没有待办</strong><small>点击上方新建任务即可安排工作</small></div></Panel></div><Panel title="推荐多智能体群组" action={<button className="ws-text-button" onClick={() => navigate('chats')}>更多群组模板 →</button>}><div className="ws-recommend">{['财务审计协同组', '市场调研小组', '智能研发协作', '创意营销工坊'].map((name, i) => <button key={name} onClick={() => { setModal('chat'); setNewName(name); }}><span className={`ws-recommend-icon tint-${i}`}><BriefcaseBusiness size={20} /></span><strong>{name}</strong><small>连接专业智能体，快速启动协作</small></button>)}</div></Panel></>}
        {section === 'projects' && <><div className="ws-page-heading"><div><h1>{currentProject.name}</h1><p>{currentProject.description}</p></div><button className="ws-primary" onClick={() => setModal('project')}><Plus size={16} /> 创建项目</button></div><div className="ws-stats four"><Stat icon={<Folder />} label="项目总数" value={`${projects.length}`} hint="当前工作空间" /><Stat icon={<CheckCircle2 />} label="总体完成率" value={`${Math.round(projects.reduce((n, p) => n + p.progress, 0) / projects.length)}%`} hint="项目任务进度" color="green" /><Stat icon={<Users />} label="参与成员" value={`${currentProject.members} 人`} hint="含协作智能体" color="teal" /><Stat icon={<CalendarDays />} label="待办任务" value="8 项" hint="本周需跟进" color="orange" /></div><div className="ws-project-grid"><Panel title="项目进度概览" action={<Badge tone="green">进行中</Badge>}><div className="ws-project-progress"><div><strong>{currentProject.progress}%</strong><small>整体进度</small></div><div className="ws-progress-track"><i style={{ width: `${currentProject.progress}%` }} /></div><p>已完成 18 / 25 个任务节点</p></div><div className="ws-milestones">{['需求调研', '方案设计', '功能开发', '联调验收'].map((t, i) => <span key={t} className={i < 2 ? 'done' : ''}>{i < 2 ? '✓' : i + 1} {t}</span>)}</div></Panel><Panel title="近七日任务趋势" action={<span className="ws-muted">任务完成情况</span>}><Chart kind="bars" /></Panel></div><div className="ws-project-grid"><Panel title="项目成员与智能体"><div className="ws-people">{['老K', '统筹智能体', '本地执行智能体', '设计团队'].map(t => <span key={t}><span className="ws-avatar">{t.slice(0, 2)}</span>{t}</span>)}</div></Panel><Panel title="项目动态" action={<button className="ws-text-button" onClick={() => navigate('chats')}>进入群组 →</button>}><div className="ws-timeline"><p><b>今日 09:30</b> 统筹智能体更新项目阶段计划</p><p><b>昨日 16:20</b> 完成知识库资料归档</p><p><b>09月26日</b> 项目例会纪要已整理</p></div></Panel></div></>}
        {section === 'chats' && <div className="ws-chat"><header><div><span className="ws-avatar">{currentChat.name.slice(0, 2)}</span><span><strong>{currentChat.name}</strong><small>● {currentChat.project} · 2 个智能体协作中</small></span></div><div><IconButton title="邀请成员" onClick={() => notify('邀请成员将在成员接口接入后开放')}><Users size={17} /></IconButton><IconButton title="群组文件" onClick={() => notify('群组文件将在服务端存储接入后开放')}><Folder size={17} /></IconButton><IconButton title="更多" onClick={() => notify('群组设置即将开放')}><MoreHorizontal size={17} /></IconButton></div></header><div className="ws-chat-messages"><p className="ws-chat-date">加载更多消息</p>{currentChat.messages.map((m, i) => <div className={`ws-message ${m.author === '我' ? 'self' : ''}`} key={`${m.time}-${i}`}><span className="ws-avatar">{m.author.slice(0, 2)}</span><div><small>{m.author} · {m.time}</small><p>{m.text}</p></div></div>)}</div><div className="ws-chat-compose"><textarea placeholder="发送消息给群组 (支持 @ 智能体)..." value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} /><div><span><Paperclip size={16} /> 附件　<Bot size={16} /> 智能体</span><button className="ws-primary" onClick={send}><Send size={15} />发送给群组</button></div></div></div>}
        {section === 'knowledge' && <><div className="ws-page-heading"><div><h1>知识库</h1><p>统一管理企业、项目及个人知识资产</p></div><button className="ws-primary" onClick={() => setModal('knowledge')}><Upload size={16} /> 上传文件</button></div><div className="ws-knowledge-layout"><div><div className="ws-stats three"><Stat icon={<BookOpen />} label="知识总量" value={`${docs.length + 8} 份`} hint="已授权访问" /><Stat icon={<CheckCircle2 />} label="已完成知识化" value={`${docs.filter(d => d.status === '已完成').length + 8} 份`} hint="可供智能体检索" color="green" /><Stat icon={<Clock3 />} label="处理中" value="1 份" hint="等待服务端处理" color="orange" /></div><Panel title="知识资产" action={<div className="ws-inline"><select aria-label="知识范围" value={knowledgeScope} onChange={e => setKnowledgeScope(e.target.value)}>{['全部知识', '企业知识', '项目知识', '个人知识'].map(t => <option key={t}>{t}</option>)}</select><div className="ws-sub-search"><Search size={14} /><input placeholder="搜索文件..." value={query} onChange={e => setQuery(e.target.value)} /></div></div>}><div className="ws-folder-row">{['企业知识', '项目知识', '个人知识'].map(t => <button className={knowledgeScope === t ? 'active' : ''} onClick={() => setKnowledgeScope(t)} key={t}><Folder size={18} />{t}<small>{docs.filter(d => d.group === t).length} 份</small></button>)}</div><table className="ws-table"><thead><tr><th>文件名称</th><th>所属知识库</th><th>大小</th><th>处理状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{filteredDocs.map(d => <tr key={d.name}><td><FileText size={16} /> {d.name}</td><td>{d.group}</td><td>{d.size}</td><td><Badge tone={d.status === '已完成' ? 'green' : 'orange'}>{d.status}</Badge></td><td>{d.date}</td><td><button className="ws-text-button" onClick={() => setDetails(d.name)}>查看</button></td></tr>)}</tbody></table>{filteredDocs.length === 0 && <div className="ws-empty">没有匹配的文件</div>}</Panel></div><aside className="ws-rag"><div><Sparkles size={23} /><h2>智能知识引擎</h2><p>让企业知识为协同工作提供可信依据</p></div><div><h3>RAG 智能检索</h3><p>从当前权限范围内检索文档，结合上下文提供准确回答。</p><span>● 服务状态正常</span></div><button onClick={() => notify('知识问答将在检索 API 接入后开放')}>开始知识问答 <ArrowRight size={15} /></button></aside></div></>}
        {section === 'compute' && <><div className="ws-compute-heading"><span>算力平台 / <b>{computeNav.find(n => n.id === computeView)?.label}</b></span><div>时间范围: <select aria-label="时间范围"><option>近 7 天</option><option>近 24 小时</option><option>近 30 天</option></select></div></div>
          {computeView === 'dashboard' && <><div className="ws-stats four"><Stat icon={<Wallet />} label="余额" value="$1,000.00" hint="可用: $1,000.00" color="green" /><Stat icon={<KeyRound />} label="API 密钥" value={`${keys.length}`} hint="● 已启用" /><Stat icon={<Send />} label="今日请求" value="3" hint="总计: 3" color="teal" /><Stat icon={<CreditCard />} label="今日消费" value="$0.0049" hint="总计: $0.0049" /></div><div className="ws-stats four"><Stat icon={<Database />} label="今日 Token" value="43.8K" hint="输入: 29.1K / 输出: 14.4K" color="orange" /><Stat icon={<Activity />} label="累计 Token" value="43.8K" hint="近 7 天累计" color="teal" /><Stat icon={<Cloud />} label="性能指标" value="0 RPM" hint="0 TPM" /><Stat icon={<Clock3 />} label="平均响应" value="3.74s" hint="网络稳定" color="purple" /></div><Panel title="按平台拆分" action={<small className="ws-muted">已连接 1 个活跃分组</small>}><div className="ws-provider"><span className="ws-provider-icon">AI</span><strong>OpenAI</strong><small>请求 3 次 · Token 43.8K</small><b>$0.0049</b></div></Panel><div className="ws-project-grid"><Panel title="模型分布"><div className="ws-donut-row"><div className="ws-donut">100%<small>glm-5.3</small></div><div>zhipu/glm-5.3-flash<br /><small>3 次请求 · 43.8K Token</small></div></div></Panel><Panel title="Token 使用趋势"><Chart /><div className="ws-chart-labels">09/25　　09/26　　09/27　　09/28　　09/29　　今日</div></Panel></div></>}
          {computeView === 'keys' && <Panel title="API 密钥" action={<button className="ws-primary" onClick={() => { setNewName(''); setModal('key'); }}><Plus size={15} /> 创建密钥</button>}><div className="ws-filters"><div className="ws-sub-search"><Search size={15} /><input placeholder="搜索名称或 Key..." value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="分组筛选"><option>全部分组</option></select><select aria-label="状态筛选"><option>全部状态</option><option>活跃</option></select></div><table className="ws-table"><thead><tr><th>名称</th><th>API 密钥</th><th>分组</th><th>当前并发</th><th>用量</th><th>过期时间</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{keys.filter(k => k.name.includes(query)).map(k => <tr key={k.value}><td>● {k.name}</td><td><code>{k.value}</code> <IconButton title="复制密钥" onClick={() => { void navigator.clipboard?.writeText(k.value); notify('已复制预览密钥'); }}><Copy size={13} /></IconButton></td><td><Badge tone="green">● 算力订阅分组</Badge></td><td>0</td><td>今日: $0.0049</td><td>永久有效</td><td><Badge tone={k.active ? 'green' : 'muted'}>{k.active ? '活跃' : '已停用'}</Badge></td><td>{k.created}</td><td><button className="ws-text-button" onClick={() => setKeys(items => items.map(x => x.value === k.value ? { ...x, active: !x.active } : x))}>{k.active ? '停用' : '启用'}</button></td></tr>)}</tbody></table><p className="ws-table-footer">共 {keys.length} 条记录 · 预览数据</p></Panel>}
          {computeView === 'usage' && <><div className="ws-stats four"><Stat icon={<FileText />} label="总请求数" value="3" hint="最近时间内" /><Stat icon={<Database />} label="总 Token" value="43.77K" hint="输入: 29.13K / 输出: 14.4K" color="orange" /><Stat icon={<Wallet />} label="总消费" value="$0.0049" hint="预览统计" color="green" /><Stat icon={<Clock3 />} label="平均耗时" value="3.74s" color="purple" /></div><div className="ws-project-grid"><Panel title="模型分布"><div className="ws-donut-row"><div className="ws-donut" /><div>zhipu/glm-5.3-flash<br /><small>3 次请求 · 43.77K Token</small></div></div></Panel><Panel title="Token 使用趋势"><Chart /></Panel></div><Panel title="使用记录" action={<button className="ws-primary teal" onClick={downloadCsv}><Download size={14} /> 导出 CSV</button>}><div className="ws-filters"><select aria-label="模型"><option>全部模型</option></select><select aria-label="密钥"><option>全部密钥</option></select><select aria-label="类型"><option>全部类型</option></select><button onClick={() => notify('已刷新预览数据')}>刷新</button></div><table className="ws-table"><thead><tr><th>请求时间</th><th>模型</th><th>API 密钥</th><th>Token 消耗</th><th>实际消费</th><th>状态</th></tr></thead><tbody>{usage.map(r => <tr key={r.time}><td>{r.time}</td><td>{r.model}</td><td>{r.key}</td><td>{r.tokens}</td><td>{r.cost}</td><td><Badge tone="green">{r.state}</Badge></td></tr>)}</tbody></table></Panel></>}
          {(computeView === 'market' || computeView === 'mine') && <><div className="ws-market-controls"><div className="ws-sub-search"><Search size={16} /><input placeholder="搜索大语言模型、深度推理、视觉多模态..." value={query} onChange={e => setQuery(e.target.value)} /></div><div className="ws-segment compact"><button className={computeView === 'market' ? 'active' : ''} onClick={() => setComputeView('market')}>模型广场</button><button className={computeView === 'mine' ? 'active' : ''} onClick={() => setComputeView('mine')}>我的模型 ({selectedModels.length})</button></div></div><div className="ws-chip-row market">{['全部模型', '深度思考', '编程写作', '海量上下文', '企业级'].map(t => <button key={t} className={marketFilter === t ? 'active' : ''} onClick={() => setMarketFilter(t)}>{t}</button>)}</div><div className="ws-model-grid">{models.filter(m => (computeView === 'market' || selectedModels.includes(m.name)) && (marketFilter === '全部模型' || m.category === marketFilter) && `${m.name}${m.vendor}`.toLowerCase().includes(query.toLowerCase())).map(m => <article className="ws-model" key={m.name}><div className="ws-model-head"><span className="ws-model-icon">{m.icon}</span><div><h3>{m.name}</h3><small>{m.vendor}</small></div><Badge tone="green">{m.category}</Badge></div><p>面向复杂任务与专业场景，提供可靠的内容理解、生成与智能协作能力。</p><div className="ws-model-spec"><span>上下文窗口<b>{m.context}</b></span><span>首字延迟<b>{m.latency}</b></span><span>输入计费<b>{m.cost}</b></span></div><div className="ws-model-actions"><button onClick={() => notify(`${m.name} 测速将在算力 API 接入后开放`)}>测速</button><button onClick={() => setDetails(m.name)}>参数详情</button><button className="ws-primary" onClick={() => { setSelectedModels(items => items.includes(m.name) ? items.filter(x => x !== m.name) : [...items, m.name]); notify(selectedModels.includes(m.name) ? '已从我的模型移除' : '已选用模型'); }}>{selectedModels.includes(m.name) ? <><Check size={14} /> 已选用</> : <><Plus size={14} /> 选用此模型</>}</button></div></article>)}</div>{computeView === 'mine' && selectedModels.length === 0 && <div className="ws-empty">暂无选用模型，前往模型广场添加</div>}</>}
        </>}
      </div>
    </main>
    {modal && !['register','identity','create-enterprise','join-enterprise'].includes(modal) && <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModal(null); }}><div className="ws-modal"><header><h2>{modal === 'project' ? '创建项目' : modal === 'chat' ? '创建群聊' : modal === 'key' ? '创建 API 密钥' : modal === 'agent' ? '新建自定义智能体' : '上传知识文件'}</h2><IconButton title="关闭" onClick={() => setModal(null)}><X size={19} /></IconButton></header>{modal === 'knowledge' ? <div className="ws-upload"><Upload size={28} /><p>选择文件加入知识库</p><select value={knowledgeScope === '全部知识' ? '个人知识' : knowledgeScope} onChange={e => setKnowledgeScope(e.target.value)}>{['企业知识', '项目知识', '个人知识'].map(t => <option key={t}>{t}</option>)}</select><input type="file" multiple onChange={e => { const files = Array.from(e.target.files ?? []); setDocs(items => [...items, ...files.map(f => ({ name: f.name, group: knowledgeScope === '全部知识' ? '个人知识' : knowledgeScope, size: `${(f.size / 1024).toFixed(0)} KB`, status: '待处理', date: new Date().toISOString().slice(0, 10) }))]); setModal(null); if (files.length) notify(`已加入 ${files.length} 个本地预览文件；服务端上传与知识化待接入`); }} /></div> : <form onSubmit={e => { e.preventDefault(); create(); }}><label>{modal === 'project' ? '项目名称' : modal === 'chat' ? '群聊名称' : modal === 'agent' ? '智能体名称' : '密钥名称'}<input autoFocus required value={newName} onChange={e => setNewName(e.target.value)} placeholder="请输入名称" /></label>{(modal === 'project' || modal === 'agent') && <label>{modal === 'project' ? '项目说明' : '职责说明'}<textarea value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="简要描述职责与目标" /></label>}{modal === 'agent' && <label>挂载模型<select value={newModel} onChange={e => setNewModel(e.target.value)}>{models.map(m => <option key={m.name}>{m.name}</option>)}</select></label>}{modal === 'chat' && <label>关联项目<select value={newProject || projects[0].name} onChange={e => setNewProject(e.target.value)}>{projects.map(p => <option key={p.id}>{p.name}</option>)}</select></label>}<footer><button type="button" onClick={() => setModal(null)}>取消</button><button className="ws-primary" type="submit">创建</button></footer></form>}</div></div>}
    {agentDraft && <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setAgentDraft(null); }}><div className="ws-modal"><header><h2>配置 · {agentDraft.name}</h2><IconButton title="关闭" onClick={() => setAgentDraft(null)}><X size={19} /></IconButton></header><form onSubmit={e => { e.preventDefault(); setAgents(items => items.map(a => a.name === agentDraft.name ? agentDraft : a)); setAgentDraft(null); notify('智能体配置已更新（前端预览）'); }}><label>身份与职责<textarea value={agentDraft.role} onChange={e => setAgentDraft({ ...agentDraft, role: e.target.value })} /></label><label>挂载模型<select value={agentDraft.model} onChange={e => setAgentDraft({ ...agentDraft, model: e.target.value })}><option>默认模型槽位</option><option>外部连接器</option>{selectedModels.map(m => <option key={m}>{m}</option>)}</select></label><p className="ws-detail-copy">技能和权限由服务端管理；本页仅保存前端预览状态。</p><footer><button type="button" onClick={() => setAgentDraft(null)}>取消</button><button className="ws-primary">保存</button></footer></form></div></div>}
    {details && <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setDetails(null); }}><div className="ws-modal"><header><h2>{details}</h2><IconButton title="关闭" onClick={() => setDetails(null)}><X size={19} /></IconButton></header><p className="ws-detail-copy">当前为前端预览数据。文件正文或模型参数详情将在对应服务端接口接入后展示。</p><footer><button className="ws-primary" onClick={() => setDetails(null)}>关闭</button></footer></div></div>}
    {modal && ['register','identity','create-enterprise','join-enterprise'].includes(modal) && <div className="ws-modal-backdrop"><div className="ws-modal ws-auth-modal">
      <header><h2>{modal === 'register' ? '创建账号' : modal === 'identity' ? '选择登录身份' : modal === 'create-enterprise' ? '创建企业身份' : '加入企业'}</h2>{modal !== 'identity' && <IconButton title="关闭" onClick={() => setModal(null)}><X size={19} /></IconButton>}</header>
      {modal === 'register' && <form onSubmit={e => { e.preventDefault(); void register(); }}><label>用户名<input required value={authNewName} onChange={e => setAuthNewName(e.target.value)} autoComplete="nickname" /></label><label>邮箱<input required type="email" value={authNewEmail} onChange={e => setAuthNewEmail(e.target.value)} autoComplete="email" /></label><label>密码<input required type="password" minLength={8} value={authNewPassword} onChange={e => setAuthNewPassword(e.target.value)} autoComplete="new-password" /></label><footer><button type="button" onClick={() => setModal(null)}>取消</button><button className="ws-primary">创建账号</button></footer></form>}
      {modal === 'identity' && <div className="ws-identity-list"><button onClick={() => { setModal(null); notify('已使用个人身份登录'); }}><UserCircle size={18} /><span>个人身份<small>个人工作区</small></span><ArrowRight size={15} /></button>{identities.filter(item => item.type === 'enterprise').map(item => <button key={item.id} onClick={() => void activateIdentity(item.id)}><BriefcaseBusiness size={18} /><span>{item.displayName}<small>企业身份</small></span><ArrowRight size={15} /></button>)}<div className="ws-identity-actions"><button onClick={() => setModal('create-enterprise')}><Plus size={15} /> 创建新的企业</button><button onClick={() => setModal('join-enterprise')}><Users size={15} /> 加入已有企业</button></div></div>}
      {modal === 'create-enterprise' && <form onSubmit={e => { e.preventDefault(); void createEnterprise(); }}><label>企业名称<input required value={companyName} onChange={e => setCompanyName(e.target.value)} /></label><label>营业执照编码<input required value={licenseNumber} onChange={e => setLicenseNumber(e.target.value)} /></label><p className="ws-detail-copy">创建后将为当前账号建立企业管理员身份。</p><footer><button type="button" onClick={() => setModal('identity')}>返回</button><button className="ws-primary">创建并进入</button></footer></form>}
      {modal === 'join-enterprise' && <form onSubmit={e => { e.preventDefault(); void joinEnterprise(); }}><label>企业邀请码<input required value={inviteCode} onChange={e => setInviteCode(e.target.value.toUpperCase())} /></label><p className="ws-detail-copy">加入成功后将为当前账号建立该企业的成员身份。</p><footer><button type="button" onClick={() => setModal('identity')}>返回</button><button className="ws-primary">加入并进入</button></footer></form>}
    </div></div>}
    {notice && <div className="ws-toast">{notice}</div>}
  </div>;
}
