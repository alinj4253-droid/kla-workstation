import {
  AlertTriangle, Brain, FileText, FolderOpen, Loader2, MoreVertical, Paperclip, Send, SlidersHorizontal, Smile, Sparkles, X,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { AgentAvatar } from '../components/AgentAvatar';
import { VirtualMessageList } from '../components/VirtualMessageList';
import { MemoryManager } from '../components/MemoryManager';

type MentionRef = { target: { scope: 'profile'; id: string }; label: string; start: number; end: number };

const AGENT_NAMES = ['统筹管理智能体', '知识管理智能体', '企业本地化专家', 'DevOps 流程专家', '创意洞察大脑', 'Codex CLI'];
const AGENT_ID_MAP: Record<string, string> = {
  '统筹管理智能体': 'orchestrator',
  '知识管理智能体': 'knowledge',
  '企业本地化专家': 'finance',
  'DevOps 流程专家': 'devops',
  '创意洞察大脑': 'creative',
  'Codex CLI': 'codex',
};

function extractMentions(text: string): MentionRef[] {
  const mentions: MentionRef[] = [];
  const re = /@([\u4e00-\u9fff\w]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const name = match[1]!;
    const id = AGENT_ID_MAP[name];
    if (id) {
      mentions.push({ target: { scope: 'profile', id }, label: name, start: match.index, end: match.index + name.length + 1 });
    }
  }
  return mentions;
}

type ProjectItem = {
  id: string;
  name: string;
  status: string;
  lastActiveAt: string;
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

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

interface PerProjectState {
  draft: string;
  previewOpen: boolean;
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

const DEFAULT_PROJECT_STATE: PerProjectState = { draft: '', previewOpen: true, scrollOffset: 0 };

export function ChatPage(): React.JSX.Element {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [draft, setDraft] = useState('');
  const [previewOpen, setPreviewOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [streamMap, setStreamMap] = useState<Record<string, string>>({});
  const [runStatuses, setRunStatuses] = useState<Record<string, { status: string; agentName?: string }>>({});
  const [eventError, setEventError] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [memoryManagerOpen, setMemoryManagerOpen] = useState(false);
  const [sharedKnowledge, setSharedKnowledge] = useState(true);
  const projectStateRef = useRef<Record<string, PerProjectState>>({});

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

  const prevProjectIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!projectId) return;
    const prevId = prevProjectIdRef.current;
    prevProjectIdRef.current = projectId;
    if (prevId) {
      projectStateRef.current[prevId] = { draft, previewOpen, scrollOffset };
    }
    const saved = projectStateRef.current[projectId] ?? DEFAULT_PROJECT_STATE;
    setDraft(saved.draft);
    setPreviewOpen(saved.previewOpen);
    setScrollOffset(saved.scrollOffset);
    setPreviewFile(null);
    setPreviewData(null);
    const url = new URL(window.location.href);
    const previewPath = url.searchParams.get('preview');
    if (previewPath) {
      setPreviewOpen(true);
      void openPreview(previewPath);
    }
    setLoading(true);
    void loadProjects();
    void loadMessages();
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const unsubscribe = window.kunqing?.events.subscribe((raw) => {
      const event = raw as { type: string; projectId?: string; [key: string]: unknown };
      if (event.projectId && event.projectId !== projectId) return;

      switch (event.type) {
        case 'message.delta': {
          const { messageId, delta } = event as { type: 'message.delta'; projectId: string; messageId: string; seq: number; delta: string };
          setStreamMap((prev) => ({ ...prev, [messageId]: (prev[messageId] ?? '') + delta }));
          break;
        }
        case 'message.committed': {
          const { messageId, content } = event as { type: 'message.committed'; projectId: string; messageId: string; content: string };
          setStreamMap((prev) => { const next = { ...prev }; delete next[messageId]; return next; });
          setMessages((prev) => {
            if (prev.some((m) => m.id === messageId)) return prev;
            return [...prev, { id: messageId, senderType: 'agent', senderId: '', kind: 'text', contentJson: content, status: 'sent', createdAt: new Date().toISOString() }];
          });
          break;
        }
        case 'run.status': {
          const { run } = event as { type: 'run.status'; projectId: string; run: { id: string; agentId: string; status: string } };
          setRunStatuses((prev) => ({ ...prev, [run.id]: { status: run.status, agentName: run.agentId } }));
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
            setRunStatuses((prev) => { const next = { ...prev }; delete next[run.id]; return next; });
          }
          break;
        }
        case 'message.created': {
          const { message } = event as { type: 'message.created'; projectId: string; message: MessageItem };
          setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
          break;
        }
      }
    });
    return () => { unsubscribe?.(); };
  }, [projectId]);

  // auto-scroll handled by VirtualMessageList

  const activeProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? { id: projectId ?? '', name: '新建协作群聊', status: 'active', lastActiveAt: '' },
    [projects, projectId],
  );

  const generateIdempotencyKey = (): string =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const sendMessage = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);

    const content = { schemaVersion: 1 as const, text, mentions: extractMentions(text), stagedUploadIds: [] };
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
      setEventError(null);
    } else if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
      const err = (result as Record<string, unknown>).error as { message?: string } ?? {};
      setEventError(err.message ?? '发送失败');
    }
  };

  const activeRuns = useMemo(() => Object.entries(runStatuses).map(([runId, val]) => ({ runId, status: val.status, agentName: val.agentName })), [runStatuses]);

  const cancelRun = async (runId: string): Promise<void> => {
    await window.kunqing?.messages.cancelRun({ runId });
  };

  const retryRun = async (messageId: string): Promise<void> => {
    await window.kunqing?.messages.retryRun({ idempotencyKey: generateIdempotencyKey(), runId: messageId });
  };

  const openPreview = async (filePath: string): Promise<void> => {
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
  };

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

  const loadMore = (): void => {
    if (messages.length > 0) {
      void loadMessages(messages[0]?.createdAt);
    }
  };

  return (
    <div className={`chat-workspace${previewOpen ? '' : ' chat-workspace--preview-closed'}`}>
      <aside className="project-panel" aria-label="协作项目">
        <div className="project-panel__header">
          <h2>协作项目</h2>
          <button type="button" className="icon-button" aria-label="筛选项目"><SlidersHorizontal size={17} /></button>
        </div>
        <div className="project-list">
          {projects.length === 0 && <div className="file-empty" style={{ padding: '24px 16px' }}>暂无项目</div>}
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className={`project-list-item${project.id === projectId ? ' project-list-item--active' : ''}`}
              onClick={() => navigate(`/projects/${project.id}/chat`)}
            >
              <div className="project-list-item__meta">
                <span className={`status-pill status-pill--${project.status.toLowerCase()}`}>{project.status}</span>
                <time>{formatTime(project.lastActiveAt)}</time>
              </div>
              <strong>{project.name}</strong>
              <p>点击查看群聊</p>
            </button>
          ))}
        </div>
      </aside>

      <section className="conversation-panel">
        <header className="conversation-header">
          <div className="conversation-title">
            <div className="avatar-stack avatar-stack--header">
              <AgentAvatar label="FA" tone="indigo" size="sm" />
              <AgentAvatar label="MA" tone="cyan" size="sm" overlap />
              <AgentAvatar label="KM" tone="violet" size="sm" overlap />
            </div>
            <div>
              <h2>{activeProject.name}</h2>
              <p><span className="online-dot" /> 智能体等待中</p>
            </div>
          </div>
          <div className="conversation-actions">
            <button type="button" className="icon-button" aria-label="打开工作区" onClick={() => navigate(`/projects/${projectId}/workspace`)}><FolderOpen size={18} /></button>
            <button type="button" className="icon-button" aria-label="记忆管理" onClick={() => setMemoryManagerOpen(true)} title="记忆"><Brain size={18} /></button>
            <label className="shared-knowledge-toggle" title={sharedKnowledge ? '共享知识已开启' : '共享知识已关闭'}>
              <input type="checkbox" checked={sharedKnowledge} onChange={(e) => { setSharedKnowledge(e.target.checked); void window.kunqing?.projects.setSharedKnowledge({ projectId: projectId ?? '', enabled: e.target.checked }); }} />
              <span>共享知识</span>
            </label>
            <button type="button" className="icon-button" aria-label="更多操作"><MoreVertical size={18} /></button>
          </div>
        </header>

        <VirtualMessageList
          key={projectId}
          messages={messages}
          streamMap={streamMap}
          activeRuns={activeRuns}
          hasMore={hasMore}
          loading={loading}
          projectId={projectId}
          initialScrollOffset={scrollOffset}
          onScrollOffsetChange={setScrollOffset}
          onLoadMore={loadMore}
          onCancelRun={cancelRun}
          onRetryRun={retryRun}
          onPreviewFile={openPreview}
        />

        {eventError && <div className="composer-error"><AlertTriangle size={14} />{eventError}<button type="button" className="icon-button" onClick={() => setEventError(null)}><X size={14} /></button></div>}
        {activeRuns.length > 0 && <div className="composer-status-bar"><Loader2 size={14} className="spin" />{activeRuns.length} 个运行中</div>}
        <form className="chat-composer-wrap" onSubmit={(e) => void sendMessage(e)}>
          <div className="chat-composer">
            <button type="button" className="composer-tool" aria-label="更多输入方式" disabled><Sparkles size={18} /></button>
            <textarea
              aria-label="发送消息给智能体小组"
              placeholder="发送消息给智能体小组..."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={sending}
            />
            <button type="button" className="composer-tool" aria-label="添加附件" disabled><Paperclip size={17} /></button>
            <button type="button" className="composer-tool" aria-label="语音输入" disabled><Sparkles size={17} /></button>
            <button type="button" className="composer-tool" aria-label="表情" disabled><Smile size={17} /></button>
            <button className="chat-send" type="submit" disabled={!draft.trim() || sending} aria-label="发送消息">
              {sending ? <Sparkles size={17} /> : <Send size={17} />}
            </button>
          </div>
          <p><Sparkles size={12} /> AI 正在监控工作流合规性</p>
        </form>
      </section>

      {previewOpen && (
        <aside className="artifact-preview" aria-label="成果文件预览">
          <header className="preview-header">
            <div><FileText size={18} /><strong>{previewData?.fileName ? previewData.fileName : (previewFile ?? '项目摘要')}</strong></div>
            <div>
              <button type="button" className="icon-button" aria-label="关闭预览" onClick={closePreview}><X size={18} /></button>
            </div>
          </header>
          <div className="preview-scroll">
            {previewLoading ? (
              <div className="file-empty" style={{ padding: '40px' }}><Loader2 size={34} className="spin" /><span>正在加载预览…</span></div>
            ) : previewData ? (
              previewData.error ? (
                <div className="file-empty" style={{ padding: '40px' }}><FileText size={34} /><span>{previewData.error}</span></div>
              ) : previewData.kind === 'image' && previewData.dataUri ? (
                <div style={{ padding: '16px', textAlign: 'center' }}><img src={previewData.dataUri} alt={previewData.fileName} style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} /></div>
              ) : previewData.kind === 'pdf' && previewData.appFileUrl ? (
                <iframe src={previewData.appFileUrl} className="preview-iframe" title="PDF 预览" style={{ width: '100%', flex: 1, border: 'none' }} />
              ) : previewData.kind === 'html' && previewData.content ? (
                <iframe srcDoc={DOMPurify.sanitize(previewData.content)} className="preview-iframe" sandbox="allow-same-origin" title="HTML 预览" style={{ width: '100%', flex: 1, border: 'none' }} />
              ) : previewData.kind === 'text' ? (
                <pre className="preview-content" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '10px', lineHeight: 1.6 }}>{previewData.content}</pre>
              ) : (
                <div className="file-empty" style={{ padding: '40px' }}><FileText size={34} /><span>该文件类型暂不支持预览</span></div>
              )
            ) : (
              <div className="file-empty" style={{ padding: '40px' }}><FileText size={34} /><strong>暂无成果文件</strong><span>点击消息中的成果文件进行预览</span></div>
            )}
            {previewFile && !previewLoading && !previewData?.error && (
              <div className="preview-actions" style={{ padding: '12px 28px 24px', display: 'flex', gap: '8px' }}>
                <button type="button" className="secondary-button" style={{ fontSize: '10px' }} onClick={() => { void window.kunqing?.workspace.openWithSystem({ projectId: projectId ?? '', relativePath: previewFile }); }}>
                  <FileText size={13} /> 系统打开
                </button>
              </div>
            )}
          </div>
        </aside>
      )}
      {memoryManagerOpen && (
        <MemoryManager projectId={projectId ?? ''} agentInstanceId="" agentName="统筹管理智能体" onClose={() => setMemoryManagerOpen(false)} />
      )}
    </div>
  );
}
