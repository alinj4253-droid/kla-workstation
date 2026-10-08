import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowRight, Bell, BookOpen, Bot, BriefcaseBusiness, CalendarDays, Check, CheckCircle2, ChevronDown, CircleHelp, Clock3, Cloud, Code2, Copy, CreditCard, Database, Download, Eye, EyeOff, FileText, Folder, FolderPlus, Home, KeyRound, LayoutDashboard, Menu, MessageSquare, MoreHorizontal, Paperclip, Plus, Search, Send, Settings, ShieldCheck, Sparkles, Upload, UserCircle, Users, Wallet, X, Brain as BrainIcon } from 'lucide-react';
import logo from '../assets/kla-sidebar-logo.png';
import type { IdentityDto } from '@kla-workstation/contracts';
import { authExpiredEventName, klaApi } from '../api/client';
import { ComputeSection, type ComputeView } from './ComputeSection';
import { Badge, Chart, formatUsd, IconButton, Panel, Stat } from './ui';

type Section = 'home' | 'projects' | 'knowledge' | 'agents' | 'memory' | 'compute' | 'chats' | 'settings';
type LoginIdentity = IdentityDto & { role?: 'personal' | 'admin' | 'member' };
type Modal = 'project' | 'chat' | 'knowledge' | 'knowledge-create' | 'agent' | 'register' | 'identity' | 'create-enterprise' | 'join-enterprise' | null;
type Project = { id: string; name: string; description: string; progress: number; members: number; color: string; open?: boolean; groupIds?: string[] };
type Chat = { id: string; name: string; project: string; projectId?: string; messages: { id?: string; author: string; text: string; time: string; senderType?: string; artifactId?: string }[] };
type ChatMessage = { id: string; senderType: string; senderName?: string; text: string; createdAt: string; metadata?: { artifactId?: string } };
type ChatRun = { id: string; status: string };
const mapChatMessages = (messages: ChatMessage[]): Chat['messages'] => messages.map(m => ({ id: m.id, author: m.senderType === 'agent' ? (m.senderName ?? '智能体') : '我', text: m.text, time: new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), senderType: m.senderType, artifactId: m.metadata?.artifactId }));
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
  { id: 'demo-1', name: '测试版本', description: '测试版本1.0', progress: 67, members: 8, color: '#2779e9', open: true, groupIds: ['demo-chat-1', 'demo-chat-2'] },
  { id: 'demo-2', name: '测试版本1.0', description: '个人项目', progress: 0, members: 1, color: '#0d9488', open: false, groupIds: [] },
];
const initialChats: Chat[] = [
  { id: 'demo-chat-1', name: '测试4.0德韬', project: '测试版本', projectId: 'demo-1', messages: [{ author: '统筹智能体', text: '大家好，项目材料已经整理完成，可以继续讨论下一步工作。', time: '08-27' }] },
  { id: 'demo-chat-2', name: '测试3.0鲲鹭', project: '测试版本', projectId: 'demo-1', messages: [{ author: '本地执行智能体', text: '已汇总行业趋势与主要竞品的公开资料。', time: '08-27' }] },
  { id: 'demo-chat-3', name: '测试2.C', project: '未关联项目', messages: [] },
  { id: 'demo-chat-4', name: '测试1.C', project: '未关联项目', messages: [] },
  { id: 'demo-chat-5', name: '分析图生3D文档', project: '未关联项目', messages: [] },
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
  { id: 'knowledge', label: '知识库', Icon: BookOpen }, { id: 'agents', label: '智能体', Icon: Bot },
  { id: 'memory', label: '记忆', Icon: BrainIcon }, { id: 'compute', label: '算力', Icon: Activity },
] as const;
const computeNav = [
  { id: 'dashboard', label: '仪表盘', Icon: LayoutDashboard }, { id: 'keys', label: 'API 密钥', Icon: KeyRound },
  { id: 'usage', label: '使用记录', Icon: FileText }, { id: 'market', label: '模型广场', Icon: Database },
  { id: 'members', label: '成员管理', Icon: Users },
] as const;

// UI 原语（IconButton / Badge / Panel / Stat / Chart）已抽到 ./ui，算力模块共用。

export function Workstation(): React.JSX.Element {
  const [signedIn, setSignedIn] = useState(() => Boolean(sessionStorage.getItem('kla.access-token')));
  const [authChecking, setAuthChecking] = useState(() => Boolean(sessionStorage.getItem('kla.access-token')));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [section, setSection] = useState<Section>('home');
  const [computeView, setComputeView] = useState<ComputeView>('dashboard');
  const [modal, setModal] = useState<Modal>(null);
  const [identities, setIdentities] = useState<LoginIdentity[]>([]);
  const [activeIdentityId, setActiveIdentityId] = useState(() => klaApi.getIdentity() ?? '');
  const [identityAction, setIdentityAction] = useState<'create' | 'join' | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [docs, setDocs] = useState<Document[]>([]);
  const [activeProject, setActiveProject] = useState('');
  const [activeChat, setActiveChat] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newModel, setNewModel] = useState('DeepSeek-R1');
  const [knowledgeScope, setKnowledgeScope] = useState('全部知识');
  const [knowledgeView, setKnowledgeView] = useState<'catalog' | 'detail'>('catalog');
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [activeKnowledgeBase, setActiveKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [knowledgeTab, setKnowledgeTab] = useState<KnowledgeTab>('sources');
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSource[]>([]);
  const [knowledgeChunks, setKnowledgeChunks] = useState<KnowledgeChunk[]>([]);
  const [knowledgePreview, setKnowledgePreview] = useState<{ title: string; content?: string; url?: string; kind: 'text' | 'file' } | null>(null);
  const [knowledgeFiles, setKnowledgeFiles] = useState<File[]>([]);
  const [knowledgeScopeChoice, setKnowledgeScopeChoice] = useState<KnowledgeScope>('personal');
  const [models, setModels] = useState(initialModels);
  const [computeBalanceUsd, setComputeBalanceUsd] = useState<number | null>(null);
  /** 当前身份是否具备企业管理员能力；由算力模块按服务端权限标志上报，仅用于决定侧栏是否展示「成员管理」 */
  const [computeAdmin, setComputeAdmin] = useState(false);
  /** §12：身份切换后强制算力模块清空缓存并重新加载 */
  const [computeReloadKey, setComputeReloadKey] = useState(0);
  const [notice, setNotice] = useState('');
  const [details, setDetails] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentFilter, setAgentFilter] = useState('全部');
  const [agentView, setAgentView] = useState<'mine' | 'market'>('mine');
  const [agentDraft, setAgentDraft] = useState<Agent | null>(null);
  const [memoryGroup, setMemoryGroup] = useState('');
  const [memoryAgent, setMemoryAgent] = useState('全部智能体');
  const [memories, setMemories] = useState<Array<{ id: string; groupId: string; agent: string; text: string; source: string }>>([]);
  const [authNewName, setAuthNewName] = useState('');
  const [authNewEmail, setAuthNewEmail] = useState('');
  const [authNewEmailCode, setAuthNewEmailCode] = useState('');
  const [authNewPassword, setAuthNewPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [pendingRuns, setPendingRuns] = useState<Record<string, string>>({});
  const sendingChats = useRef(new Set<string>());
  const createLock = useRef(false);
  const [creating, setCreating] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const chatSending = Boolean(pendingRuns[activeChat]);
  const pendingRunId = pendingRuns[activeChat];
  const [previewArtifact, setPreviewArtifact] = useState<{ name: string; content: string } | null>(null);
  const currentProject = projects.find(p => p.id === activeProject) ?? projects[0] ?? { id: '', name: '暂无项目', description: '创建项目后显示项目工作台', progress: 0, members: 0, color: '#2779e9', groupIds: [] };
  const currentChat = chats.find(c => c.id === activeChat) ?? chats[0] ?? { id: '', name: '暂无群组', project: '暂无项目', messages: [] };
  const filteredDocs = useMemo(() => docs.filter(d => (knowledgeScope === '全部知识' || d.group === knowledgeScope) && d.name.toLowerCase().includes(query.toLowerCase())), [docs, knowledgeScope, query]);
  const activeSources = useMemo(() => activeKnowledgeBase ? knowledgeSources.filter(s => s.knowledgeBaseId === activeKnowledgeBase.id && s.name.toLowerCase().includes(query.toLowerCase())) : [], [activeKnowledgeBase, knowledgeSources, query]);
  const activeChunks = useMemo(() => activeKnowledgeBase ? knowledgeChunks.filter(chunk => activeSources.some(source => source.id === chunk.sourceId)) : [], [activeKnowledgeBase, knowledgeChunks, activeSources]);
  const notify = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 3500); };
  const apiError = (result: { message?: string; error?: { message?: string } }) => result.message ?? result.error?.message ?? '请求失败';
  const openArtifact = async (artifactId: string) => {
    const identityId = activeIdentityId;
    try {
      const result = await klaApi.request<{ name: string; content: string }>(`/v1/artifacts/${artifactId}`, { headers: { 'x-identity-id': identityId } });
      if (klaApi.getIdentity() !== identityId) return;
      if (result.ok) setPreviewArtifact(result.data);
      else notify(apiError(result));
    } catch {
      if (klaApi.getIdentity() === identityId) notify('成果文件加载失败，请重试');
    }
  };
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
    klaApi.request('/v1/me').then(result => { setSignedIn(result.ok); setAuthChecking(false); if (!result.ok) expire(); }).catch(() => { klaApi.clearAccessToken(); setSignedIn(false); setAuthChecking(false); notify('认证服务暂不可用，请重新登录'); });
    }
    return () => window.removeEventListener(authExpiredEventName, expire);
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    const headers = activeIdentityId ? { 'x-identity-id': activeIdentityId } : undefined;
    setWorkspaceLoading(true);
    setProjects([]); setChats([]); setActiveProject(''); setActiveChat(''); setPendingRuns({}); setPreviewArtifact(null);
    void (async () => {
      const result = await klaApi.request<{ projects: Array<{ id: string; name: string }>; conversations: Array<{ id: string; name: string; projectId: string; projectName?: string }> }>('/v1/bootstrap', { headers });
      if (cancelled) return;
      if (!result.ok) { notify(apiError(result)); return; }
      const nextProjects = result.data.projects.map((p, index) => ({ id: p.id, name: p.name, description: '当前身份下的项目工作区', progress: 0, members: 1, color: ['#2779e9', '#0d9488', '#8b5cf6'][index % 3], open: true, groupIds: result.data.conversations.filter(c => c.projectId === p.id).map(c => c.id) }));
      const nextChats = result.data.conversations.map((c) => ({ id: c.id, name: c.name, project: c.projectName ?? nextProjects.find((p) => p.id === c.projectId)?.name ?? '项目', projectId: c.projectId, messages: [] }));
      if (nextProjects.length) { setProjects(nextProjects); setActiveProject(nextProjects[0].id); }
      if (nextChats.length) { setChats(nextChats); setActiveChat(nextChats[0].id); }
      if (!nextProjects.length) { setProjects([]); setActiveProject(''); }
      if (!nextChats.length) { setChats([]); setActiveChat(''); }
      setWorkspaceLoading(false);
      const agentResult = await klaApi.request<Array<{ id: string; name: string; role: string; type: string; modelId: string | null; enabled: boolean }>>('/v1/agents', { headers });
      if (cancelled) return;
      if (agentResult.ok && agentResult.data.length) setAgents(agentResult.data.map((a, index) => ({ name: a.name, role: a.role, type: a.type === 'official' ? '官方智能体' : a.type === 'external' ? '外接第三方' : '自定义智能体', model: a.modelId ?? '默认模型槽位', skills: [], enabled: a.enabled, color: ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b'][index % 4] })));
      const modelResult = await klaApi.request<Array<{ id: string; name: string; provider: string; base_url?: string; capabilities?: { thinking?: boolean; vision?: boolean; context?: number }; configured?: boolean }>>('/v1/models', { headers });
      if (cancelled) return;
      if (modelResult.ok && modelResult.data.length) setModels(modelResult.data.map((m, index) => ({ id: m.id, name: m.name, vendor: `${m.provider} / ${m.id}`, category: m.capabilities?.vision ? '视觉多模态' : m.capabilities?.thinking ? '深度思考' : '通用模型', context: m.capabilities?.context ? `${Math.round(m.capabilities.context / 1000)}K` : '128K', latency: '服务端探测', cost: m.configured ? '已配置' : '待配置密钥', icon: ['◈', '文', '✣', '◉'][index % 4] })));
      const memoryResult = await klaApi.request<Array<{ id: string; workspaceId: string; content: string; kind: string; createdAt: string }>>('/v1/memories', { headers });
      if (cancelled) return;
      if (memoryResult.ok) setMemories(memoryResult.data.map(m => ({ id: m.id, groupId: m.workspaceId, agent: '智能体', text: m.content, source: `${m.kind} · ${new Date(m.createdAt).toLocaleString('zh-CN')}` })));
    })().catch(() => { if (!cancelled) notify('工作区加载失败，请检查后端连接'); }).finally(() => { if (!cancelled) setWorkspaceLoading(false); });
    return () => { cancelled = true; };
  }, [signedIn, activeIdentityId]);
  useEffect(() => {
    if (!signedIn || !activeChat) { setChatLoading(false); return; }
    let cancelled = false;
    setChatLoading(true);
    void (async () => {
      const result = await klaApi.request<ChatMessage[]>(`/v1/conversations/${activeChat}/messages`);
      if (cancelled) return;
      if (!result.ok) { notify(apiError(result)); return; }
      setChats(items => items.map(chat => chat.id === activeChat ? { ...chat, messages: mapChatMessages(result.data) } : chat));
      const runs = await klaApi.request<ChatRun[]>(`/v1/conversations/${activeChat}/runs`);
      if (cancelled || !runs.ok) return;
      const running = runs.data.find(run => ['queued', 'running'].includes(run.status));
      if (running) setPendingRuns(items => ({ ...items, [activeChat]: running.id }));
    })().catch(() => { if (!cancelled) notify('消息加载失败，请检查后端连接'); }).finally(() => { if (!cancelled) setChatLoading(false); });
    return () => { cancelled = true; };
  }, [signedIn, activeChat, activeIdentityId]);
  useEffect(() => {
    if (!signedIn || !activeChat || !pendingRunId || pendingRunId === 'submitting') return;
    let cancelled = false;
    let timer: number | undefined;
    const clearPending = () => setPendingRuns(items => { const next = { ...items }; if (next[activeChat] === pendingRunId) delete next[activeChat]; return next; });
    const poll = async () => {
      try {
        const runs = await klaApi.request<ChatRun[]>(`/v1/conversations/${activeChat}/runs`);
        if (cancelled) return;
        if (!runs.ok) { notify(apiError(runs)); clearPending(); return; }
        const result = await klaApi.request<ChatMessage[]>(`/v1/conversations/${activeChat}/messages`);
        if (cancelled) return;
        if (!result.ok) { notify(apiError(result)); clearPending(); return; }
        setChats(items => items.map(chat => chat.id === activeChat ? { ...chat, messages: mapChatMessages(result.data) } : chat));
        const run = runs.data.find(item => item.id === pendingRunId);
        if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) { clearPending(); return; }
        timer = window.setTimeout(() => { void poll(); }, 1000);
      } catch {
        if (!cancelled) { clearPending(); notify('无法获取执行状态，重新进入群组可继续查看'); }
      }
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [signedIn, activeChat, activeIdentityId, pendingRunId]);
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
    const result = await klaApi.request<LoginIdentity>('/v1/me/identities/' + identityId + '/activate', { method: 'POST', body: '{}', headers: { 'x-identity-id': identityId } });
    if (!result.ok) { notify(apiError(result)); return; }
    klaApi.setIdentity(result.data.id);
    setActiveIdentityId(result.data.id);
    setComputeBalanceUsd(null);
    setComputeAdmin(false);
    setComputeReloadKey(key => key + 1);
    setIdentities(items => items.map(item => ({ ...item, isDefault: item.id === result.data.id })));
    setModal(null);
    notify(`已进入${result.data.displayName}身份`);
  };
  const createEnterprise = async () => { const result = await klaApi.request<LoginIdentity & { inviteCode?: string | null }>('/v1/organizations', { method: 'POST', body: JSON.stringify({ name: companyName.trim(), licenseNumber: licenseNumber.trim() }) }); if (!result.ok) { notify(apiError(result)); return; } setIdentities(items => [...items, result.data]); setCompanyName(''); setLicenseNumber(''); await activateIdentity(result.data.id); notify(result.data.inviteCode ? `企业创建成功，邀请码：${result.data.inviteCode}` : '企业创建成功，已进入企业身份'); };
  const joinEnterprise = async () => { const result = await klaApi.request<LoginIdentity>('/v1/organizations/join', { method: 'POST', body: JSON.stringify({ inviteCode: inviteCode.trim() }) }); if (!result.ok) { notify(apiError(result)); return; } setIdentities(items => [...items, result.data]); setInviteCode(''); await activateIdentity(result.data.id); notify('已加入企业，已进入企业身份'); };
  const send = async (conversationId = activeChat) => {
    if (!draft.trim() || pendingRuns[conversationId] || sendingChats.current.has(conversationId) || chatLoading) return;
    if (!signedIn || !conversationId) { notify('请先创建或选择一个真实群组'); return; }
    const text = draft.trim();
    const identityId = activeIdentityId;
    sendingChats.current.add(conversationId);
    setPendingRuns(items => ({ ...items, [conversationId]: 'submitting' }));
    try {
      const submitted = await klaApi.request<{ message: ChatMessage; run: ChatRun }>(`/v1/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ text, mode: 'balanced' }), headers: { 'x-identity-id': identityId } });
      if (klaApi.getIdentity() !== identityId) return;
      if (!submitted.ok) { notify(apiError(submitted)); setPendingRuns(items => { const next = { ...items }; delete next[conversationId]; return next; }); return; }
      setChats(items => items.map(chat => chat.id === conversationId ? { ...chat, messages: [...chat.messages.filter(message => message.id !== submitted.data.message.id), ...mapChatMessages([submitted.data.message])] } : chat));
      setDraft(current => current.trim() === text ? '' : current);
      setPendingRuns(items => ({ ...items, [conversationId]: submitted.data.run.id }));
    } catch {
      if (klaApi.getIdentity() === identityId) { notify('消息发送失败，请检查后端连接后重试'); setPendingRuns(items => { const next = { ...items }; delete next[conversationId]; return next; }); }
    } finally { sendingChats.current.delete(conversationId); }
  };
  const create = () => {
    if (!newName.trim() || createLock.current || workspaceLoading) return;
    if (modal === 'project') {
      if (!signedIn) { notify('请先登录后创建项目'); return; }
      const identityId = activeIdentityId;
      createLock.current = true; setCreating(true);
      void klaApi.request<{ id: string; name: string }>('/v1/projects', { method: 'POST', body: JSON.stringify({ name: newName.trim() }) }).then((result) => {
        if (klaApi.getIdentity() !== identityId) return;
        if (!result.ok) { notify(apiError(result)); return; }
        setProjects(items => [...items, { id: result.data.id, name: result.data.name, description: newDescription.trim() || '当前身份下的项目工作区', progress: 0, members: 1, color: '#2779e9', open: true, groupIds: [] }]);
        setActiveProject(result.data.id); setModal(null); setNewName(''); setNewDescription(''); navigate('projects'); notify('项目已创建并保存到数据库');
      }).catch((error: unknown) => notify(error instanceof Error ? `创建项目失败：${error.message}` : '创建项目失败，请检查后端连接后重试')).finally(() => { createLock.current = false; setCreating(false); });
      return;
    }
    if (modal === 'chat') {
      if (!signedIn) { notify('请先登录后创建群组'); return; }
      const selectedProject = projects.find(p => p.id === (newProject || activeProject || projects[0]?.id));
      if (!selectedProject?.id) { notify('请先创建项目，再创建群组'); return; }
      const identityId = activeIdentityId;
      createLock.current = true; setCreating(true);
      void klaApi.request<{ id: string; projectId: string; name: string }>('/v1/conversations', { method: 'POST', body: JSON.stringify({ projectId: selectedProject.id, name: newName.trim() }) }).then((result) => {
        if (klaApi.getIdentity() !== identityId) return;
        if (!result.ok) { notify(apiError(result)); return; }
        const chat = { id: result.data.id, name: result.data.name, project: selectedProject.name, projectId: selectedProject.id, messages: [] };
        setChats(items => [...items, chat]); setProjects(items => items.map(p => p.id === selectedProject.id ? { ...p, groupIds: [...(p.groupIds ?? []), chat.id], open: true } : p)); setActiveChat(chat.id); setActiveProject(selectedProject.id); setModal(null); setNewName(''); setNewProject(''); setSection('chats'); notify('群组已创建并保存到数据库');
      }).catch((error: unknown) => notify(error instanceof Error ? `创建群聊失败：${error.message}` : '创建群聊失败，请检查后端连接后重试')).finally(() => { createLock.current = false; setCreating(false); });
      return;
    }
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
  // 用量导出改由服务端生成（§7.4），前端不再本地拼接 CSV。

  const authModal = modal && ['register','identity','create-enterprise','join-enterprise'].includes(modal) && <div className="ws-modal-backdrop"><div className="ws-modal ws-auth-modal">
      <header><h2>{modal === 'register' ? '创建账号' : modal === 'identity' ? '选择登录身份' : modal === 'create-enterprise' ? '创建企业身份' : '加入企业'}</h2>{modal !== 'identity' && <IconButton title="关闭" onClick={() => setModal(null)}><X size={19} /></IconButton>}</header>
      {modal === 'register' && <div className="ws-register-flow"><div className="ws-register-intro"><span className="ws-register-kicker">ACCOUNT REGISTRATION</span><h3>注册鲲擎账号</h3><p>填写账号、密码并完成邮箱验证即可注册；登录后可切换要进入的企业身份。</p></div><form onSubmit={e => { e.preventDefault(); void register(); }}><label>账号<input required value={authNewName} onChange={e => setAuthNewName(e.target.value)} autoComplete="username" placeholder="设置登录账号，如 laok" /><small className="ws-auth-hint">账号与邮箱都可作为登录凭证</small></label><label>密码<input required type="password" minLength={8} value={authNewPassword} onChange={e => setAuthNewPassword(e.target.value)} autoComplete="new-password" placeholder="设置登录密码，至少 8 位" /><small className="ws-auth-hint">密码需至少 8 位，并包含数字、大写字母和小写字母</small></label><label>邮箱<input required type="email" value={authNewEmail} onChange={e => setAuthNewEmail(e.target.value)} autoComplete="email" placeholder="用于接收验证码与找回密码" /></label><label>验证码<div className="ws-auth-code-row"><input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={authNewEmailCode} onChange={e => setAuthNewEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="请输入 6 位验证码" /><button type="button" onClick={() => notify('演示环境验证码为 123456')}>获取验证码</button></div><small className="ws-auth-hint">验证码 5 分钟内有效，演示环境固定使用 123456</small></label><footer><button type="button" className="ws-auth-back" onClick={() => setModal(null)}>取消</button><button className="ws-primary">注册</button></footer></form></div>}
      {modal === 'identity' && <div className="ws-identity-flow"><div className="ws-register-intro"><span className="ws-register-kicker">IDENTITY WORKSPACE</span><h3>选择进入身份</h3><p>不同身份拥有独立的工作区、项目和数据权限，进入后可在右上角随时切换。</p></div><div className="ws-identity-list"><button className="ws-identity-card" onClick={() => { const personal = identities.find(item => item.type === 'personal'); if (personal) void activateIdentity(personal.id); else { setModal(null); notify('个人身份不可用'); } }}><span className="ws-identity-icon personal"><UserCircle size={18} /></span><span><strong>个人身份</strong><small>个人工作区 · 默认权限</small></span><ArrowRight size={15} /></button>{identities.filter(item => item.type === 'enterprise').map(item => <button className="ws-identity-card" key={item.id} onClick={() => void activateIdentity(item.id)}><span className="ws-identity-icon enterprise"><BriefcaseBusiness size={18} /></span><span><strong>{item.displayName}</strong><small>{item.role === 'admin' ? '企业管理员' : '企业员工'} · 独立权限</small></span><ArrowRight size={15} /></button>)}</div><div className="ws-identity-actions"><button onClick={() => setModal('create-enterprise')}><Plus size={15} /> 创建新的企业</button><button onClick={() => setModal('join-enterprise')}><Users size={15} /> 加入已有企业</button></div></div>}
      {modal === 'create-enterprise' && <form onSubmit={e => { e.preventDefault(); void createEnterprise(); }}><header className="ws-nested-auth-heading"><h3>创建企业账号</h3><p>为企业开一个新的知识空间。创建后你将成为该企业的超级管理员。</p></header><label>企业名称<input required value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="例如 卡伦特制造" /></label><label>营业执照编码<input required value={licenseNumber} onChange={e => setLicenseNumber(e.target.value)} placeholder="请输入营业执照编码" /></label><footer><button type="button" onClick={() => setModal('identity')}>取消</button><button className="ws-primary">创建并进入</button></footer></form>}
      {modal === 'join-enterprise' && <form onSubmit={e => { e.preventDefault(); void joinEnterprise(); }}><header className="ws-nested-auth-heading"><h3>加入已有企业</h3><p>输入企业超级管理员发给你的邀请码，校验通过后会新增一个企业身份并切换过去。</p></header><label>企业邀请码<input required value={inviteCode} onChange={e => setInviteCode(e.target.value.toUpperCase())} placeholder="例如 KQ-2026-8F3A" /><small className="ws-auth-hint">加入成功后将建立该企业的成员身份</small></label><footer><button type="button" onClick={() => setModal('identity')}>取消</button><button className="ws-primary">校验并加入</button></footer></form>}
    </div></div>;

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
    </form><footer>● 集群所有核心服务已连接正常 · 延迟 12ms <span>© 2026 鲲擎智能 · 保障企业数据与合规隐私安全</span></footer>{authModal}{notice && <div className="ws-toast">{notice}</div>}
  </div>;

  return <div className="ws-app">
    <aside className="ws-sidebar"><div><div className="ws-brand"><img src={logo} alt="鲲擎" /><span>鲲擎平台<small>AI INTELLIGENCE</small></span></div><nav>{nav.map(({ id, label, Icon }) => <button key={id} className={section === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={19} />{label}</button>)}</nav></div><div className="ws-sidebar-bottom"><button onClick={() => { navigate('compute'); setComputeView('dashboard'); }}><Sparkles size={15} /> 积分余额 <b>1,008.71</b><span className="ws-side-chevron">›</span></button><button onClick={() => navigate('settings')}><Settings size={17} /> 设置</button></div></aside>
    <main className={`ws-main ${(section === 'projects' || section === 'chats' || section === 'knowledge' || section === 'compute' || section === 'settings') ? 'has-subnav' : 'wide'}`}>
    {(section === 'projects' || section === 'chats' || section === 'knowledge' || section === 'compute' || section === 'settings') && <aside className="ws-subnav">
        {(section === 'projects' || section === 'chats') && <><header className="ws-panel-heading"><span className="ws-panel-heading-icon"><Folder size={17} /></span><span><strong>项目与群组</strong><small>{projects.length} 个项目 · {chats.length} 个群组</small></span><IconButton title="新建项目" onClick={() => setModal('project')}><Plus size={17} /></IconButton></header><div className="ws-sub-list ws-project-tree"><div className="ws-tree-label">项目 <button title="新建项目" onClick={() => setModal('project')}><Plus size={14} /></button></div>{projects.map(p => <div key={p.id} className="ws-tree-project"><div className={`ws-tree-row ${p.id === activeProject ? 'active' : ''}`}><button className="ws-tree-toggle" onClick={() => setProjects(items => items.map(x => x.id === p.id ? { ...x, open: !x.open } : x))}>{p.open ? '▾' : '▸'}</button><button className="ws-tree-main" onClick={() => { setActiveProject(p.id); setSection('projects'); }}><span className="ws-avatar" style={{ background: p.color }}>{p.name.slice(0, 2)}</span><span>{p.name}<small>{p.description} · {p.groupIds?.length ?? 0} 个关联群组</small></span></button><button className="ws-tree-add" title="在此项目下新建群聊" onClick={() => { setNewProject(p.id); setNewName(''); setModal('chat'); }}>＋</button></div>{p.open && <div className="ws-tree-children">{(p.groupIds ?? []).map(id => { const chat = chats.find(c => c.id === id); return chat ? <button key={chat.id} className={activeChat === chat.id ? 'active' : ''} onClick={() => { setActiveChat(chat.id); setActiveProject(p.id); setSection('chats'); }}><span className="ws-tree-branch">└</span><span className="ws-avatar">{chat.name.slice(0, 2)}</span><span>{chat.name}<small>进行中 · {chat.messages.at(-1)?.time ?? '暂无消息'}</small></span></button> : null; })}</div>}</div>)}<div className="ws-tree-label ws-tree-orphans">群组 <button title="新建群聊" onClick={() => { setNewProject(''); setNewName(''); setModal('chat'); }}><Plus size={14} /></button></div>{chats.filter(c => !projects.some(p => p.groupIds?.includes(c.id))).map(chat => <button key={chat.id} className={activeChat === chat.id ? 'active' : ''} onClick={() => { setActiveChat(chat.id); setSection('chats'); }}><span className="ws-avatar">{chat.name.slice(0, 2)}</span><span>{chat.name}<small>进行中 · {chat.project}</small></span></button>)}</div></>}
      {section === 'compute' && <><header className="ws-compute-title"><span className="ws-tiny-icon"><Activity size={18} /></span><span>算力与计费中心<small>Cluster Mesh v4.8</small></span></header><div className="ws-compute-links">{computeNav.filter(item => item.id !== 'members' || computeAdmin).map(({ id, label, Icon }) => <button key={id} className={computeView === id ? 'active' : ''} onClick={() => { setComputeView(id); setQuery(''); }}><Icon size={16} />{label}</button>)}</div><div className="ws-wallet"><small>账户可用算力余额 <b>{computeBalanceUsd === null ? '待加载' : computeBalanceUsd > 0 ? '可用' : '不足'}</b></small><strong>{formatUsd(computeBalanceUsd)}</strong><button className="ws-primary" onClick={() => setComputeView('dashboard')}>查看余额与额度</button></div></>}
      {section === 'settings' && <><header className="ws-compute-title"><span className="ws-tiny-icon"><Settings size={18} /></span><span>设置中心<small>智能体与工作站配置</small></span></header><div className="ws-settings-menu"><small>AI 核心</small><button className="active"><Bot size={16} /> 智能体管理</button><button onClick={() => { navigate('compute'); setComputeView('market'); }}><Database size={16} /> 模型广场</button><small>AI 生产力</small><button onClick={() => notify('技能管理将在后续版本开放')}><Sparkles size={16} /> 技能管理</button><small>扩展设置</small><button onClick={() => notify('权限管理待服务端接入')}><ShieldCheck size={16} /> 权限管理</button></div></>}
    </aside>}
    <div className="ws-topbar"><div className="ws-breadcrumb"><span>协同工作台</span><b>/</b><strong>{section === 'home' ? '总览主页' : section === 'compute' ? `算力平台 / ${computeNav.find(n => n.id === computeView)?.label}` : section === 'settings' ? '设置 / 智能体管理' : section === 'chats' ? '群聊 / 工作空间' : `${nav.find(n => n.id === section)?.label ?? '工作空间'} / 工作空间`}</strong></div><Badge tone="green">系统正常运行</Badge><div className="ws-top-actions"><button className="ws-top-search" onClick={() => notify('已提交搜索')}><Search size={14} /> 快速搜索智能体、任务…</button><IconButton title="通知" onClick={() => notify('暂无新通知')}><Bell size={16} /></IconButton><IconButton title="帮助" onClick={() => notify('帮助中心')}><CircleHelp size={16} /></IconButton><button className="ws-user ws-user-button" onClick={() => notify('个人信息、记忆与身份切换将在用户菜单中展开')}><span className="ws-user-avatar">K</span><span>老K<small>数字化员工</small></span></button></div></div>
      <div className="ws-content">
        {(section === 'settings' || section === 'agents') && <><div className="ws-agent-heading"><div><h1>智能体</h1><p>Agent Control ｜ 管理官方智能体、外接三方和自定义智能体，也可以从市场安装通用能力型智能体。</p></div><button className="ws-primary" onClick={() => { setNewName(''); setNewDescription(''); setModal('agent'); }}><Plus size={15} /> 新建智能体</button></div><div className="ws-agent-tabs"><button className={agentView === 'mine' ? 'active' : ''} onClick={() => setAgentView('mine')}>我的智能体 · {agents.length}</button><button className={agentView === 'market' ? 'active' : ''} onClick={() => setAgentView('market')}>智能体市场 · 12</button></div>{agentView === 'mine' ? <><div className="ws-agent-toolbar"><div className="ws-segment">{['全部', '官方智能体', '外接第三方', '自定义智能体'].map(t => <button key={t} className={agentFilter === t ? 'active' : ''} onClick={() => setAgentFilter(t)}>{t}</button>)}</div><div className="ws-sub-search"><Search size={14} /><input placeholder="搜索智能体..." value={query} onChange={e => setQuery(e.target.value)} /></div></div><div className="ws-agent-grid">{agents.filter(a => (agentFilter === '全部' || agentFilter === a.type) && `${a.name}${a.role}`.toLowerCase().includes(query.toLowerCase())).map(a => <article className="ws-agent-card" key={a.name}><div className="ws-agent-card-head"><span className="ws-avatar" style={{ background: a.color }}>{a.name.slice(0, 2)}</span><div><h3>{a.name}</h3><small>{a.type}</small></div><Badge tone={a.enabled ? 'green' : 'muted'}>{a.enabled ? '已启用' : '未连接'}</Badge></div><p>{a.role}</p><div className="ws-agent-meta"><span>运行方式: {a.type === '外接第三方' ? '外部连接器' : '本地模型智能体'}</span><span>挂载模型: {a.model}</span></div><div className="ws-agent-skills">{a.skills.map(s => <Badge key={s}>{s}</Badge>)}</div><footer><button onClick={() => setAgentDraft(a)}><Settings size={14} /> 配置</button><button onClick={() => setAgents(items => items.map(x => x.name === a.name ? { ...x, enabled: !x.enabled } : x))}>{a.enabled ? '停用' : '启用'}</button></footer></article>)}</div></> : <div className="ws-agent-market"><div className="ws-market-controls"><div className="ws-sub-search"><Search size={14} /><input placeholder="搜索市面上的通用智能体..." value={query} onChange={e => setQuery(e.target.value)} /></div><Badge>安装后出现在“我的智能体”</Badge></div><div className="ws-market-grid">{['市场调研智能体','PPT 设计智能体','代码审查智能体','合同审阅智能体','数据清洗智能体','客服分析智能体'].map(name => <article key={name}><span className="ws-avatar">{name.slice(0, 2)}</span><strong>{name}</strong><small>通用能力型智能体 · 可挂载模型与技能</small><button className="ws-primary" onClick={() => { if (!agents.some(a => a.name === name)) setAgents(items => [...items, { name, role: `${name}，提供可复用的专业能力`, type: '自定义智能体', model: '默认模型槽位', skills: ['通用任务'], enabled: true, color: '#2563eb' }]); notify(`已安装${name}`); }}>安装</button></article>)}</div></div>}</>}
        {section === 'home' && <div className="ws-home-prototype">
          <section className="ws-proto-welcome"><span className="ws-proto-avatar">K</span><div className="ws-proto-welcome-copy"><h1>早上好，老K · 开启高效多智能体协同的一天</h1><p>老K · 数字化员工 ｜ 已自动识别身份 · 员工目录 ｜ 科技BG · 数字化中心 · 数字化员工</p><div className="ws-proto-tags"><Badge tone="green">全域智能调度引擎运行中</Badge><Badge tone="green">算力响应正常 · 延迟 &lt; 85ms</Badge><Badge>4 大业务群组在线协同</Badge><Badge>已连接 4 个核心模型</Badge><Badge tone="muted">岗位语义智能自动匹配</Badge></div></div><div className="ws-proto-summary"><b>4<small>在线协同群组</small></b><b>6<small>可访问知识库</small></b><b>18<small>工作记忆条目</small></b></div><div className="ws-proto-actions"><button className="ws-primary" onClick={() => { navigate('compute'); setComputeView('market'); }}>查看模型矩阵与算力 <ArrowRight size={14} /></button><button onClick={() => navigate('knowledge')}>进入知识库</button></div></section>
          <div className="ws-proto-stats"><Stat icon={<Wallet />} label="积分余额" value="1,008.71" hint="集团统一额度分配，按 BG 配额结算，可在算力与计费中心查看明细" /><Stat icon={<Bot />} label="已安装应用" value="4 个" hint="可选 4 个 · 均由管理员统一授权" color="green" /><Stat icon={<BookOpen />} label="可访问知识" value="12 份" hint="按 BG 与权限过滤 · 可见范围随岗位权限变化" color="teal" /><Stat icon={<FileText />} label="工作记忆" value="18 条" hint="员工可查看、可删除 · 记忆随时由本人管理" color="orange" /></div>
  <div className="ws-proto-two"><Panel title="AI 工作入口 · 今天想完成什么？" action={<Badge tone="green">当前已连接 DeepSeek-V3 与百炼核心模型</Badge>}><div className="ws-proto-chatbar"><button onClick={() => notify('已打开智能体选择')}>@ 智能体</button><button onClick={() => notify('已打开技能库')}>/ 技能</button><button onClick={() => notify('已打开附件上传')}><Paperclip size={13} />附件</button></div><textarea className="ws-home-prompt" rows={3} placeholder="试试：帮我把上周的投资可行性评估整理成一页汇报…" value={draft} onChange={e => setDraft(e.target.value)} /><div className="ws-proto-chatfoot"><div className="ws-chip-row">{['总结本周工作', '查询集团制度', '生成项目汇报', '拆解今天的任务'].map(t => <button key={t} onClick={() => setDraft(t)}>{t}</button>)}</div><button className="ws-primary" onClick={() => { if (!chats[0]?.id) { notify('请先创建或选择一个真实群组'); return; } setActiveChat(chats[0].id); navigate('chats'); void send(chats[0].id); }}><Sparkles size={14} />发送</button></div><small className="ws-proto-note">已就绪：自动根据任务语义匹配最优模型并完成协同 <button onClick={() => { navigate('compute'); setComputeView('market'); }}>查看模型市场 →</button></small></Panel><Panel title="快捷功能入口" action={<Badge>6 大模块</Badge>}><div className="ws-proto-functions">{([['知识库','6 个知识库 · 28,452 个切片，支持检索与文件预览',BookOpen],['智能体','4 个已安装 · 可挂载模型与配置技能',Bot],['记忆','按群组隔离，可下钻到每个智能体的记忆',FileText],['算力与积分','积分余额、使用记录与模型广场',Activity],['项目与群组','2 个项目 · 4 个群组，项目内可直接建群组',Folder],['统一任务','待办 0 项 · 与群组任务实时同步',CheckCircle2],['成员管理','超管专属 · 成员、知识库权限、Token 与邀请码',Users],['平台设置','渠道 / 技能 / 工具 / 外观 / 运维管理',Settings]] as const).map(([name, desc, Icon]) => <button key={name} onClick={() => name === '知识库' ? navigate('knowledge') : name === '项目与群组' ? navigate('projects') : name === '算力与积分' ? navigate('compute') : name === '平台设置' ? navigate('settings') : notify(`${name}模块已聚焦`)}><span><Icon size={16} /></span><strong>{name}</strong><small>{desc}</small></button>)}</div></Panel></div>
          <div className="ws-proto-three"><Panel title="统一任务" action={<button className="ws-text-button" onClick={() => notify('新建任务')}>+ 新建任务</button>}><div className="ws-empty"><CheckCircle2 size={28} /><strong>今天没有待办</strong><small>点击上方“新建任务”即可安排工作，待办提醒会实时同步到工作台</small></div><div className="ws-proto-card-foot">待办提醒实时同步 <button onClick={() => notify('通知偏好')}>配置通知偏好</button></div></Panel><Panel title="协同应用状态" action={<Badge tone="green">运行正常</Badge>}><div className="ws-proto-list"><b>4 组就绪<small>4 大业务群组在线，可随时发起任务</small></b><b>跨群组通信 · 双向畅通<small>消息与文件均可互传，通信链路已验证</small></b><b>模型矩阵 · 4 个核心模型<small>支持按任务语义自动路由到最优模型</small></b></div></Panel><Panel title="OA 工作提醒 · OA 消息中心" action={<button className="ws-text-button" onClick={() => notify('打开 OA 消息中心')}>查看全部 →</button>}><div className="ws-empty"><Bell size={25} /><strong>尚未绑定个人 OA</strong><small>暂无未读消息 · 绑定本人 OA 账号后，消息与审批任务会自动双向同步到工作台</small></div><div className="ws-proto-card-foot"><Badge tone="orange">待绑定</Badge><button onClick={() => notify('绑定我的 OA')}>绑定我的 OA</button></div></Panel></div>
          <Panel title="快速协作模板推荐 · 多智能体群组" action={<button className="ws-text-button" onClick={() => navigate('chats')}>更多群组模板 →</button>}><div className="ws-proto-templates">{[['财务审计协同组 · 3 智能体','法务审合同 + 财务核票据 + 风险评级自动复核，输出审计结论与风险清单'],['市场调研小组 · 4 智能体','竞品爬取分析 + 舆情摘要 + 商业洞察报告编写，一次跑完调研到成稿'],['智能研发协作 · 2 智能体','架构设计评审 + API 自动化测试用例生成，评审意见与用例同步产出'],['创意营销工坊 · 3 智能体','新媒体文案裂变 + 分镜脚本 + 渠道分发策略，覆盖投放全链路']].map(([name, desc]) => <button key={name} onClick={() => { setModal('chat'); setNewName(name.split(' · ')[0]); }}><BriefcaseBusiness size={19} /><strong>{name}</strong><small>{desc}</small></button>)}</div></Panel>
        </div>}
        {section === 'projects' && <><div className="ws-page-heading"><div><h1>{currentProject.name}</h1><p>{currentProject.description}</p></div><button className="ws-primary" onClick={() => setModal('project')}><Plus size={16} /> 创建项目</button></div><div className="ws-stats four"><Stat icon={<Folder />} label="项目总数" value={`${projects.length}`} hint="当前工作空间" /><Stat icon={<CheckCircle2 />} label="总体完成率" value={`${projects.length ? Math.round(projects.reduce((n, p) => n + p.progress, 0) / projects.length) : 0}%`} hint="项目任务进度" color="green" /><Stat icon={<Users />} label="参与成员" value={`${currentProject.members} 人`} hint="含协作智能体" color="teal" /><Stat icon={<CalendarDays />} label="待办任务" value="8 项" hint="本周需跟进" color="orange" /></div><div className="ws-project-grid"><Panel title="项目进度概览" action={<Badge tone="green">进行中</Badge>}><div className="ws-project-progress"><div><strong>{currentProject.progress}%</strong><small>整体进度</small></div><div className="ws-progress-track"><i style={{ width: `${currentProject.progress}%` }} /></div><p>已完成 18 / 25 个任务节点</p></div><div className="ws-milestones">{['需求调研', '方案设计', '功能开发', '联调验收'].map((t, i) => <span key={t} className={i < 2 ? 'done' : ''}>{i < 2 ? '✓' : i + 1} {t}</span>)}</div></Panel><Panel title="近七日任务趋势" action={<span className="ws-muted">任务完成情况</span>}><Chart kind="bars" /></Panel></div><div className="ws-project-grid"><Panel title="项目成员与智能体"><div className="ws-people">{['老K', '统筹智能体', '本地执行智能体', '设计团队'].map(t => <span key={t}><span className="ws-avatar">{t.slice(0, 2)}</span>{t}</span>)}</div></Panel><Panel title="项目动态" action={<button className="ws-text-button" onClick={() => navigate('chats')}>进入群组 →</button>}><div className="ws-timeline"><p><b>今日 09:30</b> 统筹智能体更新项目阶段计划</p><p><b>昨日 16:20</b> 完成知识库资料归档</p><p><b>09月26日</b> 项目例会纪要已整理</p></div></Panel></div></>}
        {section === 'memory' && <><div className="ws-page-heading"><div><h1>记忆</h1><p>管理由对话中提炼出的记忆与偏好模型。记忆按群组隔离，只在对应群组的对话与任务中生效。</p></div><button className="ws-primary" onClick={() => notify('新增该群组记忆')}>+ 新增记忆</button></div><div className="ws-stats three"><Stat icon={<Users />} label="可记忆群组" value={`${chats.length} 个`} hint="群组创建后自动开启独立记忆" /><Stat icon={<BrainIcon />} label="记忆条目总数" value={`${memories.length} 条`} hint="按群组分别统计，互不可见" color="teal" /><Stat icon={<Clock3 />} label="最近自动整理" value="8 分钟前" hint="每晚自动整理更新" color="orange" /></div><Panel title="选择群组" action={<span className="ws-muted">记忆只在本群组内生效，切换群组会读取该群组自己的记忆</span>}><div className="ws-memory-tabs">{chats.map(chat => <button key={chat.id} className={memoryGroup === chat.id ? 'active' : ''} onClick={() => { setMemoryGroup(chat.id); setMemoryAgent('全部智能体'); }}>{chat.name} · {memories.filter(m => m.groupId === chat.id).length} 条</button>)}</div></Panel><div className="ws-memory-layout"><Panel title={currentChat.name}><div className="ws-memory-filter"><span>按智能体查看</span>{['全部智能体', ...Array.from(new Set(memories.filter(m => m.groupId === memoryGroup).map(m => m.agent)))].map(agent => <button key={agent} className={memoryAgent === agent ? 'active' : ''} onClick={() => setMemoryAgent(agent)}>{agent}</button>)}</div><div className="ws-memory-list">{memories.filter(m => m.groupId === memoryGroup && (memoryAgent === '全部智能体' || m.agent === memoryAgent)).map(memory => <article key={memory.id}><div><p>{memory.text}</p><small>来源：{memory.source}</small></div><div><button onClick={() => notify('编辑该条记忆')}>编辑</button><button className="danger" onClick={() => setMemories(items => items.filter(item => item.id !== memory.id))}>删除</button></div></article>)}</div>{memories.filter(m => m.groupId === memoryGroup).length === 0 && <div className="ws-empty">当前群组暂无记忆</div>}</Panel><aside className="ws-memory-side"><h3>记忆使用说明</h3><p>群组内的智能体在回答时会带入本群组记忆，其他群组读不到。</p><p>每条记忆都标注来源智能体，可逐条核对与删除。</p><Badge tone="green">● 隔离策略正常</Badge></aside></div></>}
{section === 'chats' && <div className="ws-chat"><header><div><span className="ws-avatar">{currentChat.name.slice(0, 2)}</span><span><strong>{currentChat.name}</strong><small>● {currentChat.project} · 2 个智能体协作中</small></span></div><div><IconButton title="邀请成员" onClick={() => notify('邀请成员将在成员接口接入后开放')}><Users size={17} /></IconButton><IconButton title="群组文件" onClick={() => notify('群组文件将在服务端存储接入后开放')}><Folder size={17} /></IconButton><IconButton title="更多" onClick={() => notify('群组设置即将开放')}><MoreHorizontal size={17} /></IconButton></div></header><div className="ws-chat-messages"><p className="ws-chat-date">{chatLoading ? '正在加载消息…' : '消息记录'}</p>{currentChat.messages.map((m, i) => <div className={`ws-message ${m.author === '我' ? 'self' : ''}`} key={m.id ?? `${m.time}-${i}`}><span className="ws-avatar">{m.author.slice(0, 2)}</span><div><small>{m.author} · {m.time}</small><p>{m.text}</p>{m.artifactId && <button className="ws-text-button" onClick={() => void openArtifact(m.artifactId!)}><FileText size={14} /> 打开成果文件</button>}</div></div>)}{chatSending && <div className="ws-message"><span className="ws-avatar">统筹</span><div><small>统筹智能体 · 正在处理</small><p className="ws-thinking"><span /> <span /> <span /></p></div></div>}</div><div className="ws-chat-compose"><textarea placeholder="发送消息给群组 (支持 @ 智能体)..." value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} /><div><span><Paperclip size={16} /> 附件 <Bot size={16} /> 智能体</span><button className="ws-primary" disabled={chatSending || chatLoading || !currentChat.id} onClick={() => void send()}><Send size={15} />{chatSending ? '处理中…' : '发送给群组'}</button></div></div></div>}
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
        {section === 'compute' && <>
          <ComputeSection view={computeView} onNotify={notify} onBalance={setComputeBalanceUsd} onAdminCapability={setComputeAdmin} reloadKey={computeReloadKey} projects={projects.map(project => ({ id: project.id, name: project.name }))} />
        </>}
      </div>
    </main>
    {modal && !['register','identity','create-enterprise','join-enterprise'].includes(modal) && <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !creating) setModal(null); }}><div className="ws-modal"><header><h2>{modal === 'project' ? '创建项目' : modal === 'chat' ? '创建群聊' : modal === 'agent' ? '新建自定义智能体' : modal === 'knowledge-create' ? '新建知识库' : '上传知识文件'}</h2><IconButton title="关闭" onClick={() => { if (!creating) setModal(null); }}><X size={19} /></IconButton></header>{modal === 'knowledge' ? <div className="ws-upload"><Upload size={28} /><p>拖拽文件到此处，或点击选择本地文件</p><small>支持 xlsx、ppt/pptx、word、pdf、mp4、mp3、png、jpg</small><input type="file" multiple accept=".xlsx,.xls,.ppt,.pptx,.doc,.docx,.pdf,.mp4,.mp3,.wav,.png,.jpg,.jpeg,.txt,.md,.html" onChange={e => addKnowledgeFiles(Array.from(e.target.files ?? []))} /></div> : modal === 'knowledge-create' ? <form onSubmit={e => { e.preventDefault(); create(); }}><label>知识库名称<input autoFocus required value={newName} onChange={e => setNewName(e.target.value)} placeholder="请输入知识库名称" /></label><label>说明（选填）<textarea value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="说明知识库的用途和内容范围" /></label><label>知识库层级<select value={knowledgeScopeChoice} onChange={e => setKnowledgeScopeChoice(e.target.value as KnowledgeScope)}><option value="personal">个人知识库</option><option value="project">项目知识库</option><option value="enterprise">企业知识库</option></select></label><p className="ws-detail-copy">企业知识库需企业管理员权限，项目知识库默认归当前项目创建者管理。</p><footer><button type="button" disabled={creating} onClick={() => setModal(null)}>取消</button><button className="ws-primary" type="submit">创建知识库</button></footer></form> : <form onSubmit={e => { e.preventDefault(); create(); }}><label>{modal === 'project' ? '项目名称' : modal === 'chat' ? '群聊名称' : modal === 'agent' ? '智能体名称' : '密钥名称'}<input autoFocus required value={newName} onChange={e => setNewName(e.target.value)} placeholder="请输入名称" /></label>{(modal === 'project' || modal === 'agent') && <label>{modal === 'project' ? '项目说明' : '职责说明'}<textarea value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="简要描述职责与目标" /></label>}{modal === 'agent' && <label>挂载模型<select value={newModel} onChange={e => setNewModel(e.target.value)}>{models.map(m => <option key={m.name}>{m.name}</option>)}</select></label>}{modal === 'chat' && <label>关联项目<select value={newProject || activeProject || projects[0]?.id || ""} onChange={e => setNewProject(e.target.value)} disabled={!projects.length}>{projects.length ? projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>) : <option value="">暂无可用项目</option>}</select></label>}<footer><button type="button" disabled={creating} onClick={() => setModal(null)}>取消</button><button className="ws-primary" type="submit" disabled={creating || workspaceLoading || (modal === "chat" && !projects.length)}>{creating ? '创建中…' : '创建'}</button></footer></form>}</div></div>}
    {agentDraft && <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setAgentDraft(null); }}><div className="ws-modal"><header><h2>配置 · {agentDraft.name}</h2><IconButton title="关闭" onClick={() => setAgentDraft(null)}><X size={19} /></IconButton></header><form onSubmit={e => { e.preventDefault(); setAgents(items => items.map(a => a.name === agentDraft.name ? agentDraft : a)); setAgentDraft(null); notify('智能体配置已更新（前端预览）'); }}><label>身份与职责<textarea value={agentDraft.role} onChange={e => setAgentDraft({ ...agentDraft, role: e.target.value })} /></label><label>挂载模型<select value={agentDraft.model} onChange={e => setAgentDraft({ ...agentDraft, model: e.target.value })}><option>默认模型槽位</option><option>外部连接器</option>{models.map(m => <option key={m.id}>{m.name}</option>)}</select></label><p className="ws-detail-copy">技能和权限由服务端管理；本页仅保存前端预览状态。</p><footer><button type="button" onClick={() => setAgentDraft(null)}>取消</button><button className="ws-primary">保存</button></footer></form></div></div>}
    {details && <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setDetails(null); }}><div className="ws-modal"><header><h2>{details}</h2><IconButton title="关闭" onClick={() => setDetails(null)}><X size={19} /></IconButton></header><p className="ws-detail-copy">当前为前端预览数据。文件正文或模型参数详情将在对应服务端接口接入后展示。</p><footer><button className="ws-primary" onClick={() => setDetails(null)}>关闭</button></footer></div></div>}
    {knowledgePreview && <div className="ws-modal-backdrop" style={{ justifyContent: 'flex-end', padding: 0, background: '#15375724' }} onMouseDown={e => { if (e.target === e.currentTarget) { if (knowledgePreview.url) URL.revokeObjectURL(knowledgePreview.url); setKnowledgePreview(null); } }}><div className="ws-modal ws-knowledge-preview"><header><h2>{knowledgePreview.title}</h2><IconButton title="关闭预览" onClick={() => { if (knowledgePreview.url) URL.revokeObjectURL(knowledgePreview.url); setKnowledgePreview(null); }}><X size={19} /></IconButton></header>{knowledgePreview.url ? <iframe title={knowledgePreview.title} src={knowledgePreview.url} /> : <article>{knowledgePreview.content}</article>}</div></div>}
    {authModal}
    {notice && <div className="ws-toast">{notice}</div>}
    {previewArtifact && <div className="ws-modal-backdrop" style={{ justifyContent: 'flex-end', padding: 0, background: '#15375724' }} onMouseDown={e => { if (e.target === e.currentTarget) setPreviewArtifact(null); }}><div className="ws-modal" style={{ width: 'min(720px, 52vw)', minWidth: 420, height: '100%', borderRadius: 0, display: 'flex', flexDirection: 'column' }}><header><h2>{previewArtifact.name}</h2><IconButton title="关闭预览" onClick={() => setPreviewArtifact(null)}><X size={19} /></IconButton></header><iframe title={previewArtifact.name} srcDoc={previewArtifact.content} sandbox="" style={{ flex: 1, width: '100%', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }} /></div></div>}
  </div>;
}
