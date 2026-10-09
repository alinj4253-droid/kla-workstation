import { useQuery } from '@tanstack/react-query';
import type { SearchRequest, SearchResponse } from '@kla-workstation/contracts/knowledge';
import { bKey } from '../shared.js';
import type { QueryContext } from '../shared.js';
import { searchKnowledge } from './adapter.js';

export function useKnowledgeSearch(context: QueryContext, request: SearchRequest | null) {
  const resourceVersion = context.resourceVersion;
  const queryKey = request === null
    ? bKey(context.cacheScope, 'search', null, resourceVersion)
    : bKey(
      context.cacheScope,
      'search',
      request.collection,
      request.query,
      request.mode,
      request.top_k,
      request.expand,
      request.fold_adjacent,
      resourceVersion,
    );

  return useQuery<SearchResponse, Error>({
    queryKey,
    enabled: request !== null,
    // 检索是用户显式触发的动作，结果只依赖检索词与集合。任何缓存失效（任务轮询、
    // 窗口聚焦等）都不应把它变成后台自动重取，否则会出现"循环检索"且拖慢知识服务。
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryFn: () => {
      if (request === null) throw new Error('Search is disabled until the user submits a request');
      return searchKnowledge(context, request);
    },
  });
}
