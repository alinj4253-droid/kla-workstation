import { documentRequestSchema, documentSlicesSchema, type DocumentSlices } from '@kla-workstation/contracts/knowledge';
import { KnowledgeBFailure, type KnowledgeTransport } from './transport.js';

/** Fetch the generated slices for one document and discard server-only path fields. */
export async function fetchDocumentSlices(transport: KnowledgeTransport, input: unknown): Promise<DocumentSlices> {
  const request = documentRequestSchema.safeParse(input);
  if (!request.success) throw new KnowledgeBFailure('validation');

  let encodedDocId: string;
  try {
    encodedDocId = encodeURIComponent(request.data.docId);
  } catch {
    throw new KnowledgeBFailure('validation');
  }

  let response: unknown;
  try {
    response = await transport({
      method: 'GET',
      path: `/v1/documents/${encodedDocId}/slices`,
    });
  } catch (error: unknown) {
    // Keep A's distinction between an absent document and a document whose slices are pending.
    if (error instanceof KnowledgeBFailure) throw error;
    throw new KnowledgeBFailure('network');
  }

  const parsed = documentSlicesSchema.safeParse(response);
  if (!parsed.success || parsed.data.doc_id !== request.data.docId) throw new KnowledgeBFailure('protocol');
  return parsed.data;
}
