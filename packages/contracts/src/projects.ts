import { z } from 'zod';

export const projectDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  ownerIdentityId: z.string().min(1),
  createdAt: z.string().datetime(),
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
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  // Collaborating agents only; the server always adds the project coordinator.
  agentIds: z.array(z.string().uuid()).min(1).max(100).refine(ids => new Set(ids).size === ids.length, '智能体不能重复').optional(),
});

export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;

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
  fileIds: z.array(z.string().uuid()).max(20).default([]).transform(ids => [...new Set(ids)]),
  replyToId: z.string().min(1).optional(),
}).refine(input => Boolean(input.text.trim()) || input.fileIds.length > 0, '消息不能为空');

export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;
