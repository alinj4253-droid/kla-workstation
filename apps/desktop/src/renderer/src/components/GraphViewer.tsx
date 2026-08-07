import { ExternalLink, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type GraphArtifactPreview = {
  kind: 'html';
  content: string;
  appFileUrl?: string;
  fileName: string;
};

type GraphViewerProps = {
  scopeType: 'project' | 'shared';
  projectId: string;
  onClose: () => void;
};

const GRAPH_ARTIFACT_PATH = 'graph-visualization/knowledge-graph.html';

export function GraphViewer({ scopeType, projectId, onClose }: GraphViewerProps): React.JSX.Element {
  const [preview, setPreview] = useState<GraphArtifactPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadGraph = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await window.kunqing?.workspace.getPreview({
        projectId,
        relativePath: GRAPH_ARTIFACT_PATH,
        ...(scopeType === 'shared' ? { scopeType: 'shared' as const } : {}),
      }) as {
        ok: boolean;
        data?: { kind?: string; content?: string; appFileUrl?: string; fileName?: string; error?: string };
        error?: { message?: string };
      } | undefined;

      if (!result?.ok || !result.data) {
        setError(result?.error?.message ?? '尚未生成知识图谱，请先由知识管理智能体处理原始文件。');
        return;
      }
      if (result.data.error) {
        setError(result.data.error);
        return;
      }
      if (result.data.kind !== 'html') {
        setError('图谱可视化文件格式不正确。');
        return;
      }

      setPreview({
        kind: 'html',
        content: result.data.content ?? '',
        ...(result.data.appFileUrl ? { appFileUrl: result.data.appFileUrl } : {}),
        fileName: result.data.fileName ?? 'knowledge-graph.html',
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载图谱可视化失败');
    } finally {
      setLoading(false);
    }
  }, [projectId, scopeType]);

  useEffect(() => { void loadGraph(); }, [loadGraph]);

  const openWithSystem = async (): Promise<void> => {
    await window.kunqing?.workspace.openWithSystem({
      projectId,
      relativePath: GRAPH_ARTIFACT_PATH,
      ...(scopeType === 'shared' ? { scopeType: 'shared' as const } : {}),
    });
  };

  return (
    <div className="graph-viewer-overlay" role="presentation">
      <div className="graph-viewer" role="dialog" aria-modal="true" aria-label="图谱可视化">
        <header className="graph-viewer-header">
          <div className="graph-viewer-title">
            <h3>图谱可视化</h3>
            {preview && <span className="graph-viewer-meta">{preview.fileName}</span>}
          </div>
          <div className="graph-viewer-header-actions">
            {preview && (
              <button type="button" className="icon-button" aria-label="使用系统应用打开图谱" title="系统打开" onClick={() => void openWithSystem()}>
                <ExternalLink size={17} />
              </button>
            )}
            <button type="button" className="icon-button" aria-label="关闭图谱" onClick={onClose}><X size={18} /></button>
          </div>
        </header>
        <div className="graph-viewer-body">
          {loading ? (
            <div className="graph-viewer-empty">加载图谱中...</div>
          ) : error ? (
            <div className="graph-viewer-empty">{error}</div>
          ) : preview ? (
            <iframe
              className="graph-viewer-artifact"
              src={preview.appFileUrl}
              srcDoc={preview.appFileUrl ? undefined : preview.content}
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
              referrerPolicy="no-referrer"
              title="知识图谱可视化"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
