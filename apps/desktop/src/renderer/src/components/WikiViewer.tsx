import { useMemo, useState } from 'react';
import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { X, FileText, Book } from 'lucide-react';

type WikiPage = {
  id: string;
  scopeType: string;
  scopeId: string;
  slug: string;
  title: string;
  bodyMd: string | null;
  sourceRefsJson: string | null;
  updatedAt: string;
};

type WikiViewerProps = {
  scopeType: 'project' | 'shared';
  scopeId: string;
  projectId: string;
  onClose: () => void;
};

export function WikiViewer({ scopeType, scopeId, projectId, onClose }: WikiViewerProps): React.JSX.Element {
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [activeSlug, setActiveSlug] = useState('index');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const effectiveScopeType = scopeType === 'shared' ? 'shared' : 'project';
  const effectiveScopeId = scopeType === 'shared' ? 'shared-knowledge' : scopeId;

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        setLoading(true);
        const result = await window.kunqing?.knowledge.wikiList({ scopeType: effectiveScopeType, scopeId: effectiveScopeId, projectId }) as { ok: boolean; data?: WikiPage[] } | undefined;
        if (result?.data && result.data.length > 0) {
          setPages(result.data);
          setError('');
        } else {
          setError('暂无 Wiki 页面');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载 Wiki 失败');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [effectiveScopeType, effectiveScopeId]);

  const activePage = useMemo(() => pages.find((p) => p.slug === activeSlug) ?? null, [pages, activeSlug]);

  const groupedPages = useMemo(() => {
    const groups: Record<string, WikiPage[]> = {};
    for (const p of pages) {
      const group = p.slug.startsWith('entities/') ? '实体' : p.slug.startsWith('topics/') ? '主题' : '通用';
      if (!groups[group]) groups[group] = [];
      groups[group].push(p);
    }
    return groups;
  }, [pages]);

  const handlePreviewLink = (href: string): void => {
    if (href.startsWith('wiki:')) {
      setActiveSlug(href.slice(5));
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="wiki-viewer" onClick={(e) => e.stopPropagation()}>
        <aside className="wiki-viewer__sidebar">
          <div className="wiki-viewer__sidebar-header">
            <h3><Book size={15} /> Wiki</h3>
            <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="wiki-viewer__sidebar-list">
            {loading ? (
              <div className="wiki-message">加载中...</div>
            ) : pages.length === 0 ? (
              <div className="wiki-message">暂无页面</div>
            ) : (
              Object.entries(groupedPages).map(([group, groupPages]) => (
                <div key={group}>
                  <div className="wiki-sidebar-group">{group}</div>
                  {groupPages.map((page) => (
                    <button
                      key={page.slug}
                      type="button"
                      className={`wiki-sidebar-item${page.slug === activeSlug ? ' wiki-sidebar-item--active' : ''}`}
                      onClick={() => setActiveSlug(page.slug)}
                    >
                      <FileText size={13} />
                      <span>{page.title}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </aside>
        <div className="wiki-viewer__content">
          {error && <div className="wiki-message wiki-error">{error}</div>}
          {activePage ? (
            <div className="wiki-markdown">
              <ReactMarkdown
                components={{
                  a: ({ href, children }) => {
                    if (href?.startsWith('wiki:')) {
                      return (
                        <a href={href} className="wiki-link" onClick={(e) => { e.preventDefault(); handlePreviewLink(href!); }}>
                          {children}
                        </a>
                      );
                    }
                    return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
                  },
                }}
              >
                {activePage.bodyMd ?? ''}
              </ReactMarkdown>
            </div>
          ) : !loading ? (
            <div className="wiki-message">选择左侧 Wiki 页面查看</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
