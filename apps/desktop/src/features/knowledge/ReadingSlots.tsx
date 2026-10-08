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
  return <div className="kb-b-body"><DocumentContent key={JSON.stringify([queryContext.cacheScope, source.docId, version])} context={queryContext} docId={source.docId} displayName={current?.name ?? source.displayName} {...(sliceIndex !== undefined ? { sliceIndex } : {})}/></div>;
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
export function KnowledgeSearchContent({ context, sources, sourceVersion, onOpenDocument }: SearchProps) {
  const queryContext = useMemo(() => readingContext(context, sourceVersion), [context.serviceInstanceId, context.collection, sourceVersion]);
  const queries = useQueries({ queries: sources.map(source => slicesOptions({ ...queryContext, resourceVersion: source.version }, source.docId, context.collection)) });
  const mappingReady = queries.every(query => query.isSuccess && !query.isError && !query.isFetching);
  const mapped = mappingReady ? sources.map((source, index) => ({ ...source, searchSources: queries[index]?.data ? [queries[index]!.data!.source] : [] })) : [];
  const openSource = (target: OpenKnowledgeSource) => {
    const source = mapped.find(item => item.docId === target.docId);
    if (source) onOpenDocument(publicRef(source), target.sliceIndex);
  };
  return <div className="kb-b-body">{!mappingReady && <p className="kb-b-note">{queries.some(query => query.isError) ? '部分来源关联未确认，暂不能从检索结果打开原件。可在切片列表重试读取。' : '正在核对结果来源关联…'}</p>}<SearchContent key={JSON.stringify([readingScope(context), sourceVersion])} context={queryContext} collection={context.collection} sources={mapped} onOpenSource={openSource}/></div>;
}
export const knowledgeReadingSlots: KnowledgeSlots = {
  chunksPanel: props => <KnowledgeSlicesContent {...props}/>,
  documentPanel: props => <KnowledgeDocumentContent {...props}/>,
  searchPanel: props => <KnowledgeSearchContent {...props}/>,
  slicePanel: ({ slice, source, onOpenDocument }) => <div className="kb-b-body"><SliceDetailContent slice={slice} source={source} onOpenSource={target => onOpenDocument(publicRef(source), target.sliceIndex)}/></div>,
};
