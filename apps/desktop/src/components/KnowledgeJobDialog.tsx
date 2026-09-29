import { useEffect, useState } from 'react';
import { X, Circle, CheckCircle, Clock, AlertTriangle, Loader2 } from 'lucide-react';

type SourceDetail = {
  source: {
    id: string; scopeType: string; scopeId: string; fileId: string;
    versionId: string | null; sha256: string | null;
    status: string; ingestedAt: string | null;
  } | null;
  job: {
    id: string; scopeType: string; scopeId: string; sourceId: string;
    status: string; stage: string | null; progress: number | null;
    errorCode: string | null; createdAt: string; updatedAt: string;
  } | null;
  chunkCount: number;
  nodeCount: number;
};

type KnowledgeJobDialogProps = {
  fileId: string;
  fileName: string;
  onClose: () => void;
};

const STATUS_LABEL: Record<string, { label: string; icon: React.JSX.Element }> = {
  pending: { label: '待入库', icon: <Clock size={14} /> },
  ingesting: { label: '处理中', icon: <Loader2 size={14} className="spin-icon" /> },
  ready: { label: '已入库', icon: <CheckCircle size={14} /> },
  error: { label: '失败', icon: <AlertTriangle size={14} /> },
};

export function KnowledgeJobDialog({ fileId, fileName, onClose }: KnowledgeJobDialogProps): React.JSX.Element {
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        setLoading(true);
        const result = await window.kunqing?.knowledge.getSourceDetail({ fileId }) as { ok: boolean; data?: SourceDetail } | undefined;
        setDetail(result?.data ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [fileId]);

  const statusInfo = detail?.source ? STATUS_LABEL[detail.source.status] ?? { label: detail.source.status, icon: <Circle size={14} /> } : null;

  return (
    <div className="modal-backdrop modal-backdrop--nested" role="presentation" onClick={onClose}>
      <div className="knowledge-detail-dialog" onClick={(e) => e.stopPropagation()}>
        <header>
          <div><h3>知识状态详情</h3><p>{fileName}</p></div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        {loading && <div className="knowledge-detail-loading">加载中…</div>}
        {error && <div className="knowledge-detail-error">{error}</div>}

        {detail && !loading && (
          <div className="knowledge-detail-body">
            {detail.source ? (
              <>
                <section className="knowledge-detail-section">
                  <h4>入库状态</h4>
                  <div className="knowledge-detail-status-row">
                    <span className={`knowledge-badge knowledge-badge--${detail.source.status}`}>{statusInfo?.icon} {statusInfo?.label}</span>
                    {detail.source.ingestedAt && <span className="knowledge-detail-meta">入库时间: {new Date(detail.source.ingestedAt).toLocaleString('zh-CN')}</span>}
                  </div>
                </section>

                {detail.job && (
                  <section className="knowledge-detail-section">
                    <h4>最近作业</h4>
                    <dl className="knowledge-detail-dl">
                      <dt>状态</dt><dd><span className={`knowledge-badge knowledge-badge--${detail.job.status === 'running' ? 'ingesting' : detail.job.status === 'completed' ? 'ready' : detail.job.status === 'failed' ? 'error' : 'pending'}`}>{detail.job.status}</span></dd>
                      {detail.job.stage && <><dt>阶段</dt><dd>{detail.job.stage}</dd></>}
                      {detail.job.progress !== null && detail.job.progress !== undefined && <><dt>进度</dt><dd>{Math.round(detail.job.progress * 100)}%</dd></>}
                      {detail.job.errorCode && <><dt>错误码</dt><dd className="knowledge-detail-error-text">{detail.job.errorCode}</dd></>}
                      <dt>创建时间</dt><dd>{new Date(detail.job.createdAt).toLocaleString('zh-CN')}</dd>
                    </dl>
                  </section>
                )}

                <section className="knowledge-detail-section">
                  <h4>来源统计</h4>
                  <div className="knowledge-detail-stats">
                    <div className="knowledge-detail-stat"><span className="knowledge-detail-stat-value">{detail.chunkCount}</span><span className="knowledge-detail-stat-label">文本块</span></div>
                    <div className="knowledge-detail-stat"><span className="knowledge-detail-stat-value">{detail.nodeCount}</span><span className="knowledge-detail-stat-label">关联节点</span></div>
                    <div className="knowledge-detail-stat"><span className="knowledge-detail-stat-value">{detail.source.sha256?.slice(0, 12) ?? '—'}</span><span className="knowledge-detail-stat-label">文件哈希</span></div>
                  </div>
                </section>
              </>
            ) : (
              <div className="knowledge-detail-empty">该文件尚未进行知识入库</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
