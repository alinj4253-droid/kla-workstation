import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { SafeBody } from '../SafeBody.js';
import { useDocumentContent } from './query.js';
import type { QueryContext } from '../shared.js';
import { readingPages } from './reading-pages';
import { locateTextPage, type TextLocation } from './locate-text';

export interface TextPreviewProps {
  context: QueryContext;
  docId: string;
  format: 'txt' | 'md';
  readable: boolean;
  displayName?: string;
  limit?: number;
  locateText?: string;
}

export function TextPreview({ context, docId, format, readable, displayName, limit = 2, locateText }: TextPreviewProps): JSX.Element {
  const query = useDocumentContent(context, docId, limit, readable);
  const requestKey = JSON.stringify([context.cacheScope, context.resourceVersion, docId, limit, locateText]);
  const currentKey = useRef(requestKey);
  currentKey.current = requestKey;
  const [selection, setSelection] = useState({ key: requestKey, page: 0 });
  const appendRequest = useRef<{ key: string; pending: boolean } | null>(null);
  const pages = query.data?.pages ?? [];
  const visiblePages = readingPages(pages);
  const selectedPage = selection.key === requestKey ? Math.min(selection.page, Math.max(0, visiblePages.length - 1)) : 0;
  const queryRef = useRef(query);
  queryRef.current = query;
  const sheetRef = useRef<HTMLDivElement>(null);
  const [location, setLocation] = useState<{ key: string; result: TextLocation | { kind: 'error' | 'incomplete' } } | null>(null);
  const locating = Boolean(locateText) && location?.key !== requestKey;
  const hasData = Boolean(query.data);

  useEffect(() => {
    if (!locateText || !readable || !hasData) return;
    let cancelled = false;
    const locate = async () => {
      const finish = (result: TextLocation | { kind: 'error' | 'incomplete' }) => {
        if (cancelled || currentKey.current !== requestKey) return;
        setLocation({ key: requestKey, result });
        if (result.kind === 'found') setSelection({ key: requestKey, page: result.page });
      };
      let loaded = queryRef.current.data?.pages ?? [];
      for (let request = 0; request < 100 && !cancelled; request++) {
        if (loaded.reduce((size, page) => size + page.paragraphs.join('').length, 0) > 2_000_000) {
          finish({ kind: 'incomplete' }); return;
        }
        const last = loaded.at(-1);
        if (!last) { finish({ kind: 'error' }); return; }
        if (!last.has_more) { finish(locateTextPage(readingPages(loaded), locateText)); return; }
        if (last.next_para === null || last.returned <= 0 || last.next_para !== last.para + last.returned) {
          finish({ kind: 'incomplete' }); return;
        }
        const result = await queryRef.current.fetchNextPage({ cancelRefetch: false });
        if (result.isError) { finish({ kind: 'error' }); return; }
        const next = result.data?.pages ?? [];
        if (next.length <= loaded.length) { finish({ kind: 'incomplete' }); return; }
        loaded = next;
      }
      finish({ kind: 'incomplete' });
    };
    void locate().catch(() => {
      if (!cancelled && currentKey.current === requestKey) setLocation({ key: requestKey, result: { kind: 'error' } });
    });
    return () => { cancelled = true; };
  }, [requestKey, locateText, readable, hasData]);

  useEffect(() => {
    if (location?.key === requestKey && location.result.kind === 'found' && location.result.page === selectedPage) {
      sheetRef.current?.focus({ preventScroll: true });
      sheetRef.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [location, requestKey, selectedPage]);

  const nextPage = async (): Promise<void> => {
    if (query.isFetching || locating) return;
    const target = selectedPage + 1;
    if (target < visiblePages.length) {
      setSelection({ key: requestKey, page: target });
      return;
    }
    let currentRequest = appendRequest.current;
    if (!currentRequest || currentRequest.key !== requestKey) {
      currentRequest = { key: requestKey, pending: false };
      appendRequest.current = currentRequest;
    }
    if (currentRequest.pending || !query.hasNextPage) return;
    currentRequest.pending = true;
    try {
      const result = await query.fetchNextPage({ cancelRefetch: false });
      if (currentKey.current === requestKey && !result.isError && readingPages(result.data?.pages ?? []).length > target) {
        setSelection({ key: requestKey, page: target });
      }
    } finally {
      if (appendRequest.current === currentRequest) currentRequest.pending = false;
    }
  };

  if (!readable) return <div className="kb-b-content-unavailable">此文件不支持全文预览</div>;
  if (query.isPending && !query.data) return <div className="kb-b-content-loading" role="status">正在加载文档段落…</div>;
  if (query.isError && !query.data) {
    return (
      <div className="kb-b-content-error" role="alert">
        <span>正文首次加载失败：{query.error.message}</span>
        <button type="button" className="kb-b-content-action" onClick={() => void query.refetch()} disabled={query.isFetching}>重试加载</button>
      </div>
    );
  }

  const firstPage = pages[0];
  const lastPage = pages.at(-1);
  const page = visiblePages[selectedPage];
  const hasNext = selectedPage + 1 < visiblePages.length || Boolean(query.hasNextPage);

  if (firstPage && firstPage.total_paragraphs === 0) {
    return <div className="kb-b-content-empty" role="status">此文档没有可预览的内容</div>;
  }

  return (
    <section className="kb-b-content-preview" aria-label="文档段落预览">
      {firstPage && <div className="kb-b-content-heading">{displayName || '原文预览'}</div>}
      {locateText && <p role="status">{locating ? '正在逐段读取并匹配来源位置…' : location?.result.kind === 'found' ? location.result.partial ? '已按切片中唯一匹配的原文片段定位；切片经过清洗，文字可能不同。' : '已按切片文本定位到对应阅读页（忽略空白与 Markdown 标记差异）。' : location?.result.kind === 'ambiguous' ? '正文中有多个相同片段，无法唯一定位，请手动阅读。' : location?.result.kind === 'missing' ? '原文中未找到相同片段；切片可能经过清洗或原文已更新，请手动阅读。' : location?.result.kind === 'error' ? '来源定位读取失败，已加载正文保留；请关闭后重新打开重试。' : '未能完整读取正文，无法确认唯一位置，请手动阅读。'}</p>}
      {page && <nav className="kb-b-content-pagination" aria-label="原始文件正文分页">
        <button type="button" className="kb-b-content-action" onClick={() => setSelection({ key: requestKey, page: selectedPage - 1 })} disabled={selectedPage === 0 || query.isFetching || locating}>上一页</button>
        <span aria-live="polite">第 {selectedPage + 1} 页 · {lastPage?.has_more ? `已加载 ${visiblePages.length} 页` : `共 ${visiblePages.length} 页`}</span>
        <button type="button" className="kb-b-content-action" onClick={() => void nextPage()} disabled={!hasNext || query.isFetching || locating}>{query.isFetchingNextPage ? '正在加载…' : query.isFetchNextPageError && selectedPage === visiblePages.length - 1 ? '重试下一页' : '下一页'}</button>
      </nav>}
      <div ref={sheetRef} className="kb-b-reading-sheet" key={`${requestKey}:${selectedPage}`} aria-label={`正文第 ${selectedPage + 1} 页`} tabIndex={0}>
        <SafeBody content={page?.content ?? ''} markdown={format === 'md'} />
      </div>
      {page && <div className="kb-b-content-count">当前内容来自第 {page.para + 1}–{page.para + page.returned} 段 / 共 {page.total} 段</div>}
      {query.isError && query.data && !query.isFetchNextPageError && (
        <div className="kb-b-content-error" role="alert">
          <span>更新正文失败，当前页仍可查看。</span>
          <button type="button" className="kb-b-content-action" onClick={() => void query.refetch()} disabled={query.isFetching}>重试</button>
        </div>
      )}
      {query.isFetchNextPageError && <div className="kb-b-content-error" role="alert">下一页加载失败，当前页仍可查看，请重试下一页。</div>}

      {lastPage?.has_more && !query.hasNextPage && <div className="kb-b-content-more" role="status">已停止继续加载：没有有效的下一段位置。</div>}
      <details className="kb-b-content-scope">
        <summary>阅读范围说明</summary>
        <p>正文分成适合阅读的短页，长段落也会分页；翻页按需读取后续内容。页码为文本阅读页码，接口没有提供原文件或 PDF 页码。</p>
      </details>
    </section>
  );
}
