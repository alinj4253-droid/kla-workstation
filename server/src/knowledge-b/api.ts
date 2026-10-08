import type { ContentRequest } from '@kla-workstation/contracts/knowledge';
import { fetchDocumentDetail } from './detail.js';
import { fetchDocumentMeta } from './meta.js';
import { fetchDocumentContent } from './content.js';
import { fetchDocumentSlices } from './slices.js';
import { searchKnowledge } from './search.js';
import { KnowledgeBFailure, type KnowledgeTransport } from './transport.js';

/** Validated endpoint dispatch inside A's existing IPC and transport, without another RPC facade. */
export async function readKnowledgeContent(transport: KnowledgeTransport, input: ContentRequest, collection: string): Promise<unknown> {
  if (input.endpoint === 'search') {
    if (!input.search || input.search.collection !== collection) throw new KnowledgeBFailure('validation');
    return searchKnowledge(transport, input.search);
  }
  if (!input.docId) throw new KnowledgeBFailure('validation');
  const request = { docId: input.docId };
  switch (input.endpoint) {
    case 'document': return fetchDocumentDetail(transport, request);
    case 'meta': return fetchDocumentMeta(transport, request);
    case 'content': return fetchDocumentContent(transport, { ...request, para: input.para ?? 0, limit: input.limit ?? 20 });
    case 'slices': {
      const result = await fetchDocumentSlices(transport, request);
      if (result.collection !== collection) throw new KnowledgeBFailure('protocol');
      return result;
    }
  }
}
