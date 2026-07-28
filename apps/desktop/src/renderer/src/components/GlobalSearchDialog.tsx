import { Search, X, FolderOpen, MessageSquare, BookOpen, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface SearchHit {
  kind: 'project' | 'message' | 'knowledge';
  id: string;
  title: string;
  snippet: string;
  score: number;
}

export function GlobalSearchDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim()) { setResults([]); return; }

    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await window.kunqing?.app.search({ query: query.trim() });
        if (res && typeof res === 'object' && 'ok' in res && (res as { ok: boolean; data: SearchHit[] }).ok) {
          setResults((res as { ok: boolean; data: SearchHit[] }).data);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose();
  };

  const handleSelect = (hit: SearchHit): void => {
    if (hit.kind === 'project') {
      window.location.hash = `/projects/${hit.id}/chat`;
    } else if (hit.kind === 'message') {
      window.location.hash = `/projects/${hit.id.split('_')[0] ?? ''}/chat`;
    }
    onClose();
  };

  const iconMap = {
    project: <FolderOpen size={16} />,
    message: <MessageSquare size={16} />,
    knowledge: <BookOpen size={16} />,
  } as const;

  const labelMap = {
    project: '项目',
    message: '消息',
    knowledge: '知识片段',
  } as const;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={handleKeyDown}>
      <div className="search-dialog" role="dialog" aria-label="全局搜索">
        <div className="search-dialog__header">
          <Search size={18} className="search-dialog__icon" />
          <input
            ref={inputRef}
            className="search-dialog__input"
            type="text"
            placeholder="搜索项目、消息、知识片段..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {query && (
            <button type="button" className="search-dialog__clear" onClick={() => setQuery('')} aria-label="清除">
              <X size={16} />
            </button>
          )}
          <kbd>ESC</kbd>
        </div>

        <div className="search-dialog__body">
          {loading && (
            <div className="search-dialog__loading">
              <Loader2 size={20} className="search-dialog__spinner" />
              <span>搜索中...</span>
            </div>
          )}

          {!loading && query && results.length === 0 && (
            <div className="search-dialog__empty">
              <p>未找到与 <strong>"{query}"</strong> 相关的结果</p>
            </div>
          )}

          {!loading && results.length > 0 && (
            <ul className="search-dialog__results" role="listbox">
              {results.map((hit) => (
                <li
                  key={`${hit.kind}-${hit.id}`}
                  className="search-dialog__result-item"
                  role="option"
                  tabIndex={0}
                  onClick={() => handleSelect(hit)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSelect(hit); }}
                >
                  <span className="search-dialog__result-icon">{iconMap[hit.kind]}</span>
                  <div className="search-dialog__result-content">
                    <div className="search-dialog__result-title">
                      <span>{hit.title}</span>
                      <span className="search-dialog__result-kind">{labelMap[hit.kind]}</span>
                    </div>
                    {hit.snippet && <p className="search-dialog__result-snippet">{hit.snippet}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {!query && (
            <div className="search-dialog__hint">
              <p>输入关键词搜索项目、消息和知识片段</p>
              <p className="search-dialog__hint-sub">支持全文搜索，按 <kbd>Enter</kbd> 选择结果</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}