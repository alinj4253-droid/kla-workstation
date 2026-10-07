import { z } from 'zod';

/** GET /api/v1/agents 与 bootstrap 返回的行（当前为数据库原始行，TODO(M1): 归一为 camelCase）。 */
export const agentRowSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  role: z.string(),
  type: z.string(),
  model_id: z.string().nullable(),
  enabled: z.boolean(),
  version: z.number().int(),
});

export type AgentRow = z.infer<typeof agentRowSchema>;

/** GET /api/v1/conversations/{id}/agents 返回的群聊成员智能体行。 */
export const conversationAgentRowSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  role: z.string(),
  type: z.string(),
  model_id: z.string().nullable(),
  enabled: z.boolean(),
  conversation_role: z.string().nullable(),
});

export type ConversationAgentRow = z.infer<typeof conversationAgentRowSchema>;

export const addConversationAgentRequestSchema = z.object({
  agentId: z.string().min(1),
  role: z.string().min(1).max(50).optional(),
});

export type AddConversationAgentRequest = z.infer<typeof addConversationAgentRequestSchema>;
