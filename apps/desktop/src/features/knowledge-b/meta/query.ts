import { useQuery } from '@tanstack/react-query';
import type { DocumentMeta } from '@kla-workstation/contracts/knowledge';
import { createKnowledgeBClient } from '../bridge.js';
import { bKey, unwrap, type QueryContext } from '../shared.js';

export function useDocumentMeta(context: QueryContext, docId: string) {
  const client = createKnowledgeBClient(context.api);
  return useQuery<DocumentMeta>({
    queryKey: bKey(context.cacheScope, 'meta', docId, context.resourceVersion),
    retry: false,
    queryFn: async () => unwrap(await client.meta({ docId })),
    enabled: docId.length > 0,
  });
}
