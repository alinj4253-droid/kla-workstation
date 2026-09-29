import {
  Activity, ArrowLeft, ArrowRight, Bot, Check, CirclePause, CirclePlay, Ellipsis, ExternalLink, Link2,
  Loader2, Monitor, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, Puzzle,
  RefreshCw, Save, Square, Trash2, Video, X,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssociateProjectDialog } from '../components/AssociateProjectDialog';
import { NameAvatar } from '../components/NameAvatar';
import { associationKey, normalizeEnterpriseProjects, normalizeProjectAssociations, projectAssociationLabel, type EnterpriseProject, type EnterpriseProjectAssociations } from '../enterprise-projects';

type OperationWorkflow = {
  inputSchema?: { required?: string[] };
  steps?: Array<{ id: string; title: string; action: string; url?: string }>;
  plan?: { businessSteps?: Array<{ id?: string; title?: string; purpose?: string; domStepIndexes?: number[]; verification?: string }> };
};
type SkillActivationResult = { activated: true; workflow: OperationWorkflow };
type OperationSkill = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt?: string;
  status?: 'draft' | 'learning' | 'active' | 'failed' | 'abandoned' | 'revoked';
  ownerAgentId?: string;
  workflow?: OperationWorkflow | null;
  pendingWorkflow?: OperationWorkflow | null;
  pendingSummary?: string | null;
  learningError?: string | null;
  learningPhase?: 'processing' | 'awaiting-user' | 'ready' | 'failed';
  enabled?: boolean | number;
  recordingRelPath?: string | null;
  messages?: LearningMessage[];
};
type OperationSkillDraft = OperationSkill & { status: 'draft'; recordingSeconds: number };
type OperationHistoryItem = { id: string; title: string; detail: string; createdAt: string };
type OperationMessage = { id: string; role: 'user' | 'agent'; text: string; createdAt: string };
type PersistedOperationMessage = { id: string; role: 'user' | 'agent' | 'system'; content: string; createdAt: string };
type LearningMessage = { id: string; role: 'user' | 'agent' | 'system'; content: string; createdAt: string };
type OperationRunEvent = { id?: string; sequence?: number; type?: string; stepId?: string; detail?: { title?: string; error?: string; [key: string]: unknown }; createdAt?: string };
type OperationRun = { id: string; skillId: string; skillName?: string; status: string; errorMessage?: string; createdAt: string; updatedAt?: string; events?: OperationRunEvent[] };
type OperationPlatform = {
  id: string;
  name: string;
  url: string;
  description: string;
  agentName: string;
  modelProfileId: string;
  temperature: number;
  createdAt: string;
  updatedAt: string;
  skills: OperationSkill[];
  skillDrafts: OperationSkillDraft[];
  history: OperationHistoryItem[];
  conversation: OperationMessage[];
};
type OperationView = 'monitor' | 'create-skill' | 'skills' | 'agents';
type UnifiedModel = { id: string; name: string; modelId: string; type: string };
type RpcResult<T> = { ok?: boolean; data?: T; error?: { message?: string } };

function normalizePlatformUrl(raw: string): string | null {
  const candidate = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}

function createId(prefix: string): string { return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now().toString(36)}`; }
const backendAvailable = (): boolean => Boolean(window.kunqing?.operations);

function normalizePlatform(value: unknown): OperationPlatform | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<OperationPlatform>;
  if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.url !== 'string' || !normalizePlatformUrl(item.url)) return null;
  const now = new Date().toISOString();
  return {
    id: item.id, name: item.name, url: normalizePlatformUrl(item.url)!,
    description: typeof item.description === 'string' ? item.description : '',
    agentName: typeof item.agentName === 'string' ? item.agentName : `${item.name}助手`,
    modelProfileId: typeof item.modelProfileId === 'string' ? item.modelProfileId : '',
    temperature: typeof item.temperature === 'number' && Number.isFinite(item.temperature) ? item.temperature : 0.7,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
    skills: Array.isArray(item.skills) ? item.skills.filter((skill): skill is OperationSkill => !!skill && typeof skill === 'object' && typeof (skill as OperationSkill).name === 'string') : [],
    skillDrafts: Array.isArray(item.skillDrafts) ? item.skillDrafts.filter((draft): draft is OperationSkillDraft => !!draft && typeof draft === 'object' && typeof (draft as OperationSkillDraft).name === 'string').map((draft) => ({ ...draft, status: 'draft', recordingSeconds: Number(draft.recordingSeconds ?? 0) })) : [],
    history: Array.isArray(item.history) ? item.history : [],
    conversation: Array.isArray(item.conversation) ? item.conversation : [],
  };
}

async function syncPlatformBackend(platform: OperationPlatform): Promise<void> {
  const result = await window.kunqing?.operations?.syncPlatform({
    id: platform.id, name: platform.name, url: platform.url, description: platform.description,
    agentName: platform.agentName, modelProfileId: platform.modelProfileId, temperature: platform.temperature,
  });
  const payload = result as RpcResult<{ platformId?: string }> | undefined;
  if (payload?.ok === false) throw new Error(payload.error?.message || '操作平台同步失败');
  const workspace = await window.kunqing?.operations?.ensureWorkspace({ platformId: platform.id });
  const workspacePayload = workspace as RpcResult<unknown> | undefined;
  if (workspacePayload?.ok === false) throw new Error(workspacePayload.error?.message || '操作智能体工作区初始化失败');
}

async function readBackendSkills(platformId: string, includeRevoked = false): Promise<OperationSkill[]> {
  if (!backendAvailable()) return [];
  const result = await window.kunqing?.operations.listSkills({ platformId, includeRevoked }) as RpcResult<OperationSkill[]> | undefined;
  return result?.ok && Array.isArray(result.data) ? result.data : [];
}

export function OperationPlatformsPage(): React.JSX.Element {
  const [platforms, setPlatforms] = useState<OperationPlatform[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [view, setView] = useState<OperationView>('monitor');
  const [notice, setNotice] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(286);
  const [associateProjectOpen, setAssociateProjectOpen] = useState(false);
  const [enterpriseProjects, setEnterpriseProjects] = useState<EnterpriseProject[]>([]);
  const [projectAssociations, setProjectAssociations] = useState<EnterpriseProjectAssociations>({});
  const resizingRef = useRef(false);

  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const [settingsResult, modelsResult] = await Promise.all([
          window.kunqing?.settings.getAll() as Promise<RpcResult<Record<string, unknown>>> | undefined,
          window.kunqing?.models.listUnified() as Promise<RpcResult<UnifiedModel[]>> | undefined,
        ]);
        const stored = settingsResult?.data?.operationPlatforms;
        const items = Array.isArray(stored) ? stored.map(normalizePlatform).filter((item): item is OperationPlatform => !!item) : [];
        const loadedAssociations = normalizeProjectAssociations(settingsResult?.data?.enterpriseProjectAssociations);
        if (backendAvailable()) {
          await Promise.all(items.map(async (item) => {
            await syncPlatformBackend(item);
            const projectId = loadedAssociations[associationKey('operation', item.id)];
            if (projectId) await window.kunqing?.operations?.ensureWorkspace({ platformId: item.id, projectId });
          }));
          const skills = await Promise.all(items.map((item) => readBackendSkills(item.id)));
          items.forEach((item, index) => {
            item.skills = (skills[index] ?? []).filter((skill) => skill.status === 'active' && skill.enabled !== false && skill.enabled !== 0);
            item.skillDrafts = (skills[index] ?? []).filter((skill) => skill.status === 'draft').map((skill) => ({ ...skill, status: 'draft', recordingSeconds: 0 }));
          });
        }
        setPlatforms(items);
        setEnterpriseProjects(normalizeEnterpriseProjects(settingsResult?.data?.enterpriseProjects));
        setProjectAssociations(loadedAssociations);
        setSelectedId(items[0]?.id ?? '');
        setModels(modelsResult?.ok ? modelsResult.data ?? [] : []);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '操作平台加载失败');
      } finally { setLoading(false); }
    })();
    return () => { void window.kunqing?.operations?.hideView({}); };
  }, []);

  const selected = useMemo(() => platforms.find((platform) => platform.id === selectedId) ?? platforms[0] ?? null, [platforms, selectedId]);

  const persist = useCallback(async (next: OperationPlatform[]): Promise<boolean> => {
    const result = await window.kunqing?.settings.update({ operationPlatforms: next }) as RpcResult<unknown> | undefined;
    if (!result?.ok) { setNotice(result?.error?.message || '保存失败，请稍后重试'); return false; }
    if (backendAvailable()) {
      try { await Promise.all(next.map(syncPlatformBackend)); } catch (error) { setNotice(error instanceof Error ? error.message : '操作平台同步失败'); return false; }
    }
    setPlatforms(next); setNotice(''); return true;
  }, []);

  const updateSelected = async (changes: Partial<OperationPlatform>): Promise<boolean> => {
    if (!selected) return false;
    return persist(platforms.map((platform) => platform.id === selected.id ? { ...platform, ...changes, updatedAt: new Date().toISOString() } : platform));
  };

  const createPlatform = async (input: { name: string; url: string; description: string; agentName: string; modelProfileId: string }): Promise<boolean> => {
    const now = new Date().toISOString();
    const platform: OperationPlatform = {
      id: createId('platform'), name: input.name, url: input.url, description: input.description,
      agentName: input.agentName || `${input.name}助手`, modelProfileId: input.modelProfileId, temperature: 0.7,
      createdAt: now, updatedAt: now, skills: [], skillDrafts: [], history: [], conversation: [],
    };
    if (!await persist([...platforms, platform])) return false;
    setSelectedId(platform.id); setEditorOpen(false); setView('monitor'); return true;
  };

  const deletePlatform = async (): Promise<void> => {
    if (!selected) return;
    if (backendAvailable()) {
      const revoke = await window.kunqing?.operations.revokePlatform({ platformId: selected.id }) as RpcResult<unknown> | undefined;
      if (!revoke?.ok) { setNotice(revoke?.error?.message || '注销平台技能失败'); return; }
    }
    const next = platforms.filter((platform) => platform.id !== selected.id);
    if (await persist(next)) { setSelectedId(next[0]?.id ?? ''); setDeleteOpen(false); setView('monitor'); }
  };

  const startResize = (event: React.MouseEvent): void => {
    event.preventDefault(); resizingRef.current = true;
    const startX = event.clientX; const startWidth = sidebarWidth;
    const onMove = (move: MouseEvent): void => { if (resizingRef.current) setSidebarWidth(Math.max(220, Math.min(480, startWidth + move.clientX - startX))); };
    const onUp = (): void => { resizingRef.current = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  };

  const browserEnabled = !editorOpen && !renameOpen && !deleteOpen && !associateProjectOpen;

  return <div className={`operation-workspace${sidebarOpen ? '' : ' operation-workspace--sidebar-closed'}`} style={{ '--operation-sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
    {sidebarOpen && <aside className="operation-platform-sidebar" aria-label="操作平台列表">
      <header><button type="button" className="icon-button operation-sidebar-toggle" aria-label="收起操作平台栏" title="收起操作平台栏" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={18} /></button><h2>操作平台</h2><button type="button" className="icon-button" aria-label="创建操作平台" title="创建操作平台" onClick={() => setEditorOpen(true)}><Plus size={18} /></button></header>
      <div className="operation-platform-list">{loading ? <p className="operation-platform-list__empty">加载中...</p> : platforms.length === 0 ? <p className="operation-platform-list__empty">暂无操作平台</p> : platforms.map((platform) => { const association = projectAssociationLabel(enterpriseProjects, projectAssociations, 'operation', platform.id); return <button type="button" key={platform.id} className={`operation-platform-item${selected?.id === platform.id ? ' operation-platform-item--active' : ''}`} onClick={() => { setSelectedId(platform.id); setView('monitor'); setMoreOpen(false); }}><NameAvatar name={platform.name} /><span className="operation-platform-item__body"><span className="operation-platform-item__title">{platform.name}</span><small className={association.linked ? 'project-association project-association--linked' : 'project-association project-association--unlinked'}>{association.name}</small></span></button>; })}</div>
      <div className="operation-sidebar-resize-handle" onMouseDown={startResize} />
    </aside>}
    <section className="operation-platform-main">
      {!sidebarOpen && <button type="button" className="icon-button operation-sidebar-expand" aria-label="展开操作平台栏" title="展开操作平台栏" onClick={() => setSidebarOpen(true)}><PanelLeftOpen size={18} /></button>}
      {selected ? <>
        <header className="operation-platform-header"><div className="operation-platform-title"><span><Monitor size={19} /></span><div><h1>{selected.name}</h1><small>{selected.description || new URL(selected.url).hostname}</small></div></div><nav aria-label="操作平台工具"><button type="button" className={view === 'monitor' ? 'active' : ''} onClick={() => setView('monitor')}><Activity size={16} /><span>操作监控</span></button><button type="button" className={view === 'create-skill' ? 'active' : ''} onClick={() => setView('create-skill')}><Play size={16} /><span>创建技能</span></button><button type="button" className={view === 'skills' ? 'active' : ''} onClick={() => setView('skills')}><Puzzle size={16} /><span>技能管理</span></button><button type="button" className={view === 'agents' ? 'active' : ''} onClick={() => setView('agents')}><Bot size={16} /><span>智能体管理</span></button><div className="operation-platform-more"><button type="button" aria-label="更多操作" className={moreOpen ? 'active' : ''} onClick={() => setMoreOpen((open) => !open)}><Ellipsis size={18} /></button>{moreOpen && <div className="operation-platform-more__menu"><button type="button" onClick={() => { setMoreOpen(false); setAssociateProjectOpen(true); }}><Link2 size={15} />关联项目</button><button type="button" onClick={() => { setMoreOpen(false); setRenameOpen(true); }}><Pencil size={15} />重命名</button><button type="button" className="danger" onClick={() => { setMoreOpen(false); setDeleteOpen(true); }}><Trash2 size={15} />删除</button></div>}</div></nav></header>
        {view === 'monitor' && <MonitorView platform={selected} browserEnabled={browserEnabled} {...(projectAssociations[associationKey('operation', selected.id)] ? { projectId: projectAssociations[associationKey('operation', selected.id)] } : {})} />}
        {view === 'create-skill' && <CreateSkillView platform={selected} browserEnabled={browserEnabled} onActivated={async (skill) => { await updateSelected({ skills: [...selected.skills.filter((item) => item.id !== skill.id), skill] }); }} />}
        {view === 'skills' && <SkillManagementView platform={selected} />}
        {view === 'agents' && <AgentManagementView platform={selected} models={models} onSave={async (changes) => { await updateSelected(changes); }} />}
      </> : <div className="operation-platform-empty"><span><Monitor size={28} /></span><h1>创建操作平台</h1><p>添加平台名称、网址和描述后即可开始配置。</p><button type="button" className="primary-button" onClick={() => setEditorOpen(true)}><Plus size={16} />开始创建</button></div>}
      {notice && <div className="operation-platform-notice">{notice}</div>}
    </section>
    {editorOpen && <PlatformEditorDialog models={models} onClose={() => setEditorOpen(false)} onSubmit={createPlatform} />}
    {renameOpen && selected && <RenamePlatformDialog platform={selected} onClose={() => setRenameOpen(false)} onSubmit={async (name) => { const ok = await updateSelected({ name }); if (ok) setRenameOpen(false); return ok; }} />}
    {deleteOpen && selected && <DeletePlatformDialog platform={selected} onClose={() => setDeleteOpen(false)} onConfirm={() => void deletePlatform()} />}
    {associateProjectOpen && selected && <AssociateProjectDialog kind="operation" resourceId={selected.id} resourceName={selected.name} onClose={() => setAssociateProjectOpen(false)} onSaved={(available, associations) => { setEnterpriseProjects(available); setProjectAssociations(associations); }} />}
  </div>;
}

function WebsiteFrame({ platform, enabled = true, frameRef }: { platform: OperationPlatform; enabled?: boolean; frameRef?: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const localRef = useRef<HTMLDivElement>(null);
  const rootRef = frameRef ?? localRef;
  const [ready, setReady] = useState(!backendAvailable());
  const [reloadKey, setReloadKey] = useState(0);
  const [navigation, setNavigation] = useState({ canGoBack: false, canGoForward: false });
  useEffect(() => {
    if (!backendAvailable() || !enabled) {
      if (backendAvailable()) void window.kunqing?.operations.hideView({ platformId: platform.id });
      return;
    }
    let frame = 0;
    const show = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect || rect.width < 1 || rect.height < 1) return;
        void (async (): Promise<void> => {
          const result = await window.kunqing?.operations.showView({ platformId: platform.id, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }) as RpcResult<{ canGoBack?: boolean; canGoForward?: boolean }> | undefined;
          if (result?.ok && result.data) setNavigation({ canGoBack: result.data.canGoBack === true, canGoForward: result.data.canGoForward === true });
        })();
      });
    };
    void syncPlatformBackend(platform).then(show);
    const observer = new ResizeObserver(show);
    if (rootRef.current) observer.observe(rootRef.current);
    window.addEventListener('resize', show);
    const unsubscribe = window.kunqing?.events.subscribe((event) => {
      const payload = event as { type?: string; platformId?: string; canGoBack?: boolean; canGoForward?: boolean };
      if (payload.platformId !== platform.id) return;
      if (payload.type === 'operation.browser.ready') setReady(true);
      if (payload.type === 'operation.browser.ready' || payload.type === 'operation.browser.navigated') {
        setNavigation({ canGoBack: payload.canGoBack === true, canGoForward: payload.canGoForward === true });
      }
    });
    show();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', show); unsubscribe?.();
      void window.kunqing?.operations.hideView({ platformId: platform.id });
    };
  }, [enabled, platform.id, platform.url, reloadKey, rootRef]);
  const host = useMemo(() => { try { return new URL(platform.url).hostname; } catch { return platform.url; } }, [platform.url]);
  const reload = (): void => { setReady(false); setReloadKey((value) => value + 1); };
  const navigateHistory = async (direction: 'back' | 'forward'): Promise<void> => {
    if (!backendAvailable()) return;
    const operation = direction === 'back' ? window.kunqing?.operations.goBack : window.kunqing?.operations.goForward;
    const result = await operation?.({ platformId: platform.id }) as RpcResult<{ canGoBack?: boolean; canGoForward?: boolean }> | undefined;
    if (result?.ok && result.data) setNavigation({ canGoBack: result.data.canGoBack === true, canGoForward: result.data.canGoForward === true });
  };
  return <section className="operation-website-frame"><header className="operation-website-frame__toolbar"><div><span className="operation-browser-status"><i className={ready ? 'ready' : ''} />{ready ? '已连接' : '加载中'}</span><strong>{host}</strong></div><div><button type="button" className="icon-button" title="后退" aria-label="后退" disabled={!navigation.canGoBack} onClick={() => void navigateHistory('back')}><ArrowLeft size={15} /></button><button type="button" className="icon-button" title="前进" aria-label="前进" disabled={!navigation.canGoForward} onClick={() => void navigateHistory('forward')}><ArrowRight size={15} /></button><button type="button" className="icon-button" title="刷新嵌入页" aria-label="刷新嵌入页" onClick={reload}><RefreshCw size={15} /></button><button type="button" className="icon-button" title="在系统浏览器打开" aria-label="在系统浏览器打开" onClick={() => void window.kunqing?.app.openExternal({ url: platform.url })}><ExternalLink size={15} /></button></div></header><div className="operation-website-frame__inner" ref={rootRef}>
    {!ready && <div className="operation-platform-frame__loading"><span className="spin" /><p>正在加载 {platform.name}</p></div>}
    {!backendAvailable() && <iframe key={`${platform.id}:${platform.url}:${reloadKey}`} src={platform.url} title={`${platform.name} 操作平台`} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerPolicy="strict-origin-when-cross-origin" onLoad={() => setReady(true)} />}
  </div></section>;
}

function AgentPanel({ platform, history = [], messages: controlledMessages, learning = false, learningComplete = false, busy = false, onAbort, onActivate, onSend }: { platform: OperationPlatform; history?: OperationHistoryItem[]; messages?: OperationMessage[]; learning?: boolean; learningComplete?: boolean; busy?: boolean; onAbort?: () => void; onActivate?: () => void; onSend?: (text: string) => Promise<void> }): React.JSX.Element {
  const [tab, setTab] = useState<'history' | 'conversation'>('conversation');
  const [message, setMessage] = useState('');
  const [localMessages, setLocalMessages] = useState<OperationMessage[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const base = platform.conversation.length ? platform.conversation : [{ id: 'welcome', role: 'agent' as const, text: learning ? '我会结合 DOM 轨迹和操作说明学习这个技能；如果存在关键疑问，会在这里向你确认。' : '我会使用这个平台已生效的操作技能完成任务。', createdAt: platform.createdAt }];
  const messages = controlledMessages ?? [...base, ...localMessages];
  useEffect(() => {
    setTab('conversation');
    setMessage('');
    setLocalMessages([]);
  }, [platform.id, learning]);
  useEffect(() => {
    if (tab !== 'conversation') return;
    requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (body) body.scrollTop = body.scrollHeight;
    });
  }, [tab, messages.length, busy]);
  useEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = 'auto';
    const maxHeight = 66;
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [message]);
  const submitMessage = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); const text = message.trim(); if (!text || busy || learningComplete) return;
    setMessage('');
    if (onSend) { await onSend(text); return; }
    const createdAt = new Date().toISOString();
    setLocalMessages((items) => [...items, { id: createId('message'), role: 'user', text, createdAt }]);
    if (backendAvailable()) {
      const result = await window.kunqing?.operations.runInstruction({ platformId: platform.id, instruction: text }) as RpcResult<{ runId?: string; message: string }> | undefined;
      setLocalMessages((items) => [...items, { id: createId('message'), role: 'agent', text: result?.data?.message || result?.error?.message || '操作请求未能启动。', createdAt: new Date().toISOString() }]);
    } else {
      setLocalMessages((items) => [...items, { id: createId('message'), role: 'agent', text: '收到，我会使用已生效的操作技能处理。', createdAt: new Date().toISOString() }]);
    }
  };
  const header = learning
    ? <header className="operation-agent-panel__heading"><Bot size={15} /><strong>技能学习对话</strong><button type="button" className="operation-abort-learning" onClick={onAbort}>放弃技能</button></header>
    : <div className="operation-agent-panel__tabs"><button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>历史</button><button type="button" className={tab === 'conversation' ? 'active' : ''} onClick={() => setTab('conversation')}>对话</button></div>;
  return <aside className={`operation-agent-panel${learning ? ' operation-agent-panel--conversation-only' : ''}`}>{header}<div className="operation-agent-panel__body" ref={bodyRef}>
    {tab === 'history' && !learning ? (history.length ? history.map((item) => <div className="operation-history-item" key={item.id}><strong>{item.title}</strong><span>{item.detail}</span><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small></div>) : <p className="operation-panel-empty">还没有操作留痕</p>) : messages.map((item) => <div className={`operation-agent-message operation-agent-message--${item.role}`} key={item.id}><span className="operation-agent-message__avatar">{item.role === 'agent' ? <Bot size={14} /> : '我'}</span><p>{item.text}</p></div>)}
  </div>{(tab === 'conversation' || learning) && (learningComplete ? <div className="operation-agent-composer operation-agent-composer--activate"><button type="button" className="primary-button" onClick={onActivate}>生效技能</button></div> : <><div className={`operation-agent-thinking${busy ? ' operation-agent-thinking--active' : ''}`} aria-live="polite">{busy && <><Loader2 size={13} className="spin" />{learning ? '正在结合录制轨迹学习技能' : '正在理解页面并执行操作'}</>}</div><form className="operation-agent-composer" onSubmit={(event) => void submitMessage(event)}><textarea ref={composerRef} rows={1} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="输入对操作智能体的说明" disabled={busy} /><button type="submit" className="primary-button" disabled={busy || !message.trim()}>发送</button></form></>)}</aside>;
}

function runToHistory(run: OperationRun): OperationHistoryItem {
  const latest = [...(run.events ?? [])].reverse().find((event) => event.type?.startsWith('step.') || event.type?.startsWith('run.'));
  const title = `${run.skillName || '操作技能'} · ${run.status === 'completed' ? '已完成' : run.status === 'failed' ? '失败' : run.status === 'cancelled' ? '已取消' : '执行中'}`;
  const detail = run.errorMessage || latest?.detail?.title || latest?.detail?.error || '等待执行状态更新';
  return { id: run.id, title, detail: String(detail), createdAt: run.createdAt };
}

function MonitorView({ platform, browserEnabled, projectId }: { platform: OperationPlatform; browserEnabled: boolean; projectId?: string }): React.JSX.Element {
  const [skills, setSkills] = useState<OperationSkill[]>(platform.skills);
  const [runs, setRuns] = useState<OperationRun[]>([]);
  const [messages, setMessages] = useState<OperationMessage[]>([]);
  const [deciding, setDeciding] = useState(false);
  const refresh = useCallback(async (): Promise<void> => {
    if (!backendAvailable()) return;
    const [nextSkills, runResult, conversationResult] = await Promise.all([
      readBackendSkills(platform.id),
      window.kunqing?.operations.listRuns({ platformId: platform.id, limit: 50 }) as Promise<RpcResult<OperationRun[]>>,
      window.kunqing?.operations.listConversation({ platformId: platform.id, limit: 120 }) as Promise<RpcResult<PersistedOperationMessage[]>>,
    ]);
    setSkills(nextSkills.filter((skill) => skill.status === 'active' && skill.enabled !== false && skill.enabled !== 0));
    if (runResult?.ok) setRuns(runResult.data ?? []);
    if (conversationResult?.ok) {
      setMessages((conversationResult.data ?? []).filter((item) => item.role !== 'system').map((item) => ({
        id: item.id, role: item.role === 'user' ? 'user' : 'agent', text: item.content, createdAt: item.createdAt,
      })));
    }
  }, [platform.id]);
  useEffect(() => {
    setMessages([]); setRuns([]); setSkills(platform.skills);
    void refresh();
    const unsubscribe = window.kunqing?.events.subscribe((event) => {
      const payload = event as { type?: string; platformId?: string };
      if (payload.platformId === platform.id && (payload.type === 'operation.run' || payload.type === 'operation.skill' || payload.type === 'operation.conversation')) void refresh();
    });
    return unsubscribe;
  }, [platform.id, platform.skills, refresh]);
  const sendInstruction = async (text: string): Promise<void> => {
    const optimisticId = createId('pending-message');
    setMessages((items) => [...items, { id: optimisticId, role: 'user', text, createdAt: new Date().toISOString() }]);
    setDeciding(true);
    try {
      const result = await window.kunqing?.operations.runInstruction({ platformId: platform.id, instruction: text, ...(projectId ? { projectId } : {}) }) as RpcResult<{ runId?: string; message: string; intent: 'execute' | 'clarify' | 'answer' }> | undefined;
      if (!result?.ok) setMessages((items) => [...items.filter((item) => item.id !== optimisticId), { id: createId('message-error'), role: 'agent', text: result?.error?.message || '操作智能体暂时无法处理这条消息。', createdAt: new Date().toISOString() }]);
      await refresh();
    } finally { setDeciding(false); }
  };
  const active = runs.some((run) => ['queued', 'running', 'cancelling'].includes(run.status));
  return <div className="operation-content-view operation-monitor-view"><div className="operation-main-column"><WebsiteFrame platform={platform} enabled={browserEnabled} /><div className="operation-skill-strip">{skills.length ? skills.map((skill) => <div className="operation-skill-card" key={skill.id}><Puzzle size={14} /><span>{skill.name}</span></div>) : <p>暂无已生效技能，点击“创建技能”开始录制。</p>}</div></div><AgentPanel platform={platform} history={runs.map(runToHistory)} {...(messages.length ? { messages } : {})} busy={active || deciding} onSend={sendInstruction} /></div>;
}

function SkillSetupPanel({ name, description, videoSaved, duration, disabled, onNameChange, onDescriptionChange, onCreate }: { name: string; description: string; videoSaved: boolean; duration: string; disabled: boolean; onNameChange: (value: string) => void; onDescriptionChange: (value: string) => void; onCreate: () => void }): React.JSX.Element {
  return <section className="operation-skill-form-panel"><header className="operation-skill-form-panel__header"><Bot size={15} /><strong>技能信息</strong></header><label className="operation-record-name"><span>技能名称 <em>*</em></span><input disabled={disabled} value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="请输入技能名称" /></label><section className={`operation-saved-video${videoSaved ? ' operation-saved-video--ready' : ''}`}><header><span>操作视频 <em>*</em></span>{videoSaved && <small>已保存</small>}</header>{videoSaved ? <div><Video size={24} /><strong>{name.trim() || '录制操作视频'}</strong><span>{duration}</span></div> : <p><Video size={22} />暂无保存视频</p>}</section><label className="operation-record-description"><span>技能说明 <em>*</em></span><textarea disabled={disabled} value={description} onChange={(event) => onDescriptionChange(event.target.value)} placeholder="说明这段操作要完成什么、触发条件和预期结果。" /></label><button type="button" className="primary-button operation-create-skill-submit" disabled={!name.trim() || !description.trim() || !videoSaved || disabled} onClick={onCreate}><Plus size={16} />创建技能</button></section>;
}

function CreateSkillView({ platform, browserEnabled, onActivated }: { platform: OperationPlatform; browserEnabled: boolean; onActivated: (skill: OperationSkill) => Promise<void> }): React.JSX.Element {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [videoSaved, setVideoSaved] = useState(false);
  const [recordingId, setRecordingId] = useState('');
  const [skillId, setSkillId] = useState('');
  const [learningStatus, setLearningStatus] = useState<'idle' | 'learning' | 'awaiting-user' | 'ready' | 'failed'>('idle');
  const [learningMessages, setLearningMessages] = useState<OperationMessage[]>([]);
  const [notice, setNotice] = useState('');
  const frameRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const captureTracksRef = useRef<MediaStreamTrack[]>([]);
  const videoChunksRef = useRef<Blob[]>([]);
  const videoBlobRef = useRef<Blob | null>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    if (!recording || paused) return;
    timerRef.current = window.setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => { if (timerRef.current) window.clearInterval(timerRef.current); };
  }, [recording, paused]);

  const stopCaptureTracks = useCallback((): void => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    for (const track of captureTracksRef.current) track.stop();
    captureTracksRef.current = [];
  }, []);

  useEffect(() => () => stopCaptureTracks(), [stopCaptureTracks]);

  const refreshLearning = useCallback(async (): Promise<void> => {
    if (!skillId || !backendAvailable()) return;
    const result = await window.kunqing?.operations.getLearningStatus({ skillId }) as RpcResult<OperationSkill> | undefined;
    if (!result?.ok || !result.data) return;
    const skill = result.data;
    const status = skill.status === 'draft' || skill.learningPhase === 'ready'
      ? 'ready'
      : skill.status === 'failed' || skill.learningPhase === 'failed'
        ? 'failed'
        : skill.learningPhase === 'awaiting-user' ? 'awaiting-user' : 'learning';
    setLearningStatus(status);
    setLearningMessages((skill.messages ?? []).filter((item) => item.role !== 'system').map((item) => ({ id: item.id, role: item.role === 'user' ? 'user' : 'agent', text: item.content, createdAt: item.createdAt })));
    if (skill.learningError) setNotice(skill.learningError);
  }, [skillId]);

  useEffect(() => {
    if (!skillId || !backendAvailable()) return;
    void refreshLearning();
    const unsubscribe = window.kunqing?.events.subscribe((event) => {
      const payload = event as { type?: string; skillId?: string; status?: string };
      if (payload.type === 'operation.learning' && payload.skillId === skillId) {
        if (payload.status === 'awaiting-user') setLearningStatus('awaiting-user');
        void refreshLearning();
      }
    });
    const interval = window.setInterval(() => void refreshLearning(), 1_500);
    return () => { unsubscribe?.(); window.clearInterval(interval); };
  }, [refreshLearning, skillId]);

  const startVideoCapture = async (): Promise<void> => {
    if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') return;
    try {
      const source = await window.kunqing?.operations?.getCaptureSourceId() as RpcResult<{ sourceId: string }> | undefined;
      if (!source?.data?.sourceId) return;
      const sourceStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.data.sourceId, maxFrameRate: 20 } } as unknown as MediaTrackConstraints,
      });
      const video = document.createElement('video');
      video.srcObject = sourceStream; video.muted = true; await video.play();
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect) { sourceStream.getTracks().forEach((track) => track.stop()); return; }
      const canvas = document.createElement('canvas');
      const scaleX = video.videoWidth / window.innerWidth; const scaleY = video.videoHeight / window.innerHeight;
      canvas.width = Math.max(320, Math.round(rect.width * scaleX)); canvas.height = Math.max(180, Math.round(rect.height * scaleY));
      const context = canvas.getContext('2d');
      const draw = (): void => {
        context?.drawImage(video, rect.x * scaleX, rect.y * scaleY, rect.width * scaleX, rect.height * scaleY, 0, 0, canvas.width, canvas.height);
        animationRef.current = requestAnimationFrame(draw);
      };
      draw();
      const output = canvas.captureStream(15);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const recorder = new MediaRecorder(output, { mimeType });
      videoChunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) videoChunksRef.current.push(event.data); };
      recorder.onstop = () => { videoBlobRef.current = new Blob(videoChunksRef.current, { type: 'video/webm' }); stopCaptureTracks(); };
      captureTracksRef.current = [...sourceStream.getTracks(), ...output.getTracks()];
      mediaRecorderRef.current = recorder; recorder.start(1_000);
    } catch { setNotice('视频采集不可用，DOM 操作轨迹仍会正常保存。'); }
  };

  const startRecording = async (): Promise<void> => {
    if (learningStatus !== 'idle') return;
    setNotice(''); setSeconds(0); setVideoSaved(false); videoBlobRef.current = null;
    if (backendAvailable()) {
      const result = await window.kunqing?.operations.beginRecording({ platformId: platform.id }) as RpcResult<{ recordingId: string }> | undefined;
      if (!result?.ok || !result.data?.recordingId) { setNotice(result?.error?.message || '无法开始录制'); return; }
      setRecordingId(result.data.recordingId);
      await startVideoCapture();
    } else setRecordingId(createId('recording'));
    setRecording(true); setPaused(false);
  };

  const togglePause = async (): Promise<void> => {
    if (!recording) return;
    const next = !paused;
    if (backendAvailable()) await window.kunqing?.operations.pauseRecording({ recordingId, paused: next });
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'recording' && next) recorder.pause();
    else if (recorder?.state === 'paused' && !next) recorder.resume();
    setPaused(next);
  };

  const stopRecording = async (): Promise<void> => {
    if (!recording) return;
    if (backendAvailable()) await window.kunqing?.operations.stopRecording({ recordingId });
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => { const previous = recorder.onstop; recorder.onstop = (event) => { previous?.call(recorder, event); resolve(); }; recorder.stop(); });
    } else stopCaptureTracks();
    setRecording(false); setPaused(false);
  };

  const saveRecording = async (): Promise<void> => {
    if (!recordingId || recording || seconds === 0) return;
    if (backendAvailable()) {
      const bytes = videoBlobRef.current ? new Uint8Array(await videoBlobRef.current.arrayBuffer()) : undefined;
      const result = await window.kunqing?.operations.saveRecordingVideo({ recordingId, ...(bytes ? { bytes } : {}) }) as RpcResult<unknown> | undefined;
      if (!result?.ok) { setNotice(result?.error?.message || '保存录制失败'); return; }
    }
    setVideoSaved(true);
  };

  const beginLearning = async (): Promise<void> => {
    if (!name.trim() || !description.trim() || !videoSaved || learningStatus !== 'idle') return;
    if (!backendAvailable()) { setLearningStatus('ready'); return; }
    const result = await window.kunqing?.operations.learnSkill({ platformId: platform.id, recordingId, name: name.trim(), description: description.trim() }) as RpcResult<{ skillId: string }> | undefined;
    if (!result?.ok || !result.data?.skillId) { setNotice(result?.error?.message || '技能学习启动失败'); return; }
    setSkillId(result.data.skillId); setLearningStatus('learning');
  };

  const resetDraft = (): void => {
    setLearningStatus('idle'); setSkillId(''); setRecording(false); setPaused(false); setSeconds(0); setName(''); setDescription(''); setVideoSaved(false); setRecordingId(''); setLearningMessages([]); setNotice('');
    videoBlobRef.current = null; stopCaptureTracks();
  };

  const abortLearning = async (): Promise<void> => {
    if (skillId && backendAvailable()) await window.kunqing?.operations.abandonSkill({ skillId });
    resetDraft();
  };

  const activateSkill = async (): Promise<void> => {
    if (learningStatus !== 'ready') return;
    if (backendAvailable()) {
      const result = await window.kunqing?.operations.activateSkill({ skillId }) as RpcResult<unknown> | undefined;
      if (!result?.ok) { setNotice(result?.error?.message || '技能生效失败'); return; }
    }
    await onActivated({ id: skillId || createId('skill'), name: name.trim(), description: description.trim(), createdAt: new Date().toISOString(), status: 'active' });
    resetDraft();
  };

  const replyLearning = async (text: string): Promise<void> => {
    if (!skillId || !backendAvailable()) return;
    await window.kunqing?.operations.replyLearning({ skillId, content: text });
    setLearningStatus('learning'); await refreshLearning();
  };

  const duration = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const learning = learningStatus !== 'idle';
  return <div className="operation-content-view operation-create-skill-view"><div className="operation-main-column operation-skill-recording-main"><WebsiteFrame platform={platform} enabled={browserEnabled} frameRef={frameRef} /><div className="operation-record-controls"><button type="button" className={recording && !paused ? 'active' : ''} disabled={learning || recording} onClick={() => void startRecording()}><CirclePlay size={18} />录制</button><button type="button" disabled={!recording || learning} onClick={() => void togglePause()}>{paused ? <CirclePlay size={18} /> : <CirclePause size={18} />}{paused ? '继续' : '暂停'}</button><button type="button" disabled={!recording || learning} onClick={() => void stopRecording()}><Square size={16} />停止</button><button type="button" disabled={recording || seconds === 0 || learning} onClick={() => void saveRecording()}><Save size={16} />保存</button><span className="operation-record-timer">{duration}</span></div>{notice && <small className="operation-record-notice">{notice}</small>}</div><div className="operation-skill-right-column">{learning ? <AgentPanel platform={platform} learning learningComplete={learningStatus === 'ready'} busy={learningStatus === 'learning'} {...(learningMessages.length ? { messages: learningMessages } : {})} onAbort={() => void abortLearning()} onActivate={() => void activateSkill()} onSend={replyLearning} /> : <SkillSetupPanel name={name} description={description} videoSaved={videoSaved} duration={duration} disabled={false} onNameChange={setName} onDescriptionChange={setDescription} onCreate={() => void beginLearning()} />}</div></div>;
}

function SkillManagementView({ platform }: { platform: OperationPlatform }): React.JSX.Element {
  const [skills, setSkills] = useState<OperationSkill[]>([...platform.skills, ...platform.skillDrafts]);
  const [deleteError, setDeleteError] = useState('');
  const refresh = useCallback(async (): Promise<void> => { if (backendAvailable()) setSkills(await readBackendSkills(platform.id, true)); }, [platform.id]);
  useEffect(() => { void refresh(); const unsubscribe = window.kunqing?.events.subscribe((event) => { const payload = event as { type?: string; platformId?: string }; if (payload.platformId === platform.id && payload.type === 'operation.skill') void refresh(); }); return unsubscribe; }, [platform.id, refresh]);
  const active = skills.filter((skill) => skill.status === 'active');
  const drafts = skills.filter((skill) => ['draft', 'learning', 'failed'].includes(skill.status ?? ''));
  const revoked = skills.filter((skill) => skill.status === 'revoked');
  const activate = async (skill: OperationSkill): Promise<void> => {
    if (!backendAvailable()) return;
    const result = await window.kunqing?.operations.activateSkill({ skillId: skill.id }) as RpcResult<SkillActivationResult> | undefined;
    if (!result?.ok) { return; }
    await refresh();
  };
  const [detail, setDetail] = useState<OperationSkill | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OperationSkill | null>(null);
  const toggle = async (skill: OperationSkill, enabled: boolean): Promise<void> => {
    if (!backendAvailable()) return;
    const result = await window.kunqing?.operations.setSkillEnabled({ skillId: skill.id, enabled }) as RpcResult<unknown> | undefined;
    if (result?.ok) await refresh();
  };
  const cards = (items: OperationSkill[], draft = false): React.JSX.Element => <div className="operation-skill-grid">{items.map((skill) => {
    const enabled = skill.enabled !== false && skill.enabled !== 0;
    return <article className={`operation-skill-management-card${draft ? ' operation-skill-management-card--draft' : ''}${!enabled ? ' operation-skill-management-card--disabled' : ''}`} key={skill.id} onClick={() => setDetail(skill)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setDetail(skill); }}>
      <div><span className="operation-skill-card-icon">{draft ? <Pencil size={16} /> : <Puzzle size={16} />}</span><strong>{skill.name}</strong><span className={`operation-skill-status-dot${enabled && skill.status === 'active' ? ' is-enabled' : ''}`} /></div>
      <p>{skill.description || '暂无说明'}</p><small>{skill.status === 'active' ? (skill.pendingWorkflow ? '有待生效修改' : enabled ? '已生效' : '已停用') : skill.status === 'revoked' ? '已注销，不可调用' : skill.status === 'failed' ? `学习失败：${skill.learningError || '请重新录制'}` : skill.status === 'learning' ? '学习中' : '待生效'} · {new Date(skill.updatedAt || skill.createdAt).toLocaleDateString('zh-CN')}</small>
      <footer onClick={(event) => event.stopPropagation()}>{(skill.status === 'draft' || (skill.status === 'active' && !!skill.pendingWorkflow)) && <button type="button" className="secondary-button" onClick={() => void activate(skill)}><Check size={14} />生效技能</button>}{skill.status === 'active' && <label className="operation-skill-toggle" title={enabled ? '关闭技能' : '启用技能'}><input type="checkbox" checked={enabled} onChange={(event) => void toggle(skill, event.target.checked)} /><span /></label>}</footer>
    </article>;
  })}</div>;
  const deleteSkill = async (): Promise<void> => {
    if (!deleteTarget) return;
    if (!backendAvailable()) throw new Error('操作技能服务尚未连接');
    const result = await window.kunqing?.operations.deleteSkill({ skillId: deleteTarget.id }) as RpcResult<unknown> | undefined;
    if (!result?.ok) throw new Error(result?.error?.message || '删除技能失败，请稍后重试');
    setDeleteTarget(null); setDetail(null); setDeleteError(''); await refresh();
  };
  return <div className="operation-card-view">{deleteError && <div className="operation-platform-notice operation-platform-notice--error">{deleteError}</div>}<div className="operation-card-section"><header><div><h2>已生效技能</h2><p>当前操作平台可以直接调用的技能。</p></div><span>{active.length}</span></header>{active.length ? cards(active) : <p className="operation-panel-empty">暂无已生效技能</p>}</div><div className="operation-card-section"><header><div><h2>技能草稿</h2><p>正在学习或已经完成学习、尚未生效的技能。</p></div><span>{drafts.length}</span></header>{drafts.length ? cards(drafts, true) : <p className="operation-panel-empty">暂无技能草稿</p>}</div>{revoked.length > 0 && <div className="operation-card-section"><header><div><h2>已注销技能</h2><p>平台删除后保留的技能文件和历史，不再允许调用。</p></div><span>{revoked.length}</span></header>{cards(revoked)}</div>}{detail && <SkillDetailDialog skill={detail} onClose={() => setDetail(null)} onChanged={() => void refresh()} onDelete={() => { setDeleteError(''); setDeleteTarget(detail); }} />}{deleteTarget && <ConfirmDeleteSkillDialog skill={deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={deleteSkill} />}</div>;
}

function SkillDetailDialog({ skill, onClose, onChanged, onDelete }: { skill: OperationSkill; onClose: () => void; onChanged: () => void; onDelete: () => void }): React.JSX.Element {
  const [message, setMessage] = useState(''); const [messages, setMessages] = useState<LearningMessage[]>(skill.messages ?? []); const [sending, setSending] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState('');
  const [currentWorkflow, setCurrentWorkflow] = useState<OperationWorkflow | null>(skill.workflow ?? null);
  const [pendingWorkflow, setPendingWorkflow] = useState<OperationWorkflow | null>(skill.pendingWorkflow ?? null);
  const [skillStatus, setSkillStatus] = useState<OperationSkill['status']>(skill.status);
  const [learningPhase, setLearningPhase] = useState(skill.learningPhase ?? 'ready');
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState('');
  const refreshMessages = useCallback(async (): Promise<void> => {
    if (!backendAvailable()) return;
    const latest = await window.kunqing?.operations.getLearningStatus({ skillId: skill.id }) as RpcResult<OperationSkill> | undefined;
    if (latest?.ok && latest.data) {
      setMessages(latest.data.messages ?? []);
      setCurrentWorkflow(latest.data.workflow ?? null);
      setPendingWorkflow(latest.data.pendingWorkflow ?? null);
      setSkillStatus(latest.data.status ?? skill.status);
      setLearningPhase(latest.data.learningPhase ?? 'ready');
    }
  }, [skill.id]);
  useEffect(() => {
    setMessages(skill.messages ?? []);
    void refreshMessages();
    const unsubscribe = window.kunqing?.events.subscribe((event) => {
      const payload = event as { type?: string; platformId?: string; skillId?: string };
      if (payload.skillId !== skill.id) return;
      if (payload.type === 'operation.learning' || payload.type === 'operation.skill') void refreshMessages();
    });
    return unsubscribe;
  }, [refreshMessages, skill.id, skill.messages]);
  useEffect(() => {
    let url = '';
    void (async (): Promise<void> => {
      if (!backendAvailable()) return;
      const result = await window.kunqing?.operations.getSkillRecording({ skillId: skill.id }) as RpcResult<{ bytes: Uint8Array; mimeType: string } | null> | undefined;
      if (result?.ok && result.data?.bytes) { const bytes = result.data.bytes.slice().buffer as ArrayBuffer; url = URL.createObjectURL(new Blob([bytes], { type: result.data.mimeType || 'video/webm' })); setRecordingUrl(url); }
    })();
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [skill.id]);
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const content = message.trim();
    if (!content || sending) return;
    setMessage('');
    setSending(true);
    const optimisticMessage: LearningMessage = { id: createId('learning-user'), role: 'user', content, createdAt: new Date().toISOString() };
    setMessages((items) => [...items, optimisticMessage]);
    if (!backendAvailable()) {
      setMessages((items) => [...items, { id: createId('learning-agent'), role: 'agent', content: '操作智能体服务尚未连接，请稍后重试。', createdAt: new Date().toISOString() }]);
      setSending(false);
      return;
    }
    const result = await window.kunqing?.operations.replyLearning({ skillId: skill.id, content }) as RpcResult<unknown> | undefined;
    if (result?.ok) {
      await refreshMessages();
      onChanged();
    } else {
      setMessages((items) => [...items, { id: createId('learning-agent-error'), role: 'agent', content: result?.error?.message || '操作智能体暂时无法回复，请稍后重试。', createdAt: new Date().toISOString() }]);
    }
    setSending(false);
  };
  const workflow = pendingWorkflow ?? currentWorkflow;
  const businessSteps = workflow?.plan?.businessSteps ?? [];
  // A pending workflow is the durable signal that a correction produced a
  // candidate revision. Do not hide its activation control merely because
  // the learning phase is transitioning between processing and ready.
  const hasPendingRevision = skillStatus === 'active' && !!pendingWorkflow;
  const revisionProcessing = hasPendingRevision && learningPhase === 'processing';
  const activateRevision = async (): Promise<void> => {
    if (!hasPendingRevision || activating || !backendAvailable()) return;
    setActivating(true);
    setActivationError('');
    const result = await window.kunqing?.operations.activateSkill({ skillId: skill.id }) as RpcResult<SkillActivationResult> | undefined;
    if (result?.ok && result.data?.workflow) {
      setCurrentWorkflow(result.data.workflow);
      setPendingWorkflow(null);
      setLearningPhase('ready');
      await refreshMessages();
      onChanged();
    } else {
      setActivationError(result?.error?.message || '业务工作流尚未满足生效条件');
      await refreshMessages();
    }
    setActivating(false);
  };
  return <div className="modal-backdrop modal-backdrop--nested" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="operation-skill-detail-dialog" role="dialog" aria-modal="true"><header><div><span className="operation-skill-detail-eyebrow">操作技能详情</span><h2>{skill.name}</h2><p>{skill.description || '暂无技能说明'}</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>{hasPendingRevision && <div className="operation-skill-revision-notice"><Pencil size={14} /><span>{revisionProcessing ? '正在整理修正内容，完成后即可生效。' : '这是待生效的业务工作流预览，当前技能仍按旧版本执行。'}</span></div>}{activationError && <div className="operation-platform-notice operation-platform-notice--error">{activationError}</div>}<div className="operation-skill-detail-grid"><section className="operation-skill-detail-video"><h3><Video size={15} />录制视频</h3>{recordingUrl ? <video className="operation-skill-recording-video" src={recordingUrl} controls /> : <div className="operation-skill-video-placeholder"><Video size={28} /><span>录制视频已保存</span><small>视频暂不可预览，业务工作流仍可查看</small></div>}</section><section className="operation-skill-detail-workflow"><h3><Activity size={15} />业务工作流 {hasPendingRevision && <small>待生效预览</small>}</h3><div className="operation-workflow-list">{businessSteps.length ? businessSteps.map((node, index) => <div className="operation-workflow-step" key={node.id || index}><b>{index + 1}</b><span><strong>{node.title || `业务节点 ${index + 1}`}</strong><small>{node.purpose || '确认当前业务节点'}{node.domStepIndexes?.length ? ` · 使用 DOM 动作 ${node.domStepIndexes.join('、')}` : ` · ${node.verification === 'vision' ? '视觉确认' : '页面状态确认'}`}</small></span></div>) : <p>业务工作流尚未确认，请继续与智能体沟通。</p>}</div></section></div><section className="operation-skill-detail-chat"><header><h3><Bot size={15} />智能体修正对话</h3><span>{skillStatus === 'active' ? '可继续修正' : '学习记录'}</span></header><div className="operation-skill-detail-messages">{messages.length ? messages.map((item) => <div className={`operation-agent-message operation-agent-message--${item.role}`} key={item.id}><span className="operation-agent-message__avatar">{item.role === 'agent' ? <Bot size={14} /> : '我'}</span><p>{item.content}</p></div>) : <p className="operation-panel-empty">告诉智能体需要修正的操作，它会结合业务目标、录制画面和 DOM 证据重新理解。</p>}</div><form className="operation-agent-composer" onSubmit={(event) => void send(event)}><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="描述需要修正的操作" disabled={sending} /><button type="submit" className="primary-button" disabled={!message.trim() || sending}>{sending ? <Loader2 size={15} className="spin" /> : '发送'}</button></form></section><footer className="operation-skill-detail-footer"><span>{hasPendingRevision ? '确认后才会替换当前已生效版本。' : skill.enabled === false || skill.enabled === 0 ? '当前技能已停用，操作智能体不会调用。' : '关闭技能后仍可在此查看和修正。'}</span><div>{hasPendingRevision && <button type="button" className="primary-button" disabled={activating || revisionProcessing} onClick={() => void activateRevision()}>{activating || revisionProcessing ? <><Loader2 size={15} className="spin" />{revisionProcessing ? '修正中...' : '生效中...'}</> : <><Check size={15} />生效技能</>}</button>}<button type="button" className="danger-button" onClick={onDelete}><Trash2 size={15} />删除技能</button></div></footer></section></div>;
}

function ConfirmDeleteSkillDialog({ skill, onClose, onConfirm }: { skill: OperationSkill; onClose: () => void; onConfirm: () => Promise<void> }): React.JSX.Element { const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const confirm = async (): Promise<void> => { setBusy(true); setError(''); try { await onConfirm(); } catch (reason) { setError(reason instanceof Error ? reason.message : '删除技能失败，请稍后重试'); setBusy(false); } }; return <div className="modal-backdrop modal-backdrop--nested" role="presentation"><section className="operation-platform-dialog operation-platform-dialog--compact" role="dialog" aria-modal="true"><header><div><h2>删除技能</h2><p>确认删除“{skill.name}”？录制视频、DOM 工作流和学习记录将一并删除，且无法恢复。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>{error && <small className="operation-platform-dialog__error">{error}</small>}<footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={() => void confirm()}><Trash2 size={15} />{busy ? '删除中...' : '确认删除'}</button></footer></section></div>; }

function AgentManagementView({ platform, models, onSave }: { platform: OperationPlatform; models: UnifiedModel[]; onSave: (changes: Partial<OperationPlatform>) => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState(platform.agentName); const [url, setUrl] = useState(platform.url); const [description, setDescription] = useState(platform.description); const [model, setModel] = useState(platform.modelProfileId); const [temperature, setTemperature] = useState(platform.temperature); const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); const normalized = normalizePlatformUrl(url); if (!normalized || !name.trim() || !model) return; setSaving(true); await onSave({ agentName: name.trim(), url: normalized, description: description.trim(), modelProfileId: model, temperature }); setSaving(false); setSaved(true); window.setTimeout(() => setSaved(false), 1600); };
  return <form className="operation-agent-settings" onSubmit={(event) => void submit(event)}><header><div><h2>智能体管理</h2><p>调整此操作平台专属智能体及其网站上下文。</p></div></header><label><span>智能体名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>平台网址</span><input value={url} onChange={(event) => setUrl(event.target.value)} /></label><label><span>平台描述</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述平台用途、页面结构和常用操作。" /></label><label><span>挂载模型 <em>*</em></span><select aria-label="挂载模型" required value={model} onChange={(event) => setModel(event.target.value)}><option value="" disabled>请选择模型</option>{models.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.modelId}</option>)}</select></label><label><span>Temperature</span><input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} /></label><footer><button type="submit" className="primary-button" disabled={saving || !model}>{saved ? <><Check size={15} />已保存</> : saving ? '保存中...' : '保存设置'}</button></footer></form>;
}

function PlatformEditorDialog({ models, onClose, onSubmit }: { models: UnifiedModel[]; onClose: () => void; onSubmit: (input: { name: string; url: string; description: string; agentName: string; modelProfileId: string }) => Promise<boolean> }): React.JSX.Element {
  const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [description, setDescription] = useState(''); const [agentName, setAgentName] = useState(''); const [modelProfileId, setModelProfileId] = useState(''); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); const trimmedName = name.trim(); const normalizedUrl = normalizePlatformUrl(url); if (!trimmedName) { setError('请输入操作平台名称'); return; } if (!normalizedUrl) { setError('请输入有效的网站地址'); return; } if (!modelProfileId) { setError('请选择操作智能体使用的模型'); return; } setSaving(true); const ok = await onSubmit({ name: trimmedName, url: normalizedUrl, description: description.trim(), agentName: agentName.trim(), modelProfileId }); setSaving(false); if (!ok) setError('保存失败，请稍后重试'); };
  return <div className="modal-backdrop modal-backdrop--nested" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="operation-platform-dialog" role="dialog" aria-modal="true" onSubmit={(event) => void submit(event)}><header><div><h2>创建操作平台</h2><p>平台信息会作为操作智能体的基础上下文。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header><label><span>操作平台名称</span><input aria-label="操作平台名称" autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(''); }} placeholder="例如：客户运营后台" /></label><label><span>网站地址</span><div className="operation-platform-url"><ExternalLink size={16} /><input aria-label="网站地址" value={url} onChange={(event) => { setUrl(event.target.value); setError(''); }} placeholder="https://example.com" /></div></label><label><span>平台描述</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述网站用途、页面区域和常用业务。" /></label><label><span>智能体名称</span><input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="默认使用平台名称 + 助手" /></label><label><span>智能体模型 <em>*</em></span><select aria-label="智能体模型" required value={modelProfileId} onChange={(event) => { setModelProfileId(event.target.value); setError(''); }}><option value="" disabled>请选择模型</option>{models.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.modelId}</option>)}</select></label>{error && <small className="operation-platform-dialog__error">{error}</small>}<footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={saving || !modelProfileId}>{saving ? '创建中...' : '确定创建'}</button></footer></form></div>;
}

function RenamePlatformDialog({ platform, onClose, onSubmit }: { platform: OperationPlatform; onClose: () => void; onSubmit: (name: string) => Promise<boolean> }): React.JSX.Element { const [name, setName] = useState(platform.name); const [error, setError] = useState(''); return <div className="modal-backdrop modal-backdrop--nested" role="presentation"><form className="operation-platform-dialog operation-platform-dialog--compact" onSubmit={(event) => { event.preventDefault(); if (!name.trim()) { setError('请输入平台名称'); return; } void onSubmit(name.trim()); }}><header><h2>重命名操作平台</h2><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header><label><span>操作平台名称</span><input aria-label="操作平台名称" autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(''); }} /></label>{error && <small className="operation-platform-dialog__error">{error}</small>}<footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button">保存</button></footer></form></div>; }
function DeletePlatformDialog({ platform, onClose, onConfirm }: { platform: OperationPlatform; onClose: () => void; onConfirm: () => void }): React.JSX.Element { return <div className="modal-backdrop modal-backdrop--nested" role="presentation"><div className="operation-platform-dialog operation-platform-dialog--compact"><header><div><h2>删除操作平台</h2><p>删除后将从列表中移除“{platform.name}”。相关技能会被注销且无法继续调用，但技能文件、录制和执行历史会保留。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header><footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="danger-button" onClick={onConfirm}><Trash2 size={15} />确认删除</button></footer></div></div>; }
