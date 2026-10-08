import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { pageQuerySchema, apiOkEnvelopeSchema } from './envelope.js';
import type { ApiOkEnvelope } from './envelope.js';
import { apiError, isRetryable } from './errors.js';
import { SSE_EVENTS, sseEnvelopeSchema } from './events.js';
import { registerRequestSchema } from './auth.js';
import {
  COMPUTE_PERMISSION_CODES,
  createComputeKeyRequestSchema,
  computeUsageQuerySchema,
  computeSummarySchema,
} from './compute.js';

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

describe('compute', () => {
  it('列出 §10 全部权限码', () => {
    expect(COMPUTE_PERMISSION_CODES).toContain('compute.key.create');
    expect(COMPUTE_PERMISSION_CODES).toContain('compute.organization.usage.view');
    expect(COMPUTE_PERMISSION_CODES).toContain('model.use');
    expect(new Set(COMPUTE_PERMISSION_CODES).size).toBe(COMPUTE_PERMISSION_CODES.length);
  });

  it('创建 Key 校验必填名称并允许可选额度（美元）', () => {
    expect(createComputeKeyRequestSchema.safeParse({}).success).toBe(false);
    expect(createComputeKeyRequestSchema.safeParse({ name: '生产 Key' }).success).toBe(true);
    expect(createComputeKeyRequestSchema.safeParse({ name: '生产 Key', quota: -1 }).success).toBe(false);
    expect(
      createComputeKeyRequestSchema.safeParse({ name: '生产 Key', quota: 12.5, rpm: 60, ipAllowList: ['10.0.0.0/8'] }).success,
    ).toBe(true);
  });

  it('用量查询默认 self 作用域并沿用分页默认值', () => {
    expect(computeUsageQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 20, scope: 'self' });
    expect(computeUsageQuerySchema.parse({ scope: 'organization', pageSize: '100' })).toMatchObject({
      scope: 'organization',
      pageSize: 100,
    });
    expect(computeUsageQuerySchema.safeParse({ scope: 'everyone' }).success).toBe(false);
  });

  it('summary 不包含 secret 且以美元下发余额', () => {
    const parsed = computeSummarySchema.safeParse({
      identityId: 'id-1',
      identityType: 'personal',
      organizationId: null,
      currency: 'usd',
      balance: 0,
      used: 0,
      reserved: 0,
      available: 0,
      provisionState: 'ready',
      defaultKey: { id: 'k-1', name: '默认工作站 Key', keyPrefix: 'sk-kla-ab', status: 'active' },
      availableModelCount: 3,
      sub2apiHealth: 'healthy',
      permissions: {
        canViewKeys: true,
        canCreateKey: true,
        canUpdateKey: true,
        canDisableKey: true,
        canViewUsage: true,
        canViewOrganizationUsage: false,
        canUseModel: true,
        canAllocate: false,
        canReclaim: false,
        canRecharge: false,
      },
      lastSyncedAt: null,
    });
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed.success ? parsed.data : {})).not.toContain('secret');
  });
});
