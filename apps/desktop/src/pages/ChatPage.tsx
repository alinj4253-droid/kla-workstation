import {
  AlertTriangle, Brain, ExternalLink, FileText, FolderOpen, Globe2, Link, ListTree, Loader2, MoreVertical, Network,
  PanelLeftClose, PanelLeftOpen, Paperclip, Pencil, Plus, Send, Sparkles, Square, Trash2, UserPlus, Workflow, X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AgentAvatar, AGENT_TONES, getAgentTone } from '../components/AgentAvatar';
import { VirtualMessageList } from '../components/VirtualMessageList';
import { TaskWorkTreePanel } from '../components/TaskWorkTreePanel';
import { TaskWorkFlowPanel } from '../components/TaskWorkFlowPanel';
import { MemoryManager } from '../components/MemoryManager';
import { AddAgentsModal } from '../components/AddAgentsModal';
import { ChannelBindingsDialog } from '../components/ChannelBindingsDialog';
import { AssociateProjectDialog } from '../components/AssociateProjectDialog';
import { NameAvatar } from '../components/NameAvatar';
import { displayAgentText, extractMentions, findMentionContext, formatReplyPreview, insertComposerNewline, replaceMention, type MentionContext } from '../chat-input-utils';
import { normalizeEnterpriseProjects, normalizeProjectAssociations, projectAssociationLabel, type EnterpriseProject, type EnterpriseProjectAssociations } from '../enterprise-projects';
import type { BusinessProcess } from '../types/business-process';

type ProjectItem = {
  id: string;
  name: string;
  status: string;
  lastActiveAt: string;
};

type AgentInstance = {
  id: string;
  projectId: string;
  agentName: string;
  role: string;
  runtimeMode: string;
};

type MessageItem = {
  id: string;
  senderType: string;
  senderId: string;
  kind: string;
  contentJson: string;
  status: string;
  replyToId?: string | null;
  createdAt: string;
};

type RunTraceItem = {
  id: string;
  kind: 'plan' | 'reasoning' | 'handoff' | 'tool' | 'execution' | 'file' | 'warning';
  title: string;
  detail?: string;
  status: 'running' | 'completed' | 'failed';
  at: string;
};

type RunActivity = {
  status: string;
  agentName?: string;
  agentId?: string;
  anchorMessageId?: string;
  triggerMessageId?: string;
  parentRunId?: string;
  requestedByType?: string;
  requestedById?: string;
  createdAt?: string;
  stage?: string;
  progress?: number;
  traces: RunTraceItem[];
  checklist?: { items: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'failed'; detail?: string }>; updatedAt: string };
  businessProcess?: BusinessProcess;
  updatedAt: string;
};

type CollaborationMode = 'fast' | 'balanced' | 'expert';

interface PerProjectState {
  draft: string;
  previewOpen: boolean;
  workTreeOpen: boolean;
  scrollOffset: number;
}

interface PreviewData {
  kind: 'text' | 'image' | 'unknown' | 'html' | 'pdf' | 'web';
  content?: string;
  dataUri?: string;
  appFileUrl?: string;
  mimeType?: string;
  fileName: string;
  fileId?: string;
  versionId?: string;
  sourceUrl?: string;
  error?: string;
}

function formatSidebarTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', date.getFullYear() === now.getFullYear() ? { month: '2-digit', day: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' }).replaceAll('/', '-');
}

const DEFAULT_PROJECT_STATE: PerProjectState = { draft: '', previewOpen: false, workTreeOpen: false, scrollOffset: 0 };

export function ChatPage(): React.JSX.Element {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [lastSentMessageId, setLastSentMessageId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [collaborationMode, setCollaborationMode] = useState<CollaborationMode>('expert');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [workTreeOpen, setWorkTreeOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [hasMore, setHasMore] = useState(false);
  const [runStatuses, setRunStatuses] = useState<Record<string, RunActivity>>({});
  const [eventError, setEventError] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [enlargedImage, setEnlargedImage] = useState<{ url: string; alt?: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pendingArtifact, setPendingArtifact] = useState<{ path: string; runId?: string; triggerMessageId?: string; createdAt: string } | null>(null);
  const [memoryManagerOpen, setMemoryManagerOpen] = useState(false);
  const [addAgentsOpen, setAddAgentsOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const [dissolveOpen, setDissolveOpen] = useState(false);
  const [channelBindOpen, setChannelBindOpen] = useState(false);
  const [associateProjectOpen, setAssociateProjectOpen] = useState(false);
  const [enterpriseProjects, setEnterpriseProjects] = useState<EnterpriseProject[]>([]);
  const [projectAssociations, setProjectAssociations] = useState<EnterpriseProjectAssociations>({});
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [stoppingAllRuns, setStoppingAllRuns] = useState(false);
  const [workTreeView, setWorkTreeView] = useState<'tree' | 'flow'>('tree');
  const [projectPanelOpen, setProjectPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(300);
  const [previewWidth, setPreviewWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem('kunqing.previewWidth'));
    return Number.isFinite(saved) && saved >= 320 ? saved : 520;
  });
  const [projectAgents, setProjectAgents] = useState<AgentInstance[]>([]);
  const [replyingTo, setReplyingTo] = useState<MessageItem | null>(null);
  const [userProfile, setUserProfile] = useState({ nickname: '项目负责人', avatarDataUrl: '' });
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionContext, setMentionContext] = useState<MentionContext | null>(null);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resizingRef = useRef(false);
  const previewResizingRef = useRef(false);
  const projectStateRef = useRef<Record<string, PerProjectState>>({});
  const autoOpenedTaskRef = useRef<string | null>(null);

  // Apply panel width CSS variable
  useEffect(() => {
    document.documentElement.style.setProperty('--kq-project-panel-width', `${panelWidth}px`);
  }, [panelWidth]);

  useEffect(() => {
    document.documentElement.style.setProperty('--kq-preview-panel-width', `${previewWidth}px`);
    window.localStorage.setItem('kunqing.previewWidth', String(previewWidth));
  }, [previewWidth]);

  useEffect(() => {
    if (!projectId) {
      setCollaborationMode('expert');
      return;
    }
    const saved = window.localStorage.getItem(`kunqing.collaborationMode.${projectId}`);
    setCollaborationMode(saved === 'fast' || saved === 'balanced' ? saved : 'expert');
  }, [projectId]);

  const changeCollaborationMode = (mode: CollaborationMode): void => {
    setCollaborationMode(mode);
    if (projectId) window.localStorage.setItem(`kunqing.collaborationMode.${projectId}`, mode);
  };

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = panelWidth;

    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const newWidth = Math.max(200, Math.min(600, startWidth + ev.clientX - startX));
      setPanelWidth(newWidth);
    };

    const onUp = () => {
      resizingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  const startPreviewResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    previewResizingRef.current = true;
    const startX = event.clientX;
    const startWidth = previewWidth;
    const onMove = (moveEvent: MouseEvent): void => {
      if (!previewResizingRef.current) return;
      const available = Math.max(360, window.innerWidth - (projectPanelOpen ? panelWidth : 0) - 420);
      setPreviewWidth(Math.max(320, Math.min(available, startWidth + startX - moveEvent.clientX)));
    };
    const onUp = (): void => {
      previewResizingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth, previewWidth, projectPanelOpen]);

  const loadProjects = useCallback(async (): Promise<ProjectItem[]> => {
    const result = await window.kunqing?.projects.list({} as Record<string, never>);
    if (result && typeof result === 'object' && 'ok' in result && result.ok) {
      const items = (result as Record<string, unknown>).data as ProjectItem[];
      setProjects([...items].sort((left, right) => new Date(right.lastActiveAt).getTime() - new Date(left.lastActiveAt).getTime()));
      return items;
    }
    return [];
  }, []);

  const touchProject = useCallback((targetProjectId: string, at: string): void => {
    setProjects((current) => current
      .map((project) => project.id === targetProjectId ? { ...project, lastActiveAt: at } : project)
      .sort((left, right) => new Date(right.lastActiveAt).getTime() - new Date(left.lastActiveAt).getTime()));
  }, []);

  const loadMessages = useCallback(async (before?: string, knownProjectName?: string) => {
    if (!projectId) return;
    // One-time UI-only cleanup for the fixed demo chat. This deliberately
    // leaves messages, memories and run records in SQLite; it only advances
    // the renderer's display boundary so the next user message starts clean.
    const currentProject = projects.find((project) => project.id === projectId);
    const projectName = knownProjectName ?? currentProject?.name ?? '';
    const isFixedDemoChat = /鲲擎KLA助手/u.test(projectName);
    const isAssetDemoChat = /标品资产设计与入库/u.test(projectName);
    const clearKey = isAssetDemoChat
      ? `kunqing.chat.displayClearedAt.asset-demo.v1.${projectId}`
      : `kunqing.chat.displayClearedAt.v5.${projectId}`;
    let displaySince = window.localStorage.getItem(clearKey);
    const result = before
      ? await window.kunqing?.messages.list({ projectId, before, limit: 50 })
      : await window.kunqing?.messages.list({ projectId, limit: 50 });
    if (result && typeof result === 'object' && 'ok' in result && result.ok) {
      const data = (result as Record<string, unknown>).data as { messages: MessageItem[]; hasMore: boolean };
      // Establish the boundary from persisted history, rather than the local
      // clock. This hides all existing demo bubbles even when stored timestamps
      // come from a different clock or have been replayed by a test fixture.
      if ((isFixedDemoChat || isAssetDemoChat) && !displaySince && !before) {
        displaySince = data.messages[data.messages.length - 1]?.createdAt ?? new Date().toISOString();
        window.localStorage.setItem(clearKey, displaySince);
      }
      const displayBoundary = displaySince;
      const visibleMessages = displayBoundary
        ? data.messages.filter((message) => message.createdAt > displayBoundary)
        : data.messages;
      if (before) {
        setMessages((prev) => {
          const byId = new Map([...visibleMessages, ...prev].map((message) => [message.id, message]));
          return [...byId.values()];
        });
      } else {
        setMessages(visibleMessages);
      }
      setHasMore(displaySince ? visibleMessages.length === data.messages.length && data.hasMore : data.hasMore);
    }
    setLoading(false);
  }, [projectId]);

  const loadRunActivities = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    const listRunActivity = window.kunqing?.messages.listRunActivity;
    if (typeof listRunActivity !== 'function') return;
    const result = await listRunActivity({ projectId, limit: 30 }) as {
      ok: boolean;
      data?: Array<{
        runId: string; agentId: string; agentName: string; anchorMessageId?: string; triggerMessageId?: string; parentRunId?: string;
        requestedByType?: string; requestedById?: string; createdAt?: string; status: string; traces: RunTraceItem[];
        checklist?: RunActivity['checklist']; businessProcess?: RunActivity['businessProcess']; updatedAt: string;
      }>;
    } | undefined;
    if (!result?.ok || !result.data) return;
    const next: Record<string, RunActivity> = {};
    for (const run of result.data) {
      const traceMap = new Map<string, RunTraceItem>();
      for (const trace of run.traces ?? []) traceMap.set(trace.id, trace);
      const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
      if (terminal && traceMap.size === 0 && !run.checklist?.items?.length && !run.businessProcess) continue;
      next[run.runId] = {
        status: run.status,
        agentId: run.agentId,
        agentName: run.agentName,
        ...(run.anchorMessageId ? { anchorMessageId: run.anchorMessageId } : {}),
        ...(run.triggerMessageId ? { triggerMessageId: run.triggerMessageId } : {}),
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
        ...(run.requestedByType ? { requestedByType: run.requestedByType } : {}),
        ...(run.requestedById ? { requestedById: run.requestedById } : {}),
        ...(run.createdAt ? { createdAt: run.createdAt } : {}),
        traces: [...traceMap.values()],
        ...(run.checklist ? { checklist: run.checklist } : {}),
        ...(run.businessProcess ? { businessProcess: run.businessProcess } : {}),
        updatedAt: run.updatedAt,
      };
    }
    setRunStatuses(next);
  }, [projectId]);

  const prevProjectIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!projectId) return;
    const prevId = prevProjectIdRef.current;
    prevProjectIdRef.current = projectId;
    if (prevId) {
      projectStateRef.current[prevId] = { draft, previewOpen, workTreeOpen, scrollOffset };
    }
    const saved = projectStateRef.current[projectId] ?? DEFAULT_PROJECT_STATE;
    setDraft(saved.draft);
    setPreviewOpen(saved.previewOpen);
    setWorkTreeOpen(saved.workTreeOpen);
    setScrollOffset(saved.scrollOffset);
    setPreviewFile(null);
    setPreviewData(null);
    setPendingArtifact(null);
    autoOpenedTaskRef.current = null;
    const url = new URL(window.location.href);
    const previewPath = url.searchParams.get('preview');
    if (previewPath) {
      setPreviewOpen(true);
      setWorkTreeOpen(false);
      void openPreview(previewPath);
    }
    setProjectAgents([]);
    setReplyingTo(null);
    setShowMentions(false);
    setMentionContext(null);
    setMentionSelectedIndex(0);
    setRunStatuses({});
    setLoading(true);
    void (async (): Promise<void> => {
      const items = await loadProjects();
      const projectName = items.find((project) => project.id === projectId)?.name;
      await loadMessages(undefined, projectName);
    })();
    void loadRunActivities();
    window.kunqing?.agents.getProjectInstances({ projectId }).then((result) => {
      const r = result as { ok: boolean; data?: AgentInstance[] } | undefined;
      if (r?.ok && r.data) setProjectAgents(r.data);
    });
  }, [projectId]);

  useEffect(() => {
    void (async (): Promise<void> => {
      const result = await window.kunqing?.settings.getAll() as { ok?: boolean; data?: Record<string, unknown> } | undefined;
      if (!result?.ok) return;
      const nickname = String(result.data?.personalNickname ?? '').trim() || '项目负责人';
      const avatarDataUrl = String(result.data?.personalAvatarDataUrl ?? '').trim();
      setUserProfile({ nickname, avatarDataUrl });
      setEnterpriseProjects(normalizeEnterpriseProjects(result.data?.enterpriseProjects));
      setProjectAssociations(normalizeProjectAssociations(result.data?.enterpriseProjectAssociations));
    })();
  }, []);

  useEffect(() => {
    if (!projectId) return;
    const unsubscribe = window.kunqing?.events.subscribe((raw) => {
      const event = raw as { type: string; projectId?: string; [key: string]: unknown };
      if (event.projectId && event.projectId !== projectId) return;

      switch (event.type) {
        case 'project.agents.changed': {
          void window.kunqing?.agents.getProjectInstances({ projectId }).then((result) => {
            const r = result as { ok: boolean; data?: AgentInstance[] } | undefined;
            if (r?.ok && r.data) setProjectAgents(r.data);
          });
          break;
        }
        case 'message.delta': {
          const { messageId, senderId, delta } = event as unknown as { messageId: string; senderId?: string; delta?: string };
          if (!messageId || typeof delta !== 'string') break;
          setMessages((prev) => {
            const existing = prev.find((message) => message.id === messageId);
            if (!existing) {
              return [...prev, {
                id: messageId,
                senderType: 'agent',
                senderId: senderId ?? '',
                kind: 'text',
                contentJson: JSON.stringify({ schemaVersion: 1, text: delta, mentions: [] }),
                status: 'sending',
                createdAt: new Date().toISOString(),
              }];
            }
            if (existing.status !== 'sending') return prev;
            let currentText = '';
            try { currentText = (JSON.parse(existing.contentJson) as { text?: string }).text ?? ''; } catch { /* start empty */ }
            return prev.map((message) => message.id === messageId
              ? { ...message, senderId: senderId ?? message.senderId, contentJson: JSON.stringify({ schemaVersion: 1, text: currentText + delta, mentions: [] }) }
              : message);
          });
          break;
        }
        case 'message.committed': {
          const { messageId, senderType, senderId, kind, content } = event as {
            type: 'message.committed'; projectId: string; messageId: string; senderType?: string; senderId: string; kind?: string; content: string;
          };
          setMessages((prev) => {
            if (prev.some((m) => m.id === messageId)) {
              return prev.map((message) => message.id === messageId
                ? { ...message, senderType: senderType ?? message.senderType, senderId: senderId ?? message.senderId, kind: kind ?? message.kind, contentJson: content, status: 'sent' }
                : message);
            }
            // Older event producers omit senderType. Keep their prior agent/system
            // behavior, but recognize the local user so a broadcast that wins the
            // IPC race cannot turn a user reply into an agent bubble.
            const inferredSenderType = senderType ?? (senderId === 'system' ? 'system' : senderId === 'local-user' ? 'user' : 'agent');
            return [...prev, { id: messageId, senderType: inferredSenderType, senderId: senderId ?? '', kind: inferredSenderType === 'system' ? 'system' : (kind === 'artifact' ? 'artifact' : 'text'), contentJson: content, status: 'sent', createdAt: new Date().toISOString() }];
          });
          if (event.projectId) touchProject(event.projectId, new Date().toISOString());
          break;
        }
        case 'message.discarded': {
          // 真流式占位被丢弃（去重复用、取消或失败）：仅移除仍处于 sending 状态的占位。
          const { messageId } = event as { type: 'message.discarded'; projectId: string; messageId: string; reason?: string };
          if (!messageId) break;
          setMessages((prev) => prev.filter((message) => !(message.id === messageId && message.status === 'sending')));
          break;
        }
        case 'run.status': {
          const { run } = event as { type: 'run.status'; projectId: string; run: {
            id: string; agentId: string; agentName: string; anchorMessageId?: string; triggerMessageId?: string; parentRunId?: string;
            requestedByType?: string; requestedById?: string; createdAt?: string; status: string; stage?: string; progress?: number; error?: string;
          } };
          setRunStatuses((prev) => {
            const next = {
              status: run.status,
              agentName: projectAgents.find((agent) => agent.id === run.agentId)?.agentName
                ?? (run.agentName && run.agentName !== run.agentId ? displayAgentText(run.agentName, projectAgents) : '智能体'),
              agentId: run.agentId,
              ...(run.anchorMessageId ? { anchorMessageId: run.anchorMessageId } : prev[run.id]?.anchorMessageId ? { anchorMessageId: prev[run.id]!.anchorMessageId } : {}),
              ...(run.triggerMessageId ? { triggerMessageId: run.triggerMessageId } : prev[run.id]?.triggerMessageId ? { triggerMessageId: prev[run.id]!.triggerMessageId } : {}),
              ...(run.parentRunId ? { parentRunId: run.parentRunId } : prev[run.id]?.parentRunId ? { parentRunId: prev[run.id]!.parentRunId } : {}),
              ...(run.requestedByType ? { requestedByType: run.requestedByType } : prev[run.id]?.requestedByType ? { requestedByType: prev[run.id]!.requestedByType } : {}),
              ...(run.requestedById ? { requestedById: run.requestedById } : prev[run.id]?.requestedById ? { requestedById: prev[run.id]!.requestedById } : {}),
              ...(run.createdAt ? { createdAt: run.createdAt } : prev[run.id]?.createdAt ? { createdAt: prev[run.id]!.createdAt } : {}),
              traces: prev[run.id]?.traces ?? [],
              ...(prev[run.id]?.checklist ? { checklist: prev[run.id]!.checklist } : {}),
              ...(prev[run.id]?.businessProcess ? { businessProcess: prev[run.id]!.businessProcess } : {}),
              updatedAt: new Date().toISOString(),
              ...(run.stage !== undefined || prev[run.id]?.stage !== undefined
                ? { stage: run.stage ?? prev[run.id]!.stage }
                : {}),
              ...(run.progress !== undefined || prev[run.id]?.progress !== undefined
                ? { progress: run.progress ?? prev[run.id]!.progress }
                : {}),
            };
            return { ...prev, [run.id]: next };
          });
          if (run.status === 'failed') {
            // 添加错误消息到聊天（P2-17：ID 与主进程 insertRunFailureNotice 派生规则一致，
            // 持久化广播先到则此处去重跳过；落库失败时此内存消息是唯一兜底提示）。
            const errorMsg: MessageItem = {
              id: `run-fail-${run.id}`,
              senderType: 'system',
              senderId: 'system',
              kind: 'system',
              contentJson: JSON.stringify({ schemaVersion: 1, text: run.error ? `运行出错：${run.error}` : '智能体运行失败，请检查模型配置。' }),
              status: 'sent',
              createdAt: new Date().toISOString(),
            };
            setMessages((prev) => (prev.some((m) => m.id === errorMsg.id) ? prev : [...prev, errorMsg]));
          }
          if (['completed', 'cancelled', 'interrupted'].includes(run.status)) {
            setRunStatuses((prev) => {
              const current = prev[run.id];
              return current ? { ...prev, [run.id]: { ...current, status: run.status, updatedAt: new Date().toISOString() } } : prev;
            });
          }
          break;
        }
        case 'run.trace': {
          const { runId, agentId, anchorMessageId, triggerMessageId, parentRunId, requestedByType, requestedById, createdAt, trace } = event as {
            type: 'run.trace'; projectId: string; runId: string; agentId: string; anchorMessageId?: string; triggerMessageId?: string;
            parentRunId?: string; requestedByType?: string; requestedById?: string; createdAt?: string; trace: RunTraceItem;
          };
          setRunStatuses((prev) => {
            const current = prev[runId] ?? { status: 'running', agentId, agentName: projectAgents.find((agent) => agent.id === agentId)?.agentName ?? '智能体', traces: [], updatedAt: trace.at };
            const existingIndex = current.traces.findIndex((item) => item.id === trace.id);
            const traces = existingIndex >= 0
              ? current.traces.map((item, index) => index === existingIndex ? trace : item)
              : [...current.traces, trace];
            return { ...prev, [runId]: {
              ...current,
              ...(anchorMessageId ? { anchorMessageId } : {}),
              ...(triggerMessageId ? { triggerMessageId } : {}),
              ...(parentRunId ? { parentRunId } : {}),
              ...(requestedByType ? { requestedByType } : {}),
              ...(requestedById ? { requestedById } : {}),
              ...(createdAt ? { createdAt } : {}),
              traces,
              updatedAt: trace.at,
            } };
          });
          break;
        }
        case 'run.checklist': {
          const { runId, agentId, triggerMessageId, parentRunId, requestedByType, requestedById, createdAt, checklist } = event as {
            type: 'run.checklist'; projectId: string; runId: string; agentId: string; triggerMessageId?: string; parentRunId?: string;
            requestedByType?: string; requestedById?: string; createdAt?: string; checklist: NonNullable<RunActivity['checklist']>;
          };
          setRunStatuses((prev) => {
            const current = prev[runId] ?? { status: 'running', agentId, agentName: projectAgents.find((agent) => agent.id === agentId)?.agentName ?? '智能体', traces: [], updatedAt: checklist.updatedAt };
            return { ...prev, [runId]: {
              ...current,
              ...(triggerMessageId ? { triggerMessageId } : {}),
              ...(parentRunId ? { parentRunId } : {}),
              ...(requestedByType ? { requestedByType } : {}),
              ...(requestedById ? { requestedById } : {}),
              ...(createdAt ? { createdAt } : {}),
              checklist,
              updatedAt: checklist.updatedAt,
            } };
          });
          break;
        }
        case 'run.business-process': {
          const { runId, agentId, triggerMessageId, parentRunId, requestedByType, requestedById, createdAt, businessProcess } = event as {
            type: 'run.business-process'; projectId: string; runId: string; agentId: string; triggerMessageId?: string; parentRunId?: string;
            requestedByType?: string; requestedById?: string; createdAt?: string; businessProcess: NonNullable<RunActivity['businessProcess']>;
          };
          setRunStatuses((prev) => {
            const current = prev[runId] ?? {
              status: 'running',
              agentId,
              agentName: projectAgents.find((agent) => agent.id === agentId)?.agentName ?? businessProcess.generatedByAgentName,
              traces: [],
              updatedAt: businessProcess.generatedAt,
            };
            return { ...prev, [runId]: {
              ...current,
              ...(triggerMessageId ? { triggerMessageId } : {}),
              ...(parentRunId ? { parentRunId } : {}),
              ...(requestedByType ? { requestedByType } : {}),
              ...(requestedById ? { requestedById } : {}),
              ...(createdAt ? { createdAt } : {}),
              businessProcess,
              updatedAt: businessProcess.generatedAt,
            } };
          });
          break;
        }
        case 'cli.event': {
          const { runId, event: cliEvent } = event as { type: 'cli.event'; projectId: string; runId: string; event: { type?: string; callId?: string; tool?: string; safeSummary?: string; ok?: boolean; sandboxRelativePath?: string; at?: string; protocol_degraded?: boolean } };
          if (cliEvent.protocol_degraded || !cliEvent.type || !['tool.requested', 'tool.completed', 'artifact.proposed'].includes(cliEvent.type)) break;
          const traceId = cliEvent.callId ? `cli-${cliEvent.callId}` : `cli-artifact-${cliEvent.sandboxRelativePath ?? Date.now()}`;
          const trace: RunTraceItem = {
            id: traceId,
            kind: cliEvent.type.startsWith('tool.') ? 'tool' : 'file',
            title: cliEvent.type === 'tool.requested' ? `调用工具：${cliEvent.tool ?? 'CLI 工具'}` : cliEvent.type === 'tool.completed' ? `工具调用${cliEvent.ok === false ? '失败' : '完成'}` : '生成成果文件',
            ...(cliEvent.safeSummary || cliEvent.sandboxRelativePath ? { detail: cliEvent.safeSummary ?? cliEvent.sandboxRelativePath } : {}),
            status: cliEvent.type === 'tool.requested' ? 'running' : cliEvent.ok === false ? 'failed' : 'completed',
            at: cliEvent.at ?? new Date().toISOString(),
          };
          setRunStatuses((prev) => {
            const current = prev[runId] ?? { status: 'running', traces: [], updatedAt: trace.at };
            const exists = current.traces.some((item) => item.id === trace.id);
            return { ...prev, [runId]: { ...current, traces: exists ? current.traces.map((item) => item.id === trace.id ? trace : item) : [...current.traces, trace], updatedAt: trace.at } };
          });
          break;
        }
        case 'message.created': {
          const { message, runId, triggerMessageId } = event as { type: 'message.created'; projectId: string; runId?: string; triggerMessageId?: string; message: MessageItem };
          setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
          if (event.projectId) touchProject(event.projectId, message.createdAt);
          if (message.kind === 'artifact') {
            try {
              const content = JSON.parse(message.contentJson) as { text?: unknown };
              if (typeof content.text === 'string' && content.text.trim()) {
                setPendingArtifact({
                  path: content.text.trim(),
                  ...(runId ? { runId } : {}),
                  ...(triggerMessageId ? { triggerMessageId } : {}),
                  createdAt: message.createdAt,
                });
              }
            } catch { /* 无效成果消息不触发自动预览 */ }
          }
          break;
        }
      }
    });
    return () => { unsubscribe?.(); };
  }, [projectId, projectAgents, touchProject]);

  // The demo label-card is loaded in an app-file iframe. Its Save button
  // notifies the host renderer so the main-process demo state can advance
  // immediately; the filesystem mtime watcher remains a restart-safe fallback.
  useEffect(() => {
    if (!projectId) return;
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = event.data as { type?: unknown } | null;
      if (data?.type !== 'asset-demo-label-saved') return;
      void window.kunqing?.demo?.labelSaved({ projectId }).then((result) => {
        const response = result as { ok?: boolean; data?: { accepted?: boolean } } | undefined;
        // The save completes this user interaction; hide the card before the
        // next scripted asset-management message arrives.
        if (response?.ok && response.data?.accepted) {
          setPreviewOpen(false);
          setPreviewFile(null);
          setPreviewData(null);
        }
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [projectId]);

  // auto-scroll handled by VirtualMessageList

  const activeProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? { id: projectId ?? '', name: '新建协作群聊', status: 'active', lastActiveAt: '' },
    [projects, projectId],
  );
  // The fixed asset-design demo uses the conversation as the stage. Its
  // scripted progress is visible in message bubbles, while the work tree
  // remains an explicit, user-controlled view.
  const isAssetDemoProject = activeProject.name.trim() === '标品资产设计与入库';

  const generateIdempotencyKey = (): string =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const filteredMentionAgents = useMemo(() => {
    const query = mentionQuery.trim().toLocaleLowerCase('zh-CN');
    return projectAgents.filter((agent) => agent.agentName.toLocaleLowerCase('zh-CN').includes(query));
  }, [mentionQuery, projectAgents]);

  useEffect(() => {
    setMentionSelectedIndex((index) => filteredMentionAgents.length === 0 ? 0 : Math.min(index, filteredMentionAgents.length - 1));
  }, [filteredMentionAgents.length]);

  const updateMentionState = (value: string, caret: number): void => {
    const context = findMentionContext(value, caret);
    if (!context) {
      setShowMentions(false);
      setMentionContext(null);
      setMentionQuery('');
      return;
    }
    const query = context.query.trim().toLocaleLowerCase('zh-CN');
    const completedMention = /\s$/.test(context.query)
      && projectAgents.some((agent) => agent.agentName.toLocaleLowerCase('zh-CN') === query);
    const hasCandidates = projectAgents.some((agent) => agent.agentName.toLocaleLowerCase('zh-CN').includes(query));
    setMentionContext(context);
    setMentionQuery(context.query);
    setShowMentions(hasCandidates && !completedMention);
    setMentionSelectedIndex(0);
  };

  const handlePromptChange = (value: string, caret: number): void => {
    setDraft(value);
    updateMentionState(value, caret);
  };

  const insertMention = (agentName: string): void => {
    const caret = textareaRef.current?.selectionStart ?? draft.length;
    const context = mentionContext ?? findMentionContext(draft, caret);
    if (!context) return;
    const next = replaceMention(draft, context, agentName);
    setDraft(next.value);
    setShowMentions(false);
    setMentionContext(null);
    setMentionQuery('');
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const sendMessage = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);

    const content = { schemaVersion: 1 as const, text, mentions: extractMentions(text, projectAgents), stagedUploadIds: [], collaborationMode };
    let result: unknown;
    try {
      result = await window.kunqing?.messages.send({
        idempotencyKey: generateIdempotencyKey(),
        projectId: projectId ?? '',
        content,
        ...(replyingTo ? { replyToId: replyingTo.id } : {}),
      });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
    if (result && typeof result === 'object' && 'ok' in result && result.ok) {
      const data = (result as Record<string, unknown>).data as { id: string; createdAt: string; replyToId?: string | null; resumedRunId?: string; rootTriggerMessageId?: string; noteOnly?: boolean };
      const tempMsg: MessageItem = {
        id: data.id,
        senderType: 'user',
        senderId: 'local-user',
        kind: 'text',
        contentJson: JSON.stringify(content),
        status: 'sent',
        ...(data.replyToId ? { replyToId: data.replyToId } : {}),
        createdAt: data.createdAt,
      };
      setMessages((prev) => (prev.some((message) => message.id === tempMsg.id) ? prev : [...prev, tempMsg]));
      setLastSentMessageId(data.id);
      setDraft('');
      setReplyingTo(null);
      setPendingArtifact(null);
      // /note 消息不触发任何 run，跳过任务工作树自动打开（P2-18）。
      if (!data.noteOnly && !isAssetDemoProject) {
        autoOpenedTaskRef.current = data.rootTriggerMessageId ?? data.id;
        setWorkTreeOpen(true);
      }
      setPreviewOpen(false);
      setPreviewFile(null);
      setPreviewData(null);
      const url = new URL(window.location.href);
      url.searchParams.delete('preview');
      url.searchParams.delete('previewFileId');
      url.searchParams.delete('previewVersionId');
      window.history.replaceState(null, '', url.toString());
      setShowMentions(false);
      setMentionContext(null);
      setMentionQuery('');
      setEventError(null);
    } else if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
      const err = (result as Record<string, unknown>).error as { message?: string } ?? {};
      setEventError(err.message ?? '发送失败');
    }
  };

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;

    if (showMentions && filteredMentionAgents.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        setMentionSelectedIndex((index) => (index + 1) % filteredMentionAgents.length);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        setMentionSelectedIndex((index) => (index - 1 + filteredMentionAgents.length) % filteredMentionAgents.length);
        return;
      }
      if (event.key === 'Enter' && !event.ctrlKey) {
        event.preventDefault();
        const selected = filteredMentionAgents[mentionSelectedIndex] ?? filteredMentionAgents[0];
        if (selected) insertMention(selected.agentName);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowMentions(false);
        setMentionContext(null);
        return;
      }
    }

    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.ctrlKey) {
      const textarea = event.currentTarget;
      const next = insertComposerNewline(draft, textarea.selectionStart, textarea.selectionEnd);
      setDraft(next.value);
      requestAnimationFrame(() => textarea.setSelectionRange(next.caret, next.caret));
      return;
    }
    if (draft.trim() && !sending) void sendMessage();
  };

  const activeRuns = useMemo(() => Object.entries(runStatuses)
    .map(([runId, val]) => ({ runId, ...val }))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .slice(-30), [runStatuses]);
  const runningRuns = useMemo(() => activeRuns.filter((run) => !['awaiting_user', 'completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)), [activeRuns]);
  const runningCount = runningRuns.length;
  const runningAgents = useMemo(() => {
    const orderedAgentIds = projectAgents.map((agent) => agent.id);
    const uniqueAgents = new Map<string, { id: string; name: string; tone: ReturnType<typeof getAgentTone> }>();
    for (const run of runningRuns) {
      const projectAgent = projectAgents.find((agent) => agent.id === run.agentId);
      const id = projectAgent?.id ?? run.agentId ?? run.agentName ?? run.runId;
      if (uniqueAgents.has(id)) continue;
      uniqueAgents.set(id, {
        id,
        name: projectAgent?.agentName ?? run.agentName ?? '智能体',
        tone: getAgentTone(id, orderedAgentIds),
      });
    }
    return [...uniqueAgents.values()];
  }, [projectAgents, runningRuns]);
  // 聊天流末尾的执行气泡：只展示接下来会输出文本的 Run。
  // 正在等待子任务返回的 Run（例如统筹监听成员执行）只做监听，不显示
  // 气泡——成员执行时只有成员有气泡，统筹做最终总结时才重新出现。
  const runningAgentBubbles = useMemo(() => {
    const waitingParentRunIds = new Set(
      runningRuns
        .filter((run) => Boolean(run.parentRunId))
        .map((run) => run.parentRunId as string),
    );
    const speakingRuns = runningRuns.filter((run) => !waitingParentRunIds.has(run.runId));
    const orderedAgentIds = projectAgents.map((agent) => agent.id);
    const uniqueAgents = new Map<string, { id: string; name: string; tone: ReturnType<typeof getAgentTone>; streamingText: string }>();
    for (const run of speakingRuns) {
      const projectAgent = projectAgents.find((agent) => agent.id === run.agentId);
      const id = projectAgent?.id ?? run.agentId ?? run.agentName ?? run.runId;
      if (uniqueAgents.has(id)) continue;
      let streamingText = '';
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]!;
        if (message.status === 'sending' && message.senderType === 'agent' && message.senderId === id) {
          try {
            streamingText = (JSON.parse(message.contentJson) as { text?: string }).text ?? '';
          } catch {
            streamingText = '';
          }
          break;
        }
      }
      uniqueAgents.set(id, {
        id,
        name: projectAgent?.agentName ?? run.agentName ?? '智能体',
        tone: getAgentTone(id, orderedAgentIds),
        streamingText,
      });
    }
    return [...uniqueAgents.values()];
  }, [projectAgents, runningRuns, messages]);
  const rightPanelOpen = previewOpen || workTreeOpen;

  const cancelRun = async (runId: string): Promise<void> => {
    await window.kunqing?.messages.cancelRun({ runId });
  };

  const stopAllRuns = async (): Promise<void> => {
    if (!projectId || stoppingAllRuns) return;
    setStoppingAllRuns(true);
    try {
      const result = await window.kunqing?.messages.cancelProjectRuns({ projectId }) as { ok?: boolean; error?: { message?: string } } | undefined;
      if (result?.ok === false) {
        setEventError(result.error?.message ?? '停止任务失败，请重试');
        return;
      }
      setRunStatuses((current) => Object.fromEntries(Object.entries(current).map(([runId, run]) => [
        runId,
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
          ? run
          : { ...run, status: 'cancelled', updatedAt: new Date().toISOString() },
      ])));
    } catch {
      setEventError('停止任务失败，请重试');
    } finally {
      setStoppingAllRuns(false);
    }
  };

  const retryRun = async (messageId: string): Promise<void> => {
    await window.kunqing?.messages.retryRun({ idempotencyKey: generateIdempotencyKey(), runId: messageId });
  };

  const openPreview = useCallback(async (filePath: string): Promise<void> => {
    setWorkTreeOpen(false);
    setPreviewFile(filePath);
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewData(null);
    if (projectId) {
      const url = new URL(window.location.href);
      url.searchParams.set('preview', filePath);
      url.searchParams.delete('previewFileId');
      url.searchParams.delete('previewVersionId');
      window.history.replaceState(null, '', url.toString());
    }
    try {
      const result = await window.kunqing?.workspace.getPreview({ projectId: projectId ?? '', relativePath: filePath }) as { ok: boolean; data?: PreviewData } | undefined;
      if (result?.ok && result.data) {
        setPreviewData(result.data);
        if (result.data.fileId && result.data.versionId && projectId) {
          const url = new URL(window.location.href);
          url.searchParams.set('previewFileId', result.data.fileId);
          url.searchParams.set('previewVersionId', result.data.versionId);
          window.history.replaceState(null, '', url.toString());
        }
      } else {
        setPreviewData({ kind: 'unknown', fileName: filePath, error: '无法预览此文件' });
      }
    } catch {
      setPreviewData({ kind: 'unknown', fileName: filePath, error: '预览失败' });
    } finally {
      setPreviewLoading(false);
    }
  }, [projectId]);

  const openWebPreview = useCallback((sourceUrl: string): void => {
    if (!/^https?:\/\//i.test(sourceUrl)) return;
    let title = '网页预览';
    try { title = new URL(sourceUrl).hostname || title; } catch { /* validated by protocol above */ }
    setWorkTreeOpen(false);
    setPreviewFile(null);
    setPreviewOpen(true);
    setPreviewLoading(false);
    setPreviewData({ kind: 'web', fileName: title, sourceUrl });
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete('preview');
    currentUrl.searchParams.delete('previewFileId');
    currentUrl.searchParams.delete('previewVersionId');
    window.history.replaceState(null, '', currentUrl.toString());
  }, []);

  const openImagePreview = useCallback((url: string, alt?: string): void => {
    if (!url) return;
    // app-file URLs are readable by the existing protocol handler, so they
    // can be shown directly without copying or exposing the source path.
    setPreviewFile(null);
    setPreviewOpen(true);
    setPreviewLoading(false);
    setPreviewData({ kind: 'image', ...( /^app-file:\/\//i.test(url) ? { appFileUrl: url } : { dataUri: url }), fileName: alt ?? '图片' });
  }, []);

  const closePreview = (): void => {
    setPreviewOpen(false);
    setPreviewFile(null);
    setPreviewData(null);
    if (projectId) {
      const url = new URL(window.location.href);
      url.searchParams.delete('preview');
      url.searchParams.delete('previewFileId');
      url.searchParams.delete('previewVersionId');
      window.history.replaceState(null, '', url.toString());
    }
  };

  useEffect(() => {
    const active = activeRuns.filter((run) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status));
    const latest = active[active.length - 1];
    const taskId = latest?.triggerMessageId;
    if (!taskId || autoOpenedTaskRef.current === taskId) return;
    autoOpenedTaskRef.current = taskId;
    setPreviewOpen(false);
    setPreviewFile(null);
    setPreviewData(null);
    setWorkTreeOpen(true);
  }, [activeRuns]);

  useEffect(() => {
    if (!pendingArtifact) return;
    const taskRuns = activeRuns.filter((run) => (
      pendingArtifact.triggerMessageId
        ? run.triggerMessageId === pendingArtifact.triggerMessageId
        : pendingArtifact.runId
          ? run.runId === pendingArtifact.runId
          : false
    ));
    if (taskRuns.length === 0 || taskRuns.some((run) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status))) return;
    const path = pendingArtifact.path;
    setPendingArtifact(null);
    void openPreview(path);
  }, [activeRuns, openPreview, pendingArtifact]);

  useEffect(() => {
    if (!enlargedImage) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setEnlargedImage(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enlargedImage]);

  const toggleWorkTree = (): void => {
    if (workTreeOpen) {
      setWorkTreeOpen(false);
      return;
    }
    if (previewOpen) closePreview();
    setWorkTreeOpen(true);
  };

  const loadMore = (): void => {
    if (messages.length > 0) {
      void loadMessages(messages[0]?.createdAt);
    }
  };

  const renameProject = async (): Promise<void> => {
    const name = renameValue.trim();
    if (!name) {
      setRenameError('请输入群聊名称');
      return;
    }
    setProjectActionBusy(true);
    const result = await window.kunqing?.projects.rename({ projectId: projectId ?? '', name }) as { ok: boolean } | undefined;
    setProjectActionBusy(false);
    if (!result?.ok) {
      setRenameError('重命名失败，请重试');
      return;
    }
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, name } : project));
    setRenameOpen(false);
  };

  const dissolveProject = async (): Promise<void> => {
    if (!projectId) return;
    setProjectActionBusy(true);
    await window.kunqing?.messages.cancelProjectRuns({ projectId });
    const result = await window.kunqing?.projects.archive({ projectId }) as { ok: boolean } | undefined;
    setProjectActionBusy(false);
    if (!result?.ok) return;
    const remainingProjects = projects.filter((project) => project.id !== projectId);
    setProjects(remainingProjects);
    setDissolveOpen(false);
    navigate(remainingProjects[0] ? `/projects/${remainingProjects[0].id}/chat` : '/');
  };

  return (
    <div className={`chat-workspace${rightPanelOpen ? '' : ' chat-workspace--preview-closed'}${projectPanelOpen ? '' : ' chat-workspace--panel-closed'}`}>
      {projectPanelOpen && <aside className="project-panel project-panel--open" aria-label="项目协作群组">
        <div className="project-panel__header">
          <button type="button" className="icon-button project-panel-toggle" aria-label="收起项目栏" title="收起项目栏" onClick={() => setProjectPanelOpen(false)}>
            <PanelLeftClose size={18} />
          </button>
          <h2>项目协作群组</h2>
          <button type="button" className="icon-button project-panel-create" aria-label="创建群组" title="创建群组" onClick={() => window.dispatchEvent(new Event('kunqing:open-new-chat'))}>
            <Plus size={17} />
          </button>
        </div>
        <div className="project-panel__resize-handle" onMouseDown={startResize} />
        <div className="project-list">
          {projects.length === 0 && <div className="file-empty" style={{ padding: '24px 16px' }}>暂无项目</div>}
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className={`project-list-item${project.id === projectId ? ' project-list-item--active' : ''}`}
              onClick={() => navigate(`/projects/${project.id}/chat`)}
            >
              <NameAvatar name={project.name} />
              <span className="project-list-item__body">
                <span className="project-list-item__title"><strong>{project.name}</strong><time>{formatSidebarTime(project.lastActiveAt)}</time></span>
                {(() => {
                const association = projectAssociationLabel(enterpriseProjects, projectAssociations, 'group', project.id);
                return <span className="project-list-item__meta"><span className="project-list-item__status"><i className={`project-status-dot project-status-dot--${project.status.toLowerCase()}`} />{project.status === 'active' ? '进行中' : project.status}</span><small className={association.linked ? 'project-association project-association--linked' : 'project-association project-association--unlinked'}>{association.name}</small></span>;
                })()}
              </span>
            </button>
          ))}
        </div>
      </aside>}

      <section className="conversation-panel">
        <header className="conversation-header">
          <div className="conversation-title">
            {!projectPanelOpen && <button type="button" className="icon-button project-panel-toggle" aria-label="展开项目栏" title="展开项目栏" onClick={() => setProjectPanelOpen(true)}>
              <PanelLeftOpen size={18} />
            </button>}
            <div className="avatar-stack avatar-stack--header">
              {projectAgents.map((agent, i) => (
                <AgentAvatar key={agent.id} label={agent.agentName} tone={AGENT_TONES[i % AGENT_TONES.length]!} size="sm" overlap={i > 0} />
              ))}
            </div>
            <div>
              <h2>{activeProject.name}</h2>
              <p><span className="online-dot" /> {projectAgents.length} 个智能体{projectAgents.length > 0 ? '待命中' : ''}</p>
            </div>
          </div>
          <div className="conversation-actions">
            <button type="button" className="icon-button" aria-label="添加智能体" title="添加智能体" onClick={() => setAddAgentsOpen(true)}><UserPlus size={18} /></button>
            <button type="button" className="icon-button" aria-label="打开工作区" onClick={() => navigate(`/projects/${projectId}/workspace`)}><FolderOpen size={18} /></button>
            <button type="button" className="icon-button" aria-label="记忆管理" onClick={() => setMemoryManagerOpen(true)} title="记忆"><Brain size={18} /></button>
            <button
              type="button"
              className={`icon-button${workTreeOpen ? ' icon-button--active' : ''}`}
              aria-label={workTreeOpen ? '关闭工作树' : '打开工作树'}
              title="工作树"
              onClick={toggleWorkTree}
            ><Network size={18} /></button>
            <button type="button" className={`icon-button${previewOpen ? ' icon-button--active' : ''}`} aria-label={previewOpen ? '关闭成果预览' : '打开成果预览'} title="成果预览" onClick={() => {
              if (previewOpen) closePreview();
              else { setWorkTreeOpen(false); setPreviewOpen(true); }
            }}><FileText size={18} /></button>
            <div className="conversation-more">
              <button type="button" className={`icon-button${moreMenuOpen ? ' icon-button--active' : ''}`} aria-label="更多操作" title="更多操作" onClick={() => setMoreMenuOpen((value) => !value)}><MoreVertical size={18} /></button>
              {moreMenuOpen && <div className="conversation-more-menu">
                <button type="button" onClick={() => { setMoreMenuOpen(false); setRenameValue(activeProject.name); setRenameError(''); setRenameOpen(true); }}><Pencil size={15} />重命名</button>
                <button type="button" onClick={() => { setMoreMenuOpen(false); setAssociateProjectOpen(true); }}><FolderOpen size={15} />关联项目</button>
                <button type="button" onClick={() => { setMoreMenuOpen(false); setChannelBindOpen(true); }}><Link size={15} />绑定渠道会话</button>
                <button type="button" className="conversation-more-menu__danger" onClick={() => { setMoreMenuOpen(false); setDissolveOpen(true); }}><Trash2 size={15} />解散群聊</button>
              </div>}
            </div>
          </div>
        </header>

        <VirtualMessageList
          key={projectId}
          messages={messages}
          projectAgents={projectAgents}
          hasMore={hasMore}
          loading={loading}
          projectId={projectId}
          initialScrollOffset={scrollOffset}
          onScrollOffsetChange={setScrollOffset}
          onLoadMore={loadMore}
          onRetryRun={retryRun}
          onPreviewFile={openPreview}
          onPreviewUrl={openWebPreview}
          onPreviewImage={(url, alt) => { void openImagePreview(url, alt); }}
          onReplyMessage={(message) => { setReplyingTo(message); requestAnimationFrame(() => textareaRef.current?.focus()); }}
          userProfile={userProfile}
          scrollToBottomSignal={lastSentMessageId}
          runningAgents={runningAgentBubbles}
        />

        {eventError && <div className="composer-error"><AlertTriangle size={14} />{eventError}<button type="button" className="icon-button" onClick={() => setEventError(null)}><X size={14} /></button></div>}
        {runningCount > 0 && (
          <div className="composer-execution-dock" role="status" aria-label={`${runningAgents.map((agent) => agent.name).join('、')}执行中`}>
            <div className="composer-execution-pill">
              <span className="composer-execution-pill__avatars" aria-hidden="true">
                {runningAgents.slice(0, 3).map((agent, index) => (
                  <AgentAvatar key={agent.id} label={agent.name} tone={agent.tone} size="sm" overlap={index > 0} />
                ))}
                {runningAgents.length > 3 && <span className="composer-execution-pill__overflow">+{runningAgents.length - 3}</span>}
              </span>
              <span className="composer-execution-pill__label">
                执行中
                <span className="composer-execution-pill__dots" aria-hidden="true"><i /><i /><i /></span>
              </span>
              <button
                type="button"
                className="composer-execution-pill__stop"
                aria-label="停止全部任务"
                title="停止全部任务"
                disabled={stoppingAllRuns}
                onClick={() => { void stopAllRuns(); }}
              >
                <Square size={9} fill="currentColor" strokeWidth={0} />
              </button>
            </div>
          </div>
        )}
        <form className="chat-composer-wrap" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          {replyingTo && (
            <div className="composer-reply-reference">
              <button type="button" className="icon-button" aria-label="取消回复" onClick={() => setReplyingTo(null)}><X size={15} /></button>
              <div>
                <strong>回复 {replyingTo.senderType === 'user'
                  ? userProfile.nickname
                  : projectAgents.find((agent) => agent.id === replyingTo.senderId)?.agentName ?? '智能体'}</strong>
                {(() => {
                  let fullText = '文件消息';
                  try { fullText = (JSON.parse(replyingTo.contentJson) as { text?: string }).text ?? fullText; } catch { /* use fallback */ }
                  return <span title={fullText}>{formatReplyPreview(fullText)}</span>;
                })()}
              </div>
            </div>
          )}
          <div className="chat-composer">
            <button type="button" className="composer-tool" aria-label="添加附件" onClick={() => { if (projectId) void window.kunqing?.workspace.uploadFiles({ projectId }); }}><Paperclip size={17} /></button>
            <textarea
              ref={textareaRef}
              aria-label="发送消息给智能体小组"
              placeholder="发送消息给智能体小组..."
              value={draft}
              onChange={(event) => handlePromptChange(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
              onSelect={(event) => updateMentionState(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
              onKeyDown={handleComposerKeyDown}
              disabled={sending}
            />
            {showMentions && (
              <div className="mention-popup">
                {filteredMentionAgents.map((agent, index) => (
                    <button
                      type="button"
                      key={agent.id}
                      className={`mention-option${index === mentionSelectedIndex ? ' mention-option--active' : ''}`}
                      aria-selected={index === mentionSelectedIndex}
                      onMouseDown={(event) => { event.preventDefault(); insertMention(agent.agentName); }}
                    >
                      {agent.agentName}
                    </button>
                  ))}
              </div>
            )}
            <button className="chat-send" type="submit" disabled={!draft.trim() || sending} aria-label="发送消息">
              {sending ? <Sparkles size={17} /> : <Send size={17} />}
            </button>
          </div>
          <div className="composer-footer">
            <div className="collaboration-mode-switch" role="group" aria-label="协同模式">
              <button type="button" className={collaborationMode === 'fast' ? 'is-active' : ''} aria-pressed={collaborationMode === 'fast'} title="以最少必要步骤完成任务" onClick={() => changeCollaborationMode('fast')}><Zap size={13} />快速</button>
              <button type="button" className={collaborationMode === 'balanced' ? 'is-active' : ''} aria-pressed={collaborationMode === 'balanced'} title="在速度与完整性之间保持均衡" onClick={() => changeCollaborationMode('balanced')}><Sparkles size={13} />均衡</button>
              <button type="button" className={collaborationMode === 'expert' ? 'is-active' : ''} aria-pressed={collaborationMode === 'expert'} title="完整规划、核验与恢复循环，适合复杂和高质量任务" onClick={() => changeCollaborationMode('expert')}><Brain size={13} />专家</button>
            </div>
            <span><Sparkles size={12} /> AI 正在监控工作流合规性</span>
          </div>
        </form>
      </section>

      {workTreeOpen ? (
        <aside className="artifact-preview task-worktree-panel" aria-label="完整任务工作树">
          <div className="preview-resize-handle" role="separator" aria-label="调整对话与工作树宽度" onMouseDown={startPreviewResize} />
          <header className="preview-header task-worktree-header">
            <div><Network size={18} /><strong>工作树</strong>{runningCount > 0 && <span>{runningCount} 个节点执行中</span>}</div>
            <div className="task-worktree-header__actions">
              <div className="worktree-view-switch" role="group" aria-label="工作树视图">
                <button type="button" className={workTreeView === 'tree' ? 'worktree-view-switch__active' : ''} aria-label="树结构视图" title="树结构视图" onClick={() => setWorkTreeView('tree')}><ListTree size={16} /></button>
                <button type="button" className={workTreeView === 'flow' ? 'worktree-view-switch__active' : ''} aria-label="流程视图" title="流程视图" onClick={() => setWorkTreeView('flow')}><Workflow size={16} /></button>
              </div>
              <button type="button" className="icon-button" aria-label="关闭工作树" onClick={() => setWorkTreeOpen(false)}><X size={18} /></button>
            </div>
          </header>
          {workTreeView === 'tree'
            ? <TaskWorkTreePanel runs={activeRuns} messages={messages} projectAgents={projectAgents} onCancelRun={cancelRun} />
            : <TaskWorkFlowPanel runs={activeRuns} messages={messages} />}
        </aside>
      ) : previewOpen && (
        <aside className="artifact-preview" aria-label="成果文件预览">
          <div className="preview-resize-handle" role="separator" aria-label="调整对话与预览宽度" onMouseDown={startPreviewResize} />
          <header className="preview-header">
            <div>{previewData?.kind === 'web' ? <Globe2 size={18} /> : <FileText size={18} />}<strong title={previewData?.sourceUrl}>{previewData?.fileName ? previewData.fileName : (previewFile ?? '项目摘要')}</strong></div>
            <div>
              {previewData?.kind === 'web' && previewData.sourceUrl && (
                <button type="button" className="icon-button" aria-label="使用系统浏览器打开" title="浏览器打开" onClick={() => { void window.kunqing?.app.openExternal({ url: previewData.sourceUrl! }); }}>
                  <ExternalLink size={17} />
                </button>
              )}
              {previewFile && !previewLoading && !previewData?.error && (
                <button type="button" className="icon-button" aria-label="使用系统应用打开" title="系统打开" onClick={() => { void window.kunqing?.workspace.openWithSystem({ projectId: projectId ?? '', relativePath: previewFile }); }}>
                  <ExternalLink size={17} />
                </button>
              )}
              <button type="button" className="icon-button" aria-label="关闭预览" onClick={closePreview}><X size={18} /></button>
            </div>
          </header>
          <div className={`preview-scroll${previewData?.kind === 'html' || previewData?.kind === 'pdf' || previewData?.kind === 'web' ? ' preview-scroll--document' : ''}`}>
            {previewLoading ? (
              <div className="file-empty" style={{ padding: '40px' }}><Loader2 size={34} className="spin" /><span>正在加载预览…</span></div>
            ) : previewData ? (
              previewData.error ? (
                <div className="file-empty" style={{ padding: '40px' }}><FileText size={34} /><span>{previewData.error}</span></div>
              ) : previewData.kind === 'image' && (previewData.dataUri || previewData.appFileUrl) ? (
                <div style={{ padding: '16px', textAlign: 'center' }}><img src={previewData.dataUri ?? previewData.appFileUrl} alt={previewData.fileName} style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', cursor: 'zoom-in' }} onClick={() => setEnlargedImage({ url: previewData.dataUri ?? previewData.appFileUrl!, alt: previewData.fileName })} /></div>
              ) : previewData.kind === 'pdf' && previewData.appFileUrl ? (
                <iframe src={previewData.appFileUrl} className="preview-iframe" title="PDF 预览" style={{ width: '100%', flex: 1, border: 'none' }} />
              ) : previewData.kind === 'html' && previewData.appFileUrl ? (
                <iframe
                  src={previewData.appFileUrl}
                  className="preview-iframe"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
                  referrerPolicy="no-referrer"
                  title="HTML 预览"
                />
              ) : previewData.kind === 'web' && previewData.sourceUrl ? (
                <iframe
                  src={previewData.sourceUrl}
                  className="preview-iframe preview-iframe--web"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                  referrerPolicy="no-referrer"
                  title={`网页预览 ${previewData.fileName}`}
                />
              ) : previewData.kind === 'text' ? (
                <pre className="preview-content" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '10px', lineHeight: 1.6 }}>{previewData.content}</pre>
              ) : (
                <div className="file-empty" style={{ padding: '40px' }}><FileText size={34} /><span>该文件类型暂不支持预览</span></div>
              )
            ) : (
              <div className="file-empty" style={{ padding: '40px' }}><FileText size={34} /><strong>暂无成果文件</strong><span>点击消息中的成果文件进行预览</span></div>
            )}
          </div>
        </aside>
      )}
      {enlargedImage && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={enlargedImage.alt ?? '图片预览'} onMouseDown={(event) => { if (event.target === event.currentTarget) setEnlargedImage(null); }}>
          <button type="button" className="icon-button image-lightbox__close" aria-label="关闭图片预览" title="关闭" onClick={() => setEnlargedImage(null)}><X size={20} /></button>
          <img src={enlargedImage.url} alt={enlargedImage.alt ?? '图片'} />
        </div>
      )}
      {memoryManagerOpen && (
        <MemoryManager
          projectId={projectId ?? ''}
          agents={projectAgents}
          initialAgentInstanceId={projectAgents.find((agent) => agent.role === 'leader')?.id ?? projectAgents[0]?.id ?? ''}
          onClose={() => setMemoryManagerOpen(false)}
        />
      )}
      {addAgentsOpen && (
        <AddAgentsModal projectId={projectId ?? ''} existingAgents={projectAgents} onClose={() => setAddAgentsOpen(false)} onAdded={setProjectAgents} />
      )}
      {renameOpen && (
        <div className="modal-backdrop modal-backdrop--nested" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setRenameOpen(false)}>
          <div className="project-action-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-project-title">
            <header><div><h3 id="rename-project-title">重命名群聊</h3><p>群聊工作区路径与历史数据不会改变。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setRenameOpen(false)}><X size={18} /></button></header>
            <label><span>群聊名称</span><input autoFocus className={renameError ? 'input-invalid' : ''} value={renameValue} onChange={(event) => { setRenameValue(event.target.value); setRenameError(''); }} onKeyDown={(event) => event.key === 'Enter' && void renameProject()} />{renameError && <small>{renameError}</small>}</label>
            <footer><button type="button" className="secondary-button" onClick={() => setRenameOpen(false)}>取消</button><button type="button" className="primary-button" disabled={projectActionBusy} onClick={() => void renameProject()}>{projectActionBusy ? '保存中…' : '保存'}</button></footer>
          </div>
        </div>
      )}
      {dissolveOpen && (
        <div className="modal-backdrop modal-backdrop--nested" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDissolveOpen(false)}>
          <div className="project-action-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dissolve-project-title">
            <header><div><h3 id="dissolve-project-title">确认解散群聊？</h3><p>解散后该群聊不会再出现在项目列表中，但本地工作区文件会完整保留。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setDissolveOpen(false)}><X size={18} /></button></header>
            <div className="project-action-dialog__warning"><AlertTriangle size={17} /><span>这是二次确认操作。当前正在执行的智能体任务将停止。</span></div>
            <footer><button type="button" className="secondary-button" onClick={() => setDissolveOpen(false)}>取消</button><button type="button" className="primary-button danger" disabled={projectActionBusy} onClick={() => void dissolveProject()}>{projectActionBusy ? '处理中…' : '确认解散'}</button></footer>
          </div>
        </div>
      )}
      {channelBindOpen && (
        <ChannelBindingsDialog projectId={projectId ?? ''} projectName={activeProject.name} onClose={() => setChannelBindOpen(false)} />
      )}
      {associateProjectOpen && projectId && (
        <AssociateProjectDialog
          kind="group"
          resourceId={projectId}
          resourceName={activeProject.name}
          onClose={() => setAssociateProjectOpen(false)}
          onSaved={(available, associations) => { setEnterpriseProjects(available); setProjectAssociations(associations); }}
        />
      )}
    </div>
  );
}
