import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowRight, Bell, BookOpen, Bot, BriefcaseBusiness, CalendarDays, Check, CheckCircle2, ChevronDown, CircleHelp, Clock3, Cloud, Code2, Copy, CreditCard, Database, Download, Eye, EyeOff, FileText, Folder, FolderPlus, Home, KeyRound, LayoutDashboard, Menu, MessageSquare, MoreHorizontal, Paperclip, Plus, Search, Send, Settings, ShieldCheck, Sparkles, Upload, UserCircle, Users, Wallet, X } from 'lucide-react';
import logo from '../assets/kla-sidebar-logo.png';
import { authExpiredEventName, klaApi } from '../api/client';

type Section = 'home' | 'projects' | 'chats' | 'knowledge' | 'compute' | 'settings';
type ComputeView = 'dashboard' | 'keys' | 'usage' | 'market' | 'mine';
type Modal = 'project' | 'chat' | 'key' | 'knowledge' | 'knowledge-create' | 'agent' | 'register' | 'identity' | 'create-enterprise' | 'join-enterprise' | null;
type Project = { id: string; name: string; description: string; progress: number; members: number; color: string };
type Chat = { id: string; name: string; project: string; projectId?: string; messages: { id?: string; author: string; text: string; time: string; senderType?: string; artifactId?: string }[] };
type Document = { name: string; group: string; size: string; status: string; date: string };
type KnowledgeScope = 'enterprise' | 'project' | 'personal';
type KnowledgeTab = 'sources' | 'chunks';
type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  scopeType: KnowledgeScope;
  projectId?: string;
  fileCount: number;
  chunkCount: number;
  status: 'ready' | 'processing' | 'failed';
  updatedAt: string;
  color: string;
  canManage: boolean;
};
type KnowledgeSource = {
  id: string;
  knowledgeBaseId: string;
  name: string;
  mimeType: string;
  size: string;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  updatedAt: string;
  file?: File;
};
type KnowledgeChunk = {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  page?: number;
  section?: string;
  startOffset: number;
  endOffset: number;
  status: 'ready' | 'processing';
};

const initialProjects: Project[] = [
  { id: 'demo-1', name: '智能办公平台升级', description: '构建跨团队智能协作与知识处理平台', progress: 72, members: 8, color: '#2779e9' },
  { id: 'demo-2', name: '市场洞察与研究', description: '行业趋势分析、竞品研究与报告产出', progress: 48, members: 5, color: '#0d9488' },
  { id: 'demo-3', name: '品牌标准化建设', description: '统一资产规范并推进设计资料入库', progress: 86, members: 6, color: '#8b5cf6' },
];
const initialChats: Chat[] = [
  { id: 'demo-chat-1', name: '项目协作群组', project: '智能办公平台升级', projectId: 'demo-1', messages: [{ author: '统筹智能体', text: '大家好，项目材料已经整理完成，可以继续讨论下一步工作。', time: '09:56' }] },
  { id: 'demo-chat-2', name: '市场调研讨论', project: '市场洞察与研究', projectId: 'demo-2', messages: [{ author: '本地执行智能体', text: '已汇总行业趋势与主要竞品的公开资料。', time: '昨天' }] },
  { id: 'demo-chat-3', name: '品牌规范评审', project: '品牌标准化建设', projectId: 'demo-3', messages: [] },
];
const initialDocs: Document[] = [
  { name: '企业知识管理规范.pdf', group: '企业知识', size: '2.4 MB', status: '已完成', date: '2026-09-27' },
  { name: '智能办公需求说明.docx', group: '项目知识', size: '856 KB', status: '已完成', date: '2026-09-26' },
  { name: '市场洞察报告.md', group: '项目知识', size: '48 KB', status: '已完成', date: '2026-09-25' },
  { name: '个人工作笔记.txt', group: '个人知识', size: '12 KB', status: '处理中', date: '2026-09-24' },
];
const initialKnowledgeBases: KnowledgeBase[] = [
  { id: 'kb-enterprise', name: '企业制度与规范', description: '企业级制度、流程与合规资料', scopeType: 'enterprise', fileCount: 18, chunkCount: 246, status: 'ready', updatedAt: '2026-09-29', color: '#2779e9', canManage: true },
  { id: 'kb-project-1', name: '智能办公平台升级', description: '项目需求、设计与联调资料', scopeType: 'project', projectId: 'demo-1', fileCount: 7, chunkCount: 108, status: 'ready', updatedAt: '2026-09-28', color: '#0d9488', canManage: true },
  { id: 'kb-personal', name: '我的工作资料', description: '仅当前个人身份可见的资料', scopeType: 'personal', fileCount: 4, chunkCount: 37, status: 'processing', updatedAt: '2026-09-27', color: '#f59e0b', canManage: true },
];
const initialKnowledgeSources: KnowledgeSource[] = [
  { id: 'src-1', knowledgeBaseId: 'kb-enterprise', name: '企业知识管理规范.pdf', mimeType: 'application/pdf', size: '2.4 MB', status: 'ready', updatedAt: '2026-09-27' },
  { id: 'src-2', knowledgeBaseId: 'kb-project-1', name: '智能办公需求说明.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: '856 KB', status: 'ready', updatedAt: '2026-09-26' },
  { id: 'src-3', knowledgeBaseId: 'kb-personal', name: '个人工作笔记.txt', mimeType: 'text/plain', size: '12 KB', status: 'processing', updatedAt: '2026-09-24' },
];
const initialKnowledgeChunks: KnowledgeChunk[] = [
  { id: 'chunk-1', sourceId: 'src-1', title: '知识库权限与责任', content: '企业知识库由企业管理员统一维护，所有检索结果必须经过当前身份权限过滤。', page: 3, section: '2.1 权限管理', startOffset: 1820, endOffset: 1863, status: 'ready' },
  { id: 'chunk-2', sourceId: 'src-2', title: '项目目标与范围', content: '本项目建设跨团队智能协作与知识处理平台，覆盖群聊、项目和知识库能力。', page: 2, section: '1. 项目概述', startOffset: 640, endOffset: 682, status: 'ready' },
];
const initialModels = [
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', vendor: 'deepseek / deepseek-reasoner', category: '深度思考', context: '128K', latency: '服务端探测', cost: '待配置密钥', icon: '◈' },
  { id: 'gpt-4o', name: 'GPT-4o', vendor: 'openai / gpt-4o', category: '视觉多模态', context: '128K', latency: '服务端探测', cost: '待配置密钥', icon: '◉' },
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', vendor: 'anthropic / claude-3-5-sonnet', category: '视觉多模态', context: '200K', latency: '服务端探测', cost: '待配置密钥', icon: '✦' },
  { id: 'zhipu/glm-5.3-flash', name: 'GLM 5.3 Flash', vendor: 'zhipu / glm-5.3-flash', category: '视觉多模态', context: '128K', latency: '服务端探测', cost: '已配置', icon: '文' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', vendor: 'deepseek / deepseek-v4-flash', category: '通用模型', context: '128K', latency: '服务端探测', cost: '待配置密钥', icon: '◈' },
  { id: 'qwen-plus', name: 'Qwen Plus', vendor: 'qwen / qwen-plus', category: '深度思考', context: '128K', latency: '服务端探测', cost: '待配置密钥', icon: '✣' },
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
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [section, setSection] = useState<Section>('home');
  const [computeView, setComputeView] = useState<ComputeView>('dashboard');
  const [modal, setModal] = useState<Modal>(null);
  const [identities, setIdentities] = useState<Array<{ id: string; displayName: string; type: string; organizationId: string | null; isDefault?: boolean }>>([]);
  const [activeIdentityId, setActiveIdentityId] = useState(() => klaApi.getIdentity() ?? '');
  const [identityAction, setIdentityAction] = useState<'create' | 'join' | null>(null);
  const [projects, setProjects] = useState(initialProjects);
  const [chats, setChats] = useState(initialChats);
  const [docs, setDocs] = useState(initialDocs);
  const [activeProject, setActiveProject] = useState('demo-1');
  const [activeChat, setActiveChat] = useState('demo-chat-1');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newModel, setNewModel] = useState('DeepSeek-R1');
  const [knowledgeScope, setKnowledgeScope] = useState('全部知识');
  const [knowledgeView, setKnowledgeView] = useState<'catalog' | 'detail'>('catalog');
  const [knowledgeBases, setKnowledgeBases] = useState(initialKnowledgeBases);
  const [activeKnowledgeBase, setActiveKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [knowledgeTab, setKnowledgeTab] = useState<KnowledgeTab>('sources');
  const [knowledgeSources, setKnowledgeSources] = useState(initialKnowledgeSources);
  const [knowledgeChunks, setKnowledgeChunks] = useState(initialKnowledgeChunks);
  const [knowledgePreview, setKnowledgePreview] = useState<{ title: string; content?: string; url?: string; kind: 'text' | 'file' } | null>(null);
  const [knowledgeFiles, setKnowledgeFiles] = useState<File[]>([]);
  const [knowledgeScopeChoice, setKnowledgeScopeChoice] = useState<KnowledgeScope>('personal');
  const [marketFilter, setMarketFilter] = useState('全部模型');
  const [models, setModels] = useState(initialModels);
  const [selectedModels, setSelectedModels] = useState(['DeepSeek-R1']);
  const [keys, setKeys] = useState([{ name: '订阅分组', value: 'sk-0000...f7E2', created: '2026-09-28 21:58', active: true }]);
  const [notice, setNotice] = useState('');
  const [details, setDetails] = useState<string | null>(null);
  const [agents, setAgents] = useState(initialAgents);
  const [agentFilter, setAgentFilter] = useState('全部');
  const [agentDraft, setAgentDraft] = useState<Agent | null>(null);
  const [authNewName, setAuthNewName] = useState('');
  const [authNewEmail, setAuthNewEmail] = useState('');
  const [authNewEmailCode, setAuthNewEmailCode] = useState('');
  const [authNewPassword, setAuthNewPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const [previewArtifact, setPreviewArtifact] = useState<{ name: string; content: string } | null>(null);
  const currentProject = projects.find(p => p.id === activeProject) ?? projects[0];
  const currentChat = chats.find(c => c.id === activeChat) ?? chats[0];
  const filteredDocs = useMemo(() => docs.filter(d => (knowledgeScope === '全部知识' || d.group === knowledgeScope) && d.name.toLowerCase().includes(query.toLowerCase())), [docs, knowledgeScope, query]);
  const activeSources = useMemo(() => activeKnowledgeBase ? knowledgeSources.filter(s => s.knowledgeBaseId === activeKnowledgeBase.id && s.name.toLowerCase().includes(query.toLowerCase())) : [], [activeKnowledgeBase, knowledgeSources, query]);
  const activeChunks = useMemo(() => activeKnowledgeBase ? knowledgeChunks.filter(chunk => activeSources.some(source => source.id === chunk.sourceId)) : [], [activeKnowledgeBase, knowledgeChunks, activeSources]);
  const notify = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 3500); };
  const apiError = (result: { message?: string; error?: { message?: string } }) => result.message ?? result.error?.message ?? '请求失败';
  const navigate = (next: Section) => { setSection(next); setQuery(''); };
  const openKnowledgeBase = (base: KnowledgeBase) => { setActiveKnowledgeBase(base); setKnowledgeView('detail'); setKnowledgeTab('sources'); setQuery(''); };
  const addKnowledgeFiles = (files: File[]) => {
    if (!activeKnowledgeBase || !files.length) return;
    const accepted = files.filter(file => /\.(xlsx?|pptx?|docx?|pdf|mp4|mp3|wav|png|jpe?g|txt|md|html?)$/i.test(file.name));
    if (!accepted.length) { notify('没有可处理的文件格式'); return; }
    const now = new Date().toISOString().slice(0, 10);
    const next = accepted.map((file, index) => ({ id: `src-local-${Date.now()}-${index}`, knowledgeBaseId: activeKnowledgeBase.id, name: file.name, mimeType: file.type || 'application/octet-stream', size: `${Math.max(1, Math.round(file.size / 1024))} KB`, status: 'uploaded' as const, updatedAt: now, file }));
    setKnowledgeSources(items => [...items, ...next]);
    setKnowledgeBases(items => items.map(base => base.id === activeKnowledgeBase.id ? { ...base, fileCount: base.fileCount + next.length, status: 'processing', updatedAt: now } : base));
    setKnowledgeFiles([]); setModal(null); notify(`已上传 ${next.length} 个文件，点击“开始知识处理”进入知识化流程`);
  };
  const startKnowledgeProcessing = () => {
    if (!activeKnowledgeBase) return;
    setKnowledgeSources(items => items.map(source => source.knowledgeBaseId === activeKnowledgeBase.id && source.status === 'uploaded' ? { ...source, status: 'processing' } : source));
    setKnowledgeBases(items => items.map(base => base.id === activeKnowledgeBase.id ? { ...base, status: 'processing' } : base));
    notify('知识处理已启动，处理中内容不会参与检索');
    window.setTimeout(() => {
      setKnowledgeSources(items => items.map(source => source.knowledgeBaseId === activeKnowledgeBase.id && source.status === 'processing' ? { ...source, status: 'ready' } : source));
      setKnowledgeBases(items => items.map(base => base.id === activeKnowledgeBase.id ? { ...base, status: 'ready', updatedAt: new Date().toISOString().slice(0, 10) } : base));
      notify('知识处理完成，内容已可检索');
    }, 1800);
  };
  useEffect(() => {
    const expire = () => { klaApi.clearAccessToken(); setSignedIn(false); setAuthChecking(false); notify('登录状态已失效，请重新登录'); };
    window.addEventListener(authExpiredEventName, expire);
    if (sessionStorage.getItem('kla.access-token')) {
      klaApi.request('/v1/me').then(result => { setSignedIn(result.ok); setAuthChecking(false); if (!result.ok) expire(); });
    }
    return () => window.removeEventListener(authExpiredEventName, expire);
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    void (async () => {
      const result = await klaApi.request<{ projects: Array<{ id: string; name: string }>; conversations: Array<{ id: string; name: string; projectId: string; projectName?: string }> }>('/v1/bootstrap');
      if (!result.ok) return;
      const nextProjects = result.data.projects.map((p, index) => ({ id: p.id, name: p.name, description: '当前身份下的项目工作区', progress: 0, members: 1, color: ['#2779e9', '#0d9488', '#8b5cf6'][index % 3] }));
      const nextChats = result.data.conversations.map((c) => ({ id: c.id, name: c.name, project: c.projectName ?? nextProjects.find((p) => p.id === c.projectId)?.name ?? '项目', projectId: c.projectId, messages: [] }));
      if (nextProjects.length) { setProjects(nextProjects); setActiveProject(nextProjects[0].id); }
      if (nextChats.length) { setChats(nextChats); setActiveChat(nextChats[0].id); }
      const agentResult = await klaApi.request<Array<{ id: string; name: string; role: string; type: string; modelId: string | null; enabled: boolean }>>('/v1/agents');
      if (agentResult.ok && agentResult.data.length) setAgents(agentResult.data.map((a, index) => ({ name: a.name, role: a.role, type: a.type === 'official' ? '官方智能体' : a.type === 'external' ? '外接第三方' : '自定义智能体', model: a.modelId ?? '默认模型槽位', skills: [], enabled: a.enabled, color: ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b'][index % 4] })));
      const modelResult = await klaApi.request<Array<{ id: string; name: string; provider: string; base_url?: string; capabilities?: { thinking?: boolean; vision?: boolean; context?: number }; configured?: boolean }>>('/v1/models');
      if (modelResult.ok && modelResult.data.length) setModels(modelResult.data.map((m, index) => ({ id: m.id, name: m.name, vendor: `${m.provider} / ${m.id}`, category: m.capabilities?.vision ? '视觉多模态' : m.capabilities?.thinking ? '深度思考' : '通用模型', context: m.capabilities?.context ? `${Math.round(m.capabilities.context / 1000)}K` : '128K', latency: '服务端探测', cost: m.configured ? '已配置' : '待配置密钥', icon: ['◈', '文', '✣', '◉'][index % 4] })));
    })();
  }, [signedIn, activeIdentityId]);
  useEffect(() => {
    if (!signedIn || !activeChat || activeChat.startsWith('demo-')) return;
    setChatLoading(true);
    void klaApi.request<Array<{ id: string; senderType: string; senderName?: string; text: string; createdAt: string; metadata?: { artifactId?: string } }>>(`/v1/conversations/${activeChat}/messages`).then((result) => {
      if (result.ok) setChats((items) => items.map((chat) => chat.id === activeChat ? { ...chat, messages: result.data.map((m) => ({ id: m.id, author: m.senderType === 'agent' ? (m.senderName ?? '智能体') : '我', text: m.text, time: new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), senderType: m.senderType, artifactId: m.metadata?.artifactId })) } : chat));
      setChatLoading(false);
    });
  }, [signedIn, activeChat]);
  const login = async () => {
    const result = await klaApi.request<{ session: { accessToken: string; refreshToken: string; expiresAt: string; deviceId?: string | null }; identities?: typeof identities }>('/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ identifier: username.trim(), password }),
    });
    if (!result.ok) { notify(apiError(result)); return; }
    klaApi.setSession(result.data.session);
    setSignedIn(true);
    setAuthChecking(false);
    setIdentities(result.data.identities ?? []);
    const loginIdentity = result.data.identities?.find((item) => item.isDefault) ?? result.data.identities?.[0];
    if (loginIdentity) { klaApi.setIdentity(loginIdentity.id); setActiveIdentityId(loginIdentity.id); }
    setModal('identity');
  };
  const register = async () => {
    const passwordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
    if (!authNewName.trim()) { notify('请输入用户名'); return; }
    if (!authNewEmail.trim()) { notify('请输入邮箱'); return; }
    if (authNewEmailCode.trim() !== '123456') { notify('邮箱验证码错误，演示环境请输入 123456'); return; }
    if (!passwordPattern.test(authNewPassword)) { notify('密码至少 8 位，且必须包含数字、大写字母和小写字母'); return; }
    const result = await klaApi.request<{ session: { accessToken: string; refreshToken: string; expiresAt: string; deviceId?: string | null }; identities?: typeof identities }>('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: authNewEmail.trim(), password: authNewPassword, nickname: authNewName.trim() }) });
    if (!result.ok) { notify(apiError(result)); return; }
    setAuthNewEmailCode('');
    klaApi.setSession(result.data.session); setIdentities(result.data.identities ?? []); const registerIdentity = result.data.identities?.find((item) => item.isDefault) ?? result.data.identities?.[0]; if (registerIdentity) { klaApi.setIdentity(registerIdentity.id); setActiveIdentityId(registerIdentity.id); } setSignedIn(true); setAuthChecking(false); setModal('identity');
  };
  const activateIdentity = async (identityId: string) => {
    // Send the target identity explicitly, then persist it before any identity-scoped request.
    const result = await klaApi.request<{ id: string; displayName: string; type: string; organizationId: string | null; isDefault?: boolean }>('/v1/me/identities/' + identityId + '/activate', { method: 'POST', body: '{}', headers: { 'x-identity-id': identityId } });
    if (!result.ok) { notify(apiError(result)); return; }
    klaApi.setIdentity(result.data.id);
    setActiveIdentityId(result.data.id);
    setIdentities(items => items.map(item => ({ ...item, isDefault: item.id === result.data.id })));
    setModal(null);
    notify(`已进入${result.data.displayName}身份`);
  };
  const createEnterprise = async () => { const result = await klaApi.request<{ id: string; displayName: string; type: string; organizationId: string | null; inviteCode?: string | null }>('/v1/organizations', { method: 'POST', body: JSON.stringify({ name: companyName.trim(), licenseNumber: licenseNumber.trim() }) }); if (!result.ok) { notify(apiError(result)); return; } setIdentities(items => [...items, result.data]); setCompanyName(''); setLicenseNumber(''); await activateIdentity(result.data.id); notify(result.data.inviteCode ? `企业创建成功，邀请码：${result.data.inviteCode}` : '企业创建成功，已进入企业身份'); };
  const joinEnterprise = async () => { const result = await klaApi.request<{ id: string; displayName: string; type: string; organizationId: string | null }>('/v1/organizations/join', { method: 'POST', body: JSON.stringify({ inviteCode: inviteCode.trim() }) }); if (!result.ok) { notify(apiError(result)); return; } setIdentities(items => [...items, result.data]); setInviteCode(''); await activateIdentity(result.data.id); notify('已加入企业，已进入企业身份'); };
  const send = () => {
    if (!draft.trim()) return;
    const text = draft.trim();
    const message = { author: '我', text, time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) };
    setChats(items => items.map(c => c.id === activeChat ? { ...c, messages: [...c.messages, message] } : c));
    setDraft('');
    if (!signedIn || activeChat.startsWith('demo-')) return;
    setChatSending(true);
    void klaApi.request<{ message: { id: string }; run: { id: string } }>(`/v1/conversations/${activeChat}/messages`, { method: 'POST', body: JSON.stringify({ text, mode: 'balanced' }) }).then(() => {
      const poll = window.setInterval(() => {
        void klaApi.request<Array<{ senderType: string; senderName?: string; text: string; createdAt: string; metadata?: { artifactId?: string } }>>(`/v1/conversations/${activeChat}/messages`).then((result) => {
          if (!result.ok) return;
          const mapped = result.data.map((m) => ({ author: m.senderType === 'agent' ? (m.senderName ?? '智能体') : '我', text: m.text, time: new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), senderType: m.senderType, artifactId: m.metadata?.artifactId }));
          setChats((items) => items.map(c => c.id === activeChat ? { ...c, messages: mapped } : c));
          if (mapped.some(m => m.senderType === 'agent')) { window.clearInterval(poll); setChatSending(false); }
        });
      }, 700);
      window.setTimeout(() => { window.clearInterval(poll); setChatSending(false); }, 30_000);
    });
  };
  const create = () => {
    if (!newName.trim()) return;
    if (modal === 'project') { const id = `local-${Date.now()}`; if (signedIn) { void klaApi.request<{ id: string; name: string }>('/v1/projects', { method: 'POST', body: JSON.stringify({ name: newName.trim() }) }).then((result) => { if (result.ok) { setProjects(items => [...items, { id: result.data.id, name: result.data.name, description: newDescription.trim() || '暂无项目说明', progress: 0, members: 1, color: '#2779e9' }]); setActiveProject(result.data.id); } }); } else { setProjects(items => [...items, { id, name: newName.trim(), description: newDescription.trim() || '暂无项目说明', progress: 0, members: 1, color: '#2779e9' }]); setActiveProject(id); } navigate('projects'); }
    if (modal === 'chat') { const selectedProject = projects.find((p) => p.name === (newProject || projects[0]?.name)) ?? projects[0]; if (signedIn && selectedProject && !selectedProject.id.startsWith('demo-')) void klaApi.request<{ id: string }>('/v1/conversations', { method: 'POST', body: JSON.stringify({ projectId: selectedProject.id, name: newName.trim() }) }).then((result) => { if (result.ok) { setChats(items => [...items, { id: result.data.id, name: newName.trim(), project: selectedProject.name, projectId: selectedProject.id, messages: [] }]); setActiveChat(result.data.id); } }); else { const id = `local-${Date.now()}`; setChats(items => [...items, { id, name: newName.trim(), project: selectedProject?.name ?? '项目', projectId: selectedProject?.id, messages: [] }]); setActiveChat(id); } navigate('chats'); }
    if (modal === 'key') setKeys(items => [...items, { name: newName.trim(), value: `sk-demo...${Math.random().toString(36).slice(2, 6)}`, created: new Date().toLocaleString('zh-CN'), active: true }]);
    if (modal === 'agent') {
      if (agents.some(a => a.name === newName.trim())) { notify('智能体名称已存在'); return; }
      setAgents(items => [...items, { name: newName.trim(), role: newDescription.trim() || '自定义智能体', type: '自定义智能体', model: newModel, skills: [], enabled: true, color: '#2563eb' }]);
    }
    if (modal === 'knowledge-create') {
      const id = `kb-local-${Date.now()}`;
      const color = knowledgeScopeChoice === 'enterprise' ? '#2779e9' : knowledgeScopeChoice === 'project' ? '#0d9488' : '#f59e0b';
      const base: KnowledgeBase = { id, name: newName.trim(), description: newDescription.trim() || '新的知识资产空间', scopeType: knowledgeScopeChoice, projectId: knowledgeScopeChoice === 'project' ? activeProject : undefined, fileCount: 0, chunkCount: 0, status: 'ready', updatedAt: new Date().toISOString().slice(0, 10), color, canManage: true };
      setKnowledgeBases(items => [...items, base]);
      setNewName(''); setNewDescription(''); setModal(null); notify('知识库已创建');
      return;
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
      <img src={logo} alt="鲲擎标识" /><h1>欢迎登录鲲擎平台</h1><p>企业级多智能体协同进化工作台 · 企业旗舰版</p>
      <label>账号 / 邮箱<input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required placeholder="请输入账号或邮箱" /></label>
      <label>登录密码<span className="ws-password"><input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required placeholder="请输入密码" /><IconButton title={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</IconButton></span></label>
      <div className="ws-login-options"><label><input type="checkbox" defaultChecked /> 记住登录状态</label><button type="button" onClick={() => notify('密码找回将在认证服务接入后开放')}>忘记密码？</button></div>
      <button className="ws-primary wide" type="submit">立即登录并连接 Agent 网络 <ArrowRight size={15} /></button>
      <div className="ws-login-register-row"><span>还没有账号？</span><button type="button" className="ws-login-register" onClick={() => { setAuthNewName(''); setAuthNewEmail(''); setAuthNewEmailCode(''); setAuthNewPassword(''); setModal('register'); }}>注册鲲擎账号</button></div>
    </form><footer>● 集群所有核心服务已连接正常 · 延迟 12ms <span>© 2026 鲲擎智能 · 保障企业数据与合规隐私安全</span></footer>{notice && <div className="ws-toast">{notice}</div>}
  </div>;

  return <div className="ws-app">
    <aside className="ws-sidebar"><div><div className="ws-brand"><img src={logo} alt="鲲擎" /><span>鲲擎平台<small>AI INTELLIGENCE</small></span></div><nav>{nav.map(({ id, label, Icon }) => <button key={id} className={section === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={19} />{label}</button>)}</nav></div><div className="ws-sidebar-bottom"><button onClick={() => { navigate('compute'); setComputeView('dashboard'); }}><Sparkles size={15} /> 积分余额 <b>1,008.71 ›</b></button><button onClick={() => { setModal('chat'); setNewName(''); }}><Plus size={16} />新建群聊 / New Chat</button><button onClick={() => navigate('settings')}><Settings size={17} /> 设置</button><button onClick={() => { void klaApi.request('/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: klaApi.getRefreshToken() }) }); klaApi.clearAccessToken(); setSignedIn(false); }}><UserCircle size={17} /> 个人中心 · 退出</button></div></aside>
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
        {section === 'chats' && <div className="ws-chat"><header><div><span className="ws-avatar">{currentChat.name.slice(0, 2)}</span><span><strong>{currentChat.name}</strong><small>● {currentChat.project} · 2 个智能体协作中</small></span></div><div><IconButton title="邀请成员" onClick={() => notify('邀请成员将在成员接口接入后开放')}><Users size={17} /></IconButton><IconButton title="群组文件" onClick={() => notify('群组文件将在服务端存储接入后开放')}><Folder size={17} /></IconButton><IconButton title="更多" onClick={() => notify('群组设置即将开放')}><MoreHorizontal size={17} /></IconButton></div></header><div className="ws-chat-messages"><p className="ws-chat-date">{chatLoading ? '正在加载消息…' : '消息记录'}</p>{currentChat.messages.map((m, i) => <div className={`ws-message ${m.author === '我' ? 'self' : ''}`} key={m.id ?? `${m.time}-${i}`}><span className="ws-avatar">{m.author.slice(0, 2)}</span><div><small>{m.author} · {m.time}</small><p>{m.text}</p>{m.artifactId && <button className="ws-text-button" onClick={() => void klaApi.request<{ name: string; content: string }>(`/v1/artifacts/${m.artifactId}`).then((result) => { if (result.ok) setPreviewArtifact(result.data); })}><FileText size={14} /> 打开成果文件</button>}</div></div>)}{chatSending && <div className="ws-message"><span className="ws-avatar">统筹</span><div><small>统筹智能体 · 正在处理</small><p className="ws-thinking"><span /> <span /> <span /></p></div></div>}</div><div className="ws-chat-compose"><textarea placeholder="发送消息给群组 (支持 @ 智能体)..." value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} /><div><span><Paperclip size={16} /> 附件 <Bot size={16} /> 智能体</span><button className="ws-primary" disabled={chatSending} onClick={send}><Send size={15} />{chatSending ? '处理中…' : '发送给群组'}</button></div></div></div>}
        {section === 'knowledge' && <>
          <div className="ws-page-heading"><div><h1>{knowledgeView === 'catalog' ? '知识库' : activeKnowledgeBase?.name}</h1><p>{knowledgeView === 'catalog' ? '按企业、项目和个人身份隔离管理知识资产' : activeKnowledgeBase?.description}</p></div><div className="ws-inline">{knowledgeView === 'detail' && <button onClick={() => { setKnowledgeView('catalog'); setActiveKnowledgeBase(null); }}><ArrowRight size={15} style={{ transform: 'rotate(180deg)' }} /> 返回知识库</button>}<button className="ws-primary" onClick={() => setModal(knowledgeView === 'catalog' ? 'knowledge-create' as Modal : 'knowledge')}><Plus size={16} /> {knowledgeView === 'catalog' ? '新建知识库' : '上传文件'}</button></div></div>
          {knowledgeView === 'catalog' ? <>
            <div className="ws-stats three"><Stat icon={<BookOpen />} label="可访问知识库" value={`${knowledgeBases.length}`} hint="按当前身份权限过滤" /><Stat icon={<CheckCircle2 />} label="可检索文件" value={`${knowledgeSources.filter(s => s.status === 'ready').length}`} hint="已完成知识化" color="green" /><Stat icon={<Clock3 />} label="处理中" value={`${knowledgeSources.filter(s => s.status === 'processing').length}`} hint="暂不参与检索" color="orange" /></div>
            <div className="ws-kb-grid">{(['enterprise', 'project', 'personal'] as KnowledgeScope[]).map(scope => <section className={`ws-kb-section ${scope}`} key={scope}><header><div><span className="ws-kb-eyebrow">{scope === 'enterprise' ? '企业空间' : scope === 'project' ? '项目空间' : '个人空间'}</span><h2>{scope === 'enterprise' ? '企业知识库' : scope === 'project' ? '项目知识库' : '个人知识库'}</h2></div><Badge tone={scope === 'enterprise' ? 'blue' : scope === 'project' ? 'green' : 'orange'}>{knowledgeBases.filter(base => base.scopeType === scope).length} 个</Badge></header><div className="ws-kb-cards">{knowledgeBases.filter(base => base.scopeType === scope).map(base => <button className="ws-kb-card" key={base.id} onClick={() => openKnowledgeBase(base)}><span className="ws-kb-card-icon" style={{ background: base.color }}><BookOpen size={19} /></span><span><strong>{base.name}</strong><small>{base.description}</small><em>{base.fileCount} 份文件 · {base.chunkCount} 个切片</em></span><span className="ws-kb-card-arrow"><ArrowRight size={16} /></span>{base.status !== 'ready' && <Badge tone="orange">知识录入中</Badge>}</button>)}</div></section>)}</div>
          </> : <>
            <div className="ws-kb-detail-toolbar"><div className="ws-segment"><button className={knowledgeTab === 'sources' ? 'active' : ''} onClick={() => setKnowledgeTab('sources')}>原始文件 ({activeSources.length})</button><button className={knowledgeTab === 'chunks' ? 'active' : ''} onClick={() => setKnowledgeTab('chunks')}>知识切片 ({activeChunks.length})</button></div><div className="ws-inline"><div className="ws-sub-search"><Search size={14} /><input placeholder="搜索当前知识库" value={query} onChange={e => setQuery(e.target.value)} /></div>{activeKnowledgeBase?.status === 'processing' && <Badge tone="orange">知识录入中</Badge>}<button className="ws-primary" onClick={startKnowledgeProcessing}><Sparkles size={15} /> 开始知识处理</button></div></div>
            <div className="ws-knowledge-layout"><div><Panel title={knowledgeTab === 'sources' ? '原始文件' : '知识切片'}>{knowledgeTab === 'sources' ? <table className="ws-table"><thead><tr><th>文件名称</th><th>类型</th><th>大小</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{activeSources.map(source => <tr key={source.id}><td><FileText size={15} /> {source.name}</td><td>{source.mimeType.split('/').pop()}</td><td>{source.size}</td><td><Badge tone={source.status === 'ready' ? 'green' : source.status === 'processing' ? 'orange' : 'muted'}>{source.status === 'ready' ? '已完成' : source.status === 'processing' ? '处理中' : '待处理'}</Badge></td><td>{source.updatedAt}</td><td><button className="ws-text-button" onClick={() => { if (source.file) setKnowledgePreview({ title: source.name, url: URL.createObjectURL(source.file), kind: 'file' }); else setKnowledgePreview({ title: source.name, content: '原始文件预览将在服务端文件预览接口接入后展示。', kind: 'text' }); }}>预览</button></td></tr>)}</tbody></table> : <table className="ws-table"><thead><tr><th>切片标题</th><th>来源文件</th><th>页码/章节</th><th>定位</th><th>内容摘要</th><th>操作</th></tr></thead><tbody>{activeChunks.map(chunk => <tr key={chunk.id}><td>{chunk.title}</td><td>{knowledgeSources.find(s => s.id === chunk.sourceId)?.name ?? '-'}</td><td>{chunk.page ? `第 ${chunk.page} 页` : '-'} {chunk.section ?? ''}</td><td><code>{chunk.startOffset}-{chunk.endOffset}</code></td><td>{chunk.content.slice(0, 42)}...</td><td><button className="ws-text-button" onClick={() => setKnowledgePreview({ title: chunk.title, content: chunk.content, kind: 'text' })}>查看</button></td></tr>)}</tbody></table>}{(knowledgeTab === 'sources' ? activeSources.length : activeChunks.length) === 0 && <div className="ws-empty">当前没有可展示内容</div>}</Panel></div><aside className="ws-rag"><div><Sparkles size={23} /><h2>智能知识引擎</h2><p>当前知识库内容按身份权限隔离，处理中内容不会参与检索。</p></div><div><h3>检索状态</h3><p>仅 status=ready 的知识库、文件和切片进入检索索引。</p><span>● 服务状态正常</span></div><button onClick={() => notify('检索接口将在后端知识服务接入后调用')}>开始知识检索 <ArrowRight size={15} /></button></aside></div>
          </>}
        </>}
        {section === 'compute' && <><div className="ws-compute-heading"><span>算力平台 / <b>{computeNav.find(n => n.id === computeView)?.label}</b></span><div>时间范围: <select aria-label="时间范围"><option>近 7 天</option><option>近 24 小时</option><option>近 30 天</option></select></div></div>
          {computeView === 'dashboard' && <><div className="ws-stats four"><Stat icon={<Wallet />} label="余额" value="$1,000.00" hint="可用: $1,000.00" color="green" /><Stat icon={<KeyRound />} label="API 密钥" value={`${keys.length}`} hint="● 已启用" /><Stat icon={<Send />} label="今日请求" value="3" hint="总计: 3" color="teal" /><Stat icon={<CreditCard />} label="今日消费" value="$0.0049" hint="总计: $0.0049" /></div><div className="ws-stats four"><Stat icon={<Database />} label="今日 Token" value="43.8K" hint="输入: 29.1K / 输出: 14.4K" color="orange" /><Stat icon={<Activity />} label="累计 Token" value="43.8K" hint="近 7 天累计" color="teal" /><Stat icon={<Cloud />} label="性能指标" value="0 RPM" hint="0 TPM" /><Stat icon={<Clock3 />} label="平均响应" value="3.74s" hint="网络稳定" color="purple" /></div><Panel title="按平台拆分" action={<small className="ws-muted">已连接 1 个活跃分组</small>}><div className="ws-provider"><span className="ws-provider-icon">AI</span><strong>OpenAI</strong><small>请求 3 次 · Token 43.8K</small><b>$0.0049</b></div></Panel><div className="ws-project-grid"><Panel title="模型分布"><div className="ws-donut-row"><div className="ws-donut">100%<small>glm-5.3</small></div><div>zhipu/glm-5.3-flash<br /><small>3 次请求 · 43.8K Token</small></div></div></Panel><Panel title="Token 使用趋势"><Chart /><div className="ws-chart-labels">{['09/25', '09/26', '09/27', '09/28', '09/29', '今日'].join('　')}</div></Panel></div></>}
          {computeView === 'keys' && <Panel title="API 密钥" action={<button className="ws-primary" onClick={() => { setNewName(''); setModal('key'); }}><Plus size={15} /> 创建密钥</button>}><div className="ws-filters"><div className="ws-sub-search"><Search size={15} /><input placeholder="搜索名称或 Key..." value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="分组筛选"><option>全部分组</option></select><select aria-label="状态筛选"><option>全部状态</option><option>活跃</option></select></div><table className="ws-table"><thead><tr><th>名称</th><th>API 密钥</th><th>分组</th><th>当前并发</th><th>用量</th><th>过期时间</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{keys.filter(k => k.name.includes(query)).map(k => <tr key={k.value}><td>● {k.name}</td><td><code>{k.value}</code> <IconButton title="复制密钥" onClick={() => { void navigator.clipboard?.writeText(k.value); notify('已复制预览密钥'); }}><Copy size={13} /></IconButton></td><td><Badge tone="green">● 算力订阅分组</Badge></td><td>0</td><td>今日: $0.0049</td><td>永久有效</td><td><Badge tone={k.active ? 'green' : 'muted'}>{k.active ? '活跃' : '已停用'}</Badge></td><td>{k.created}</td><td><button className="ws-text-button" onClick={() => setKeys(items => items.map(x => x.value === k.value ? { ...x, active: !x.active } : x))}>{k.active ? '停用' : '启用'}</button></td></tr>)}</tbody></table><p className="ws-table-footer">共 {keys.length} 条记录 · 预览数据</p></Panel>}
          {computeView === 'usage' && <><div className="ws-stats four"><Stat icon={<FileText />} label="总请求数" value="3" hint="最近时间内" /><Stat icon={<Database />} label="总 Token" value="43.77K" hint="输入: 29.13K / 输出: 14.4K" color="orange" /><Stat icon={<Wallet />} label="总消费" value="$0.0049" hint="预览统计" color="green" /><Stat icon={<Clock3 />} label="平均耗时" value="3.74s" color="purple" /></div><div className="ws-project-grid"><Panel title="模型分布"><div className="ws-donut-row"><div className="ws-donut" /><div>zhipu/glm-5.3-flash<br /><small>3 次请求 · 43.77K Token</small></div></div></Panel><Panel title="Token 使用趋势"><Chart /></Panel></div><Panel title="使用记录" action={<button className="ws-primary teal" onClick={downloadCsv}><Download size={14} /> 导出 CSV</button>}><div className="ws-filters"><select aria-label="模型"><option>全部模型</option></select><select aria-label="密钥"><option>全部密钥</option></select><select aria-label="类型"><option>全部类型</option></select><button onClick={() => notify('已刷新预览数据')}>刷新</button></div><table className="ws-table"><thead><tr><th>请求时间</th><th>模型</th><th>API 密钥</th><th>Token 消耗</th><th>实际消费</th><th>状态</th></tr></thead><tbody>{usage.map(r => <tr key={r.time}><td>{r.time}</td><td>{r.model}</td><td>{r.key}</td><td>{r.tokens}</td><td>{r.cost}</td><td><Badge tone="green">{r.state}</Badge></td></tr>)}</tbody></table></Panel></>}
          {(computeView === 'market' || computeView === 'mine') && <><div className="ws-market-controls"><div className="ws-sub-search"><Search size={16} /><input placeholder="搜索大语言模型、深度推理、视觉多模态..." value={query} onChange={e => setQuery(e.target.value)} /></div><div className="ws-segment compact"><button className={computeView === 'market' ? 'active' : ''} onClick={() => setComputeView('market')}>模型广场</button><button className={computeView === 'mine' ? 'active' : ''} onClick={() => setComputeView('mine')}>我的模型 ({selectedModels.length})</button></div></div><div className="ws-chip-row market">{['全部模型', '深度思考', '编程写作', '海量上下文', '企业级'].map(t => <button key={t} className={marketFilter === t ? 'active' : ''} onClick={() => setMarketFilter(t)}>{t}</button>)}</div><div className="ws-model-grid">{models.filter(m => (computeView === 'market' || selectedModels.includes(m.name)) && (marketFilter === '全部模型' || m.category === marketFilter) && `${m.name}${m.vendor}`.toLowerCase().includes(query.toLowerCase())).map(m => <article className="ws-model" key={m.name}><div className="ws-model-head"><span className="ws-model-icon">{m.icon}</span><div><h3>{m.name}</h3><small>{m.vendor}</small></div><Badge tone="green">{m.category}</Badge></div><p>面向复杂任务与专业场景，提供可靠的内容理解、生成与智能协作能力。</p><div className="ws-model-spec"><span>上下文窗口<b>{m.context}</b></span><span>首字延迟<b>{m.latency}</b></span><span>输入计费<b>{m.cost}</b></span></div><div className="ws-model-actions"><button onClick={() => notify(`${m.name} 测速将在算力 API 接入后开放`)}>测速</button><button onClick={() => setDetails(m.name)}>参数详情</button><button className="ws-primary" onClick={() => { setSelectedModels(items => items.includes(m.name) ? items.filter(x => x !== m.name) : [...items, m.name]); notify(selectedModels.includes(m.name) ? '已从我的模型移除' : '已选用模型'); }}>{selectedModels.includes(m.name) ? <><Check size={14} /> 已选用</> : <><Plus size={14} /> 选用此模型</>}</button></div></article>)}</div>{computeView === 'mine' && selectedModels.length === 0 && <div className="ws-empty">暂无选用模型，前往模型广场添加</div>}</>}
        </>}
      </div>
    </main>
    {modal && !['register','identity','create-enterprise','join-enterprise'].includes(modal) && <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModal(null); }}><div className="ws-modal"><header><h2>{modal === 'project' ? '创建项目' : modal === 'chat' ? '创建群聊' : modal === 'key' ? '创建 API 密钥' : modal === 'agent' ? '新建自定义智能体' : modal === 'knowledge-create' ? '新建知识库' : '上传知识文件'}</h2><IconButton title="关闭" onClick={() => setModal(null)}><X size={19} /></IconButton></header>{modal === 'knowledge' ? <div className="ws-upload"><Upload size={28} /><p>拖拽文件到此处，或点击选择本地文件</p><small>支持 xlsx、ppt/pptx、word、pdf、mp4、mp3、png、jpg</small><input type="file" multiple accept=".xlsx,.xls,.ppt,.pptx,.doc,.docx,.pdf,.mp4,.mp3,.wav,.png,.jpg,.jpeg,.txt,.md,.html" onChange={e => addKnowledgeFiles(Array.from(e.target.files ?? []))} /></div> : modal === 'knowledge-create' ? <form onSubmit={e => { e.preventDefault(); create(); }}><label>知识库名称<input autoFocus required value={newName} onChange={e => setNewName(e.target.value)} placeholder="请输入知识库名称" /></label><label>说明（选填）<textarea value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="说明知识库的用途和内容范围" /></label><label>知识库层级<select value={knowledgeScopeChoice} onChange={e => setKnowledgeScopeChoice(e.target.value as KnowledgeScope)}><option value="personal">个人知识库</option><option value="project">项目知识库</option><option value="enterprise">企业知识库</option></select></label><p className="ws-detail-copy">企业知识库需企业管理员权限，项目知识库默认归当前项目创建者管理。</p><footer><button type="button" onClick={() => setModal(null)}>取消</button><button className="ws-primary" type="submit">创建知识库</button></footer></form> : <form onSubmit={e => { e.preventDefault(); create(); }}><label>{modal === 'project' ? '项目名称' : modal === 'chat' ? '群聊名称' : modal === 'agent' ? '智能体名称' : '密钥名称'}<input autoFocus required value={newName} onChange={e => setNewName(e.target.value)} placeholder="请输入名称" /></label>{(modal === 'project' || modal === 'agent') && <label>{modal === 'project' ? '项目说明' : '职责说明'}<textarea value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="简要描述职责与目标" /></label>}{modal === 'agent' && <label>挂载模型<select value={newModel} onChange={e => setNewModel(e.target.value)}>{models.map(m => <option key={m.name}>{m.name}</option>)}</select></label>}{modal === 'chat' && <label>关联项目<select value={newProject || projects[0].name} onChange={e => setNewProject(e.target.value)}>{projects.map(p => <option key={p.id}>{p.name}</option>)}</select></label>}<footer><button type="button" onClick={() => setModal(null)}>取消</button><button className="ws-primary" type="submit">创建</button></footer></form>}</div></div>}
    {agentDraft && <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setAgentDraft(null); }}><div className="ws-modal"><header><h2>配置 · {agentDraft.name}</h2><IconButton title="关闭" onClick={() => setAgentDraft(null)}><X size={19} /></IconButton></header><form onSubmit={e => { e.preventDefault(); setAgents(items => items.map(a => a.name === agentDraft.name ? agentDraft : a)); setAgentDraft(null); notify('智能体配置已更新（前端预览）'); }}><label>身份与职责<textarea value={agentDraft.role} onChange={e => setAgentDraft({ ...agentDraft, role: e.target.value })} /></label><label>挂载模型<select value={agentDraft.model} onChange={e => setAgentDraft({ ...agentDraft, model: e.target.value })}><option>默认模型槽位</option><option>外部连接器</option>{selectedModels.map(m => <option key={m}>{m}</option>)}</select></label><p className="ws-detail-copy">技能和权限由服务端管理；本页仅保存前端预览状态。</p><footer><button type="button" onClick={() => setAgentDraft(null)}>取消</button><button className="ws-primary">保存</button></footer></form></div></div>}
    {details && <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setDetails(null); }}><div className="ws-modal"><header><h2>{details}</h2><IconButton title="关闭" onClick={() => setDetails(null)}><X size={19} /></IconButton></header><p className="ws-detail-copy">当前为前端预览数据。文件正文或模型参数详情将在对应服务端接口接入后展示。</p><footer><button className="ws-primary" onClick={() => setDetails(null)}>关闭</button></footer></div></div>}
    {knowledgePreview && <div className="ws-modal-backdrop" style={{ justifyContent: 'flex-end', padding: 0, background: '#15375724' }} onMouseDown={e => { if (e.target === e.currentTarget) { if (knowledgePreview.url) URL.revokeObjectURL(knowledgePreview.url); setKnowledgePreview(null); } }}><div className="ws-modal ws-knowledge-preview"><header><h2>{knowledgePreview.title}</h2><IconButton title="关闭预览" onClick={() => { if (knowledgePreview.url) URL.revokeObjectURL(knowledgePreview.url); setKnowledgePreview(null); }}><X size={19} /></IconButton></header>{knowledgePreview.url ? <iframe title={knowledgePreview.title} src={knowledgePreview.url} /> : <article>{knowledgePreview.content}</article>}</div></div>}
    {modal && ['register','identity','create-enterprise','join-enterprise'].includes(modal) && <div className="ws-modal-backdrop"><div className="ws-modal ws-auth-modal">
      <header><h2>{modal === 'register' ? '创建账号' : modal === 'identity' ? '选择登录身份' : modal === 'create-enterprise' ? '创建企业身份' : '加入企业'}</h2>{modal !== 'identity' && <IconButton title="关闭" onClick={() => setModal(null)}><X size={19} /></IconButton>}</header>
      {modal === 'register' && <div className="ws-register-flow"><div className="ws-register-intro"><span className="ws-register-kicker">ACCOUNT REGISTRATION</span><h3>注册鲲擎账号</h3><p>填写账号、密码并完成邮箱验证即可注册；登录后可切换要进入的企业身份。</p></div><form onSubmit={e => { e.preventDefault(); void register(); }}><label>账号<input required value={authNewName} onChange={e => setAuthNewName(e.target.value)} autoComplete="username" placeholder="设置登录账号，如 laok" /><small className="ws-auth-hint">账号与邮箱都可作为登录凭证</small></label><label>密码<input required type="password" minLength={8} value={authNewPassword} onChange={e => setAuthNewPassword(e.target.value)} autoComplete="new-password" placeholder="设置登录密码，至少 8 位" /><small className="ws-auth-hint">密码需至少 8 位，并包含数字、大写字母和小写字母</small></label><label>邮箱<input required type="email" value={authNewEmail} onChange={e => setAuthNewEmail(e.target.value)} autoComplete="email" placeholder="用于接收验证码与找回密码" /></label><label>验证码<div className="ws-auth-code-row"><input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={authNewEmailCode} onChange={e => setAuthNewEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="请输入 6 位验证码" /><button type="button" onClick={() => notify('演示环境验证码为 123456')}>获取验证码</button></div><small className="ws-auth-hint">验证码 5 分钟内有效，演示环境固定使用 123456</small></label><footer><button type="button" className="ws-auth-back" onClick={() => setModal(null)}>取消</button><button className="ws-primary">注册</button></footer></form></div>}
      {modal === 'identity' && <div className="ws-identity-flow"><div className="ws-register-intro"><span className="ws-register-kicker">IDENTITY WORKSPACE</span><h3>选择进入身份</h3><p>不同身份拥有独立的工作区、项目和数据权限，进入后可在右上角随时切换。</p></div><div className="ws-identity-list"><button className="ws-identity-card" onClick={() => { const personal = identities.find(item => item.type === 'personal'); if (personal) void activateIdentity(personal.id); else { setModal(null); notify('个人身份不可用'); } }}><span className="ws-identity-icon personal"><UserCircle size={18} /></span><span><strong>个人身份</strong><small>个人工作区 · 默认权限</small></span><ArrowRight size={15} /></button>{identities.filter(item => item.type === 'enterprise').map(item => <button className="ws-identity-card" key={item.id} onClick={() => void activateIdentity(item.id)}><span className="ws-identity-icon enterprise"><BriefcaseBusiness size={18} /></span><span><strong>{item.displayName}</strong><small>企业身份 · 独立权限</small></span><ArrowRight size={15} /></button>)}</div><div className="ws-identity-actions"><button onClick={() => setModal('create-enterprise')}><Plus size={15} /> 创建新的企业</button><button onClick={() => setModal('join-enterprise')}><Users size={15} /> 加入已有企业</button></div></div>}
      {modal === 'create-enterprise' && <form onSubmit={e => { e.preventDefault(); void createEnterprise(); }}><header className="ws-nested-auth-heading"><h3>创建企业账号</h3><p>为企业开一个新的知识空间。创建后你将成为该企业的超级管理员。</p></header><label>企业名称<input required value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="例如 卡伦特制造" /></label><label>营业执照编码<input required value={licenseNumber} onChange={e => setLicenseNumber(e.target.value)} placeholder="请输入营业执照编码" /></label><footer><button type="button" onClick={() => setModal('identity')}>取消</button><button className="ws-primary">创建并进入</button></footer></form>}
      {modal === 'join-enterprise' && <form onSubmit={e => { e.preventDefault(); void joinEnterprise(); }}><header className="ws-nested-auth-heading"><h3>加入已有企业</h3><p>输入企业超级管理员发给你的邀请码，校验通过后会新增一个企业身份并切换过去。</p></header><label>企业邀请码<input required value={inviteCode} onChange={e => setInviteCode(e.target.value.toUpperCase())} placeholder="例如 KQ-2026-8F3A" /><small className="ws-auth-hint">加入成功后将建立该企业的成员身份</small></label><footer><button type="button" onClick={() => setModal('identity')}>取消</button><button className="ws-primary">校验并加入</button></footer></form>}
    </div></div>}
    {notice && <div className="ws-toast">{notice}</div>}
    {previewArtifact && <div className="ws-modal-backdrop" style={{ justifyContent: 'flex-end', padding: 0, background: '#15375724' }} onMouseDown={e => { if (e.target === e.currentTarget) setPreviewArtifact(null); }}><div className="ws-modal" style={{ width: 'min(720px, 52vw)', minWidth: 420, height: '100%', borderRadius: 0, display: 'flex', flexDirection: 'column' }}><header><h2>{previewArtifact.name}</h2><IconButton title="关闭预览" onClick={() => setPreviewArtifact(null)}><X size={19} /></IconButton></header><iframe title={previewArtifact.name} srcDoc={previewArtifact.content} style={{ flex: 1, width: '100%', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }} /></div></div>}
  </div>;
}
