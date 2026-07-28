import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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

  const allItems = useMemo<VirtualItem[]>(() => {
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

  const estimateSize = useCallback((index: number): number => {
    const item = allItems[index];
    if (!item) return 200;
    switch (item.kind) {
      case 'load-more': return 48;
      case 'loading': return 120;
      case 'empty': return 200;
      case 'run': return 80;
      case 'stream': {
        // ~50 chars/line × 19px line-height + bubble padding(30) + sender(22) + margin(24)
        const lines = Math.max(Math.ceil(item.content.length / 50), 1);
        return 76 + lines * 19;
      }
      case 'message': {
        const { text } = parseContent(item.msg.contentJson);
        const lines = Math.max(Math.ceil(text.length / 50), 1);
        return 76 + lines * 19;
      }
      default: return 160;
    }
  }, [allItems]);

  const virtualizer = useVirtualizer({
    count: allItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: 8,
    ...(initialScrollOffset !== undefined ? { initialOffset: initialScrollOffset } : {}),
  });

  const prevCount = useRef(allItems.length);
  useEffect(() => {
    const current = allItems.length;
    if (current > prevCount.current) {
      const parent = parentRef.current;
      if (parent) {
        const threshold = 400;
        const isNearBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight < threshold;
        if (isNearBottom) {
          virtualizer.scrollToIndex(current - 1, { align: 'end' });
        }
      }
    }
    prevCount.current = current;
  }, [allItems.length, virtualizer]);

  const prevScrollHeight = useRef(0);
  const prevScrollTop = useRef(0);
  const handleScroll = useCallback(() => {
    const parent = parentRef.current;
    if (!parent) return;

    if (parent.scrollTop < 80 && hasMore && !loading) {
      onLoadMore();
    }

    if (allItems.length > prevCount.current) {
      const heightDiff = parent.scrollHeight - prevScrollHeight.current;
      if (heightDiff > 0) {
        parent.scrollTop = prevScrollTop.current + heightDiff;
      }
    }
    prevScrollHeight.current = parent.scrollHeight;
    prevScrollTop.current = parent.scrollTop;
    onScrollOffsetChange?.(parent.scrollTop);
  }, [hasMore, loading, onLoadMore, allItems.length, onScrollOffsetChange]);

  const formatTime = (iso: string): string => {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  const senderDisplay = (msg: MessageItem): string => {
    if (msg.senderType === 'user') return '项目负责人 (You)';
    if (msg.senderType === 'agent') return msg.senderId;
    return '系统';
  };

  const roleClass = (msg: MessageItem): string => {
    if (msg.senderType === 'user') return 'user';
    return 'financial';
  };

  return (
    <div ref={parentRef} className="message-stream" onScroll={handleScroll} style={{ overflow: 'auto' }}>
      {hasMore && (
        <div style={{ textAlign: 'center', padding: '12px 0' }}>
          <button type="button" className="load-more" onClick={onLoadMore}>
            加载更多消息
          </button>
        </div>
      )}
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = allItems[virtualItem.index];
          if (!item) return null;

          return (
            <div
              key={virtualItem.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {item.kind === 'loading' && (
                <div className="file-empty" style={{ padding: '40px' }}>加载中...</div>
              )}
              {item.kind === 'empty' && (
                <div className="file-empty" style={{ padding: '40px' }}>
                  <strong>开始对话</strong>
                  <span>发送一条消息开始与智能体协作文档</span>
                </div>
              )}
              {item.kind === 'stream' && (
                <article className="message-row message-row--financial">
                  <div className="message-agent-icon message-agent-icon--financial"><Bot size={18} /></div>
                  <div className="message-body">
                    <div className="message-sender"><strong>智能体</strong><time>流式输出中...</time></div>
                    <div className="message-bubble"><MarkdownMessage content={item.content} /><span className="stream-cursor">|</span></div>
                  </div>
                </article>
              )}
              {item.kind === 'run' && (
                <article className="message-row message-row--system">
                  <div className="message-agent-icon message-agent-icon--system"><Loader2 size={16} className="spin" /></div>
                  <div className="message-body">
                    <div className="message-sender"><strong>系统</strong></div>
                    <div className="message-bubble message-bubble--status">
                      <span>{item.agentName || '智能体'} {item.status === 'queued' ? '排队中...' : item.status === 'starting' ? '启动中...' : '运行中...'}</span>
                      <button type="button" className="composer-tool" aria-label="取消运行" onClick={() => onCancelRun(item.runId)}><Square size={14} /></button>
                    </div>
                  </div>
                </article>
              )}
              {item.kind === 'message' && (() => {
                const { text } = parseContent(item.msg.contentJson);
                const role = roleClass(item.msg);
                return (
                  <article className={`message-row message-row--${role}`}>
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
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}
