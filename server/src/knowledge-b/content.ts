import { contentRequestSchema, documentContentSchema } from '@kla-workstation/contracts/knowledge';
import type { KnowledgeBContentRequest, DocumentContent } from '@kla-workstation/contracts/knowledge';
import { KnowledgeBFailure } from './transport.js';
import type { KnowledgeTransport } from './transport.js';

/** Fetch and validate one paragraph page from the Knowledge B service. */
export async function fetchDocumentContent(
  transport: KnowledgeTransport,
  input: KnowledgeBContentRequest,
): Promise<DocumentContent> {
  const request = contentRequestSchema.safeParse(input);
  if (!request.success) throw new KnowledgeBFailure('validation');

  const { docId, para, limit } = request.data;
  let encodedDocId: string;
  try {
    encodedDocId = encodeURIComponent(docId);
  } catch {
    throw new KnowledgeBFailure('validation');
  }

  let response: unknown;
  try {
    response = await transport({
      method: 'GET',
      path: `/v1/documents/${encodedDocId}/content`,
      query: { para, limit },
    });
  } catch (error: unknown) {
    if (error instanceof KnowledgeBFailure) throw error;
    throw new KnowledgeBFailure('network');
  }

  const parsed = documentContentSchema.safeParse(response);
  if (!parsed.success || parsed.data.doc_id !== docId || parsed.data.para !== para || parsed.data.limit !== limit)
    throw new KnowledgeBFailure('protocol');

  return parsed.data;
}
