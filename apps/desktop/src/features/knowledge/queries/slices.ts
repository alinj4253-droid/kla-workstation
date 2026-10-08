import { useQueries } from '@tanstack/react-query';
import type { DocumentSlices, KnowledgeContext, RemoteDocument } from '@kla-workstation/contracts/knowledge';
import { BQueryError } from '../../knowledge-b/shared';
import { slicesOptions } from '../../knowledge-b/slices/query';
import { readingContext, sourceResourceVersion } from '../reading-api';

export function useKnowledgeSlices(context: KnowledgeContext, sources: RemoteDocument[], { enabled = true, processing = false, pollIntervalMs = 4000 }: { enabled?: boolean; processing?: boolean; pollIntervalMs?: number } = {}) {
  const queries = useQueries({ queries: sources.map(doc => ({
    // Use B's typed reader and the same cache as its slices and search panels.
    ...slicesOptions(readingContext(context, sourceResourceVersion(doc)), doc.doc_id, context.collection),
    enabled: enabled && Boolean(context.collection),
    staleTime: 10000, refetchOnWindowFocus: true, refetchOnReconnect: true,
    refetchInterval: (query: { state: { data: DocumentSlices | undefined; error: unknown } }) => {
      const error = query.state.error;
      if (error instanceof BQueryError && ['unconfigured', 'unauthorized', 'forbidden', 'validation', 'protocol', 'cancelled', 'not_found'].includes(error.kind)) return false;
      if (processing || doc.stale || (error && !(error instanceof BQueryError && error.kind === 'slices_pending'))) return pollIntervalMs;
      if (!query.state.data || error) return Math.max(10000, pollIntervalMs);
      return 30000;
    },
  })) });
  const complete = enabled && queries.every(query => query.isSuccess);
  const errors = queries.filter(query => query.isError);
  const missingCount = errors.filter(query => query.error instanceof BQueryError && query.error.kind === 'slices_pending').length;
  return {
    queries, complete, errors, missingCount,
    count: enabled && (queries.length === 0 || queries.some(query => query.data)) ? queries.reduce((sum, query) => sum + (query.data?.count ?? 0), 0) : undefined,
    loadedCount: queries.filter(query => query.data !== undefined).length,
    fetching: queries.some(query => query.isFetching),
    pending: queries.some(query => query.isPending),
  };
}
