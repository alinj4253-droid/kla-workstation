import { searchRequestSchema, searchResponseSchema, type SearchResponse } from '@kla-workstation/contracts/knowledge';
import { KnowledgeBFailure, type KnowledgeTransport } from './transport.js';

/** POST one validated search request and accept only a response for that exact request. */
export async function searchKnowledge(transport: KnowledgeTransport, input: unknown): Promise<SearchResponse> {
  const request = searchRequestSchema.safeParse(input);
  if (!request.success) throw new KnowledgeBFailure('validation');

  let response: unknown;
  try {
    response = await transport({ method: 'POST', path: '/v1/search', body: request.data });
  } catch (error: unknown) {
    if (error instanceof KnowledgeBFailure) throw error;
    throw new KnowledgeBFailure('network');
  }

  const parsed = searchResponseSchema.safeParse(response);
  if (!parsed.success
    || parsed.data.query !== request.data.query
    || parsed.data.collection !== request.data.collection
    || parsed.data.mode !== request.data.mode) {
    throw new KnowledgeBFailure('protocol');
  }

  return parsed.data;
}
