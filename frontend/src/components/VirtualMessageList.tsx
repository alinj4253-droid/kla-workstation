import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, CircleDashed, Clock3, FileOutput, FileText, GitBranch, Loader2, RefreshCw, Square, Wrench, XCircle } from 'lucide-react';
import { MarkdownMessage, type ConfirmedMention } from './MarkdownMessage';
import { AgentAvatar, getAgentTone } from './AgentAvatar';
import { displayAgentText, formatReplyPreview } from '../chat-input-utils';
import type { BusinessProcess } from '@kunqing/native-agent-core';

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

const parseContent = (json: string): { text: string; mentions: ConfirmedMention[]; messageType?: string } => {
  try {
    const parsed = JSON.parse(json) as { text?: unknown; mentions?: unknown; messageType?: unknown };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      mentions: Array.isArray(parsed.mentions) ? parsed.mentions as ConfirmedMention[] : [],
      ...(typeof parsed.messageType === 'string' ? { messageType: parsed.messageType } : {}),
    };
  } catch {
    return { text: json, mentions: [] };
  }
};

export type RunActivity = {
  runId: string;
  status: string;
  agentId?: string;
  agentName?: string;
  anchorMessageId?: string;
  triggerMessageId?: string;
  parentRunId?: string;
  requestedByType?: string;
  requestedById?: string;
  createdAt?: string;
  stage?: string;
  progress?: number;
  updatedAt: string;
  traces: Array<{ id: string; kind: 'plan' | 'reasoning' | 'handoff' | 'tool' | 'execution' | 'file' | 'warning'; title: string; detail?: string; status: 'running' | 'completed' | 'failed'; at: string }>;
  checklist?: { items: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'failed'; detail?: string }>; updatedAt: string };
  businessProcess?: BusinessProcess;
};

// 执行中的智能体在聊天流末尾渲染为一个动态气泡：
// 无输出时展示「正在执行任务」动画，开始输出后在同一气泡内流式展示文本。
export type RunningAgentBubble = {
  id: string;
  name: string;
  tone: ReturnType<typeof getAgentTone>;
  streamingText: string;
};

const isLegacyMechanicalProgress = (message: MessageItem): boolean => {
  if (message.senderType !== 'agent') return false;
  const { text, messageType } = parseContent(message.contentJson);
  if (messageType !== 'progress') return false;
  return /^(?:#{1,6}\s*)?(?:调度进度|子任务进度|协作安排|开始执行|开始知识处理)(?:\s|$)/m.test(text.trim())
    || /已通过群聊消息将\s*\d+\s*个执行项分配给对应智能体，正在等待结果返回/.test(text)
    || /\d+\s*个执行项已完成，\s*\d+\s*个执行项未完成。正在进行结果验收与汇总/.test(text);
};

const getArtifactDisplay = (filePath: string): { fileName: string; fileType: string } => {
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toUpperCase() : undefined;
  return { fileName, fileType: extension ? `${extension} 文件` : '成果文件' };
};

interface VirtualMessageListProps {
  messages: MessageItem[];
  projectAgents: Array<{ id: string; agentName: string }>;
  hasMore: boolean;
  loading: boolean;
  projectId: string | undefined;
  initialScrollOffset?: number;
  onScrollOffsetChange?: (offset: number) => void;
  onLoadMore: () => void;
  onRetryRun: (messageId: string) => void;
  onPreviewFile?: (filePath: string) => void;
  onPreviewUrl?: (url: string) => void;
  onPreviewImage?: (url: string, alt?: string) => void;
  onReplyMessage?: (message: MessageItem) => void;
  userProfile?: { nickname: string; avatarDataUrl?: string };
  scrollToBottomSignal?: string | null;
  runningAgents?: RunningAgentBubble[];
}

type VirtualItem =
  | { kind: 'load-more' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'message'; msg: MessageItem }
  | { kind: 'running-agent'; agent: RunningAgentBubble };

export function VirtualMessageList({
  messages,
  projectAgents,
  hasMore,
  loading,
  projectId,
  initialScrollOffset,
  onScrollOffsetChange,
  onLoadMore,
  onRetryRun,
  onPreviewFile,
  onPreviewUrl,
  onPreviewImage,
  onReplyMessage,
  userProfile = { nickname: '项目负责人' },
  scrollToBottomSignal,
  runningAgents = [],
}: VirtualMessageListProps): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; message: MessageItem } | null>(null);

  useEffect(() => {
    const close = (): void => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, []);

  const allItems = useCallback((): VirtualItem[] => {
    if (loading) {
      return [{ kind: 'loading' }];
    }

    const items: VirtualItem[] = [];

    if (messages.length === 0 && runningAgents.length === 0) {
      items.push({ kind: 'empty' });
      return items;
    }

    // 执行中智能体的流式占位消息（sending）由末尾的动态气泡接管渲染，
    // 这里跳过，避免同一段流式文本在聊天流里出现两份。
    const runningAgentIds = new Set(runningAgents.map((agent) => agent.id));
    const visibleMessages = messages.filter((message) => !isLegacyMechanicalProgress(message)
      && !(message.status === 'sending' && message.senderType === 'agent' && runningAgentIds.has(message.senderId)));
    for (const msg of visibleMessages) {
      items.push({ kind: 'message', msg });
    }
    for (const agent of runningAgents) {
      items.push({ kind: 'running-agent', agent });
    }
    return items;
  }, [messages, hasMore, loading, runningAgents]);

  // Auto-scroll to bottom when new messages arrive
  const prevItemCount = useRef(0);
  useEffect(() => {
    const items = allItems();
    const count = items.length;
    const parent = parentRef.current;
    if (!parent) return;

    if (count > prevItemCount.current) {
      const threshold = 400;
      const isNearBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight < threshold;
      if (isNearBottom) {
        requestAnimationFrame(() => {
          parent.scrollTop = parent.scrollHeight;
        });
      }
    }
    prevItemCount.current = count;
  }, [allItems]);

  useEffect(() => {
    if (!scrollToBottomSignal) return;
    const parent = parentRef.current;
    if (!parent) return;
    const distanceFromBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight;
    if (distanceFromBottom <= 2) return;
    requestAnimationFrame(() => {
      parent.scrollTop = parent.scrollHeight;
    });
  }, [scrollToBottomSignal]);

  // 执行气泡内的流式文本持续增长时，若视口停留在底部附近则跟随滚动，
  // 让「正在执行任务」到流式输出的切换始终保持在可视区域内。
  const streamingSignature = runningAgents.map((agent) => `${agent.id}:${agent.streamingText.length}`).join('|');
  useEffect(() => {
    if (!streamingSignature) return;
    const parent = parentRef.current;
    if (!parent) return;
    const isNearBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight < 160;
    if (!isNearBottom) return;
    requestAnimationFrame(() => {
      parent.scrollTop = parent.scrollHeight;
    });
  }, [streamingSignature]);

  // Restore scroll position on initial mount
  useEffect(() => {
    if (initialScrollOffset !== undefined && parentRef.current) {
      parentRef.current.scrollTop = initialScrollOffset;
    }
  }, []);

  const handleScroll = useCallback(() => {
    const parent = parentRef.current;
    if (!parent) return;

    if (parent.scrollTop < 80 && hasMore && !loading) {
      onLoadMore();
    }

    onScrollOffsetChange?.(parent.scrollTop);
  }, [hasMore, loading, onLoadMore, onScrollOffsetChange]);

  const formatTime = (iso: string): string => {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  const senderDisplay = (msg: MessageItem): string => {
    if (msg.senderType === 'user') return `${userProfile.nickname} (You)`;
    if (msg.senderType === 'agent') {
      const agent = projectAgents.find((a) => a.id === msg.senderId);
      return agent?.agentName ?? '智能体';
    }
    return '系统';
  };

  const roleClass = (msg: MessageItem): string => msg.senderType === 'user' ? 'user' : 'agent';

  const items = allItems();
  return (
    <div ref={parentRef} className="message-stream" onScroll={handleScroll}>
      {hasMore && (
        <div style={{ textAlign: 'center', padding: '12px 0' }}>
          <button type="button" className="load-more" onClick={onLoadMore}>
            加载更多消息
          </button>
        </div>
      )}

      {items.map((item, index) => {
        if (item.kind === 'loading') {
          return (
            <div key="loading" className="file-empty" style={{ padding: '40px' }}>
              加载中...
            </div>
          );
        }

        if (item.kind === 'empty') {
          return (
            <div key="empty" className="file-empty" style={{ padding: '40px' }}>
              <strong>开始对话</strong>
              <span>发送一条消息开始与智能体协作文档</span>
            </div>
          );
        }

        if (item.kind === 'message') {
          const { text, mentions } = parseContent(item.msg.contentJson);
          const displayText = item.msg.kind === 'artifact' ? text : displayAgentText(text, projectAgents);
          const role = roleClass(item.msg);
          const quotedMessage = item.msg.replyToId ? messages.find((message) => message.id === item.msg.replyToId) : undefined;
          const quotedText = quotedMessage ? parseContent(quotedMessage.contentJson).text : '';
          const quotedPreview = formatReplyPreview(quotedText || '文件消息');
          return (
            <div
              key={item.msg.id}
              className="message-entry"
              onContextMenu={(event) => {
                event.preventDefault();
                const menuWidth = 152;
                const menuHeight = 48;
                const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
                const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8));
                setContextMenu({ x, y, message: item.msg });
              }}
            >
            <article className={`message-row message-row--${role}`}>
              {item.msg.senderType !== 'user' && (
                <AgentAvatar
                  label={senderDisplay(item.msg)}
                  tone={getAgentTone(item.msg.senderId, projectAgents.map((agent) => agent.id))}
                  size="md"
                />
              )}
              <div className="message-body">
                <div className="message-sender">
                  <strong>{senderDisplay(item.msg)}</strong>
                  <time>{formatTime(item.msg.createdAt)}</time>
                  {item.msg.status === 'failed' && (
                    <button type="button" className="icon-button" aria-label="重试" onClick={() => onRetryRun(item.msg.id)}><RefreshCw size={13} /></button>
                  )}
                </div>
                <div className={`message-bubble${item.msg.kind === 'warning' ? ' message-bubble--warning' : ''}`}>
                  {quotedMessage && (
                    <div className="message-reply-reference">
                      <strong>{senderDisplay(quotedMessage)}</strong>
                      <span title={quotedText || '文件消息'}>{quotedPreview}</span>
                    </div>
                  )}
                  {item.msg.kind === 'artifact' ? (
                    <button
                      type="button"
                      className="artifact-inline"
                      onClick={() => onPreviewFile?.(displayText)}
                      title={`在右侧预览 ${getArtifactDisplay(displayText).fileName}`}
                    >
                      <span className="artifact-inline__icon"><FileText size={18} /></span>
                      <span className="artifact-inline__meta">
                        <strong>{getArtifactDisplay(displayText).fileName}</strong>
                        <small>{getArtifactDisplay(displayText).fileType}</small>
                      </span>
                      <em>右侧预览</em>
                    </button>
                  ) : (
                    <MarkdownMessage content={displayText} mentions={mentions} {...(onPreviewUrl ? { onOpenLink: onPreviewUrl } : {})} {...(onPreviewImage ? { onOpenImage: onPreviewImage } : {})} />
                  )}
                  {item.msg.status === 'failed' && <span className="error-tag">发送失败</span>}
                  {item.msg.status === 'sending' && <span className="message-streaming-caret" aria-label="正在生成" />}
                </div>
              </div>
              {item.msg.senderType === 'user' && (
                <span className="user-message-avatar" aria-label={userProfile.nickname}>
                  {userProfile.avatarDataUrl ? <img src={userProfile.avatarDataUrl} alt="" /> : userProfile.nickname.slice(0, 1).toUpperCase()}
                </span>
              )}
            </article>
            </div>
          );
        }

        if (item.kind === 'running-agent') {
          const agent = item.agent;
          const streaming = agent.streamingText.trim().length > 0;
          const streamingDisplay = streaming ? displayAgentText(agent.streamingText, projectAgents) : '';
          return (
            <div key={`running-${agent.id}`} className="message-entry">
              <article className="message-row message-row--agent" role="status" aria-label={`${agent.name} 正在执行任务`}>
                <AgentAvatar label={agent.name} tone={agent.tone} size="md" />
                <div className="message-body">
                  <div className="message-sender">
                    <strong>{agent.name}</strong>
                    <span className="agent-running-badge" aria-hidden="true">执行中</span>
                  </div>
                  <div className="message-bubble message-bubble--running">
                    {streaming ? (
                      <>
                        <MarkdownMessage content={streamingDisplay} mentions={[]} {...(onPreviewUrl ? { onOpenLink: onPreviewUrl } : {})} {...(onPreviewImage ? { onOpenImage: onPreviewImage } : {})} />
                        <span className="message-streaming-caret" aria-label="正在生成" />
                      </>
                    ) : (
                      <>
                        <div className="agent-running-hint" aria-hidden="true">
                          <Loader2 size={14} className="spin-soft" />
                          <span className="agent-running-hint__label">{agent.name} 正在执行任务</span>
                          <span className="agent-running-hint__dots"><i /><i /><i /></span>
                        </div>
                        <div className="agent-running-hint__bar" aria-hidden="true" />
                      </>
                    )}
                  </div>
                </div>
              </article>
            </div>
          );
        }

        return null;
      })}
      {contextMenu && (
        <div className="message-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onClick={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => { onReplyMessage?.(contextMenu.message); setContextMenu(null); }}>
            回复消息
          </button>
        </div>
      )}
    </div>
  );
}

function formatRunDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function displayWorkText(text: string, projectAgents: Array<{ id: string; agentName: string }>): string {
  const named = displayAgentText(text, projectAgents);
  if (/^[a-f0-9]{24}$/i.test(named.trim())) return '子任务已创建';
  return named.replace(/\b[a-f0-9]{24}\b/gi, '子任务');
}

export function AgentWorkTree({
  run,
  projectAgents,
  onCancel,
  formatTime,
  autoCollapse,
  forceExpanded = false,
  phaseLabel,
  hideChecklist = false,
}: {
  run: RunActivity;
  projectAgents: Array<{ id: string; agentName: string }>;
  onCancel: (runId: string) => void;
  formatTime: (iso: string) => string;
  autoCollapse: boolean;
  forceExpanded?: boolean;
  phaseLabel?: string;
  hideChecklist?: boolean;
}): React.JSX.Element {
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
  const awaitingUser = run.status === 'awaiting_user';
  const [expanded, setExpanded] = useState(forceExpanded || (!terminal && !autoCollapse));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (forceExpanded) setExpanded(true);
    else if (terminal || autoCollapse) setExpanded(false);
  }, [terminal, autoCollapse, forceExpanded]);
  useEffect(() => {
    if (terminal || awaitingUser) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [awaitingUser, terminal]);

  // 运行中的轨迹必须由后端明确发出 completed/failed 才能结束。
  // 不能为了视觉效果把旧的 running 轨迹直接标成完成，否则工作树会出现“尚未执行却已完成”。
  const terminalTraceStatus = run.status === 'failed' ? 'failed' : 'completed';
  const visibleTraces = run.traces.map((trace) => (
    terminal && trace.status === 'running' ? { ...trace, status: terminalTraceStatus as typeof trace.status } : trace
  ));
  const latestTrace = visibleTraces[visibleTraces.length - 1];
  const currentStatusText = latestTrace?.status === 'running' ? latestTrace.title : run.stage || latestTrace?.title;
  const statusLabel = run.status === 'completed'
    ? '工作已完成'
    : run.status === 'failed'
      ? '未能完成'
      : run.status === 'cancelled'
        ? '已停止'
        : awaitingUser
          ? '等待用户回复'
        : run.status === 'queued'
          ? '正在等待开始'
          : displayWorkText(currentStatusText || '正在准备', projectAgents);
  const displayName = displayWorkText(run.agentName || '智能体', projectAgents);
  const traceTimes = visibleTraces
    .map((trace) => Date.parse(trace.at))
    .filter((value) => Number.isFinite(value));
  const fallbackTime = Date.parse(run.updatedAt);
  const startedAt = traceTimes.length > 0 ? Math.min(...traceTimes) : Number.isFinite(fallbackTime) ? fallbackTime : now;
  const endedAt = terminal
    ? Math.max(Number.isFinite(fallbackTime) ? fallbackTime : startedAt, ...traceTimes)
    : now;
  const duration = formatRunDuration(Math.max(0, endedAt - startedAt));
  const completionLabel = run.status === 'completed'
    ? '已完成'
    : run.status === 'failed'
      ? '执行失败'
      : run.status === 'cancelled' || run.status === 'interrupted'
        ? '已停止'
        : awaitingUser
          ? '等待用户'
        : run.status === 'queued'
          ? '等待中'
          : '执行中';
  const checklist = hideChecklist ? [] : run.checklist?.items ?? [];

  const traceIcon = (trace: RunActivity['traces'][number]): { Icon: typeof CheckCircle2; spinning: boolean } => {
    if (trace.status === 'failed') return { Icon: XCircle, spinning: false };
    const waiting = trace.kind === 'handoff' || /等待|排队|待命/.test(trace.title);
    if (trace.status === 'running') return waiting ? { Icon: Clock3, spinning: false } : { Icon: Loader2, spinning: true };
    if (trace.kind === 'tool') return { Icon: Wrench, spinning: false };
    if (trace.kind === 'file') return { Icon: FileOutput, spinning: false };
    if (trace.kind === 'handoff') return { Icon: GitBranch, spinning: false };
    return { Icon: CheckCircle2, spinning: false };
  };

  return (
    <section className={`agent-work-tree${terminal ? ' agent-work-tree--terminal' : ''}${awaitingUser ? ' agent-work-tree--awaiting-user' : ''}`} aria-label={`${displayName}工作过程`}>
      <button type="button" className="agent-work-tree__toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <strong className="agent-work-tree__status">{completionLabel} <time>{duration}</time></strong>
        <span className="agent-work-tree__meta">{phaseLabel ?? displayName}{!terminal && currentStatusText ? ` · ${statusLabel}` : ''}</span>
        <ChevronDown size={14} className={expanded ? 'agent-work-tree__chevron--open' : ''} />
      </button>
      {expanded && (
        <div className="agent-work-tree__body">
          {checklist.length === 0 && visibleTraces.length === 0 && (
            <div className="agent-work-tree__empty">{terminal ? <CheckCircle2 size={14} /> : awaitingUser ? <Clock3 size={14} /> : <Loader2 size={14} className="spin-soft" />}<span>{statusLabel}</span></div>
          )}
          {checklist.length > 0 && (
            <details className="agent-work-branch" open>
              <summary><strong>任务拆解</strong><span>{checklist.length} 项</span><ChevronDown size={13} /></summary>
              <div className="agent-work-branch__items">
                {checklist.map((item) => (
                  <div key={item.id} className={`agent-work-node agent-work-node--${item.status}`}>
                    {item.status === 'completed' ? <CheckCircle2 size={13} /> : item.status === 'failed' ? <XCircle size={13} /> : item.status === 'in_progress' ? <Clock3 size={13} /> : <CircleDashed size={13} />}
                    <div><strong>{displayWorkText(item.title, projectAgents)}</strong>{item.detail && <span>{displayWorkText(item.detail, projectAgents)}</span>}</div>
                  </div>
                ))}
              </div>
            </details>
          )}
          {visibleTraces.length > 0 && (
            <details className="agent-work-branch" open>
              <summary><strong>执行过程</strong><span>{visibleTraces.length} 项</span><ChevronDown size={13} /></summary>
              <div className="agent-work-branch__items">
                {visibleTraces.map((trace) => {
                  const { Icon, spinning } = traceIcon(trace);
                  return (
                    <div key={trace.id} className={`agent-work-node agent-work-node--${trace.status}`}>
                      <Icon size={13} className={spinning ? 'spin-soft' : ''} />
                      <div><strong>{displayWorkText(trace.title, projectAgents)}</strong>{trace.detail && <span>{displayWorkText(trace.detail, projectAgents)}</span>}</div>
                      <time>{formatTime(trace.at)}</time>
                    </div>
                  );
                })}
              </div>
            </details>
          )}
          {!terminal && !awaitingUser && <button type="button" className="agent-work-tree__cancel" onClick={() => onCancel(run.runId)}><Square size={11} />停止</button>}
        </div>
      )}
    </section>
  );
}
