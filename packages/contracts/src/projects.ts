import { z } from 'zod';

export const projectDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  ownerIdentityId: z.string().min(1),
  createdAt: z.string().datetime(),
  /** standalone：每身份固定的「独立群组」容器，仅承载不归属项目的群组，前端不作为项目展示。 */
  kind: z.enum(['normal', 'standalone']).optional(),
});

export type ProjectDto = z.infer<typeof projectDtoSchema>;

export const createProjectRequestSchema = z.object({
  name: z.string().min(1).max(100),
});

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const conversationDtoSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string(),
  createdAt: z.string().datetime(),
});

export type ConversationDto = z.infer<typeof conversationDtoSchema>;

export const createConversationRequestSchema = z.object({
  // 未提供时回落到当前身份的「独立群组」容器项目。
  projectId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  // Collaborating agents only; the server always adds the project coordinator.
  agentIds: z.array(z.string().uuid()).min(1).max(100).refine(ids => new Set(ids).size === ids.length, '智能体不能重复').optional(),
});

export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;

export const updateConversationRequestSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  projectId: z.string().min(1).optional(),
});

export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>;

export const messageDtoSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  senderId: z.string().min(1),
  text: z.string(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
});

export type MessageDto = z.infer<typeof messageDtoSchema>;

export const createMessageRequestSchema = z.object({
  text: z.string().max(100000).default(''),
  mode: z.string().max(50).optional(),
  /** Stable client-generated key for retry-safe message + run creation. */
  idempotencyKey: z.string().uuid().optional(),
  /** 本次运行的本地执行授权策略；不会提升操作系统权限。 */
  executionAccess: z.enum(['approval', 'full']).default('approval'),
  fileIds: z.array(z.string().uuid()).max(20).default([]).transform(ids => [...new Set(ids)]),
  replyToId: z.string().min(1).optional(),
  /** Structured recipients selected from the conversation member picker. */
  submitObject: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('user'), id: z.string().uuid() }),
    z.object({ type: z.literal('agent'), id: z.string().uuid() }),
    z.object({ type: z.literal('command'), id: z.enum(['task_execution', 'coordinator']) }),
  ])).max(32).default([]),
}).refine(input => Boolean(input.text.trim()) || input.fileIds.length > 0, '消息不能为空');

export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;
