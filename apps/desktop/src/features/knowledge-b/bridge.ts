import { z } from 'zod';
import {
  documentDetailSchema, documentMetaSchema, documentContentSchema, documentSlicesSchema,
  searchResponseSchema, rpcFailureSchema,
  type KnowledgeBApi, type RpcResult,
  type DocumentRequest, type KnowledgeBContentRequest, type SearchRequest,
} from '@kla-workstation/contracts/knowledge';
import { BQueryError } from './shared';

const successEnvelope = z.object({ ok: z.literal(true), requestId: z.string(), data: z.unknown() });
export interface ReadingRpcApi {
  detail(input: DocumentRequest): Promise<unknown>;
  meta(input: DocumentRequest): Promise<unknown>;
  content(input: KnowledgeBContentRequest): Promise<unknown>;
  slices(input: DocumentRequest): Promise<unknown>;
  search(input: SearchRequest): Promise<unknown>;
}

async function checked<T>(operation: () => Promise<unknown>, schema: z.ZodType<T>, matches: (data: T) => boolean): Promise<RpcResult<T>> {
  let raw: unknown;
  try { raw = await operation(); } catch (error: unknown) {
    if (error instanceof BQueryError) throw error;
    throw new BQueryError('network');
  }
  const success = successEnvelope.safeParse(raw);
  if (success.success) {
    const parsed = schema.safeParse(success.data.data);
    if (!parsed.success || !matches(parsed.data)) throw new BQueryError('protocol');
    return { ok: true, requestId: success.data.requestId, data: parsed.data };
  }
  const failure = rpcFailureSchema.safeParse(raw);
  if (failure.success) {
    // Main owns error normalization; only known kinds are rendered here.
    const { code, details } = failure.data.error;
    const kind = details?.kind;
    const fallback = code === 'PERMISSION_DENIED' ? 'forbidden'
      : code === 'NOT_FOUND' ? 'not_found' : code === 'VALIDATION_FAILED' ? 'validation'
      : code === 'RUN_CANCELLED' ? 'cancelled' : code === 'CHANNEL_CONNECTION_FAILED' ? 'network'
      : code === 'CONFLICT' ? 'cancelled' : 'server';
    throw new BQueryError(typeof kind === 'string' ? kind : fallback);
  }
  throw new BQueryError('protocol');
}

/** Inject the business bridge supplied by the host; never credentials or URLs. */
export function createKnowledgeBClient(api: ReadingRpcApi): KnowledgeBApi {
  return {
    detail: input => checked(() => api.detail(input), documentDetailSchema, data => data.doc_id === input.docId),
    meta: input => checked(() => api.meta(input), documentMetaSchema, data => data.doc_id === input.docId),
    content: input => checked(() => api.content(input), documentContentSchema, data => data.doc_id === input.docId && data.para === input.para && data.limit === input.limit),
    slices: input => checked(() => api.slices(input), documentSlicesSchema, data => data.doc_id === input.docId),
    search: input => checked(() => api.search(input), searchResponseSchema, data => data.query === input.query.trim() && data.collection === input.collection.trim() && data.mode === input.mode),
  };
}
