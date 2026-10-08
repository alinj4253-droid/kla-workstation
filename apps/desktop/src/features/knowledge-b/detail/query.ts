import { useQuery } from '@tanstack/react-query';
import type { DocumentDetail } from '@kla-workstation/contracts/knowledge';
import { createKnowledgeBClient } from '../bridge.js';
import { bKey, unwrap, type QueryContext } from '../shared.js';

export function useDocumentDetail(context: QueryContext, docId: string) {
  return useQuery<DocumentDetail>({
    queryKey: bKey(context.cacheScope, 'detail', docId, context.resourceVersion),
    retry: false,
    queryFn: async () => unwrap(await createKnowledgeBClient(context.api).detail({ docId })),
    enabled: docId.length > 0,
  });
}
