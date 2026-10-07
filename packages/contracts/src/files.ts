import { z } from 'zod';

/** GET /api/v1/files、GET /api/v1/files/{id} 返回的文件视图（camelCase）。 */
export const fileItemSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string(),
  storageKey: z.string(),
  checksum: z.string().nullable(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int(),
  status: z.string(),
  createdAt: z.string().datetime(),
});

export type FileItem = z.infer<typeof fileItemSchema>;

export const createUploadSessionRequestSchema = z.object({
  workspaceId: z.string().min(1),
  fileName: z.string().min(1),
  contentType: z.string().optional(),
  sizeBytes: z.number().int().min(0).optional(),
  checksum: z.string().optional(),
});

export type CreateUploadSessionRequest = z.infer<typeof createUploadSessionRequestSchema>;

/** POST /api/v1/files/upload-sessions 返回的行（当前为数据库原始行 + 占位上传字段，TODO(M1): 归一为 camelCase）。 */
export const uploadSessionRowSchema = z.object({
  id: z.string().min(1),
  file_name: z.string(),
  content_type: z.string().nullable(),
  size_bytes: z.number().int(),
  checksum: z.string().nullable(),
  status: z.string(),
  expires_at: z.string().datetime(),
  uploadUrl: z.string().nullable(),
  mode: z.string(),
});

export type UploadSessionRow = z.infer<typeof uploadSessionRowSchema>;
