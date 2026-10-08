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
    staleTime: 60_000,
    retry: false,
  };
}

export function useDocumentSlices(context: SliceQueryContext, docId: string, enabled = true, expectedCollection?: string) {
  return useQuery<DocumentSlices, Error>({
    ...slicesOptions(context, docId, expectedCollection),
    enabled: enabled && docId.length > 0,
  });
}
