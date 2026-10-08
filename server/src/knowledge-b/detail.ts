import { documentDetailSchema, documentRequestSchema, type DocumentDetail } from '@kla-workstation/contracts/knowledge';
import { KnowledgeBFailure, type KnowledgeTransport } from './transport.js';

/** Fetch and validate one document detail without allowing server paths into the renderer DTO. */
export async function fetchDocumentDetail(transport: KnowledgeTransport, input: unknown): Promise<DocumentDetail> {
  const request = documentRequestSchema.safeParse(input);
  if (!request.success) throw new KnowledgeBFailure('validation');

  let response: unknown;
  try {
    response = await transport({
      method: 'GET',
      path: `/v1/documents/${encodeURIComponent(request.data.docId)}`,
    });
  } catch (error) {
    if (error instanceof KnowledgeBFailure) throw error;
    throw new KnowledgeBFailure('network');
  }

  const detail = documentDetailSchema.safeParse(response);
  if (!detail.success || detail.data.doc_id !== request.data.docId) {
    throw new KnowledgeBFailure('protocol');
  }

  return detail.data;
}
