import { useEffect, useId, useState, type FormEvent, type JSX, type KeyboardEvent } from 'react';
import { searchRequestSchema } from '@kla-workstation/contracts/knowledge';
import type { KnowledgeSource, OpenKnowledgeSource, SearchHit, SearchRequest } from '@kla-workstation/contracts/knowledge';
import { SafeBody } from '../SafeBody.js';
import { resolveSource } from '../shared.js';
import type { QueryContext } from '../shared.js';
import { useKnowledgeSearch } from './query.js';

export interface SearchContentProps {
  context: QueryContext;
  collection: string;
  sources: readonly KnowledgeSource[];
  onOpenSource: (source: OpenKnowledgeSource) => void;
}

function sameRequest(left: SearchRequest | null, right: SearchRequest): boolean {
  return left !== null
    && left.query === right.query
    && left.collection === right.collection
    && left.mode === right.mode
    && left.top_k === right.top_k
    && left.expand === right.expand
    && left.fold_adjacent === right.fold_adjacent;
}

function SourceAction({
  sources,
  collection,
  source,
  sliceIndex,
  onOpenSource,
}: {
  sources: readonly KnowledgeSource[];
  collection: string;
  source: string | null | undefined;
  sliceIndex: SearchHit['slice_index'];
  onOpenSource: (source: OpenKnowledgeSource) => void;
}): JSX.Element {
  const reasonId = useId();
  const unavailable = (reason: string): JSX.Element => (
    <div>
      <button type="button" disabled aria-describedby={reasonId}>打开来源正文</button>
      <p id={reasonId} className="kb-b-note">{reason}</p>
    </div>
  );

  if (!source) return unavailable('检索服务没有返回来源标识，无法定位源文件。');
  const matches = sources.filter(item => item.collection === collection && item.searchSources.includes(source));
  if (matches.length === 0) return unavailable('来源标识未映射到当前知识库的文件，无法打开来源。');
  if (matches.length > 1) return unavailable('来源未映射或映射不唯一：该标识匹配多个文件，无法唯一定位。');

  const sourceInfo = matches[0];
  if (!sourceInfo) return unavailable('来源映射无效，无法定位源文件。');
  const mapped = resolveSource(sources, collection, source);
  if (!mapped || mapped.docId !== sourceInfo.docId) return unavailable('来源映射无效，无法定位源文件。');
  const target: OpenKnowledgeSource = sliceIndex === null || sliceIndex === undefined
    ? mapped
    : { ...mapped, sliceIndex };

  return (
    <div>
      <p className="kb-b-note">来源文件：{sourceInfo.name}</p>
      <button type="button" onClick={() => onOpenSource(target)}>
        打开来源正文{sliceIndex === null || sliceIndex === undefined ? '' : `（切片 ${sliceIndex}）`}
      </button>
    </div>
  );
}

function scoreDescription(hit: SearchHit): string[] {
  const description = [`检索分数 ${hit.score}`];
  if (hit.score_type !== undefined) description.push(`口径 ${hit.score_type}`);
  if (hit.score_pct !== undefined) description.push(`本次相对分 ${hit.score_pct}%`);
  if (hit.match_type !== undefined) description.push(`匹配方式 ${hit.match_type}`);
  return description;
}

function SearchHitCard({
  hit,
  collection,
  sources,
  onOpenSource,
}: {
  hit: SearchHit;
  collection: string;
  sources: readonly KnowledgeSource[];
  onOpenSource: (source: OpenKnowledgeSource) => void;
}): JSX.Element {
  return (
    <article>
      <h3>{hit.rank}. {hit.title}</h3>
      <p className="kb-b-note">命中片段</p>
      <SafeBody content={hit.content} />
      <p className="kb-b-note">{scoreDescription(hit).join(' · ')}</p>
      <SourceAction
        sources={sources}
        collection={collection}
        source={hit.source}
        sliceIndex={hit.slice_index}
        onOpenSource={onOpenSource}
      />

      {hit.context_group !== undefined && (
        <details>
          <summary>同一自然段组上下文（{hit.context_group.length}）</summary>
          {hit.context_group.length === 0 ? <p className="kb-b-note">服务未返回同组上下文。</p> : hit.context_group.map((slice, index) => (
            <div key={`${slice.slice_index}-${index}`}>
              <p className="kb-b-note">切片 {slice.slice_index}</p>
              <SafeBody content={slice.content} />
              <SourceAction
                sources={sources}
                collection={collection}
                source={hit.source}
                sliceIndex={slice.slice_index}
                onOpenSource={onOpenSource}
              />
            </div>
          ))}
        </details>
      )}

      {hit.also_matched !== undefined && (
        <details>
          <summary>折叠的相邻命中（{hit.also_matched.length}）</summary>
          {hit.also_matched.length === 0 ? <p className="kb-b-note">服务未返回折叠的相邻命中。</p> : hit.also_matched.map((slice, index) => (
            <div key={`${slice.slice_index}-${index}`}>
              <p className="kb-b-note">
                切片 {slice.slice_index}{slice.score == null ? '' : ` · 检索分数 ${slice.score}`}
              </p>
              <SafeBody content={slice.content} />
              <SourceAction
                sources={sources}
                collection={collection}
                source={hit.source}
                sliceIndex={slice.slice_index}
                onOpenSource={onOpenSource}
              />
            </div>
          ))}
        </details>
      )}

      {hit.neighbors !== undefined && (
        <details>
          <summary>前后邻片内容</summary>
          <div>
            <h4>前一片</h4>
            {hit.neighbors.prev === null ? <p className="kb-b-note">没有返回前一片内容。</p> : <SafeBody content={hit.neighbors.prev} />}
          </div>
          <div>
            <h4>后一片</h4>
            {hit.neighbors.next === null ? <p className="kb-b-note">没有返回后一片内容。</p> : <SafeBody content={hit.neighbors.next} />}
          </div>
          <p className="kb-b-note">机械邻片可能跨越话题，仅供查看上下文。</p>
        </details>
      )}
    </article>
  );
}

export function SearchContent({ context, collection, sources, onOpenSource }: SearchContentProps): JSX.Element {
  const [queryText, setQueryText] = useState('');
  const [mode, setMode] = useState<SearchRequest['mode']>('hybrid');
  const [topKText, setTopKText] = useState('5');
  const [expand, setExpand] = useState<SearchRequest['expand']>(1);
  const [foldAdjacent, setFoldAdjacent] = useState(true);
  const [submitted, setSubmitted] = useState<{ request: SearchRequest; cacheScope: string } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const activeRequest = submitted?.cacheScope === context.cacheScope && submitted.request.collection === collection
    ? submitted.request
    : null;
  const query = useKnowledgeSearch(context, activeRequest);

  useEffect(() => {
    setSubmitted(current => current !== null
      && (current.cacheScope !== context.cacheScope || current.request.collection !== collection)
      ? null
      : current);
    setValidationError(null);
  }, [context.cacheScope, collection]);

  const submitOnShortcut = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = searchRequestSchema.safeParse({
      query: queryText,
      collection,
      mode,
      top_k: Number(topKText),
      expand,
      fold_adjacent: foldAdjacent,
    });
    if (!parsed.success) {
      setSubmitted(null);
      setValidationError('检索参数无效。请输入非空检索词，并检查知识库集合、返回数量和上下文扩展设置。');
      return;
    }

    const request = parsed.data;
    setValidationError(null);
    if (sameRequest(activeRequest, request)) {
      if (!query.isFetching) void query.refetch();
    } else {
      setSubmitted({ request, cacheScope: context.cacheScope });
    }
  };

  return (
    <section className="kb-b-search-content">
      <form noValidate onSubmit={submit}>
        <label>
          检索词
          <textarea
            value={queryText}
            onChange={event => setQueryText(event.currentTarget.value)}
            onKeyDown={submitOnShortcut}
            maxLength={10000}
            rows={3}
          />
        </label>
        <p className="kb-b-note">Ctrl/Cmd+Enter 搜索。</p>
        <details>
          <summary>高级检索设置</summary>
          <p className="kb-b-note">当前知识库集合：{collection || '未配置'}</p>
          <label>
            检索模式
            <select value={mode} onChange={event => setMode(event.currentTarget.value as SearchRequest['mode'])}>
              <option value="hybrid">混合检索</option>
              <option value="vector">向量检索</option>
              <option value="keyword">关键词检索</option>
            </select>
          </label>
          <label>
            返回数量（1–100）
            <input type="number" min={1} max={100} step={1} value={topKText} onChange={event => setTopKText(event.currentTarget.value)} />
          </label>
          <label>
            上下文扩展
            <select value={expand} onChange={event => setExpand(Number(event.currentTarget.value) as SearchRequest['expand'])}>
              <option value={0}>不扩展</option>
              <option value={1}>同自然段组上下文</option>
              <option value={2}>机械前后邻片</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={foldAdjacent} onChange={event => setFoldAdjacent(event.currentTarget.checked)} />
            折叠相邻命中
          </label>
        </details>
        <button className="kb-b-primary" type="submit">搜索</button>
      </form>

      <p className="kb-b-note">检索分数不是答案正确概率，且不同模式的分数不可直接比较。</p>
      <section className="kb-b-search-results" role="region" aria-label="检索结果" aria-busy={query.isFetching}>
        {validationError && <p role="alert">{validationError}</p>}
        {query.isPending && activeRequest && <p role="status">正在搜索…</p>}
        {query.isFetching && query.data && <p role="status">正在更新；下方暂显示此前成功的结果。</p>}
        {query.isError && !query.data && (
          <div role="alert">
            <p>搜索失败：{query.error.message}</p>
            <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>重试搜索</button>
          </div>
        )}
        {query.isError && query.data && (
          <div role="alert">
            <p>本次搜索失败；下方保留的结果来自之前成功的请求，不能代表本次搜索。{query.error.message}</p>
            <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>重试本次搜索</button>
          </div>
        )}
        {query.data && activeRequest && (
          <details>
            <summary>本次检索条件</summary>
            <dl>
              <div><dt>检索词</dt><dd>{query.data.query}</dd></div>
              <div><dt>知识库集合</dt><dd>{query.data.collection}</dd></div>
              <div><dt>检索模式</dt><dd>{query.data.mode}</dd></div>
              <div><dt>返回数量</dt><dd>{activeRequest.top_k}</dd></div>
              <div><dt>上下文扩展</dt><dd>{activeRequest.expand}</dd></div>
              <div><dt>折叠相邻命中</dt><dd>{activeRequest.fold_adjacent ? '开启' : '关闭'}</dd></div>
            </dl>
          </details>
        )}
        {query.data && query.data.hits.length === 0 && <p role="status">没有找到相关内容。</p>}
        {query.data?.hits.map(hit => (
          <SearchHitCard
            key={`${hit.rank}-${hit.title}`}
            hit={hit}
            collection={collection}
            sources={sources}
            onOpenSource={onOpenSource}
          />
        ))}
      </section>
    </section>
  );
}

/** @deprecated Standalone preview compatibility only. Production composes SearchContent in its host shell. */
export function SearchDrawer(props: SearchContentProps): JSX.Element {
  return <SearchContent {...props} />;
}
