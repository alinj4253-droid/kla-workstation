import { documentRequestSchema, documentSlicesSchema, type DocumentRequest, type DocumentSlices } from '@kla-workstation/contracts/knowledge';
import { BQueryError, unwrap } from '../shared.js';
import type { QueryContext } from '../shared.js';

export async function fetchDocumentSlices(context: QueryContext, input: DocumentRequest, expectedCollection?: string): Promise<DocumentSlices> {
  const request = documentRequestSchema.safeParse(input);
  if (!request.success) throw new BQueryError('validation');

  const response = unwrap(await context.api.slices(request.data));
  const parsed = documentSlicesSchema.safeParse(response);
  if (!parsed.success || parsed.data.doc_id !== request.data.docId
    || (expectedCollection !== undefined && parsed.data.collection !== expectedCollection)) throw new BQueryError('protocol');
  return parsed.data;
}
