import { z } from 'zod';
import { agentRowSchema } from './agents.js';
import { conversationDtoSchema, projectDtoSchema } from './projects.js';
import { identityDtoSchema, userDtoSchema } from './user.js';
import { workspaceRowSchema } from './workspaces.js';

/** GET /api/v1/models 之外的 bootstrap 模型摘要（无 base_url/is_official/configured）。 */
export const bootstrapModelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  provider: z.string(),
  capabilities: z.record(z.unknown()).optional(),
  enabled: z.boolean(),
});

export type BootstrapModel = z.infer<typeof bootstrapModelSchema>;

/** bootstrap 中的任务摘要行（GET /api/v1/tasks 完整实现前的最小形态）。 */
export const taskSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.string(),
  result: z.record(z.unknown()).nullable(),
  created_at: z.string().datetime(),
});

export type TaskSummary = z.infer<typeof taskSummarySchema>;

/** GET /api/v1/bootstrap：进入工作站的一次性聚合响应。 */
export const bootstrapResponseSchema = z.object({
  user: userDtoSchema,
  identity: identityDtoSchema,
  identities: z.array(identityDtoSchema),
  projects: z.array(projectDtoSchema),
  conversations: z.array(conversationDtoSchema),
  workspaces: z.array(workspaceRowSchema),
  agents: z.array(agentRowSchema),
  models: z.array(bootstrapModelSchema),
  tasks: z.array(taskSummarySchema),
});

export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
