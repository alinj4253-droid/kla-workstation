import { z } from 'zod';
import type { RpcResult } from './error-codes.js';

const count = z.number().int().nonnegative();
export const documentRequestSchema = z.object({ docId: z.string().min(1).max(4096).refine(value => {
  try { encodeURIComponent(value); return true; } catch { return false; }
}, 'Invalid document identifier encoding') });
export const contentRequestSchema = documentRequestSchema.extend({ para: count, limit: z.number().int().min(1).max(200) });
export const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(10000), collection: z.string().trim().min(1).max(200),
  mode: z.enum(['hybrid', 'vector', 'keyword']), top_k: z.number().int().min(1).max(100),
  expand: z.number().int().min(0).max(2), fold_adjacent: z.boolean(),
});
// These DTO schemas deliberately strip privileged server paths and unknown fields.
export const documentDetailSchema = z.object({
  doc_id: z.string().min(1), name: z.string(), category: z.string(), ext: z.string(),
  size: count, readable: z.boolean(), editable: z.boolean(), modified: z.string(),
  stale: z.boolean().optional(), has_backup: z.boolean().optional(), backup_time: z.string().nullable().optional(),
});
export const documentMetaSchema = z.object({ doc_id: z.string().min(1), name: z.string(), total_chars: count, total_paragraphs: count });
export const documentContentSchema = z.object({
  doc_id: z.string().min(1), name: z.string(), para: count, limit: z.number().int().min(1).max(200),
  returned: count, total_paragraphs: count, total_chars: count,
  next_para: count.nullable(), has_more: z.boolean(), paragraphs: z.array(z.string()),
}).superRefine((value, ctx) => {
  if (value.returned !== value.paragraphs.length || value.returned > value.limit || value.para + value.returned > value.total_paragraphs && value.returned > 0)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid paragraph counts' });
  if (value.has_more && (value.returned === 0 || value.next_para === null || value.next_para !== value.para + value.returned || value.next_para >= value.total_paragraphs))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Non-progressing content cursor' });
  if (!value.has_more && (value.next_para !== null || value.para + value.returned < value.total_paragraphs))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent terminal cursor' });
});
export const sliceSchema = z.object({ id: count, title: z.string(), content: z.string(), group: count.nullable().optional(), source: z.string().optional() });
export const documentSlicesSchema = z.object({ doc_id: z.string().min(1), source: z.string(), collection: z.string(), count, slices: z.array(sliceSchema) }).superRefine((value, ctx) => {
  if (value.count !== value.slices.length || new Set(value.slices.map(s => s.id)).size !== value.slices.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid slice count or duplicate document-local ID' });
});
const contextSlice = z.object({ slice_index: count, content: z.string() });
export const searchHitSchema = z.object({
  rank: z.number().int().positive(), title: z.string(), content: z.string(), score: z.number().finite(),
  source: z.string().nullable().optional(), slice_index: count.nullable().optional(), group: count.nullable().optional(),
  match_type: z.string().optional(), score_type: z.enum(['cosine', 'bm25', 'fused']).optional(), score_pct: z.number().finite().min(0).max(100).optional(),
  context_group: z.array(contextSlice).optional(), also_matched: z.array(contextSlice.extend({ score: z.number().finite().nullable().optional() })).optional(),
  neighbors: z.object({ prev: z.string().nullable(), next: z.string().nullable() }).optional(),
});
export const searchResponseSchema = z.object({ query: z.string(), collection: z.string(), mode: z.enum(['hybrid', 'vector', 'keyword']), hits: z.array(searchHitSchema) });
export type DocumentRequest = z.infer<typeof documentRequestSchema>;
export type KnowledgeBContentRequest = z.infer<typeof contentRequestSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type DocumentDetail = z.infer<typeof documentDetailSchema>;
export type DocumentMeta = z.infer<typeof documentMetaSchema>;
export type DocumentContent = z.infer<typeof documentContentSchema>;
export type DocumentSlices = z.infer<typeof documentSlicesSchema>;
export type KnowledgeSlice = z.infer<typeof sliceSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type SearchHit = z.infer<typeof searchHitSchema>;
export interface KnowledgeBApi {
  detail(input: DocumentRequest): Promise<RpcResult<DocumentDetail>>;
  meta(input: DocumentRequest): Promise<RpcResult<DocumentMeta>>;
  content(input: KnowledgeBContentRequest): Promise<RpcResult<DocumentContent>>;
  slices(input: DocumentRequest): Promise<RpcResult<DocumentSlices>>;
  search(input: SearchRequest): Promise<RpcResult<SearchResponse>>;
}
export interface KnowledgeSource { docId: string; name: string; collection: string; searchSources: readonly string[]; version?: string }
export interface OpenKnowledgeSource { docId: string; sliceIndex?: number; locateText?: string }
