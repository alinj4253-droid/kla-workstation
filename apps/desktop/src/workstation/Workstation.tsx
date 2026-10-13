import { useEffect, useMemo, useRef, useState } from 'react';
import { ConversationAttachments } from './ConversationAttachments';
import { HomeAiReview } from './HomeAiReview';
import type { FileItem } from '@kla-workstation/contracts';
import { Activity, ArrowRight, Bell, BookOpen, Bot, BriefcaseBusiness, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, Cloud, Code2, Copy, CreditCard, Database, Download, Eye, EyeOff, FileText, Folder, FolderPlus, Home, KeyRound, LayoutDashboard, LogOut, Menu, MessageSquare, MoreHorizontal, Paperclip, Plus, Search, Send, Settings, ShieldCheck, Sparkles, Upload, UserCircle, Users, Wallet, X, Wrench, Route, RefreshCw, Brain as BrainIcon } from 'lucide-react';
import logo from '../assets/kla-sidebar-logo.png';
import type { CreateConversationRequest, IdentityDto } from '@kla-workstation/contracts';
import { authExpiredEventName, klaApi, sessionChangedEventName } from '../api/client';
import { RuntimeAgentManagement, RuntimeRoomMembers, RuntimeSkillManagement, RuntimeToolManagement, RuntimeSettingsView } from './RuntimeManagement';
import { memoryApi } from '../api/memories';
import { ComputeSection, type ComputeView } from './ComputeSection';
import { KnowledgeSection } from './KnowledgeSection';
import { MemorySection } from './MemorySection';
import { Badge, Chart, formatPoints, IconButton, Panel, Stat } from './ui';
import { computeApi } from '../api/compute';
import { ArtifactPane, MarkdownMessage, ProjectWorkspace, RunActivity, type RoomArtifact, type RunEvent, type RunStep } from './CollaborationViews';
import './collaboration.css';
import { CreateGroupDialog } from './CreateGroupDialog';
import { runtimeApi } from '../api/runtime';

type Section = 'home' | 'projects' | 'knowledge' | 'agents' | 'memory' | 'compute' | 'chats' | 'settings';
type LoginIdentity = IdentityDto & { role?: 'personal' | 'admin' | 'member' };
type Modal = 'project' | 'chat' | 'knowledge' | 'knowledge-create' | 'register' | 'identity' | 'create-enterprise' | 'join-enterprise' | null;
type Project = { id: string; name: string; description: string; progress: number; members: number; color: string; open?: boolean; groupIds?: string[] };
type FileReference = { id: string; name: string; contentType?: string; sizeBytes: number };
type Chat = { id: string; name: string; project: string; projectId?: string; messages: { id?: string; author: string; text: string; time: string; senderType?: string; artifactIds?: string[]; files?: FileReference[] }[] };
type ChatMessage = { id: string; senderType: string; senderName?: string; text: string; createdAt: string; metadata?: { artifactId?: string; artifactIds?: string[]; files?: FileReference[] } };
type ChatRun = { id: string; status: string; phase?: string; result?: { waitingReason?: string } };
const mapChatMessages = (messages: ChatMessage[]): Chat['messages'] => messages.map(m => ({ id: m.id, author: m.senderType === 'agent' ? (m.senderName ?? '智能体') : '我', text: m.text, time: new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), senderType: m.senderType, files: m.metadata?.files, artifactIds: [...new Set([...(m.metadata?.artifactIds ?? []), ...(m.metadata?.artifactId ? [m.metadata.artifactId] : [])])] }));
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
  const [chatMode, setChatMode] = useState<'fast' | 'balanced' | 'expert'>('balanced');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newProject, setNewProject] = useState('');
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
  const [computeBalancePoints, setComputeBalancePoints] = useState<number | null>(null);
  /** 当前身份是否具备企业管理员能力；由算力模块按服务端权限标志上报，仅用于决定侧栏是否展示「成员管理」 */
  const [computeAdmin, setComputeAdmin] = useState(false);
  /** §12：身份切换后强制算力模块清空缓存并重新加载 */
  const [computeReloadKey, setComputeReloadKey] = useState(0);
  const [notice, setNotice] = useState('');
  const [details, setDetails] = useState<string | null>(null);
  const [authNewName, setAuthNewName] = useState('');
  const [authNewEmail, setAuthNewEmail] = useState('');
  const [authNewEmailCode, setAuthNewEmailCode] = useState('');
  const [authNewPassword, setAuthNewPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Record<string, FileItem[]>>({});
  const [attachmentsUploading, setAttachmentsUploading] = useState(false);
  useEffect(() => { setPendingAttachments({}); setAttachmentsUploading(false); }, [activeIdentityId]);
  useEffect(() => { setAttachmentsUploading(false); }, [activeChat]);
  const [pendingRuns, setPendingRuns] = useState<Record<string, string>>({});
  const [activeRun, setActiveRun] = useState<ChatRun | null>(null);
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [chatArtifacts, setChatArtifacts] = useState<RoomArtifact[]>([]);
  const [artifactPaneOpen, setArtifactPaneOpen] = useState(false);
  const [artifactPaneCollapsed, setArtifactPaneCollapsed] = useState(false);
  const [roomMembersOpen, setRoomMembersOpen] = useState(false);
  const [agentView, setAgentView] = useState<'manage' | 'skills' | 'tools'>('manage');
  const [settingsView, setSettingsView] = useState<'channels' | 'members' | 'profile' | 'appearance' | 'ops'>('channels');
  const [localProfile, setLocalProfile] = useState(() => ({ nickname: localStorage.getItem('kla.profile.nickname') ?? '', avatar: localStorage.getItem('kla.profile.avatar') ?? '' }));
  const [accountProfile, setAccountProfile] = useState<{nickname:string;email:string|null}|null>(null);
  const displayName = localProfile.nickname || accountProfile?.nickname || '用户';
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!userMenuOpen) return;
    const close = (event: MouseEvent) => { if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setUserMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [userMenuOpen]);
  useEffect(() => { const sync = () => setLocalProfile({ nickname: localStorage.getItem('kla.profile.nickname') ?? '', avatar: localStorage.getItem('kla.profile.avatar') ?? '' }); window.addEventListener('kla:profile-changed', sync); return () => window.removeEventListener('kla:profile-changed', sync); }, []);
  useEffect(() => {
    document.documentElement.dataset.klaTheme = localStorage.getItem('kla.appearance.theme') ?? 'light';
    document.documentElement.dataset.klaCompact = localStorage.getItem('kla.appearance.compact') ?? 'false';
    document.documentElement.dataset.klaReducedMotion = localStorage.getItem('kla.appearance.reducedMotion') ?? 'false';
  }, []);
  const sendingChats = useRef(new Set<string>());
  const createLock = useRef(false);
  const [creating, setCreating] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [navProgress, setNavProgress] = useState(false);
  const navTimer = useRef<number | null>(null);
  const chatSending = Boolean(pendingRuns[activeChat]);
  const pendingRunId = pendingRuns[activeChat];
  const [previewArtifact, setPreviewArtifact] = useState<RoomArtifact | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const currentProject = projects.find(p => p.id === activeProject) ?? projects[0] ?? { id: '', name: '暂无项目', description: '创建项目后显示项目工作台', progress: 0, members: 0, color: '#2779e9', groupIds: [] };
  const canManageMembers = identities.find(identity => identity.id === activeIdentityId)?.role === 'admin';
  const currentSubpage = section === 'agents' ? { manage: '智能体管理', skills: '技能', tools: '工具' }[agentView] : { channels: '渠道', members: '成员管理', profile: '个人', appearance: '外观', ops: '运维管理' }[settingsView];
  const currentChat = chats.find(c => c.id === activeChat) ?? chats[0] ?? { id: '', name: '暂无群组', project: '暂无项目', messages: [] };
  const filteredDocs = useMemo(() => docs.filter(d => (knowledgeScope === '全部知识' || d.group === knowledgeScope) && d.name.toLowerCase().includes(query.toLowerCase())), [docs, knowledgeScope, query]);
  const activeSources = useMemo(() => activeKnowledgeBase ? knowledgeSources.filter(s => s.knowledgeBaseId === activeKnowledgeBase.id && s.name.toLowerCase().includes(query.toLowerCase())) : [], [activeKnowledgeBase, knowledgeSources, query]);
  const activeChunks = useMemo(() => activeKnowledgeBase ? knowledgeChunks.filter(chunk => activeSources.some(source => source.id === chunk.sourceId)) : [], [activeKnowledgeBase, knowledgeChunks, activeSources]);
  const notify = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 3500); };
  useEffect(() => {
    const runtime = window.klaPlatform?.agentRuntime;
    if (!runtime) return;
    let generation = 0;
    const sync = () => {
      const current = ++generation;
      const session = signedIn ? klaApi.getRuntimeSession() : null;
      if (!session) { void runtime.disconnect(); return; }
      void runtime.connect(session).then(status => {
        if (current === generation && status.error) notify(`本地执行设备连接失败：${status.error}`);
      }).catch(error => { if (current === generation) notify(`本地执行设备连接失败：${String(error)}`); });
    };
    sync();
    window.addEventListener(sessionChangedEventName, sync);
    return () => { generation++; window.removeEventListener(sessionChangedEventName, sync); };
  }, [signedIn, activeIdentityId]);
  const apiError = (result: { message?: string; error?: { message?: string } }) => result.message ?? result.error?.message ?? '请求失败';
  const openArtifact = async (artifactId: string) => {
    const identityId = activeIdentityId;
    setArtifactPaneOpen(true);
    setArtifactPaneCollapsed(false);
    if (previewArtifact?.id === artifactId && previewArtifact.sourceKind === 'file') return;
    const cached = chatArtifacts.find(item => item.id === artifactId);
    if (cached) { setPreviewArtifact(cached); return; }
    setPreviewArtifact(null);
    setArtifactLoading(true);
    try {
      const result = await klaApi.request<RoomArtifact>(`/v1/artifacts/${artifactId}`, { headers: { 'x-identity-id': identityId } });
      if (klaApi.getIdentity() !== identityId) return;
      if (result.ok) setPreviewArtifact({ ...result.data, id: artifactId });
      else notify(apiError(result));
    } catch {
      if (klaApi.getIdentity() === identityId) notify('成果文件加载失败，请重试');
    } finally { setArtifactLoading(false); }
  };
  const navigate = (next: Section) => {
    if (navTimer.current !== null) window.clearTimeout(navTimer.current);
    setNavProgress(true);
    setSection(next);
    setQuery('');
    navTimer.current = window.setTimeout(() => { setNavProgress(false); navTimer.current = null; }, 300);
  };
  useEffect(() => () => { if (navTimer.current !== null) window.clearTimeout(navTimer.current); }, []);
  useEffect(() => {
    if (!signedIn) return;
    setNavProgress(true);
    if (navTimer.current !== null) window.clearTimeout(navTimer.current);
    navTimer.current = window.setTimeout(() => { setNavProgress(false); navTimer.current = null; }, 300);
  }, [signedIn, section, activeProject, activeChat, agentView, settingsView, computeView]);
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
    const expire = () => { klaApi.clearAccessToken(); setActiveIdentityId(''); setComputeReloadKey(key => key + 1); setSignedIn(false); setAuthChecking(false); notify('登录状态已失效，请重新登录'); };
    window.addEventListener(authExpiredEventName, expire);
    if (sessionStorage.getItem('kla.access-token')) {
      void klaApi.request<{ id: string; nickname:string; email:string|null }>('/v1/me').then(async result => {
        if (!result.ok) { expire(); return; }
        klaApi.setAccount(result.data.id);
        setAccountProfile({nickname:result.data.nickname,email:result.data.email});
        const identityResult = await klaApi.request<typeof identities>('/v1/me/identities');
        if (!identityResult.ok) { expire(); return; }
        const current = identityResult.data.find(item => item.id === klaApi.getIdentity())
          ?? identityResult.data.find(item => item.isDefault) ?? identityResult.data[0];
        klaApi.setIdentity(current?.id ?? null);
        setIdentities(identityResult.data);
        setActiveIdentityId(current?.id ?? '');
        setSignedIn(true); setAuthChecking(false);
      }).catch(() => { klaApi.clearAccessToken(); setActiveIdentityId(''); setSignedIn(false); setAuthChecking(false); notify('认证服务暂不可用，请重新登录'); });
    }
    return () => window.removeEventListener(authExpiredEventName, expire);
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    const headers = activeIdentityId ? { 'x-identity-id': activeIdentityId } : undefined;
    setWorkspaceLoading(true);
    setProjects([]); setChats([]); setActiveProject(''); setActiveChat(''); setPendingRuns({}); setPreviewArtifact(null); setChatArtifacts([]); setArtifactPaneOpen(false); setRunSteps([]); setRunEvents([]);
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
      const modelResult = await klaApi.request<Array<{ id: string; name: string; provider: string; base_url?: string; capabilities?: { thinking?: boolean; vision?: boolean; context?: number }; configured?: boolean }>>('/v1/models', { headers });
      if (cancelled) return;
      if (modelResult.ok && modelResult.data.length) setModels(modelResult.data.map((m, index) => ({ id: m.id, name: m.name, vendor: `${m.provider} / ${m.id}`, category: m.capabilities?.vision ? '视觉多模态' : m.capabilities?.thinking ? '深度思考' : '通用模型', context: m.capabilities?.context ? `${Math.round(m.capabilities.context / 1000)}K` : '128K', latency: '服务端探测', cost: m.configured ? '已配置' : '待配置密钥', icon: ['◈', '文', '✣', '◉'][index % 4] })));
    })().catch(() => { if (!cancelled) notify('工作区加载失败，请检查后端连接'); }).finally(() => { if (!cancelled) setWorkspaceLoading(false); });
    return () => { cancelled = true; };
  }, [signedIn, activeIdentityId]);
  useEffect(() => {
    if (!signedIn || !activeChat) { setChatLoading(false); return; }
    let cancelled = false;
    setChatLoading(true);
    setRunSteps([]); setRunEvents([]); setChatArtifacts([]); setPreviewArtifact(null); setArtifactPaneOpen(false); setActiveRun(null);
    void (async () => {
      const result = await klaApi.request<ChatMessage[]>(`/v1/conversations/${activeChat}/messages`);
      if (cancelled) return;
      if (!result.ok) { notify(apiError(result)); return; }
      setChats(items => items.map(chat => chat.id === activeChat ? { ...chat, messages: mapChatMessages(result.data) } : chat));
      const runs = await klaApi.request<ChatRun[]>(`/v1/conversations/${activeChat}/runs`);
      if (cancelled || !runs.ok) return;
      const running = runs.data.find(run => ['queued', 'running', 'waiting_device', 'waiting_tool', 'waiting_approval'].includes(run.status));
      const latest = running ?? runs.data[0] ?? null;
      setActiveRun(latest);
      setPendingRuns(items => {
        if (running) return { ...items, [activeChat]: running.id };
        if (!items[activeChat]) return items;
        const next = { ...items }; delete next[activeChat]; return next;
      });
      const [artifacts, steps, events] = await Promise.all([
        klaApi.request<RoomArtifact[]>(`/v1/conversations/${activeChat}/artifacts`),
        latest ? klaApi.request<RunStep[]>(`/v1/conversations/${activeChat}/runs/${latest.id}/steps`) : Promise.resolve(null),
        latest ? klaApi.request<RunEvent[]>(`/v1/runtime/events?conversationId=${encodeURIComponent(activeChat)}&after=0`) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      if (artifacts.ok) setChatArtifacts(artifacts.data);
      if (steps?.ok) setRunSteps(steps.data);
      if (events?.ok) setRunEvents(events.data.filter(event => event.run_id === latest?.id));
    })().catch(() => { if (!cancelled) notify('消息加载失败，请检查后端连接'); }).finally(() => { if (!cancelled) setChatLoading(false); });
    return () => { cancelled = true; };
  }, [signedIn, activeChat, activeIdentityId]);
  useEffect(() => {
    if (signedIn && activeIdentityId) void memoryApi.warm(activeIdentityId);
  }, [signedIn, activeIdentityId]);
  useEffect(() => {
    if (!signedIn || !activeIdentityId) { setComputeBalancePoints(null); return; }
    let cancelled = false;
    const refreshBalance = async () => {
      const result = await computeApi.balance();
      if (!cancelled) setComputeBalancePoints(result.ok ? result.data.available : null);
    };
    void refreshBalance();
    const timer = window.setInterval(() => void refreshBalance(), 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [signedIn, activeIdentityId, computeReloadKey]);
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
        const [result, steps, events] = await Promise.all([
          klaApi.request<ChatMessage[]>(`/v1/conversations/${activeChat}/messages`),
          klaApi.request<RunStep[]>(`/v1/conversations/${activeChat}/runs/${pendingRunId}/steps`),
          klaApi.request<RunEvent[]>(`/v1/runtime/events?conversationId=${encodeURIComponent(activeChat)}&after=0`),
        ]);
        if (cancelled) return;
        if (!result.ok) { notify(apiError(result)); clearPending(); return; }
        setChats(items => items.map(chat => chat.id === activeChat ? { ...chat, messages: mapChatMessages(result.data) } : chat));
        if (steps.ok) setRunSteps(steps.data);
        if (events.ok) setRunEvents(events.data.filter(event => event.run_id === pendingRunId));
        const run = runs.data.find(item => item.id === pendingRunId);
        setActiveRun(run ?? null);
        if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) {
          const artifacts = await klaApi.request<RoomArtifact[]>(`/v1/conversations/${activeChat}/artifacts`);
          if (!cancelled && artifacts.ok) setChatArtifacts(artifacts.data);
          clearPending();
          void memoryApi.invalidate(activeIdentityId).then(() => memoryApi.warm(activeIdentityId));
          return;
        }
        timer = window.setTimeout(() => { void poll(); }, 1000);
      } catch {
        if (!cancelled) { clearPending(); notify('无法获取执行状态，重新进入群组可继续查看'); }
      }
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [signedIn, activeChat, activeIdentityId, pendingRunId]);
  const login = async () => {
    const result = await klaApi.request<{ user: { id: string; nickname:string; email:string|null }; session: { accessToken: string; refreshToken: string; expiresAt: string; deviceId?: string | null }; identities?: typeof identities }>('/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ identifier: username.trim(), password }),
    });
    if (!result.ok) { notify(apiError(result)); return; }
    klaApi.setSession(result.data.session);
    klaApi.setAccount(result.data.user.id);
    setAccountProfile({nickname:result.data.user.nickname,email:result.data.user.email});
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
    const result = await klaApi.request<{ user: { id: string; nickname:string; email:string|null }; session: { accessToken: string; refreshToken: string; expiresAt: string; deviceId?: string | null }; identities?: typeof identities }>('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: authNewEmail.trim(), password: authNewPassword, nickname: authNewName.trim() }) });
    if (!result.ok) { notify(apiError(result)); return; }
    setAuthNewEmailCode('');
    klaApi.setAccount(result.data.user.id);
    setAccountProfile({nickname:result.data.user.nickname,email:result.data.user.email});
    klaApi.setSession(result.data.session); setIdentities(result.data.identities ?? []); const registerIdentity = result.data.identities?.find((item) => item.isDefault) ?? result.data.identities?.[0]; if (registerIdentity) { klaApi.setIdentity(registerIdentity.id); setActiveIdentityId(registerIdentity.id); } setSignedIn(true); setAuthChecking(false); setModal('identity');
  };
  const activateIdentity = async (identityId: string) => {
    // Send the target identity explicitly, then persist it before any identity-scoped request.
    const result = await klaApi.request<LoginIdentity>('/v1/me/identities/' + identityId + '/activate', { method: 'POST', body: '{}', headers: { 'x-identity-id': identityId } });
    if (!result.ok) { notify(apiError(result)); return; }
    klaApi.setIdentity(result.data.id);
    setActiveIdentityId(result.data.id);
    setComputeBalancePoints(null);
    setComputeAdmin(false);
    setComputeReloadKey(key => key + 1);
    setIdentities(items => items.map(item => ({ ...item, isDefault: item.id === result.data.id })));
    setModal(null);
    setUserMenuOpen(false);
    notify(`已进入${result.data.displayName}身份`);
  };
  const logout = async () => {
    setUserMenuOpen(false);
    try { await klaApi.request('/v1/auth/logout', { method: 'POST', body: '{}' }); }
    finally {
      klaApi.clearAccessToken();
      setSignedIn(false); setAuthChecking(false); setActiveIdentityId(''); setIdentities([]); setAccountProfile(null);
      setProjects([]); setChats([]); setModal(null); setSection('home');
    }
  };
  const createEnterprise = async () => { const result = await klaApi.request<LoginIdentity & { inviteCode?: string | null }>('/v1/organizations', { method: 'POST', body: JSON.stringify({ name: companyName.trim(), licenseNumber: licenseNumber.trim() }) }); if (!result.ok) { notify(apiError(result)); return; } setIdentities(items => [...items, result.data]); setCompanyName(''); setLicenseNumber(''); await activateIdentity(result.data.id); notify(result.data.inviteCode ? `企业创建成功，邀请码：${result.data.inviteCode}` : '企业创建成功，已进入企业身份'); };
  const joinEnterprise = async () => { const result = await klaApi.request<LoginIdentity>('/v1/organizations/join', { method: 'POST', body: JSON.stringify({ inviteCode: inviteCode.trim() }) }); if (!result.ok) { notify(apiError(result)); return; } setIdentities(items => [...items, result.data]); setInviteCode(''); await activateIdentity(result.data.id); notify('已加入企业，已进入企业身份'); };
  const send = async (conversationId = activeChat) => {
    const files = pendingAttachments[conversationId] ?? [];
    if ((!draft.trim() && !files.length) || attachmentsUploading || pendingRuns[conversationId] || sendingChats.current.has(conversationId) || chatLoading) return;
    if (!signedIn || !conversationId) { notify('请先创建或选择一个真实群组'); return; }
    const text = draft.trim();
    const identityId = activeIdentityId;
    sendingChats.current.add(conversationId);
    setPendingRuns(items => ({ ...items, [conversationId]: 'submitting' }));
    try {
      const submitted = await klaApi.request<{ message: ChatMessage; run: ChatRun | null }>(`/v1/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ text, mode: chatMode, fileIds: files.map(file => file.id) }), headers: { 'x-identity-id': identityId } });
      if (klaApi.getIdentity() !== identityId) return;
      if (!submitted.ok) { notify(apiError(submitted)); setPendingRuns(items => { const next = { ...items }; delete next[conversationId]; return next; }); return; }
      setChats(items => items.map(chat => chat.id === conversationId ? { ...chat, messages: [...chat.messages.filter(message => message.id !== submitted.data.message.id), ...mapChatMessages([submitted.data.message])] } : chat));
      setDraft(current => current.trim() === text ? '' : current);
      setPendingAttachments(items => ({ ...items, [conversationId]: (items[conversationId] ?? []).filter(file => !files.some(sent => sent.id === file.id)) }));
      if (submitted.data.run) {
        setPendingRuns(items => ({ ...items, [conversationId]: submitted.data.run!.id }));
        setActiveRun(submitted.data.run); setRunSteps([]); setRunEvents([]);
      } else {
        setPendingRuns(items => { const next = { ...items }; delete next[conversationId]; return next; });
        setActiveRun(null); setRunSteps([]); setRunEvents([]);
      }
    } catch {
      if (klaApi.getIdentity() === identityId) { notify('消息发送失败，请检查后端连接后重试'); setPendingRuns(items => { const next = { ...items }; delete next[conversationId]; return next; }); }
    } finally { sendingChats.current.delete(conversationId); }
  };
  const cancelActiveRun = async () => {
    if (!activeChat || !pendingRunId || pendingRunId === 'submitting') return;
    const result = await klaApi.request(`/v1/conversations/${activeChat}/runs/${pendingRunId}/cancel`, { method: 'POST' });
    if (!result.ok) notify(apiError(result));
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
  const createGroup = async (input: CreateConversationRequest) => {
    if (!signedIn) throw new Error('请先登录后创建群组');
    if (workspaceLoading) throw new Error('工作区正在加载，请稍后重试');
    const selectedProject = projects.find(project => project.id === input.projectId);
    if (!selectedProject) throw new Error('项目不存在，请刷新后重试');
    const identityId = activeIdentityId;
    const result = await runtimeApi.createGroup(input, identityId);
    if (klaApi.getIdentity() !== identityId) return;
    if (!result.ok) throw new Error(apiError(result));
    const chat: Chat = { id: result.data.id, name: result.data.name, project: selectedProject.name, projectId: selectedProject.id, messages: [] };
    setChats(items => [...items, chat]);
    setProjects(items => items.map(project => project.id === selectedProject.id ? { ...project, groupIds: [...(project.groupIds ?? []), chat.id], open: true } : project));
    setActiveChat(chat.id); setActiveProject(selectedProject.id); setModal(null); setNewName(''); setNewProject(''); setSection('chats'); notify('群组已创建并保存到数据库');
  };
  // 用量导出改由服务端生成（§7.4），前端不再本地拼接 CSV。

  const authModal = modal && ['register','identity','create-enterprise','join-enterprise'].includes(modal) && <div className="ws-modal-backdrop"><div className="ws-modal ws-auth-modal">
      <header><h2>{modal === 'register' ? '创建账号' : modal === 'identity' ? '切换其他身份' : modal === 'create-enterprise' ? '创建企业身份' : '加入企业'}</h2><IconButton title="关闭" onClick={() => setModal(null)}><X size={19} /></IconButton></header>
      {modal === 'register' && <div className="ws-register-flow"><div className="ws-register-intro"><span className="ws-register-kicker">ACCOUNT REGISTRATION</span><h3>注册鲲擎账号</h3><p>填写账号、密码并完成邮箱验证即可注册；登录后可切换要进入的企业身份。</p></div><form onSubmit={e => { e.preventDefault(); void register(); }}><label>账号<input required value={authNewName} onChange={e => setAuthNewName(e.target.value)} autoComplete="username" placeholder="设置登录账号，如 laok" /><small className="ws-auth-hint">账号与邮箱都可作为登录凭证</small></label><label>密码<input required type="password" minLength={8} value={authNewPassword} onChange={e => setAuthNewPassword(e.target.value)} autoComplete="new-password" placeholder="设置登录密码，至少 8 位" /><small className="ws-auth-hint">密码需至少 8 位，并包含数字、大写字母和小写字母</small></label><label>邮箱<input required type="email" value={authNewEmail} onChange={e => setAuthNewEmail(e.target.value)} autoComplete="email" placeholder="用于接收验证码与找回密码" /></label><label>验证码<div className="ws-auth-code-row"><input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={authNewEmailCode} onChange={e => setAuthNewEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="请输入 6 位验证码" /><button type="button" onClick={() => notify('演示环境验证码为 123456')}>获取验证码</button></div><small className="ws-auth-hint">验证码 5 分钟内有效，演示环境固定使用 123456</small></label><footer><button type="button" className="ws-auth-back" onClick={() => setModal(null)}>取消</button><button className="ws-primary">注册</button></footer></form></div>}
      {modal === 'identity' && <div className="ws-identity-flow"><div className="ws-register-intro"><span className="ws-register-kicker">IDENTITY WORKSPACE</span><h3>选择进入身份</h3><p>不同身份拥有独立的工作区、项目和数据权限，进入后可在右上角随时切换。</p></div><div className="ws-identity-list"><button className={`ws-identity-card ${identities.find(item => item.type === 'personal')?.id === activeIdentityId ? 'current' : ''}`} onClick={() => { const personal = identities.find(item => item.type === 'personal'); if (personal) void activateIdentity(personal.id); else { setModal(null); notify('个人身份不可用'); } }}><span className="ws-identity-icon personal"><UserCircle size={18} /></span><span><strong>个人身份</strong><small>{identities.find(item => item.type === 'personal')?.id === activeIdentityId ? '当前身份 · 个人工作区' : '个人工作区 · 默认权限'}</small></span><ArrowRight size={15} /></button>{identities.filter(item => item.type === 'enterprise').map(item => <button className={`ws-identity-card ${item.id === activeIdentityId ? 'current' : ''}`} key={item.id} onClick={() => void activateIdentity(item.id)}><span className="ws-identity-icon enterprise"><BriefcaseBusiness size={18} /></span><span><strong>{item.displayName}</strong><small>{item.role === 'admin' ? '企业管理员' : '企业员工'} {item.id === activeIdentityId ? ' · 当前身份' : ' · 独立权限'}</small></span><ArrowRight size={15} /></button>)}</div><div className="ws-identity-actions"><button onClick={() => setModal('create-enterprise')}><Plus size={15} /> 创建新的企业</button><button onClick={() => setModal('join-enterprise')}><Users size={15} /> 加入已有企业</button></div></div>}
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
    <div className={`ws-navigation-progress ${navProgress || workspaceLoading ? 'is-active' : ''}`} aria-hidden="true" />
    <aside className="ws-sidebar"><div><div className="ws-brand"><img src={logo} alt="鲲擎" /><span>鲲擎平台<small>AI INTELLIGENCE</small></span></div><nav>{nav.map(({ id, label, Icon }) => <button key={id} className={section === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={19} />{label}</button>)}</nav></div><div className="ws-sidebar-bottom"><button onClick={() => { navigate('compute'); setComputeView('dashboard'); }}><Sparkles size={15} /> 积分余额 <b>{formatPoints(computeBalancePoints)}</b><span className="ws-side-chevron">›</span></button><button onClick={() => navigate('settings')}><Settings size={17} /> 设置</button></div></aside>
    <main className={`ws-main ${(section === 'projects' || section === 'chats' || section === 'compute' || section === 'agents' || section === 'settings') ? 'has-subnav' : 'wide'}`}>
    {(section === 'projects' || section === 'chats' || section === 'compute' || section === 'agents' || section === 'settings') && <aside className="ws-subnav">
        {(section === 'projects' || section === 'chats') && <>
          <header className="ws-panel-heading">
            <span className="ws-panel-heading-icon"><Folder size={17} /></span>
            <span><strong>项目与群组</strong><small>{projects.length} 个项目 · {chats.length} 个群组</small></span>
          </header>
          <div className="ws-sub-list ws-project-tree">
            <div className="ws-tree-label"><span>项目</span><button title="新建项目" onClick={() => setModal('project')}><Plus size={12} />新建项目</button></div>
            {projects.map(p => <div key={p.id} className="ws-tree-project">
              <div className={`ws-tree-row ${section === 'projects' && p.id === activeProject ? 'active' : ''}`}>
                <button className={`ws-tree-toggle ${p.open ? 'is-open' : ''}`} title={p.open ? '收起群组' : '展开群组'} aria-label={`${p.open ? '收起' : '展开'}${p.name}的群组`} aria-expanded={!!p.open} onClick={() => setProjects(items => items.map(x => x.id === p.id ? { ...x, open: !x.open } : x))}><ChevronRight size={13} /></button>
                <button className="ws-tree-main" title={p.name} onClick={() => { setActiveProject(p.id); setSection('projects'); }}><span className="ws-tree-copy"><span className="ws-tree-name">{p.name}</span><small>{p.groupIds?.length ?? 0} 个关联群组</small></span></button>
                <button className="ws-tree-add" title="在此项目下新建群聊" aria-label={`在${p.name}下新建群聊`} onClick={() => { setNewProject(p.id); setNewName(''); setModal('chat'); }}><Plus size={13} /></button>
              </div>
              {p.open && <div className="ws-tree-children">{(p.groupIds ?? []).map(id => {
                const chat = chats.find(c => c.id === id);
                return chat ? <button key={chat.id} className={`ws-tree-child ${section === 'chats' && activeChat === chat.id ? 'active' : ''}`} title={chat.name} onClick={() => { setActiveChat(chat.id); setActiveProject(p.id); setSection('chats'); }}><span className="ws-tree-copy"><span className="ws-tree-name">{chat.name}</span><small>进行中 · {chat.messages.at(-1)?.time ?? '暂无消息'}</small></span></button> : null;
              })}</div>}
            </div>)}
            <div className="ws-tree-label ws-tree-orphans"><span>群组</span><button title="新建群组" onClick={() => { setNewProject(''); setNewName(''); setModal('chat'); }}><Plus size={12} />新建群组</button></div>
            {chats.filter(c => !projects.some(p => p.groupIds?.includes(c.id))).map(chat => <button key={chat.id} className={`ws-tree-orphan ${section === 'chats' && activeChat === chat.id ? 'active' : ''}`} title={chat.name} onClick={() => { setActiveChat(chat.id); setSection('chats'); }}><span className="ws-tree-spacer" aria-hidden="true" /><span className="ws-tree-copy"><span className="ws-tree-name">{chat.name}</span><small>进行中 · {chat.messages.at(-1)?.time ?? '暂无消息'}</small></span></button>)}
          </div>
        </>}
      {section === 'compute' && <><header className="ws-compute-title"><span className="ws-tiny-icon"><Activity size={18} /></span><span>算力与计费中心<small>Cluster Mesh v4.8</small></span></header><div className="ws-compute-links">{computeNav.filter(item => item.id !== 'members' || computeAdmin).map(({ id, label, Icon }) => <button key={id} className={computeView === id ? 'active' : ''} onClick={() => { setComputeView(id); setQuery(''); }}><Icon size={16} />{label}</button>)}</div><div className="ws-wallet"><small>账户可用积分余额 <b>{computeBalancePoints === null ? '待加载' : computeBalancePoints > 0 ? '可用' : '不足'}</b></small><strong>{formatPoints(computeBalancePoints)}</strong><button className="ws-primary" onClick={() => setComputeView('dashboard')}>查看余额与额度</button></div></>}
      {section === 'agents' && <><header className="ws-compute-title"><span className="ws-tiny-icon"><Bot size={18} /></span><span>智能体<small>Agent Control · 我的智能体与市场</small></span></header><div className="ws-settings-menu"><small>智能体</small><button className={agentView === 'manage' ? 'active' : ''} onClick={() => setAgentView('manage')}><Bot size={16} /> 智能体管理</button><button className={agentView === 'skills' ? 'active' : ''} onClick={() => setAgentView('skills')}><Sparkles size={16} /> 技能</button><button className={agentView === 'tools' ? 'active' : ''} onClick={() => setAgentView('tools')}><Wrench size={16} /> 工具</button></div></>}
      {section === 'settings' && <><header className="ws-compute-title"><span className="ws-tiny-icon"><Settings size={18} /></span><span>平台设置<small>v2.4.0</small></span></header><div className="ws-settings-menu"><small>AI 核心</small><button className={settingsView === 'channels' ? 'active' : ''} onClick={() => setSettingsView('channels')}><Route size={16} /> 渠道</button>{canManageMembers && <><small>企业治理</small><button className={settingsView === 'members' ? 'active' : ''} onClick={() => setSettingsView('members')}><Users size={16} /> 成员管理</button></>}<small>扩展设置</small><button className={settingsView === 'profile' ? 'active' : ''} onClick={() => setSettingsView('profile')}><UserCircle size={16} /> 个人</button><button className={settingsView === 'appearance' ? 'active' : ''} onClick={() => setSettingsView('appearance')}><Sparkles size={16} /> 外观</button><button className={settingsView === 'ops' ? 'active' : ''} onClick={() => setSettingsView('ops')}><ShieldCheck size={16} /> 运维管理</button></div></>}
    </aside>}
    <div className="ws-topbar"><div className="ws-breadcrumb"><span>协同工作台</span><b>/</b><strong>{section === 'home' ? '总览主页' : section === 'compute' ? `算力平台 / ${computeNav.find(n => n.id === computeView)?.label}` : section === 'settings' ? `平台设置 / ${currentSubpage}` : section === 'agents' ? `智能体 / ${currentSubpage}` : section === 'chats' ? '群聊 / 工作空间' : `${nav.find(n => n.id === section)?.label ?? '工作空间'} / 工作空间`}</strong></div><Badge tone="green">系统正常运行</Badge><div className="ws-top-actions"><button className="ws-top-search" onClick={() => notify('已提交搜索')}><Search size={14} /> 快速搜索智能体、任务…</button><IconButton title="通知" onClick={() => notify('暂无新通知')}><Bell size={16} /></IconButton><IconButton title="帮助" onClick={() => notify('帮助中心')}><CircleHelp size={16} /></IconButton>
      <div className="ws-user-menu-wrap" ref={userMenuRef}>
        <button className="ws-user ws-user-button" aria-haspopup="menu" aria-expanded={userMenuOpen} onClick={() => setUserMenuOpen(open => !open)}><span className="ws-user-avatar">{localProfile.avatar ? <img src={localProfile.avatar} alt="" /> : displayName.slice(0, 1)}</span><span>{displayName}<small>{identities.find(item => item.id === activeIdentityId)?.displayName ?? '个人身份'}</small></span></button>
        {userMenuOpen && <div className="ws-user-popover" role="menu">
          <div className="ws-user-popover-head"><span className="ws-user-avatar large">{localProfile.avatar ? <img src={localProfile.avatar} alt="" /> : displayName.slice(0, 1)}</span><span><strong>{displayName}</strong><small>{accountProfile?.email || username || '鲲擎账号'}</small></span></div>
          <div className="ws-user-popover-meta"><span>{identities.find(item => item.id === activeIdentityId)?.displayName ?? '个人空间'}</span><span>{canManageMembers ? '企业管理员' : identities.find(item => item.id === activeIdentityId)?.type === 'enterprise' ? '企业成员' : '个人用户'}</span></div>
          <button role="menuitem" onClick={() => { setUserMenuOpen(false); navigate('settings'); setSettingsView('profile'); }}><UserCircle size={16} /> 个人信息设置</button>
          <button role="menuitem" onClick={() => { setUserMenuOpen(false); navigate('memory'); }}><BrainIcon size={16} /> 我的记忆与背景</button>
          <button role="menuitem" onClick={() => { setUserMenuOpen(false); setModal('identity'); }}><RefreshCw size={16} /> 切换其他身份</button>
          <button role="menuitem" className="danger" onClick={() => void logout()}><LogOut size={16} /> 退出登录</button>
        </div>}
      </div></div></div>
      <div className={`ws-content ${navProgress ? 'ws-content-transition' : ''}`}>
        {section === 'agents' && (agentView === 'manage' ? <RuntimeAgentManagement identityId={activeIdentityId} notify={notify} /> : agentView === 'skills' ? <RuntimeSkillManagement identityId={activeIdentityId} notify={notify} /> : <RuntimeToolManagement identityId={activeIdentityId} notify={notify} />)}
        {section === 'settings' && <RuntimeSettingsView view={settingsView === 'members' && !canManageMembers ? 'channels' : settingsView} identityId={activeIdentityId} notify={notify} />}
        {section === 'home' && <div className="ws-home-prototype">
          <section className="ws-proto-welcome"><span className="ws-proto-avatar">K</span><div className="ws-proto-welcome-copy"><h1>早上好，老K · 开启高效多智能体协同的一天</h1><p>老K · 数字化员工 ｜ 已自动识别身份 · 员工目录 ｜ 科技BG · 数字化中心 · 数字化员工</p><div className="ws-proto-tags"><Badge tone="green">全域智能调度引擎运行中</Badge><Badge tone="green">算力响应正常 · 延迟 &lt; 85ms</Badge><Badge>4 大业务群组在线协同</Badge><Badge>已连接 4 个核心模型</Badge><Badge tone="muted">岗位语义智能自动匹配</Badge></div></div><div className="ws-proto-summary"><b>4<small>在线协同群组</small></b><b>6<small>可访问知识库</small></b><b>18<small>工作记忆条目</small></b></div><div className="ws-proto-actions"><button className="ws-primary" onClick={() => { navigate('compute'); setComputeView('market'); }}>查看模型矩阵与算力 <ArrowRight size={14} /></button><button onClick={() => navigate('knowledge')}>进入知识库</button></div></section>
          <div className="ws-proto-stats"><Stat icon={<Wallet />} label="积分余额" value={formatPoints(computeBalancePoints)} hint="当前身份可用额度，可在算力与计费中心查看明细" /><Stat icon={<Bot />} label="已安装应用" value="4 个" hint="可选 4 个 · 均由管理员统一授权" color="green" /><Stat icon={<BookOpen />} label="可访问知识" value="12 份" hint="按 BG 与权限过滤 · 可见范围随岗位权限变化" color="teal" /><Stat icon={<FileText />} label="工作记忆" value="18 条" hint="员工可查看、可删除 · 记忆随时由本人管理" color="orange" /></div>
  <div className="ws-proto-two"><Panel title="AI 工作入口 · 今天想完成什么？" action={<Badge tone="green">当前已连接 DeepSeek-V3 与百炼核心模型</Badge>}><div className="ws-proto-chatbar"><button onClick={() => notify('已打开智能体选择')}>@ 智能体</button><button onClick={() => notify('已打开技能库')}>/ 技能</button><button onClick={() => notify('已打开附件上传')}><Paperclip size={13} />附件</button></div><textarea className="ws-home-prompt" rows={3} placeholder="试试：帮我把上周的投资可行性评估整理成一页汇报…" value={draft} onChange={e => setDraft(e.target.value)} /><div className="ws-proto-chatfoot"><div className="ws-chip-row">{['总结本周工作', '查询集团制度', '生成项目汇报', '拆解今天的任务'].map(t => <button key={t} onClick={() => setDraft(t)}>{t}</button>)}</div><button className="ws-primary" onClick={() => { if (!chats[0]?.id) { notify('请先创建或选择一个真实群组'); return; } setActiveChat(chats[0].id); navigate('chats'); void send(chats[0].id); }}><Sparkles size={14} />发送</button></div><small className="ws-proto-note">已就绪：自动根据任务语义匹配最优模型并完成协同 <button onClick={() => { navigate('compute'); setComputeView('market'); }}>查看模型市场 →</button></small></Panel><Panel title="快捷功能入口" action={<Badge>6 大模块</Badge>}><div className="ws-proto-functions">{([['知识库','6 个知识库 · 28,452 个切片，支持检索与文件预览',BookOpen],['智能体','4 个已安装 · 可挂载模型与配置技能',Bot],['记忆','按群组隔离，可下钻到每个智能体的记忆',FileText],['算力与积分','积分余额、使用记录与模型广场',Activity],['项目与群组','2 个项目 · 4 个群组，项目内可直接建群组',Folder],['统一任务','待办 0 项 · 与群组任务实时同步',CheckCircle2],['成员管理','超管专属 · 成员、知识库权限、Token 与邀请码',Users],['平台设置','渠道 / 技能 / 工具 / 外观 / 运维管理',Settings]] as const).map(([name, desc, Icon]) => <button key={name} onClick={() => name === '知识库' ? navigate('knowledge') : name === '项目与群组' ? navigate('projects') : name === '算力与积分' ? navigate('compute') : name === '平台设置' ? navigate('settings') : notify(`${name}模块已聚焦`)}><span><Icon size={16} /></span><strong>{name}</strong><small>{desc}</small></button>)}</div></Panel></div>
          <div className="ws-proto-three"><Panel title="统一任务" action={<button className="ws-text-button" onClick={() => notify('新建任务')}>+ 新建任务</button>}><div className="ws-empty"><CheckCircle2 size={28} /><strong>今天没有待办</strong><small>点击上方“新建任务”即可安排工作，待办提醒会实时同步到工作台</small></div><div className="ws-proto-card-foot">待办提醒实时同步 <button onClick={() => notify('通知偏好')}>配置通知偏好</button></div></Panel><Panel title="协同应用状态" action={<Badge tone="green">运行正常</Badge>}><div className="ws-proto-list"><b>4 组就绪<small>4 大业务群组在线，可随时发起任务</small></b><b>跨群组通信 · 双向畅通<small>消息与文件均可互传，通信链路已验证</small></b><b>模型矩阵 · 4 个核心模型<small>支持按任务语义自动路由到最优模型</small></b></div></Panel><Panel title="OA 工作提醒 · OA 消息中心" action={<button className="ws-text-button" onClick={() => notify('打开 OA 消息中心')}>查看全部 →</button>}><div className="ws-empty"><Bell size={25} /><strong>尚未绑定个人 OA</strong><small>暂无未读消息 · 绑定本人 OA 账号后，消息与审批任务会自动双向同步到工作台</small></div><div className="ws-proto-card-foot"><Badge tone="orange">待绑定</Badge><button onClick={() => notify('绑定我的 OA')}>绑定我的 OA</button></div></Panel></div>
          <Panel title="快速协作模板推荐 · 多智能体群组" action={<button className="ws-text-button" onClick={() => navigate('chats')}>更多群组模板 →</button>}><div className="ws-proto-templates">{[['财务审计协同组 · 3 智能体','法务审合同 + 财务核票据 + 风险评级自动复核，输出审计结论与风险清单'],['市场调研小组 · 4 智能体','竞品爬取分析 + 舆情摘要 + 商业洞察报告编写，一次跑完调研到成稿'],['智能研发协作 · 2 智能体','架构设计评审 + API 自动化测试用例生成，评审意见与用例同步产出'],['创意营销工坊 · 3 智能体','新媒体文案裂变 + 分镜脚本 + 渠道分发策略，覆盖投放全链路']].map(([name, desc]) => <button key={name} onClick={() => { setModal('chat'); setNewName(name.split(' · ')[0]); }}><BriefcaseBusiness size={19} /><strong>{name}</strong><small>{desc}</small></button>)}</div></Panel>
        </div>}
        {section === 'projects' && (workspaceLoading ? <div className="ws-project-loading"><RefreshCw size={16} />正在加载项目…</div> : currentProject.id ? <ProjectWorkspace project={currentProject} rooms={chats} onOpenRoom={id => { setActiveChat(id); navigate('chats'); }} onCreateRoom={() => { setNewProject(currentProject.id); setNewName(''); setModal('chat'); }} onCreateProject={() => setModal('project')} notify={notify} /> : <div className="ws-project-empty-state"><Folder size={28} /><h2>还没有项目</h2><p>创建项目后，可在项目下建立群组并开始协作。</p><button className="ws-primary" onClick={() => setModal('project')}><Plus size={15} />创建项目</button></div>)}
        {section === 'memory' && <MemorySection key={activeIdentityId} identityId={activeIdentityId} />}
{section === 'chats' && <div className={`ws-chat-layout ${artifactPaneOpen ? 'has-artifacts' : ''}`}>
  <div className="ws-chat">
    <header><div><span className="ws-avatar">{currentChat.name.slice(0, 2)}</span><span><strong>{currentChat.name}</strong><small>{currentChat.project} · 智能体群聊 · 消息全量存档</small></span></div><div><IconButton title="管理群聊智能体" onClick={() => setRoomMembersOpen(true)}><Users size={17} /></IconButton><IconButton title="群组成果" onClick={() => { setArtifactPaneOpen(true); setArtifactPaneCollapsed(false); if (!previewArtifact && chatArtifacts[0]) setPreviewArtifact(chatArtifacts[0]); }}><Folder size={17} /></IconButton></div></header>
    <div className="ws-chat-messages"><p className="ws-chat-date">{chatLoading ? '正在加载消息…' : '消息记录'}</p>
      {currentChat.messages.map((m, i) => <div className={`ws-message ${m.author === '我' ? 'self' : ''}`} key={m.id ?? `${m.time}-${i}`}><span className="ws-avatar">{m.author.slice(0, 2)}</span><div><small>{m.author} · {m.time}</small><div className="ws-message-bubble"><MarkdownMessage text={m.text} />{m.files?.map(file => <button key={file.id} className="ws-text-button" onClick={() => { setArtifactPaneOpen(true); setArtifactPaneCollapsed(false); setPreviewArtifact({ id: file.id, name: file.name, mimeType: file.contentType ?? 'application/octet-stream', content: '', sizeBytes: file.sizeBytes, createdAt: '', sourceKind: 'file', storageKey: file.id }); }}><Paperclip size={14} /> {file.name}</button>)}{m.artifactIds?.map((id, index) => <button key={id} className="ws-text-button" onClick={() => void openArtifact(id)}><FileText size={14} /> {index === 0 ? '打开成果文件' : `打开成果文件 ${index + 1}`}</button>)}</div></div></div>)}
      <HomeAiReview key={`${activeIdentityId}:${activeChat}`} conversationId={activeChat} identityId={activeIdentityId} />
      <RunActivity run={activeRun} steps={runSteps} events={runEvents} submitting={pendingRunId === 'submitting'} onCancel={() => void cancelActiveRun()} />
    </div>
    <div className="ws-chat-compose"><ConversationAttachments key={`${activeIdentityId}:${activeChat}`} conversationId={activeChat} identityId={activeIdentityId} files={pendingAttachments[activeChat] ?? []} onChange={files => setPendingAttachments(items => ({ ...items, [activeChat]: files }))} onBusy={setAttachmentsUploading} onError={notify} /><textarea placeholder="发送消息给智能体小组…（输入 @ 召唤特定智能体，Enter 发送、Shift + Enter 换行）" aria-label="发送消息给智能体小组" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!chatSending) void send(); } }} /><div><span><Bot size={16} /> 智能体 <select aria-label="响应模式" value={chatMode} onChange={e => setChatMode(e.target.value as typeof chatMode)}><option value="fast">快速响应</option><option value="balanced">均衡协同</option><option value="expert">专家深度推理</option></select></span><button aria-label={chatSending ? '终止生成' : '发送给群组'} className={`ws-primary ${chatSending ? 'is-stop' : ''}`} disabled={attachmentsUploading || chatLoading || !currentChat.id || pendingRunId === 'submitting'} onClick={() => chatSending ? void cancelActiveRun() : void send()}><Send size={15} />{chatSending ? '终止生成' : '发送协同指令'}</button></div></div>
  </div>
  {artifactPaneOpen && <ArtifactPane artifacts={chatArtifacts} selected={previewArtifact} loading={artifactLoading} collapsed={artifactPaneCollapsed} onSelect={id => void openArtifact(id)} onCollapse={() => setArtifactPaneCollapsed(value => !value)} onClose={() => { setArtifactPaneOpen(false); setArtifactPaneCollapsed(false); setPreviewArtifact(null); }} onDownload={artifact => void klaApi.download(artifact.sourceKind === 'file' ? `/v1/files/${artifact.id}/content` : `/v1/artifacts/${artifact.id}/download`).then(result => { if (!result.ok) { notify(result.message); return; } const url = URL.createObjectURL(result.blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = artifact.name; anchor.click(); URL.revokeObjectURL(url); })} />}
</div>}
        {section === 'knowledge' && <KnowledgeSection key={computeReloadKey} />}
        {section === 'compute' && <>
          <ComputeSection view={computeView} onNotify={notify} onBalance={setComputeBalancePoints} onAdminCapability={setComputeAdmin} reloadKey={computeReloadKey} projects={projects.map(project => ({ id: project.id, name: project.name }))} />
        </>}
      </div>
    </main>
    {modal === 'chat' && <CreateGroupDialog key={activeIdentityId} identityId={activeIdentityId} projects={projects} initialProjectId={newProject || activeProject || projects[0]?.id || ''} fixedProject={!!newProject} onClose={() => { setModal(null); setNewProject(''); }} onCreate={createGroup} />}
    {modal && !['chat','register','identity','create-enterprise','join-enterprise'].includes(modal) && <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !creating) setModal(null); }}><div className="ws-modal"><header><h2>{modal === 'project' ? '创建项目' : modal === 'knowledge-create' ? '新建知识库' : '上传知识文件'}</h2><IconButton title="关闭" onClick={() => { if (!creating) setModal(null); }}><X size={19} /></IconButton></header>{modal === 'knowledge' ? <div className="ws-upload"><Upload size={28} /><p>拖拽文件到此处，或点击选择本地文件</p><small>支持 xlsx、ppt/pptx、word、pdf、mp4、mp3、png、jpg</small><input type="file" multiple accept=".xlsx,.xls,.ppt,.pptx,.doc,.docx,.pdf,.mp4,.mp3,.wav,.png,.jpg,.jpeg,.txt,.md,.html" onChange={e => addKnowledgeFiles(Array.from(e.target.files ?? []))} /></div> : modal === 'knowledge-create' ? <form onSubmit={e => { e.preventDefault(); create(); }}><label>知识库名称<input autoFocus required value={newName} onChange={e => setNewName(e.target.value)} placeholder="请输入知识库名称" /></label><label>说明（选填）<textarea value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="说明知识库的用途和内容范围" /></label><label>知识库层级<select value={knowledgeScopeChoice} onChange={e => setKnowledgeScopeChoice(e.target.value as KnowledgeScope)}><option value="personal">个人知识库</option><option value="project">项目知识库</option><option value="enterprise">企业知识库</option></select></label><p className="ws-detail-copy">企业知识库需企业管理员权限，项目知识库默认归当前项目创建者管理。</p><footer><button type="button" disabled={creating} onClick={() => setModal(null)}>取消</button><button className="ws-primary" type="submit">创建知识库</button></footer></form> : <form onSubmit={e => { e.preventDefault(); create(); }}><label>{modal === 'project' ? '项目名称' : '名称'}<input autoFocus required value={newName} onChange={e => setNewName(e.target.value)} placeholder="请输入名称" /></label>{modal === 'project' && <label>项目说明<textarea value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="简要描述职责与目标" /></label>}<footer><button type="button" disabled={creating} onClick={() => setModal(null)}>取消</button><button className="ws-primary" type="submit" disabled={creating || workspaceLoading}>{creating ? '创建中…' : '创建'}</button></footer></form>}</div></div>}
    {roomMembersOpen && activeChat && <RuntimeRoomMembers room={activeChat} identityId={activeIdentityId} notify={notify} onClose={() => setRoomMembersOpen(false)} />}
    {details && <div className="ws-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setDetails(null); }}><div className="ws-modal"><header><h2>{details}</h2><IconButton title="关闭" onClick={() => setDetails(null)}><X size={19} /></IconButton></header><p className="ws-detail-copy">当前为前端预览数据。文件正文或模型参数详情将在对应服务端接口接入后展示。</p><footer><button className="ws-primary" onClick={() => setDetails(null)}>关闭</button></footer></div></div>}
    {knowledgePreview && <div className="ws-modal-backdrop" style={{ justifyContent: 'flex-end', padding: 0, background: '#15375724' }} onMouseDown={e => { if (e.target === e.currentTarget) { if (knowledgePreview.url) URL.revokeObjectURL(knowledgePreview.url); setKnowledgePreview(null); } }}><div className="ws-modal ws-knowledge-preview"><header><h2>{knowledgePreview.title}</h2><IconButton title="关闭预览" onClick={() => { if (knowledgePreview.url) URL.revokeObjectURL(knowledgePreview.url); setKnowledgePreview(null); }}><X size={19} /></IconButton></header>{knowledgePreview.url ? <iframe title={knowledgePreview.title} src={knowledgePreview.url} /> : <article>{knowledgePreview.content}</article>}</div></div>}
    {authModal}
    {notice && <div className="ws-toast">{notice}</div>}
  </div>;
}
