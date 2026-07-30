import { useCallback, useEffect, useRef } from 'react';
import { Bot, FileText, Loader2, RefreshCw, Square } from 'lucide-react';
import { MarkdownMessage } from './MarkdownMessage';

type MessageItem = {
  id: string;
  senderType: string;
  senderId: string;
  kind: string;
  contentJson: string;
  status: string;
  createdAt: string;
};

const parseContent = (json: string): { text: string } => {
  try {
    return JSON.parse(json) as { text: string };
  } catch {
    return { text: json };
  }
};

interface VirtualMessageListProps {
  messages: MessageItem[];
  streamMap: Record<string, string>;
  activeRuns: Array<{ runId: string; status: string; agentName: string | undefined }>;
  projectAgents: Array<{ id: string; agentName: string }>;
  hasMore: boolean;
  loading: boolean;
  projectId: string | undefined;
  initialScrollOffset?: number;
  onScrollOffsetChange?: (offset: number) => void;
  onLoadMore: () => void;
  onCancelRun: (runId: string) => void;
  onRetryRun: (messageId: string) => void;
  onPreviewFile?: (filePath: string) => void;
}

type VirtualItem =
  | { kind: 'load-more' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'message'; msg: MessageItem }
  | { kind: 'stream'; id: string; content: string }
  | { kind: 'run'; runId: string; status: string; agentName: string | undefined };

export function VirtualMessageList({
  messages,
  streamMap,
  activeRuns,
  projectAgents,
  hasMore,
  loading,
  projectId,
  initialScrollOffset,
  onScrollOffsetChange,
  onLoadMore,
  onCancelRun,
  onRetryRun,
  onPreviewFile,
}: VirtualMessageListProps): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);

  const allItems = useCallback((): VirtualItem[] => {
    if (loading) {
      return [{ kind: 'loading' }];
    }

    const items: VirtualItem[] = [];

    if (messages.length === 0 && Object.keys(streamMap).length === 0 && activeRuns.length === 0) {
      items.push({ kind: 'empty' });
      return items;
    }

    for (const msg of messages) {
      items.push({ kind: 'message', msg });
    }
    for (const [id, content] of Object.entries(streamMap)) {
      items.push({ kind: 'stream', id, content });
    }
    for (const run of activeRuns) {
      items.push({ kind: 'run', runId: run.runId, status: run.status, agentName: run.agentName });
    }

    return items;
  }, [messages, streamMap, activeRuns, hasMore, loading]);

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
    if (msg.senderType === 'user') return '项目负责人 (You)';
    if (msg.senderType === 'agent') {
      const agent = projectAgents.find((a) => a.id === msg.senderId);
      return agent?.agentName ?? msg.senderId;
    }
    return '系统';
  };

  const roleClass = (msg: MessageItem): string => {
    if (msg.senderType === 'user') return 'user';
    return 'financial';
  };

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

        if (item.kind === 'stream') {
          return (
            <article key={`stream-${item.id}`} className="message-row message-row--financial">
              <div className="message-agent-icon message-agent-icon--financial"><Bot size={18} /></div>
              <div className="message-body">
                <div className="message-sender"><strong>智能体</strong><time>流式输出中...</time></div>
                <div className="message-bubble"><MarkdownMessage content={item.content} /><span className="stream-cursor">|</span></div>
              </div>
            </article>
          );
        }

        if (item.kind === 'run') {
          return (
            <article key={`run-${item.runId}`} className="message-row message-row--system">
              <div className="message-agent-icon message-agent-icon--system"><Loader2 size={16} className="spin" /></div>
              <div className="message-body">
                <div className="message-sender"><strong>{item.agentName || '智能体'}</strong></div>
                <div className="message-bubble message-bubble--status">
                  <span>{item.status === 'queued' ? '排队中...' : item.status === 'starting' ? '启动中...' : '运行中...'}</span>
                  <button type="button" className="composer-tool" aria-label="取消运行" onClick={() => onCancelRun(item.runId)}><Square size={14} /></button>
                </div>
              </div>
            </article>
          );
        }

        if (item.kind === 'message') {
          const { text } = parseContent(item.msg.contentJson);
          const role = roleClass(item.msg);
          return (
            <article key={item.msg.id} className={`message-row message-row--${role}`}>
              {item.msg.senderType !== 'user' && (
                <div className={`message-agent-icon message-agent-icon--${role}`}>
                  {item.msg.kind === 'run-status' ? <Loader2 size={18} className="spin" /> : item.msg.kind === 'artifact' ? <FileText size={18} /> : <Bot size={18} />}
                </div>
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
                  {item.msg.kind === 'artifact' ? (
                    <button type="button" className="artifact-inline" onClick={() => onPreviewFile?.(text)} title="预览成果文件"><FileText size={16} /><span>{text}</span></button>
                  ) : (
                    <MarkdownMessage content={text} />
                  )}
                  {item.msg.status === 'failed' && <span className="error-tag">发送失败</span>}
                </div>
              </div>
            </article>
          );
        }

        return null;
      })}
    </div>
  );
}