import { z } from 'zod';

/** 运营平台行（GET/POST /api/v1/operations/platforms，数据库原始行透传）。 */
export const operationPlatformSchema = z
  .object({
    id: z.string().min(1),
    identity_id: z.string().min(1),
    name: z.string(),
    base_url: z.string().nullable(),
    description: z.string().nullable(),
    status: z.string(),
    metadata: z.record(z.unknown()).nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .passthrough();

export type OperationPlatform = z.infer<typeof operationPlatformSchema>;

export const createOperationPlatformRequestSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateOperationPlatformRequest = z.infer<typeof createOperationPlatformRequestSchema>;

/** 运营平台技能行（GET/POST /platforms/{id}/skills，SELECT * 透传）。 */
export const operationSkillSchema = z
  .object({
    id: z.string().min(1),
    platform_id: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    definition: z.record(z.unknown()).nullable(),
    created_at: z.string().datetime(),
  })
  .passthrough();

export type OperationSkill = z.infer<typeof operationSkillSchema>;

export const createOperationSkillRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  definition: z.record(z.unknown()).optional(),
});

export type CreateOperationSkillRequest = z.infer<typeof createOperationSkillRequestSchema>;

export const executeOperationRequestSchema = z.object({
  instruction: z.string().optional(),
  skillId: z.string().min(1).optional(),
  mode: z.string().optional(),
});

export type ExecuteOperationRequest = z.infer<typeof executeOperationRequestSchema>;

export const executeOperationResponseSchema = z.object({
  taskId: z.string().min(1),
  platformId: z.string().min(1),
  status: z.literal('queued'),
  executionMode: z.string(),
  message: z.string(),
});

export type ExecuteOperationResponse = z.infer<typeof executeOperationResponseSchema>;
