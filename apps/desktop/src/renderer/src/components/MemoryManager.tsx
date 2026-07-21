import { useEffect, useState } from 'react';
import { X, Brain, Trash2, Clock, Archive } from 'lucide-react';

type MemoryRecord = {
  id: string;
  projectId: string;
  agentInstanceId: string;
  scope: string;
  type: string;
  content: string;
  confidence: number;
  sourceRefsJson: string | null;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type MemoryManagerProps = {
  projectId: string;
  agentInstanceId: string;
  agentName: string;
  onClose: () => void;
};

export function MemoryManager({ projectId, agentInstanceId, agentName, onClose }: MemoryManagerProps): React.JSX.Element {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadMemories = async (): Promise<void> => {
    try {
      setLoading(true);
      const result = await window.kunqing?.memory.list({ projectId, agentInstanceId }) as { ok: boolean; data?: MemoryRecord[] } | undefined;
      setRecords(result?.data ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载记忆失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadMemories(); }, [projectId, agentInstanceId]);

  const removeMemory = async (recordId: string): Promise<void> => {
    try {
      await window.kunqing?.memory.remove({ recordId });
      setRecords((prev) => prev.filter((r) => r.id !== recordId));
    } catch {
      setError('删除失败');
    }
  };

  const shortTerm = records.filter((r) => r.scope === 'short-term' && r.status !== 'deleted');
  const longTerm = records.filter((r) => r.scope === 'long-term' && r.status !== 'deleted');

  const isExpired = (expiresAt: string | null): boolean => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };

  const formatDate = (iso: string): string => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="memory-manager" onClick={(e) => e.stopPropagation()}>
        <header className="memory-manager-header">
          <div className="memory-manager-title">
            <Brain size={18} />
            <h3>{agentName} · 记忆</h3>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="memory-manager-body">
          {loading ? (
            <div className="memory-empty">加载中...</div>
          ) : error ? (
            <div className="memory-empty memory-error">{error}</div>
          ) : records.length === 0 ? (
            <div className="memory-empty"><Archive size={34} /><strong>暂无记忆</strong><span>智能体尚未记录任何记忆</span></div>
          ) : (
            <>
              {shortTerm.length > 0 && (
                <section className="memory-section">
                  <h4><Clock size={14} /> 短期记忆 <span className="memory-count">{shortTerm.length}</span></h4>
                  {shortTerm.map((r) => (
                    <div key={r.id} className={`memory-card${isExpired(r.expiresAt) ? ' memory-card--expired' : ''}`}>
                      <div className="memory-card-header">
                        <span className="memory-type">{r.type}</span>
                        {r.expiresAt && (
                          <span className={`memory-expiry${isExpired(r.expiresAt) ? ' memory-expiry--expired' : ''}`}>
                            {isExpired(r.expiresAt) ? '已过期' : `有效期至 ${formatDate(r.expiresAt)}`}
                          </span>
                        )}
                      </div>
                      <div className="memory-content">{r.content}</div>
                      <div className="memory-meta">
                        <span>置信度 {Math.round(r.confidence * 100)}%</span>
                        <span>{formatDate(r.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </section>
              )}
              {longTerm.length > 0 && (
                <section className="memory-section">
                  <h4><Archive size={14} /> 长期记忆 <span className="memory-count">{longTerm.length}</span></h4>
                  {longTerm.map((r) => (
                    <div key={r.id} className="memory-card">
                      <div className="memory-card-header">
                        <span className="memory-type">{r.type}</span>
                        <button type="button" className="icon-button" aria-label="删除记忆" onClick={() => void removeMemory(r.id)} title="删除"><Trash2 size={13} /></button>
                      </div>
                      <div className="memory-content">{r.content}</div>
                      <div className="memory-meta">
                        <span>置信度 {Math.round(r.confidence * 100)}%</span>
                        <span>{formatDate(r.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
