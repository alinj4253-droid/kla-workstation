import { z } from 'zod';

export const SSE_EVENTS = [
  'message.committed',
  'message.delta',
  'task.created',
  'task.status',
  'task.event',
  'task.completed',
  'artifact.created',
  'knowledge.job.progress',
  'memory.updated',
  'permission.updated',
] as const;

export type SseEventName = (typeof SSE_EVENTS)[number];

export const sseScopeTypeSchema = z.enum(['personal', 'project', 'organization', 'conversation']);

export type SseScopeType = z.infer<typeof sseScopeTypeSchema>;

export const sseEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  sequence: z.number().int().min(0),
  identityId: z.string().min(1),
  scope: z.object({
    type: sseScopeTypeSchema,
    id: z.string().min(1),
  }),
  createdAt: z.string().datetime(),
  name: z.enum(SSE_EVENTS),
  payload: z.unknown(),
});

export type SseEnvelope = z.infer<typeof sseEnvelopeSchema>;
