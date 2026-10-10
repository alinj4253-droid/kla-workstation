import { z } from 'zod';

/** GET /api/v1/files、GET /api/v1/files/{id} 返回的文件视图（camelCase）。 */
export const fileItemSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  conversationId: z.string().uuid().nullable().optional(),
  name: z.string(),
  storageKey: z.string(),
  checksum: z.string().nullable(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int(),
  status: z.string(),
  contentUrl: z.string().optional(),
  createdAt: z.string().datetime(),
});

export type FileItem = z.infer<typeof fileItemSchema>;

export const createUploadSessionRequestSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  fileName: z.string().trim().min(1).max(255).refine(name => !/[\\/:*?"<>|\x00-\x1f]/.test(name) && name !== '.' && name !== '..', '文件名无效'),
  contentType: z.string().max(100).optional(),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  checksum: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine(input => Boolean(input.workspaceId) !== Boolean(input.conversationId), '选择 workspaceId 或 conversationId 之一');

export type CreateUploadSessionRequest = z.infer<typeof createUploadSessionRequestSchema>;

/** 上传会话兼容现有 snake_case 字段，真实内容通过 PUT 上传。 */
export const uploadSessionRowSchema = z.object({
  id: z.string().min(1),
  file_name: z.string(),
  content_type: z.string().nullable(),
  size_bytes: z.coerce.number().int(),
  checksum: z.string().nullable(),
  status: z.string(),
  expires_at: z.string().datetime(),
  uploadUrl: z.string().nullable(),
  completeUrl: z.string(),
  mode: z.string(),
});

export type UploadSessionRow = z.infer<typeof uploadSessionRowSchema>;
