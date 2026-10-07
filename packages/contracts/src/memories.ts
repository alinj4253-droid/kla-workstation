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
