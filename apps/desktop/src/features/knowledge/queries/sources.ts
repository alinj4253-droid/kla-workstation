import { useQuery } from '@tanstack/react-query';
import type { KnowledgeContext } from '@kla-workstation/contracts/knowledge';
import { knowledgeApi, knowledgeKeys } from '../api';
export function useSources(context: KnowledgeContext) {
  return useQuery({ queryKey: knowledgeKeys.sources(context.serviceInstanceId, context.collection, context.knowledgeBaseId), queryFn: () => knowledgeApi.sources(context.serviceInstanceId, context.collection, context.knowledgeBaseId), enabled: Boolean(context.collection), retry: false, refetchInterval: 10000 });
}
