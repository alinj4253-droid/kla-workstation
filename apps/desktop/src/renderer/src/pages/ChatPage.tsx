import {
  AlertTriangle, Brain, ExternalLink, FileText, FolderOpen, Link, ListTree, Loader2, MoreVertical, Network,
  PanelLeftClose, PanelLeftOpen, Paperclip, Pencil, Send, Sparkles, Square, Trash2, UserPlus, Workflow, X,
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
import { displayAgentText, extractMentions, findMentionContext, insertComposerNewline, replaceMention, type MentionContext } from '../chat-input-utils';
import type { BusinessProcess } from '@kunqing/native-agent-core';

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

interface PerProjectState {
  draft: string;
  previewOpen: boolean;
  workTreeOpen: boolean;
  scrollOffset: number;
}

interface PreviewData {
  kind: 'text' | 'image' | 'unknown' | 'html' | 'pdf';
  content?: string;
  dataUri?: string;
  appFileUrl?: string;
  mimeType?: string;
  fileName: string;
  fileId?: string;
  versionId?: string;
  error?: string;
}

const DEFAULT_PROJECT_STATE: PerProjectState = { draft: '', previewOpen: false, workTreeOpen: false, scrollOffset: 0 };

export function ChatPage(): React.JSX.Element {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [draft, setDraft] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [workTreeOpen, setWorkTreeOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [runStatuses, setRunStatuses] = useState<Record<string, RunActivity>>({});
  const [eventError, setEventError] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
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

  const loadProjects = useCallback(async () => {
    const result = await window.kunqing?.projects.list({} as Record<string, never>);
    if (result && typeof result === 'object' && 'ok' in result && result.ok) {
      setProjects((result as Record<string, unknown>).data as ProjectItem[]);
    }
  }, []);

  const loadMessages = useCallback(async (before?: string) => {
    if (!projectId) return;
    const result = before
      ? await window.kunqing?.messages.list({ projectId, before, limit: 50 })
      : await window.kunqing?.messages.list({ projectId, limit: 50 });
    if (result && typeof result === 'object' && 'ok' in result && result.ok) {
      const data = (result as Record<string, unknown>).data as { messages: MessageItem[]; hasMore: boolean };
      if (before) {
        setMessages((prev) => [...data.messages, ...prev]);
      } else {
        setMessages(data.messages);
      }
      setHasMore(data.hasMore);
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
    setShowMentions(false);
    setMentionContext(null);
    setMentionSelectedIndex(0);
    setRunStatuses({});
    setLoading(true);
    void loadProjects();
    void loadMessages();
    void loadRunActivities();
    window.kunqing?.agents.getProjectInstances({ projectId }).then((result) => {
      const r = result as { ok: boolean; data?: AgentInstance[] } | undefined;
      if (r?.ok && r.data) setProjectAgents(r.data);
    });
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const unsubscribe = window.kunqing?.events.subscribe((raw) => {
      const event = raw as { type: string; projectId?: string; [key: string]: unknown };
      if (event.projectId && event.projectId !== projectId) return;

      switch (event.type) {
        case 'message.delta': {
          // 中间流式片段只属于右侧工作过程，提交前不进入正式消息流。
          break;
        }
        case 'message.committed': {
          const { messageId, senderId, content } = event as { type: 'message.committed'; projectId: string; messageId: string; senderId: string; content: string };
          setMessages((prev) => {
            if (prev.some((m) => m.id === messageId)) return prev;
            return [...prev, { id: messageId, senderType: 'agent', senderId: senderId ?? '', kind: 'text', contentJson: content, status: 'sent', createdAt: new Date().toISOString() }];
          });
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
            // 添加错误消息到聊天
            const errorMsg: MessageItem = {
              id: `err-${run.id}`,
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
  }, [projectId, projectAgents]);

  // auto-scroll handled by VirtualMessageList

  const activeProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? { id: projectId ?? '', name: '新建协作群聊', status: 'active', lastActiveAt: '' },
    [projects, projectId],
  );

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
    if (!text || sending) return;
    setSending(true);

    const content = { schemaVersion: 1 as const, text, mentions: extractMentions(text, projectAgents), stagedUploadIds: [] };
    const result = await window.kunqing?.messages.send({
      idempotencyKey: generateIdempotencyKey(),
      projectId: projectId ?? '',
      content,
    });

    setSending(false);
    if (result && typeof result === 'object' && 'ok' in result && result.ok) {
      const data = (result as Record<string, unknown>).data as { id: string; createdAt: string };
      const tempMsg: MessageItem = {
        id: data.id,
        senderType: 'user',
        senderId: 'local-user',
        kind: 'text',
        contentJson: JSON.stringify(content),
        status: 'sent',
        createdAt: data.createdAt,
      };
      setMessages((prev) => [...prev, tempMsg]);
      setDraft('');
      setPendingArtifact(null);
      autoOpenedTaskRef.current = data.id;
      setPreviewOpen(false);
      setPreviewFile(null);
      setPreviewData(null);
      setWorkTreeOpen(true);
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
  const runningRuns = useMemo(() => activeRuns.filter((run) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)), [activeRuns]);
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
              <strong>{project.name}</strong>
              <span className="project-list-item__status"><i className={`project-status-dot project-status-dot--${project.status.toLowerCase()}`} />{project.status === 'active' ? '进行中' : project.status}</span>
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
          <p><Sparkles size={12} /> AI 正在监控工作流合规性</p>
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
            <div><FileText size={18} /><strong>{previewData?.fileName ? previewData.fileName : (previewFile ?? '项目摘要')}</strong></div>
            <div>
              {previewFile && !previewLoading && !previewData?.error && (
                <button type="button" className="icon-button" aria-label="使用系统应用打开" title="系统打开" onClick={() => { void window.kunqing?.workspace.openWithSystem({ projectId: projectId ?? '', relativePath: previewFile }); }}>
                  <ExternalLink size={17} />
                </button>
              )}
              <button type="button" className="icon-button" aria-label="关闭预览" onClick={closePreview}><X size={18} /></button>
            </div>
          </header>
          <div className={`preview-scroll${previewData?.kind === 'html' || previewData?.kind === 'pdf' ? ' preview-scroll--document' : ''}`}>
            {previewLoading ? (
              <div className="file-empty" style={{ padding: '40px' }}><Loader2 size={34} className="spin" /><span>正在加载预览…</span></div>
            ) : previewData ? (
              previewData.error ? (
                <div className="file-empty" style={{ padding: '40px' }}><FileText size={34} /><span>{previewData.error}</span></div>
              ) : previewData.kind === 'image' && previewData.dataUri ? (
                <div style={{ padding: '16px', textAlign: 'center' }}><img src={previewData.dataUri} alt={previewData.fileName} style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} /></div>
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
    </div>
  );
}
