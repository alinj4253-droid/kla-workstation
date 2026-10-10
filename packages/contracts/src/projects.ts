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
  createdAt: z.string().datetime(),
});

export type MessageDto = z.infer<typeof messageDtoSchema>;

export const createMessageRequestSchema = z.object({
  text: z.string().min(1),
  replyToId: z.string().min(1).optional(),
});

export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;
