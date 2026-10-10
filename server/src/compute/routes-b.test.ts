import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { AccountRepository } from '../repositories/types.js';
import { createPointsConverter } from './points.js';
import type { ComputeRepository } from './compute-repository.js';
import type { QuotaService } from './quota-service.js';
import { registerRoutes } from '../routes.js';
import { registerComputeRoutes } from './routes.js';
import { buildUsageCsv, mapComputeModel, mapUsageRecord, parseUsageQuery, registerComputeRoutesB } from './routes-b.js';

const points = createPointsConverter();

function stubAccounts(): AccountRepository {
  return { getSession: async () => null, listIdentities: async () => [] } as unknown as AccountRepository;
}

function stubRepo(): ComputeRepository {
  return { pool: { query: async () => ({ rows: [], rowCount: 0 }) } } as unknown as ComputeRepository;
}

describe('mapComputeModel', () => {
  it('映射能力、上下文与费率（USD 成本价换算为点），且不暴露上游配置', () => {
    const model = mapComputeModel({
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      provider: 'deepseek',
      capabilities: { thinking: false, streaming: true, vision: false, context: 128000 },
      enabled: true,
      input_price_per_mtok_usd: '0.50000000',
      output_price_per_mtok_usd: null,
      available_groups: ['group-chat', 3, 'group-personal'],
    }, points);
    expect(model).toEqual({
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      provider: 'deepseek',
      capabilities: { vision: false, reasoning: false, tools: false, streaming: true },
      contextWindow: 128000,
      inputPricePerMillionTokensPoints: 500,
      outputPricePerMillionTokensPoints: null,
      available: true,
      availableGroups: ['group-chat', 'group-personal'],
      status: 'active',
    });
    expect(JSON.stringify(model)).not.toContain('base_url');
    expect(JSON.stringify(model)).not.toContain('api_key');
  });

  it('停用模型返回 disabled 且 available=false，缺失能力一律按 false 处理', () => {
    const model = mapComputeModel({
      id: 'glm-4-air',
      name: 'GLM 4 Air',
      provider: 'zhipu',
      capabilities: {},
      enabled: false,
      input_price_per_mtok_usd: null,
      output_price_per_mtok_usd: null,
      available_groups: [],
    }, points);
    expect(model.status).toBe('disabled');
    expect(model.available).toBe(false);
    expect(model.capabilities.streaming).toBe(false);
    expect(model.contextWindow).toBeNull();
    expect(model.availableGroups).toEqual([]);
  });
});

describe('mapUsageRecord', () => {
  it('按列映射：Token 求和、numeric 数值化、双口径与计费通道、时间转 ISO', () => {
    const record = mapUsageRecord({
      id: 'u1',
      identity_id: 'i1',
      model: 'deepseek-v4-flash',
      key_id: 'k1',
      key_prefix: 'sk-kla-ab',
      project_id: null,
      conversation_id: null,
      task_id: null,
      prompt_tokens: '10',
      completion_tokens: 20,
      latency_ms: 123,
      status: 'success',
      amount_usd: '0.00012345',
      amount_points: '0.123',
      kind: 'model',
      tool_id: null,
      recorded_at: new Date('2026-10-07T00:00:00.000Z'),
    });
    expect(record.totalTokens).toBe(30);
    expect(record.costPoints).toBeCloseTo(0.123);
    expect(record.kind).toBe('model');
    expect(record.toolId).toBeNull();
    expect(record.usageAt).toBe('2026-10-07T00:00:00.000Z');
    expect(record.keyPrefix).toBe('sk-kla-ab');
    expect(record.requestCount).toBe(1);
  });

  it('模型或 Token 缺失时降级为 null / 0，不伪造数据', () => {
    const record = mapUsageRecord({
      id: 'u2',
      identity_id: 'i1',
      model: null,
      key_id: null,
      key_prefix: null,
      project_id: null,
      conversation_id: null,
      task_id: null,
      prompt_tokens: null,
      completion_tokens: null,
      latency_ms: null,
      status: 'success',
      amount_usd: null,
      amount_points: null,
      kind: null,
      tool_id: null,
      recorded_at: '2026-10-07T00:00:00.000Z',
    });
    expect(record.modelId).toBeNull();
    expect(record.inputTokens).toBe(0);
    expect(record.totalTokens).toBe(0);
    expect(record.costPoints).toBe(0);
    expect(record.kind).toBe('model');
  });
});

describe('buildUsageCsv', () => {
  it('输出 BOM 与表头，并转义含逗号的字段', () => {
    const csv = buildUsageCsv([
      {
        id: 'u1',
        identityId: 'i1',
        modelId: 'm,1',
        keyId: null,
        keyPrefix: null,
        projectId: null,
        conversationId: null,
        taskId: null,
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        requestCount: 1,
        latencyMs: null,
        status: 'success',
        costPoints: 0,
        kind: 'model',
        toolId: null,
        usageAt: '2026-10-07T00:00:00.000Z',
      },
    ]);
    expect(csv.startsWith('\uFEFF时间,模型/工具')).toBe(true);
    expect(csv).toContain('"m,1"');
    expect(csv.trimEnd().split('\r\n')).toHaveLength(2);
  });
});

describe('parseUsageQuery', () => {
  it('应用默认值与 pageSize 上限', () => {
    const parsed = parseUsageQuery({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.scope).toBe('self');
    expect(parsed.value.page).toBe(1);
    expect(parsed.value.pageSize).toBe(20);
    expect(parseUsageQuery({ pageSize: '1000' })).toMatchObject({ ok: true, value: { pageSize: 100 } });
  });

  it('拒绝非法时间、作用域、分页与 UUID', () => {
    expect(parseUsageQuery({ from: 'not-a-date' })).toMatchObject({ ok: false });
    expect(parseUsageQuery({ scope: 'everyone' })).toMatchObject({ ok: false });
    expect(parseUsageQuery({ keyId: 'abc' })).toMatchObject({ ok: false });
    expect(parseUsageQuery({ page: '0' })).toMatchObject({ ok: false });
  });

  it('规范化时间并解析筛选条件', () => {
    const parsed = parseUsageQuery({ from: '2026-10-07T00:00:00Z', modelId: 'm1', scope: 'organization' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.filter.from).toBe('2026-10-07T00:00:00.000Z');
    expect(parsed.value.filter.modelId).toBe('m1');
    expect(parsed.value.scope).toBe('organization');
  });
});

describe('A/B 路由合并注册', () => {
  it('A 侧 §7.5/§7.6 与 B 侧 §7.3/§7.4 同时注册且静态路由不被通配兜底吞掉', async () => {
    const app = Fastify();
    await registerRoutes(app, { accounts: stubAccounts() });
    await registerComputeRoutes(app, {
      accounts: stubAccounts(),
      computeRepo: stubRepo(),
      quota: {} as unknown as QuotaService,
      points,
    });
    await registerComputeRoutesB(app, { accounts: stubAccounts(), computeRepo: stubRepo(), points });
    await app.ready();
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/api/v1/compute/models');
    expect(routes).toContain('/api/v1/compute/usage');
    expect(routes).toContain('/compute/summary');
    expect(routes).toContain('/compute/overview');
    // 通配兜底返回 501；静态算力路由必须先命中并做鉴权（401）
    const response = await app.inject({ method: 'GET', url: '/api/v1/compute/usage' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('B 侧接口未登录返回 401', async () => {
    const app = Fastify();
    await registerComputeRoutesB(app, { accounts: stubAccounts(), computeRepo: stubRepo(), points });
    const response = await app.inject({ method: 'GET', url: '/api/v1/compute/models' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED', retryable: false } });
    await app.close();
  });
});