import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { KnowledgeSource, OpenKnowledgeSource, SourceRef } from '@kla-workstation/contracts/knowledge';
import { DocumentContent } from '../knowledge-b/detail/DocumentContent';
import { MultiSourceSlices } from '../knowledge-b/slices/MultiSourceSlices';
import { SliceDetailContent } from '../knowledge-b/slices/SliceDrawer';
import { SearchContent } from '../knowledge-b/search/SearchDrawer';
import { slicesOptions } from '../knowledge-b/slices/query';
import { readingContext, readingScope } from './reading-api';
import type { KnowledgeSlots } from './slots';
import '../knowledge-b/knowledge-b.css';

type DocumentProps = Parameters<NonNullable<KnowledgeSlots['documentPanel']>>[0];
export function KnowledgeDocumentContent({ context, source, sources, sliceIndex }: DocumentProps) {
  const current = sources.find(item => item.docId === source.docId);
  const version = current?.version ?? source.version;
  const queryContext = useMemo(() => readingContext(context, version), [context.serviceInstanceId, context.collection, version]);
  return <div className="kb-b-body"><DocumentContent key={JSON.stringify([queryContext.cacheScope, source.docId, version, source.locateText])} context={queryContext} docId={source.docId} displayName={current?.name ?? source.displayName} {...(source.locateText !== undefined ? { locateText: source.locateText } : {})} {...(sliceIndex !== undefined ? { sliceIndex } : {})}/></div>;
}
type ChunksProps = Parameters<NonNullable<KnowledgeSlots['chunksPanel']>>[0];
export function KnowledgeSlicesContent({ context, sourceMappings, sourceVersion, onChunkCount, onOpenSlice }: ChunksProps) {
  const queryContext = useMemo(() => readingContext(context), [context.serviceInstanceId, context.collection]);
  return <div className="kb-b-body"><MultiSourceSlices key={readingScope(context)} context={queryContext} sources={sourceMappings} sourceVersion={sourceVersion} scope={context} onChunkCount={onChunkCount} onOpenSlice={onOpenSlice}/></div>;
}
function publicRef(source: KnowledgeSource): SourceRef {
  return { docId: source.docId, displayName: source.name, ...(source.version !== undefined ? { version: source.version } : {}) };
}
type SearchProps = Parameters<NonNullable<KnowledgeSlots['searchPanel']>>[0];
export function KnowledgeSearchContent({ context, sources, onOpenDocument }: SearchProps) {
  // 检索结果的缓存键只认「服务实例 + 集合」，不能掺入会随任务轮询每 4 秒变化的
  // sourceVersion：否则每轮轮询都会让 key 变、SearchContent 整体重挂载，已发出的
  // 检索请求被打断重发，用户看到「正在更新…」甚至超时。检索本身只依赖集合与检索词。
  const queryContext = useMemo(() => readingContext(context), [context.serviceInstanceId, context.collection]);
  // 「命中标识 → 来源文件」映射只有逐文档 /slices（契约无批量接口）。这里仍然一次性声明
  // 全部查询（react-query 自带去重与并发调度，重复声明只会翻倍请求），关键是让它们复用
  // 切片面板的同一 queryKey 并有足够长的 staleTime：打开检索面板时切片通常已缓存命中，
  // 不会真的打出几十个请求；缓存过期后也只补一次，不会被任务轮询反复重发。
  const queries = useQueries({ queries: sources.map(source => slicesOptions({ ...queryContext, resourceVersion: source.version }, source.docId, context.collection)) });
  const mappingReady = queries.every(query => query.data !== undefined);
  const mappingFailed = queries.some(query => query.isError);
  const mapped = mappingReady
    ? sources.map((source, index) => ({ ...source, searchSources: queries[index]?.data?.source ? [queries[index]!.data!.source] : [] }))
    : sources;
  const openSource = (target: OpenKnowledgeSource) => {
    const source = mapped.find(item => item.docId === target.docId);
    if (source) onOpenDocument({ ...publicRef(source), ...(target.locateText !== undefined ? { locateText: target.locateText } : {}) }, target.sliceIndex);
  };
  return <div className="kb-b-body">{mappingFailed && <p className="kb-b-note">部分来源关联未确认，暂不能从检索结果打开原件。可在切片列表重试读取。</p>}<SearchContent key={readingScope(context)} context={queryContext} collection={context.collection} sources={mapped} onOpenSource={openSource}/></div>;
}
export const knowledgeReadingSlots: KnowledgeSlots = {
  chunksPanel: props => <KnowledgeSlicesContent {...props}/>,
  documentPanel: props => <KnowledgeDocumentContent {...props}/>,
  searchPanel: props => <KnowledgeSearchContent {...props}/>,
  slicePanel: ({ slice, source, onOpenDocument }) => <div className="kb-b-body"><SliceDetailContent slice={slice} source={source} onOpenSource={target => onOpenDocument({ ...publicRef(source), ...(target.locateText !== undefined ? { locateText: target.locateText } : {}) }, target.sliceIndex)}/></div>,
};
