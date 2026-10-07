import { z } from 'zod';
import { apiErrorEnvelopeSchema, apiOkEnvelopeSchema, requestIdMetaSchema } from './envelope.js';

/** GET /api/health：liveness 语义，进程可响应即 ok:true，不存在 ok:false 的响应形态。 */
export const serviceHealthSchema = z.object({
  ok: z.literal(true),
  service: z.literal('kla-backend'),
  version: z.string(),
  mode: z.enum(['postgres', 'mock']),
});

export type ServiceHealth = z.infer<typeof serviceHealthSchema>;

export const postgresHealthSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  database: z.string().optional(),
  serverVersion: z.string().optional(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

export type PostgresHealth = z.infer<typeof postgresHealthSchema>;

export const redisHealthSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  database: z.number().int().optional(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

export type RedisHealth = z.infer<typeof redisHealthSchema>;

/**
 * GET /api/health/database、/api/health/redis 的响应级契约，三种形态：
 * 1. ok:true + data（依赖可达）；2. ok:false + data（依赖不可达，HTTP 503）；
 * 3. ok:false + error（依赖未配置，HTTP 503）。
 */
export const postgresHealthResponseSchema = z.union([
  apiOkEnvelopeSchema(postgresHealthSchema),
  z.object({ ok: z.literal(false), data: postgresHealthSchema, meta: requestIdMetaSchema.optional() }),
  apiErrorEnvelopeSchema,
]);

export type PostgresHealthResponse = z.infer<typeof postgresHealthResponseSchema>;

export const redisHealthResponseSchema = z.union([
  apiOkEnvelopeSchema(redisHealthSchema),
  z.object({ ok: z.literal(false), data: redisHealthSchema, meta: requestIdMetaSchema.optional() }),
  apiErrorEnvelopeSchema,
]);

export type RedisHealthResponse = z.infer<typeof redisHealthResponseSchema>;
