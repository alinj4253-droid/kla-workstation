import { useQuery } from '@tanstack/react-query';
import type { UseQueryOptions } from '@tanstack/react-query';
import type { DocumentSlices } from '@kla-workstation/contracts/knowledge';
import { bKey } from '../shared.js';
import type { QueryContext } from '../shared.js';
import { fetchDocumentSlices } from './adapter.js';

export type SliceQueryContext = QueryContext;

export function slicesOptions(
  context: SliceQueryContext,
  docId: string,
  expectedCollection?: string,
): UseQueryOptions<DocumentSlices, Error> {
  const versionPart = context.resourceVersion === undefined ? [] : [context.resourceVersion];
  return {
    queryKey: bKey(context.cacheScope, 'slices', docId, ...versionPart),
    queryFn: () => fetchDocumentSlices(context, { docId }, expectedCollection),
    // 切片按文档版本缓存。集合里几十个文档时，任何一次全量失效都会同时打出几十个
    // /slices 请求并挤占检索，因此给一个明确的新鲜期，配合调用方的精确失效使用。
    // 5 分钟：打开检索面板时切片通常仍在新鲜期内，不会重发；真正的更新由
    // KnowledgeDetail 在文档/任务状态变化时的精确失效（排除 search）来触发。
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  };
}

export function useDocumentSlices(context: SliceQueryContext, docId: string, enabled = true, expectedCollection?: string) {
  return useQuery<DocumentSlices, Error>({
    ...slicesOptions(context, docId, expectedCollection),
    enabled: enabled && docId.length > 0,
  });
}
