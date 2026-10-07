import { z } from 'zod';

/** GET /api/v1/workspaces 与 bootstrap 返回的行（当前为数据库原始行，TODO(M1): 归一为 camelCase）。 */
export const workspaceRowSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['personal', 'enterprise', 'project']),
  name: z.string(),
  project_id: z.string().nullable(),
});

export type WorkspaceRow = z.infer<typeof workspaceRowSchema>;
