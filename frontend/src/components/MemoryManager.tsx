import { useEffect, useMemo, useState } from 'react';
import { Archive, Brain, Check, Clock, KeyRound, LockKeyhole, Pencil, Plus, Trash2, X } from 'lucide-react';

type MemoryRecord = {
  id: string;
  projectId: string;
  agentInstanceId: string;
  scope: 'short-term' | 'long-term';
  type: string;
  content: string;
  confidence: number;
  sourceRefsJson: string | null;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type MemoryAgent = { id: string; agentName: string; role: string };

type MemoryManagerProps = {
  projectId: string;
  agents: MemoryAgent[];
  initialAgentInstanceId: string;
  onClose: () => void;
};

export function MemoryManager({ projectId, agents, initialAgentInstanceId, onClose }: MemoryManagerProps): React.JSX.Element {
  const [authorized, setAuthorized] = useState(false);
  const [accessKey, setAccessKey] = useState('');
  const [accessError, setAccessError] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState(initialAgentInstanceId);
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [newMemory, setNewMemory] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');

  useEffect(() => {
    if (!agents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(initialAgentInstanceId || agents[0]?.id || '');
    }
  }, [agents, initialAgentInstanceId, selectedAgentId]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? agents[0],
    [agents, selectedAgentId],
  );

  const loadMemories = async (): Promise<void> => {
    if (!projectId || !selectedAgentId) {
      setRecords([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const result = await window.kunqing?.memory.list({ projectId, agentInstanceId: selectedAgentId }) as { ok: boolean; data?: MemoryRecord[] } | undefined;
      setRecords(result?.data ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载记忆失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (authorized) void loadMemories();
  }, [authorized, projectId, selectedAgentId]);

  const verifyAccess = (): void => {
    const check = window.kunqing?.app
      ? window.kunqing.app.verifyOperationsAccess({ key: accessKey }).then((res) => {
        const data = res as { ok?: boolean; data?: { granted?: boolean } } | undefined;
        if (data?.data?.granted) {
          setAccessError('');
          setAuthorized(true);
        } else {
          setAccessError('运维权限密钥不正确');
        }
      })
      : Promise.resolve();
    void check;
  };

  const removeMemory = async (recordId: string): Promise<void> => {
    try {
      await window.kunqing?.memory.remove({ recordId });
      setRecords((prev) => prev.filter((record) => record.id !== recordId));
    } catch {
      setError('删除记忆失败');
    }
  };

  const saveMemory = async (record: MemoryRecord): Promise<void> => {
    const content = editingContent.trim();
    if (!content) return;
    try {
      const result = await window.kunqing?.memory.update({ recordId: record.id, content, confidence: record.confidence }) as { ok: boolean; data?: MemoryRecord } | undefined;
      if (result?.data) setRecords((prev) => prev.map((item) => item.id === record.id ? result.data! : item));
      setEditingId(null);
      setEditingContent('');
    } catch {
      setError('保存记忆失败');
    }
  };

  const createMemory = async (): Promise<void> => {
    const content = newMemory.trim();
    if (!content || !selectedAgentId) return;
    try {
      const result = await window.kunqing?.memory.create({
        projectId,
        agentInstanceId: selectedAgentId,
        scope: 'long-term',
        type: 'manual',
        content,
        confidence: 1,
      }) as { ok: boolean; data?: MemoryRecord } | undefined;
      if (result?.data) setRecords((prev) => [result.data!, ...prev]);
      setNewMemory('');
      setAdding(false);
    } catch {
      setError('添加记忆失败');
    }
  };

  const shortTerm = records.filter((record) => record.scope === 'short-term' && record.status === 'active');
  const longTerm = records.filter((record) => record.scope === 'long-term' && record.status === 'active');
  const isExpired = (expiresAt: string | null): boolean => !!expiresAt && new Date(expiresAt) < new Date();
  const formatDate = (iso: string): string => new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
  const sourceLabel = (record: MemoryRecord): string => {
    try {
      const refs = JSON.parse(record.sourceRefsJson ?? '{}') as { source?: string; runId?: string };
      if (refs.source === 'explicit-user-memory') return '用户明确要求';
      if (refs.source === 'manual-editor') return '手动添加';
      if (refs.runId) return '任务执行摘要';
    } catch { /* ignore invalid metadata */ }
    return '自动提取';
  };

  const renderCard = (record: MemoryRecord): React.JSX.Element => (
    <div key={record.id} className={`memory-card${isExpired(record.expiresAt) ? ' memory-card--expired' : ''}`}>
      <div className="memory-card-header">
        <span className="memory-type">{record.type}</span>
        <div className="memory-card-actions">
          {editingId === record.id ? (
            <>
              <button type="button" className="icon-button" aria-label="保存记忆" onClick={() => void saveMemory(record)}><Check size={13} /></button>
              <button type="button" className="icon-button" aria-label="取消编辑" onClick={() => setEditingId(null)}><X size={13} /></button>
            </>
          ) : (
            <>
              <button type="button" className="icon-button" aria-label="编辑记忆" onClick={() => { setEditingId(record.id); setEditingContent(record.content); }}><Pencil size={13} /></button>
              <button type="button" className="icon-button" aria-label="删除记忆" onClick={() => void removeMemory(record.id)}><Trash2 size={13} /></button>
            </>
          )}
        </div>
      </div>
      {editingId === record.id ? (
        <textarea className="memory-editor" value={editingContent} onChange={(event) => setEditingContent(event.target.value)} autoFocus />
      ) : (
        <div className="memory-content">{record.content}</div>
      )}
      <div className="memory-meta">
        <span>{sourceLabel(record)}</span>
        <span>置信度 {Math.round(record.confidence * 100)}%</span>
        <span>更新于 {formatDate(record.updatedAt)}</span>
        {record.expiresAt && <span>{isExpired(record.expiresAt) ? '已过期' : `有效至 ${formatDate(record.expiresAt)}`}</span>}
      </div>
    </div>
  );

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="memory-manager" onClick={(event) => event.stopPropagation()}>
        <header className="memory-manager-header">
          <div className="memory-manager-title"><Brain size={18} /><h3>群聊记忆</h3></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        {!authorized ? (
          <form className="memory-access-gate" onSubmit={(event) => { event.preventDefault(); verifyAccess(); }}>
            <span className="memory-access-gate__icon"><LockKeyhole size={25} /></span>
            <div><h4>记忆内容受保护</h4><p>请输入运维权限密钥后查看和维护群聊智能体的私有记忆。</p></div>
            <label><span>运维权限密钥</span><div><KeyRound size={16} /><input autoFocus type="password" value={accessKey} onChange={(event) => { setAccessKey(event.target.value); setAccessError(''); }} placeholder="请输入密钥" /></div>{accessError && <small>{accessError}</small>}</label>
            <button type="submit" className="primary-button" disabled={!accessKey}>验证并进入</button>
          </form>
        ) : <>
        <div className="memory-toolbar">
          <label>
            <span>查看智能体</span>
            <select value={selectedAgent?.id ?? ''} onChange={(event) => setSelectedAgentId(event.target.value)}>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.agentName}{agent.role === 'leader' ? '（Leader）' : ''}</option>)}
            </select>
          </label>
          <button type="button" className="secondary-button" onClick={() => setAdding((value) => !value)}><Plus size={14} />添加长期记忆</button>
        </div>
        {adding && (
          <div className="memory-add-form">
            <textarea value={newMemory} onChange={(event) => setNewMemory(event.target.value)} placeholder="例如：所有项目数据只保存在本地 K_Studio 中。" autoFocus />
            <div><button type="button" className="secondary-button" onClick={() => setAdding(false)}>取消</button><button type="button" className="primary-button" disabled={!newMemory.trim()} onClick={() => void createMemory()}>保存</button></div>
          </div>
        )}
        <div className="memory-manager-body">
          {loading ? <div className="memory-empty">加载中…</div> : error ? <div className="memory-empty memory-error">{error}</div> : records.length === 0 ? (
            <div className="memory-empty"><Archive size={34} /><strong>暂无记忆</strong><span>完成任务后会自动生成任务摘要；也可以明确说“记住……”</span></div>
          ) : (
            <>
              <section className="memory-section"><h4><Archive size={14} />长期记忆 <span className="memory-count">{longTerm.length}</span></h4>{longTerm.length ? longTerm.map(renderCard) : <p className="memory-section-empty">暂无长期记忆</p>}</section>
              <section className="memory-section"><h4><Clock size={14} />短期任务记忆 <span className="memory-count">{shortTerm.length}</span></h4>{shortTerm.length ? shortTerm.map(renderCard) : <p className="memory-section-empty">暂无短期任务记忆</p>}</section>
            </>
          )}
        </div>
        </>}
      </div>
    </div>
  );
}
