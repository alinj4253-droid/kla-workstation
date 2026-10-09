import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { ChunkCountReport, KnowledgeContext, KnowledgeSlice, KnowledgeSource, OpenKnowledgeSource } from '@kla-workstation/contracts/knowledge';
import { BQueryError } from '../shared.js';
import type { QueryContext } from '../shared.js';
import { slicesOptions } from './query.js';
import { SliceDetailContent, SliceDrawer } from './SliceDrawer.js';

export interface MultiSourceSlicesProps {
  context: QueryContext;
  sources: readonly KnowledgeSource[];
  sourceVersion: string;
  onChunkCount: (report: ChunkCountReport) => void;
  scope: KnowledgeContext;
  onOpenSlice: (selection: { slice: KnowledgeSlice; source: KnowledgeSource }) => void;
}

interface SliceRow {
  slice: KnowledgeSlice;
  source: KnowledgeSource;
  sourceLabel: string;
}

interface SliceListProps extends Omit<MultiSourceSlicesProps, 'sourceVersion' | 'onChunkCount' | 'scope'> {
  mode?: 'all' | 'single';
  selectedDocId?: string | undefined;
  onSelectSource?: (docId: string) => void;
  sourceVersion?: string;
  onChunkCount?: (report: ChunkCountReport) => void;
  scope?: KnowledgeContext;
  onOpenSliceTrigger?: (trigger: HTMLButtonElement) => void;
}

interface ViewState {
  key: string;
  sourceId: string;
  filterText: string;
  page: number;
}

export interface SlicePanelProps {
  context: QueryContext;
  sources: readonly KnowledgeSource[];
  selectedDocId: string | undefined;
  onSelectSource: (docId: string) => void;
  onOpenSource: (source: OpenKnowledgeSource) => void;
  detailOpen?: boolean;
  onDetailOpenChange?: (open: boolean) => void;
}

const PAGE_SIZE = 20;
const PREVIEW_CHARACTER_LIMIT = 100;

function previewContent(content: string): string {
  const characters = Array.from(content);
  return characters.length > PREVIEW_CHARACTER_LIMIT
    ? characters.slice(0, PREVIEW_CHARACTER_LIMIT).join('') + '…'
    : content;
}

function errorDescription(error: Error): string {
  if (!(error instanceof BQueryError)) return '知识切片加载失败。';
  switch (error.kind) {
    case 'unconfigured': return '知识服务尚未配置。';
    case 'slices_pending': return '该来源尚未生成知识切片。';
    case 'not_found': return '来源文档不存在或已不可用。';
    case 'forbidden': return '没有权限读取该来源的切片。';
    case 'unauthorized': return '知识服务鉴权失败。';
    case 'network': return '知识服务网络连接失败。';
    case 'timeout': return '知识服务请求超时。';
    case 'protocol': return '知识服务返回的切片数据不符合接口契约。';
    default: return '知识切片加载失败。';
  }
}

function searchableText(row: SliceRow): string {
  return [row.slice.title, row.slice.content, row.source.name, row.sourceLabel,
    row.slice.group === undefined || row.slice.group === null ? '' : String(row.slice.group)]
    .join('\n')
    .toLocaleLowerCase('zh-CN');
}

function uniqueSources(sources: readonly KnowledgeSource[]): KnowledgeSource[] {
  const seen = new Set<string>();
  return sources.filter(source => {
    if (seen.has(source.docId)) return false;
    seen.add(source.docId);
    return true;
  });
}

function buildSourceLabels(sources: readonly KnowledgeSource[]): Map<string, string> {
  const totals = new Map<string, number>();
  const ordinals = new Map<string, number>();
  const labels = new Map<string, string>();
  sources.forEach(source => totals.set(source.name, (totals.get(source.name) ?? 0) + 1));
  sources.forEach(source => {
    const ordinal = (ordinals.get(source.name) ?? 0) + 1;
    ordinals.set(source.name, ordinal);
    labels.set(source.docId, (totals.get(source.name) ?? 0) > 1
      ? `${source.name} · 同名来源 ${ordinal}`
      : source.name);
  });
  return labels;
}

function SliceList({
  context, sources, onOpenSlice, mode = 'all', selectedDocId, onSelectSource,
  sourceVersion, onChunkCount, scope,
  onOpenSliceTrigger,
}: SliceListProps): JSX.Element {
  const allSources = useMemo(() => uniqueSources(sources), [sources]);
  const expectedCollection = scope?.collection;
  const sourcesInScope = allSources.filter(source => expectedCollection === undefined || source.collection === expectedCollection);
  const mismatchedSourceCount = allSources.length - sourcesInScope.length;
  const sourceLabels = useMemo(() => buildSourceLabels(sourcesInScope), [sourcesInScope]);
  const sourceMap = useMemo(() => new Map(sourcesInScope.map(source => [source.docId, source])), [sourcesInScope]);
  const requestedSource = mode === 'single' ? (selectedDocId ? sourceMap.get(selectedDocId) : undefined) : undefined;
  const querySources = mode === 'single'
    ? requestedSource ? [requestedSource] : []
    : sourcesInScope;
  const sourceSetKey = JSON.stringify(allSources.map(source => [source.docId, source.collection, source.version ?? null]));
  const viewKey = `${context.cacheScope}:${mode}:${sourceSetKey}:${mode === 'single' ? selectedDocId ?? '' : ''}`;
  const [view, setView] = useState<ViewState>({ key: viewKey, sourceId: '', filterText: '', page: 1 });
  const hasCurrentView = view.key === viewKey;
  const selectedSourceFilter = hasCurrentView ? view.sourceId : '';
  const filterText = hasCurrentView ? view.filterText : '';
  const currentPage = hasCurrentView ? view.page : 1;

  const queries = useQueries({ queries: querySources.map(source => {
    const versionedContext: QueryContext = { ...context, resourceVersion: source.version ?? context.resourceVersion };
    return { ...slicesOptions(versionedContext, source.docId, source.collection), enabled: source.docId.length > 0 };
  }) });

  const rows: SliceRow[] = querySources.flatMap((source, index) => {
    const data = queries[index]?.data;
    if (!data) return [];
    return data.slices.map(slice => ({ slice, source, sourceLabel: sourceLabels.get(source.docId) ?? source.name }));
  });
  const normalizedFilter = filterText.trim().toLocaleLowerCase('zh-CN');
  const visibleRows = rows.filter(row => {
    if (mode === 'all' && selectedSourceFilter && row.source.docId !== selectedSourceFilter) return false;
    return !normalizedFilter || searchableText(row).includes(normalizedFilter);
  });
  const pageCount = Math.ceil(visibleRows.length / PAGE_SIZE);
  const displayedPage = Math.min(currentPage, Math.max(pageCount, 1));
  const pageRows = visibleRows.slice((displayedPage - 1) * PAGE_SIZE, displayedPage * PAGE_SIZE);
  const loadedCount = querySources.reduce((total, _source, index) => total + (queries[index]?.data?.count ?? 0), 0);
  const loadedSources = querySources.reduce((total, _source, index) => total + (queries[index]?.data ? 1 : 0), 0);
  const failedQueries = queries.flatMap((query, index) => query.isError ? [{ query, source: querySources[index]! }] : []);
  const fetchingCount = queries.filter(query => query.isFetching).length;
  const selectedSourceIndex = selectedSourceFilter ? querySources.findIndex(source => source.docId === selectedSourceFilter) : -1;
  const selectedSourceHasNoSlices = selectedSourceIndex >= 0 && queries[selectedSourceIndex]?.data?.count === 0;
  // 「完整」只看是否已成功取到数据，不看 isFetching。此前把 isFetching 也算作不完整，
  // 结果后台任意一个来源刷新，计数就从「共 N 个切片」跳成「已加载 N · M/K 个来源」并弹出
  // 「当前统计暂不完整」，来源逐个返回时反复闪动（用户看到一条一条往外跳）。
  // 刷新期间沿用上次结果即可，统计数字本身不会因此出错。
  const complete = mismatchedSourceCount === 0
    && queries.every(query => query.data !== undefined && !query.isError);
  // 只用「是否已取到数据 + 数量」做签名：把 isFetching 计入会让每次后台刷新都重新
  // 上报一次切片统计，上层卡片跟着反复变化。
  const queryStateSignature = queries.map(query => `${query.data === undefined ? 'pending' : 'ready'}:${query.data?.count ?? ''}`).join('|');

  useEffect(() => {
    if (!onChunkCount || !scope || sourceVersion === undefined) return;
    const error = mismatchedSourceCount > 0
      ? '有来源与当前知识集合不一致，未纳入切片统计。'
      : failedQueries.length > 0
        ? `${failedQueries.length} 个来源加载失败，当前数量为部分已加载结果。`
        : undefined;
    onChunkCount({
      serviceInstanceId: scope.serviceInstanceId,
      collection: scope.collection,
      ...(scope.knowledgeBaseId !== undefined ? { knowledgeBaseId: scope.knowledgeBaseId } : {}),
      sourceVersion,
      count: loadedCount,
      complete,
      ...(error ? { error } : {}),
    });
  }, [
    complete, failedQueries.length, loadedCount, mismatchedSourceCount, onChunkCount,
    scope?.collection, scope?.knowledgeBaseId, scope?.serviceInstanceId,
    sourceVersion, queryStateSignature,
  ]);

  const changeView = (patch: Partial<Omit<ViewState, 'key'>>): void => {
    setView({
      key: viewKey,
      sourceId: selectedSourceFilter,
      filterText,
      page: currentPage,
      ...patch,
    });
  };

  return (
    <section className="kb-b-slices" aria-label="知识切片列表">
      <div className="kb-b-slices__toolbar">
        <label>
          搜索切片
          <input
            type="search"
            aria-label="搜索切片标题和正文"
            placeholder="搜索知识切片"
            value={filterText}
            onChange={event => changeView({ filterText: event.currentTarget.value, page: 1 })}
          />
        </label>
        <label>
          来源文件
          <select
            aria-label="切片来源文件"
            value={mode === 'single' ? selectedDocId ?? '' : selectedSourceFilter}
            onChange={event => {
              const docId = event.currentTarget.value;
              if (mode === 'single') {
                if (sourceMap.has(docId)) onSelectSource?.(docId);
              }
              else changeView({ sourceId: docId, page: 1 });
            }}
          >
            {mode === 'all' ? <option value="">全部来源</option> : <option value="">请选择来源文件</option>}
            {sourcesInScope.map(source => <option value={source.docId} key={source.docId}>{sourceLabels.get(source.docId) ?? source.name}</option>)}
          </select>
        </label>
        <span className="kb-b-slices__count" aria-live="polite">
          {complete ? `共 ${loadedCount} 个切片` : `已加载 ${loadedCount} 个切片 · ${loadedSources}/${querySources.length} 个来源`}
        </span>
      </div>

      {mismatchedSourceCount > 0 && <p role="alert">有 {mismatchedSourceCount} 个来源不属于当前知识集合，已跳过。</p>}
      {fetchingCount > 0 && rows.length === 0 && <p role="status">正在加载知识切片…</p>}
      {failedQueries.length > 0 && <div className="kb-b-slices__errors" aria-label="来源切片错误">
        {failedQueries.map(({ query, source }) => (
          <div role="alert" key={source.docId}>
            <span>{sourceLabels.get(source.docId) ?? source.name}：{errorDescription(query.error as Error)}</span>
            <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
              重试：{sourceLabels.get(source.docId) ?? source.name}
            </button>
          </div>
        ))}
      </div>}

      {!allSources.length ? <p role="status">当前没有可用的来源文档，因此切片数量为 0。</p>
        : !sourcesInScope.length ? <p role="status">当前来源与知识集合不匹配，无法读取切片。</p>
          : mode === 'single' && !requestedSource ? <p role="status">请选择来源文件以加载其知识切片。</p>
            : queries.some(query => query.isPending && !query.data) && rows.length === 0
              ? <p role="status">正在加载知识切片…</p>
              : rows.length === 0 && failedQueries.length === 0
                ? <p role="status">{mode === 'single' && queries.some(query => query.isSuccess) ? '此文档没有可显示的切片。' : '当前来源没有知识切片。'}</p>
                : visibleRows.length === 0 && failedQueries.length === 0
                  ? <p role="status">{selectedSourceHasNoSlices ? '所选来源没有知识切片。' : '没有匹配的切片，请调整筛选条件。'}</p>
                  : visibleRows.length === 0
                    ? null
                    : <div className="kb-b-slices__table-wrap">
                        <table aria-label={mode === 'single' ? '当前文档已加载的知识切片' : '当前来源已加载的知识切片'}>
                          <colgroup>
                            <col style={{ width: '24%' }} />
                            <col style={{ width: '24%' }} />
                            <col style={{ width: '16%' }} />
                            <col style={{ width: '28%' }} />
                            <col style={{ width: '8%' }} />
                          </colgroup>
                          <thead>
                            <tr>
                              <th scope="col">标题</th>
                              <th scope="col">来源文件</th>
                              <th scope="col">切片编号</th>
                              <th scope="col">正文预览</th>
                              <th scope="col">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pageRows.map(({ slice, source, sourceLabel }) => (
                              <tr key={`${source.docId}:${slice.id}`}>
                                <td>
                                  <button
                                    type="button"
                                    className="kb-b-slice__open"
                                    aria-haspopup="dialog"
                                    aria-label={`打开切片详情：${slice.title || '未提供标题'}${mode === 'all' ? ` · ${sourceLabel}` : ''}`}
                                    onClick={event => {
                                      onOpenSliceTrigger?.(event.currentTarget);
                                      onOpenSlice({ slice, source });
                                    }}
                                  >
                                    {slice.title || '（未提供标题）'}
                                  </button>
                                </td>
                                <td><div className="kb-b-slice__source" title={source.name}>{sourceLabel}</div></td>
                                <td><span>#{slice.id}</span></td>
                                <td><div className="kb-b-slice__preview">{previewContent(slice.content)}</div></td>
                                <td><button type="button" aria-haspopup="dialog" aria-label={`查看切片：${slice.title || slice.id} · ${sourceLabel}`} onClick={event => { onOpenSliceTrigger?.(event.currentTarget); onOpenSlice({ slice, source }); }}>查看</button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>}

      <footer className="kb-b-slices__footer">
        {/* 计数已在工具栏右侧展示，页脚只留分页控制，避免同一数字在两处跳动 */}
        {visibleRows.length > 0 && <div role="group" aria-label="切片分页">
          <button type="button" onClick={() => changeView({ page: displayedPage - 1 })} disabled={displayedPage <= 1}>上一页</button>
          <span aria-live="polite">第 {displayedPage} / {pageCount} 页</span>
          <button type="button" onClick={() => changeView({ page: displayedPage + 1 })} disabled={displayedPage >= pageCount}>下一页</button>
        </div>}
      </footer>
    </section>
  );
}

/** Lists every current source and delegates slice details to the host drawer. */
export function MultiSourceSlices(props: MultiSourceSlicesProps): JSX.Element {
  return <SliceList {...props} mode="all" />;
}

/** Compatibility wrapper for the original single-document preview. It uses the same table and query implementation. */
export function SlicePanel({
  context, sources, selectedDocId, onSelectSource, onOpenSource, detailOpen, onDetailOpenChange,
}: SlicePanelProps): JSX.Element {
  const [selection, setSelection] = useState<{ slice: KnowledgeSlice; source: KnowledgeSource } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const drawerWasOpen = useRef(false);
  const restoreFocusOnClose = useRef(false);
  const isDetailOpen = detailOpen ?? selection !== null;
  const selectedSource = selection && sources.find(source => source.docId === selection.source.docId && source.version === selection.source.version);
  const currentSelection = isDetailOpen && selectedSource ? { slice: selection!.slice, source: selectedSource } : null;

  useEffect(() => {
    const open = Boolean(currentSelection);
    if (drawerWasOpen.current && !open && restoreFocusOnClose.current && returnFocus.current?.isConnected) {
      returnFocus.current.focus();
      restoreFocusOnClose.current = false;
    }
    drawerWasOpen.current = open;
  }, [currentSelection]);

  useEffect(() => {
    if (!isDetailOpen && selection) setSelection(null);
  }, [isDetailOpen, selection]);

  return <>
    <SliceList
      context={context}
      sources={sources}
      selectedDocId={selectedDocId}
      onSelectSource={docId => {
        setSelection(null);
        onDetailOpenChange?.(false);
        onSelectSource(docId);
      }}
      mode="single"
      onOpenSliceTrigger={trigger => { returnFocus.current = trigger; }}
      onOpenSlice={picked => {
        setSelection(picked);
        onDetailOpenChange?.(true);
      }}
    />
    {currentSelection && <SliceDrawer
      key={`${currentSelection.source.docId}:${currentSelection.slice.id}`}
      {...currentSelection}
      onClose={() => {
        restoreFocusOnClose.current = true;
        setSelection(null);
        onDetailOpenChange?.(false);
      }}
      onOpenSource={source => {
        restoreFocusOnClose.current = false;
        setSelection(null);
        onDetailOpenChange?.(false);
        onOpenSource(source);
      }}
    />}
  </>;
}

export { SliceDetailContent } from './SliceDrawer.js';
