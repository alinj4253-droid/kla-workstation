import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { AccountRepository, Identity, Session } from '../repositories/types.js';
import type { ComputeRepository } from './compute-repository.js';
import type { Sub2ApiClient } from './sub2api-client.js';
import { ComputeGateway, gatewayDedupeHash, parseUsage, parseUsageFromSse, buildUpstreamBody } from './gateway.js';
import { registerComputeGatewayRoutes } from './routes-b-gateway.js';
import type { QuotaService } from './quota-service.js';

const NOW = '2026-10-07T00:00:00.000Z';
const PERMISSION_SQL = /FROM identity_roles/;

function identity(overrides: Partial<Identity> = {}): Identity {
  return { id: 'i1', userId: 'u1', type: 'personal', displayName: '测试用户', organizationId: null, status: 'active', isDefault: true, role: 'personal', ...overrides };
}

function authedAccounts(target: Identity): AccountRepository {
  const session: Session = { id: 's1', userId: target.userId, accessToken: 't', refreshToken: 'r', expiresAt: NOW };
  return { getSession: async () => session, listIdentities: async () => [target] } as unknown as AccountRepository;
}

type Calls = {
  usage: Array<Parameters<ComputeRepository['upsertUsage']>[0]>;
  /** 传给代理面的凭据（第一个参数） */
  credentials: string[];
  /** 预扣/释放调用轨迹 */
  reserve: Array<{ identityId: string; amount: number; requestId: string }>;
  release: string[];
};

function entitlement(total = 1000) {
  return { id: 'e1', identityId: 'i1', organizationId: null, quotaTotal: total, quotaGranted: 0, quotaUsed: 0, quotaReserved: 0, version: 0, createdAt: NOW, updatedAt: NOW };
}

function buildGateway(overrides: { chat?: Partial<Sub2ApiClient>; repo?: Partial<ComputeRepository>; entitlementTotal?: number; quota?: Partial<QuotaService> } = {}) {
  const calls: Calls = { usage: [], credentials: [], reserve: [], release: [] };
  const computeRepo = {
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    getCatalogModel: async () => ({ id: 'm1', provider: 'demo', enabled: true }),
    getEntitlement: async () => entitlement(overrides.entitlementTotal ?? 1000),
    getBinding: async () => ({ identityId: 'i1', sub2apiUserId: 'u1', sub2apiUsername: 'kla-personal-i1', managedPassword: 'pass', status: 'ready', provisionJobId: null, lastError: null, createdAt: NOW, updatedAt: NOW }),
    countBindingsForSub2apiUser: async () => 1,
    getActiveKey: async () => ({ id: 'k1', sub2apiKeyId: 'upstream-key-1' }),
    getModelPricing: async () => null,
    upsertUsage: async (input: Parameters<ComputeRepository['upsertUsage']>[0]) => { calls.usage.push(input); return null; },
    ...overrides.repo,
  } as unknown as ComputeRepository;
  const sub2api = {
    getUserJwt: async () => 'jwt-token',
    resolveApiKeySecret: async () => 'sk-upstream-secret',
    chatCompletions: async (credential: string) => {
      calls.credentials.push(credential);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '你好' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 }, cost: 1.25 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
    ...overrides.chat,
  } as unknown as Sub2ApiClient;
  const quota = {
    reserve: async (identityId: string, amount: number, requestId: string) => {
      calls.reserve.push({ identityId, amount, requestId });
      return { ledgerId: `hold-${calls.reserve.length}` };
    },
    release: async (ledgerId: string) => { calls.release.push(ledgerId); },
    ...overrides.quota,
  } as unknown as QuotaService;
  const gateway = new ComputeGateway({ computeRepo, sub2api, quota, encryptionKey: '', minReserveUsd: 0.01, timeoutMs: 5000 });
  return { gateway, calls, computeRepo };
}

const INPUT = { model: 'm1', messages: [{ role: 'user', content: 'hi' }], requestId: 'req-1' };

describe('Gateway 纯函数', () => {
  it('dedupe_hash 与身份+请求绑定且稳定', () => {
    expect(gatewayDedupeHash('i1', 'req-1')).toBe(gatewayDedupeHash('i1', 'req-1'));
    expect(gatewayDedupeHash('i1', 'req-1')).not.toBe(gatewayDedupeHash('i2', 'req-1'));
  });

  it('parseUsage 兼容字段变体并读上游金额', () => {
    expect(parseUsage({ usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }, total_cost: 0.5 })).toEqual({
      promptTokens: 10, completionTokens: 20, totalTokens: 30, costUsd: 0.5,
    });
  });

  it('parseUsageFromSse 取最后一个含 usage 的数据帧，忽略心跳与 [DONE]', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"a"}}]}',
      '',
      ': heartbeat',
      '',
      'data: {"usage":{"prompt_tokens":1000000,"completion_tokens":0}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    expect(parseUsageFromSse(sse)).toMatchObject({ promptTokens: 1_000_000, completionTokens: 0 });
  });

  it('buildUpstreamBody 只保留白名单字段，丢弃前端传入的 url/key', () => {
    const body = buildUpstreamBody({ ...INPUT, url: 'http://evil', apiKey: 'sk-evil', stream: true } as never);
    expect(body).toMatchObject({ model: 'm1', stream: true });
    expect(JSON.stringify(body)).not.toContain('evil');
  });
});

describe('§8 ComputeGateway 结算', () => {
  it('智能体挂载的 Key 优先于默认 Key，并按身份查询', async () => {
    const getKey = async (keyId: string, identityId: string) => {
      expect([keyId, identityId]).toEqual(['mounted-key', 'i1']);
      return { id: keyId, sub2apiKeyId: 'upstream-mounted', status: 'active' } as never;
    };
    const { gateway, calls } = buildGateway({ repo: { getKey, getActiveKey: async () => { throw new Error('不应读取默认 Key'); } } });
    await gateway.completeChat(identity(), { ...INPUT, keyId: 'mounted-key' });
    expect(calls.credentials).toEqual(['sk-upstream-secret']);
    expect(calls.usage).toHaveLength(0);
  });
  it('挂载 Key 停用时拒绝调用，不回退到默认 Key', async () => {
    const { gateway, calls } = buildGateway({ repo: { getKey: async () => ({ id: 'mounted-key', sub2apiKeyId: 'upstream-mounted', status: 'disabled' }) as never } });
    await expect(gateway.completeChat(identity(), { ...INPUT, keyId: 'mounted-key' })).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
    expect(calls.credentials).toHaveLength(0);
  });
  it('成功：预扣后释放，实际扣费等待上游明细', async () => {
    const { gateway, calls } = buildGateway();
    const result = await gateway.completeChat(identity({ organizationId: 'org1' }), { ...INPUT, tags: { projectId: 'p1', conversationId: 'c1', taskId: 't1', agentId: 'a1' } });
    expect(calls.reserve).toHaveLength(1);
    expect(calls.reserve[0]).toMatchObject({ identityId: 'i1', requestId: 'req-1' });
    expect(calls.release).toEqual(['hold-1']);
    expect(calls.usage).toHaveLength(0);
    expect(result.amountUsd).toBe(0);
  });

  it('无上游金额时不估价扣费', async () => {
    const { gateway, calls } = buildGateway({
      repo: { getModelPricing: async () => ({ inputPricePerMtokUsd: 1, outputPricePerMtokUsd: 2 }) },
      chat: { chatCompletions: async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }), { status: 200 }) },
    });
    await gateway.completeChat(identity(), INPUT);
    expect(calls.usage).toHaveLength(0);
  });

  it('上游报错：抛 GatewayError 并落 failure 用量，同时释放预扣', async () => {
    const { gateway, calls } = buildGateway({ chat: { chatCompletions: async () => new Response('boom', { status: 500 }) } });
    await expect(gateway.completeChat(identity(), INPUT)).rejects.toMatchObject({ code: 'UNAVAILABLE', httpStatus: 502 });
    expect(calls.usage[0]).toMatchObject({ status: 'failure', amountUsd: 0, ledgerId: 'hold-1' });
    expect(calls.release).toEqual(['hold-1']);
  });

  it('可用额度耗尽：403 且不调用上游', async () => {
    let called = false;
    const insufficient = new Error('算力点不足');
    insufficient.name = 'QuotaInsufficientError';
    const { gateway, calls } = buildGateway({
      quota: { reserve: async () => { throw insufficient; } },
      chat: { chatCompletions: async () => { called = true; return new Response('{}', { status: 200 }); } },
    });
    await expect(gateway.completeChat(identity(), INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
    expect(called).toBe(false);
    expect(calls.credentials).toHaveLength(0);
    expect(calls.release).toHaveLength(0);
  });

  it('共享上游账号时拒绝调用，避免跨身份余额混用', async () => {
    const { gateway, calls } = buildGateway({ repo: { countBindingsForSub2apiUser: async () => 2 } });
    await expect(gateway.completeChat(identity(), INPUT)).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
    expect(calls.credentials).toHaveLength(0);
  });

  it('目录外模型放行：上游分组是可调用性的地面真相', async () => {
    const { gateway, calls } = buildGateway({ repo: { getCatalogModel: async () => null }, chat: { chatCompletions: async () => new Response('boom', { status: 500 }) } });
    await expect(gateway.completeChat(identity(), INPUT)).rejects.toMatchObject({ code: 'UNAVAILABLE', httpStatus: 502 });
    expect(calls.usage[0]).toMatchObject({ model: 'm1' });
    expect(calls.release).toEqual(['hold-1']);
  });

  it('目录中显式停用的模型：404', async () => {
    const { gateway, calls } = buildGateway({ repo: { getCatalogModel: async () => ({ id: 'm1', provider: 'demo', enabled: false }) } });
    await expect(gateway.completeChat(identity(), INPUT)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    expect(calls.credentials).toHaveLength(0);
  });

  it('流式：逐块透传并在结束时释放预扣，实际扣费等待上游明细', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1},"cost":0.5}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const { gateway, calls } = buildGateway({ chat: { chatCompletions: async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) } });
    const chunks: string[] = [];
    const result = await gateway.streamChat(identity(), { ...INPUT, stream: true }, (chunk) => { chunks.push(Buffer.from(chunk).toString('utf8')); });
    expect(chunks.join('')).toContain('delta');
    expect(result.usage).toMatchObject({ promptTokens: 1, completionTokens: 1 });
    expect(result.amountUsd).toBe(0);
    expect(calls.reserve).toHaveLength(1);
    expect(calls.release).toEqual(['hold-1']);
    expect(calls.usage).toHaveLength(0);
  });
});

describe('§8 Gateway 路由', () => {
  const AUTH = { authorization: 'Bearer t', 'content-type': 'application/json' };
  const URL = '/api/v1/compute/gateway/chat/completions';

  async function buildApp(permissionGranted: boolean) {
    const { gateway, computeRepo } = buildGateway({
      repo: {
        pool: { query: async (sql: string) => (permissionGranted && PERMISSION_SQL.test(sql) ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 }) },
      } as unknown as Partial<ComputeRepository>,
    });
    const app = Fastify();
    await registerComputeGatewayRoutes(app, { accounts: authedAccounts(identity()), computeRepo, gateway });
    return app;
  }

  it('缺少 model.use 权限时 403', async () => {
    const app = await buildApp(false);
    const response = await app.inject({ method: 'POST', url: URL, headers: AUTH, payload: INPUT });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('messages 为空时 400', async () => {
    const app = await buildApp(true);
    const response = await app.inject({ method: 'POST', url: URL, headers: AUTH, payload: { model: 'm1', messages: [] } });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('普通响应原样透传，且不泄露上游凭据', async () => {
    const app = await buildApp(true);
    const response = await app.inject({ method: 'POST', url: URL, headers: AUTH, payload: INPUT });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.choices[0].message.content).toBe('你好');
    expect(response.body).not.toContain('jwt-token');
    expect(response.body).not.toContain('sk-upstream-secret');
    await app.close();
  });

  /** 实测代理面只认 API Key（Bearer <用户 JWT> 会 401 INVALID_API_KEY），这里锁住凭据来源。 */
  it('代理面使用 API Key 明文，而不是用户 JWT', async () => {
    const { gateway, calls } = buildGateway();
    await gateway.completeChat(identity(), INPUT);
    expect(calls.credentials).toEqual(['sk-upstream-secret']);
  });

  it('身份没有可用 Key 时拒绝调用', async () => {
    const { gateway, calls } = buildGateway({ repo: { getActiveKey: async () => null } });
    await expect(gateway.completeChat(identity(), INPUT)).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
    expect(calls.credentials).toHaveLength(0);
  });
});
