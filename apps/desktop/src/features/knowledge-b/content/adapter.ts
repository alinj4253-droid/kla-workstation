import { contentRequestSchema, documentContentSchema } from '@kla-workstation/contracts/knowledge';
import type { KnowledgeBContentRequest, DocumentContent, RpcResult } from '@kla-workstation/contracts/knowledge';
import { BQueryError, unwrap } from '../shared.js';
import type { QueryContext } from '../shared.js';

export async function fetchDocumentContent(context: QueryContext, input: KnowledgeBContentRequest): Promise<DocumentContent> {
  const request = contentRequestSchema.safeParse(input);
  if (!request.success) throw new BQueryError('validation');

  let result: RpcResult<DocumentContent>;
  try {
    result = await context.api.content(request.data);
  } catch (error: unknown) {
    if (error instanceof BQueryError) throw error;
    throw new BQueryError('network');
  }

  let raw: unknown;
  try {
    raw = unwrap(result);
  } catch (error: unknown) {
    if (error instanceof BQueryError) throw error;
    throw new BQueryError('protocol');
  }

  const response = documentContentSchema.safeParse(raw);
  if (!response.success
    || response.data.doc_id !== request.data.docId
    || response.data.para !== request.data.para
    || response.data.limit !== request.data.limit) {
    throw new BQueryError('protocol');
  }

  return response.data;
}
