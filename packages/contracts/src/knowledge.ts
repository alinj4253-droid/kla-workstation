import { z } from 'zod';

export const knowledgeSearchRequestSchema = z.object({
  query: z.string().min(1),
  collection: z.string().optional(),
  mode: z.string().optional(),
  topK: z.number().int().min(1).max(20).optional(),
});

export type KnowledgeSearchRequest = z.infer<typeof knowledgeSearchRequestSchema>;

/** POST /api/v1/knowledge/search 结果为知识服务响应透传，结构由知识服务契约定义。 */
export const knowledgeSearchResultSchema = z.record(z.unknown());

export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>;

export const readKnowledgeDocumentRequestSchema = z.object({
  text: z.string(),
  offset: z.number().int().min(0).optional(),
  maxChars: z.number().int().min(1000).max(30000).optional(),
});

export type ReadKnowledgeDocumentRequest = z.infer<typeof readKnowledgeDocumentRequestSchema>;

export const readKnowledgeDocumentResponseSchema = z.object({
  content: z.string(),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  hasMore: z.boolean(),
});

export type ReadKnowledgeDocumentResponse = z.infer<typeof readKnowledgeDocumentResponseSchema>;
export * from './knowledge-api.js';
export * from './knowledge-b.js';
export type { ErrorCode, RpcResult, RpcSuccess, RpcFailure } from './error-codes.js';
export * from './knowledge-catalog.js';
export * from './knowledge-statistics.js';
export * from './knowledge-upload-names.js';
