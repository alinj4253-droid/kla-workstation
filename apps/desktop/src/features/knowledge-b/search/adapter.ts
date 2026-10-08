import { searchRequestSchema, searchResponseSchema } from '@kla-workstation/contracts/knowledge';
import type { RpcResult, SearchRequest, SearchResponse } from '@kla-workstation/contracts/knowledge';
import { BQueryError, unwrap } from '../shared.js';
import type { QueryContext } from '../shared.js';

/** Validate the request and response at the renderer boundary as well as Main's HTTP boundary. */
export async function searchKnowledge(context: QueryContext, input: SearchRequest): Promise<SearchResponse> {
  const request = searchRequestSchema.safeParse(input);
  if (!request.success) throw new BQueryError('validation');

  let result: RpcResult<SearchResponse>;
  try {
    result = await context.api.search(request.data);
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

  const response = searchResponseSchema.safeParse(raw);
  if (!response.success
    || response.data.query !== request.data.query
    || response.data.collection !== request.data.collection
    || response.data.mode !== request.data.mode) {
    throw new BQueryError('protocol');
  }
  return response.data;
}
