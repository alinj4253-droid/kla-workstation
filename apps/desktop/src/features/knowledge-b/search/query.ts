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
    retry: false,
    queryFn: () => {
      if (request === null) throw new Error('Search is disabled until the user submits a request');
      return searchKnowledge(context, request);
    },
  });
}
