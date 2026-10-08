import { documentMetaSchema, documentRequestSchema, type DocumentMeta } from '@kla-workstation/contracts/knowledge';
import { KnowledgeBFailure, type KnowledgeTransport } from './transport.js';

/** Fetch and validate the independent document metadata endpoint. */
export async function fetchDocumentMeta(transport: KnowledgeTransport, input: unknown): Promise<DocumentMeta> {
  const request = documentRequestSchema.safeParse(input);
  if (!request.success) throw new KnowledgeBFailure('validation');

  let response: unknown;
  try {
    response = await transport({
      method: 'GET',
      path: `/v1/documents/${encodeURIComponent(request.data.docId)}/meta`,
    });
  } catch (error) {
    if (error instanceof KnowledgeBFailure) throw error;
    throw new KnowledgeBFailure('network');
  }
  const meta = documentMetaSchema.safeParse(response);
  if (!meta.success || meta.data.doc_id !== request.data.docId) throw new KnowledgeBFailure('protocol');
  return meta.data;
}
