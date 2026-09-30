import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { pageQuerySchema, apiOkEnvelopeSchema } from './envelope.js';
import type { ApiOkEnvelope } from './envelope.js';
import { apiError, isRetryable } from './errors.js';
import { SSE_EVENTS, sseEnvelopeSchema } from './events.js';
import { registerRequestSchema } from './auth.js';

describe('errors', () => {
  it('maps retryable by code', () => {
    expect(isRetryable('RATE_LIMITED')).toBe(true);
    expect(isRetryable('UNAVAILABLE')).toBe(true);
    expect(isRetryable('FORBIDDEN')).toBe(false);
    expect(isRetryable('NOT_IMPLEMENTED')).toBe(false);
  });

  it('builds the spec error envelope', () => {
    expect(apiError('NOT_IMPLEMENTED', '未实现', { requestId: 'req-1' })).toEqual({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: '未实现', retryable: false },
      meta: { requestId: 'req-1' },
    });
  });

  it('omits meta when no requestId', () => {
    expect(apiError('FORBIDDEN', '无权访问').meta).toBeUndefined();
  });
});

describe('envelope', () => {
  it('applies pagination defaults', () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(pageQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({ page: 3, pageSize: 50 });
  });

  it('keeps ApiOkEnvelope inferred from apiOkEnvelopeSchema', () => {
    const sampleSchema = z.object({ id: z.string() });
    type SampleEnvelope = z.infer<
      ReturnType<typeof apiOkEnvelopeSchema<typeof sampleSchema>>
    >;
    expectTypeOf<ApiOkEnvelope<{ id: string }>>().toEqualTypeOf<SampleEnvelope>();
  });
});

describe('auth', () => {
  it('requires email or phone on register', () => {
    expect(
      registerRequestSchema.safeParse({ password: 'secret123', nickname: 'n' }).success,
    ).toBe(false);
    expect(
      registerRequestSchema.safeParse({ email: 'a@b.co', password: 'secret123', nickname: 'n' })
        .success,
    ).toBe(true);
  });
});

describe('events', () => {
  it('validates the sse envelope', () => {
    const parsed = sseEnvelopeSchema.safeParse({
      eventId: 'evt-1',
      sequence: 1,
      identityId: 'id-1',
      scope: { type: 'conversation', id: 'c-1' },
      createdAt: new Date().toISOString(),
      name: SSE_EVENTS[0],
      payload: {},
    });
    expect(parsed.success).toBe(true);
  });
});
