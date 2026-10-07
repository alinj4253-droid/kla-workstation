import { z } from 'zod';

/** 运行记录（repository 形态，camelCase）：GET runs 列表与 POST retry 返回。 */
export const conversationRunSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  triggerMessageId: z.string().nullable(),
  status: z.string(),
  mode: z.string(),
  currentAgent: z.string().nullable(),
  result: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ConversationRun = z.infer<typeof conversationRunSchema>;

/** POST /conversations/{id}/runs/{runId}/cancel 返回的行（当前为数据库原始行，TODO(M1): 归一为 conversationRunSchema）。 */
export const cancelledRunRowSchema = z.object({
  id: z.string().min(1),
  conversation_id: z.string().min(1),
  trigger_message_id: z.string().nullable(),
  status: z.string(),
  mode: z.string(),
  current_agent: z.string().nullable(),
  result: z.record(z.unknown()).nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type CancelledRunRow = z.infer<typeof cancelledRunRowSchema>;

/** GET /conversations/{id}/runs/{runId}/steps 返回的运行步骤行。 */
export const runStepRowSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  step_index: z.number().int(),
  title: z.string(),
  instruction: z.string(),
  assigned_agent_id: z.string().nullable(),
  status: z.string(),
  result: z.record(z.unknown()).nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type RunStepRow = z.infer<typeof runStepRowSchema>;

export const runStepInputSchema = z.object({
  title: z.string().min(1),
  instruction: z.string().optional(),
  assignedAgentId: z.string().min(1).optional(),
});

export type RunStepInput = z.infer<typeof runStepInputSchema>;

export const replaceRunStepsRequestSchema = z.object({
  steps: z.array(runStepInputSchema).min(1),
});

export type ReplaceRunStepsRequest = z.infer<typeof replaceRunStepsRequestSchema>;

export const replaceRunStepsResponseSchema = z.object({
  runId: z.string().min(1),
  count: z.number().int(),
});

export type ReplaceRunStepsResponse = z.infer<typeof replaceRunStepsResponseSchema>;
