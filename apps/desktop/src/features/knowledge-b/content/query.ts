import { useInfiniteQuery } from '@tanstack/react-query';
import type { KnowledgeBContentRequest, DocumentContent } from '@kla-workstation/contracts/knowledge';
import { bKey } from '../shared.js';
import type { QueryContext } from '../shared.js';
import { fetchDocumentContent } from './adapter.js';

export function useDocumentContent(
  context: QueryContext,
  docId: string,
  limit = 20,
  enabled = true,
) {
  return useInfiniteQuery<DocumentContent, Error, { pages: DocumentContent[]; pageParams: number[] }, readonly unknown[], number>({
    queryKey: bKey(context.cacheScope, 'content', docId, limit, context.resourceVersion),
    retry: false,
    enabled: enabled && docId.length > 0,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchDocumentContent(context, { docId, para: pageParam, limit } satisfies KnowledgeBContentRequest),
    getNextPageParam: (lastPage) => {
      const next = lastPage.next_para;
      if (!lastPage.has_more || next === null || lastPage.returned <= 0) return undefined;
      // Keep malformed, repeated, skipped, or backward cursors from causing an infinite fetch loop.
      if (next <= lastPage.para || next !== lastPage.para + lastPage.returned) return undefined;
      return next;
    },
  });
}
