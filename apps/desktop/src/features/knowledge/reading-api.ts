import type { KnowledgeBApi, KnowledgeContext, KnowledgeSource, RemoteDocument, SourceJobBinding } from '@kla-workstation/contracts/knowledge';
import { bridge } from './api';
import { createKnowledgeBClient } from '../knowledge-b/bridge';
import type { QueryContext } from '../knowledge-b/shared';

/** The sole reader boundary: preserve the existing RPC envelope, then validate it. */
export function createReadingApi(serviceInstanceId: string, knowledgeBaseId?: string): KnowledgeBApi {
  return createKnowledgeBClient({
    detail: ({ docId }) => bridge().contentRequest({ serviceInstanceId, knowledgeBaseId, endpoint: 'document', docId }),
    meta: ({ docId }) => bridge().contentRequest({ serviceInstanceId, knowledgeBaseId, endpoint: 'meta', docId }),
    content: ({ docId, para, limit }) => bridge().contentRequest({ serviceInstanceId, knowledgeBaseId, endpoint: 'content', docId, para, limit }),
    slices: ({ docId }) => bridge().contentRequest({ serviceInstanceId, knowledgeBaseId, endpoint: 'slices', docId }),
    search: search => bridge().contentRequest({ serviceInstanceId, endpoint: 'search', knowledgeBaseId, search }),
  });
}
export function readingScope(context: Pick<KnowledgeContext, 'serviceInstanceId' | 'collection' | 'knowledgeBaseId'>): string {
  return JSON.stringify(context.knowledgeBaseId
    ? [context.serviceInstanceId, context.collection, context.knowledgeBaseId]
    : [context.serviceInstanceId, context.collection]);
}
export function readingContext(context: KnowledgeContext, resourceVersion?: string): QueryContext {
  return { api: createReadingApi(context.serviceInstanceId, context.knowledgeBaseId), cacheScope: readingScope(context), ...(resourceVersion !== undefined ? { resourceVersion } : {}) };
}
export function sourceResourceVersion(doc: RemoteDocument): string {
  return JSON.stringify([doc.modified, doc.size, doc.stale]);
}
export function readingSources(context: KnowledgeContext, documents: readonly RemoteDocument[], bindings: readonly SourceJobBinding[]): KnowledgeSource[] {
  return documents.map(doc => {
    const matching = bindings.filter(binding => binding.docId === doc.doc_id);
    const names = [...new Set(matching.map(binding => binding.displayName))];
    return { docId: doc.doc_id, name: names.length === 1 ? names[0]! : doc.name, collection: context.collection,
      version: sourceResourceVersion(doc), searchSources: [] };
  });
}
