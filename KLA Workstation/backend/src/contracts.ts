import { z } from 'zod';

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal('kla-backend'),
  version: z.string(),
  mode: z.literal('placeholder'),
});

export const apiNotImplementedSchema = z.object({
  ok: z.literal(false),
  code: z.literal('NOT_IMPLEMENTED'),
  message: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
