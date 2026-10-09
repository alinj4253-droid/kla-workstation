import { z } from 'zod';

/** GET /api/v1/memories 返回的记忆视图（camelCase）。 */
export const memoryViewSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  content: z.string(),
  kind: z.string(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type MemoryView = z.infer<typeof memoryViewSchema>;

/** POST /api/v1/memories、PATCH /api/v1/memories/{id} 返回的行（当前为数据库原始行，TODO(M1): 归一为 memoryViewSchema）。 */
export const memoryRowSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  content: z.string(),
  kind: z.string(),
  metadata: z.record(z.unknown()),
  created_at: z.string().datetime(),
});

export type MemoryRow = z.infer<typeof memoryRowSchema>;

/** POST /api/v1/memories/search 返回的检索命中行。 */
export const memorySearchHitSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  content: z.string(),
  kind: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  created_at: z.string().datetime(),
  score: z.number(),
});

export type MemorySearchHit = z.infer<typeof memorySearchHitSchema>;

export const createMemoryRequestSchema = z.object({
  workspaceId: z.string().min(1),
  content: z.string().min(1),
  kind: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateMemoryRequest = z.infer<typeof createMemoryRequestSchema>;

export const updateMemoryRequestSchema = z.object({
  content: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type UpdateMemoryRequest = z.infer<typeof updateMemoryRequestSchema>;

export const searchMemoriesRequestSchema = z.object({
  query: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export type SearchMemoriesRequest = z.infer<typeof searchMemoriesRequestSchema>;

/** Read-only browser; separate from memory extraction and mutation APIs. */
export const memoryBrowserQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  agentKey: z.string().min(1).max(200).optional(),
  term: z.enum(['long_term', 'short_term']).default('long_term'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
  message: 'from must be before to', path: ['to'],
});
export type MemoryBrowserQuery = z.infer<typeof memoryBrowserQuerySchema>;

export const memoryBrowserAgentSchema = z.object({ key: z.string(), name: z.string() });
export type MemoryBrowserAgent = z.infer<typeof memoryBrowserAgentSchema>;
export const memoryBrowserScopesSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), agents: z.array(memoryBrowserAgentSchema) })),
  conversations: z.array(z.object({
    id: z.string(), projectId: z.string(), name: z.string(), agents: z.array(memoryBrowserAgentSchema),
  })),
  agents: z.array(memoryBrowserAgentSchema),
  counts: z.object({ longTerm: z.number().int().nonnegative(), shortTerm: z.number().int().nonnegative() }),
  latestUpdatedAt: z.string().datetime().nullable(),
});
export type MemoryBrowserScopes = z.infer<typeof memoryBrowserScopesSchema>;

export const memoryBrowserEntrySchema = z.object({
  id: z.string(), content: z.string(), term: z.enum(['long_term', 'short_term']),
  kind: z.string(), source: z.enum(['stored_memory', 'conversation_context']),
  projectId: z.string().nullable(), projectName: z.string().nullable(),
  conversationId: z.string().nullable(), conversationName: z.string().nullable(),
  agentKey: z.string(), agentName: z.string(), shared: z.boolean(),
  sourceMessageId: z.string().nullable(), createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(), expiresAt: z.string().datetime().nullable(),
  reinforcedAt: z.string().datetime().optional(),
  retainedUntil: z.string().datetime().nullable().optional(),
  /** null for fixed long-term memory; zero-weight short-term history remains viewable. */
  timeWeight: z.number().min(0).max(1).nullable().optional(),
});
export type MemoryBrowserEntry = z.infer<typeof memoryBrowserEntrySchema>;
export const memoryBrowserPageSchema = z.object({
  items: z.array(memoryBrowserEntrySchema),
  page: z.object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int().nonnegative() }),
});
export type MemoryBrowserPage = z.infer<typeof memoryBrowserPageSchema>;
