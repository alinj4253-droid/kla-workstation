import { z } from 'zod';

/** GET /api/v1/skills 返回的智能体技能行。 */
export const skillRowSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  definition: z.record(z.unknown()).nullable(),
  enabled: z.boolean(),
  version: z.number().int(),
  agent_name: z.string(),
});

export type SkillRow = z.infer<typeof skillRowSchema>;

/** GET /api/v1/me/permissions 返回的权限行。 */
export const permissionRowSchema = z.object({
  code: z.string().min(1),
  description: z.string().nullable(),
});

export type PermissionRow = z.infer<typeof permissionRowSchema>;
