import { z } from 'zod';

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal('kla-backend'),
  version: z.string(),
  mode: z.literal('placeholder'),
});

export const requestContextSchema = z.object({
  accessToken: z.string().optional(),
  identityId: z.string().optional(),
  requestId: z.string().optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
