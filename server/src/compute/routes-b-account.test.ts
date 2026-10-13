import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { AccountRepository, Identity, Session } from '../repositories/types.js';
import type { ComputeRepository } from './compute-repository.js';
import type { ProvisioningService } from './provisioning-service.js';
import type { QuotaService } from './quota-service.js';
import type { Sub2ApiClient } from './sub2api-client.js';
import { registerComputeRoutes } from './routes.js';
import { buildProvisionSteps, registerComputeAccountRoutes } from './routes-b-account.js';
import { encryptField } from './encryption.js';

const NOW = '2026-10-07T00:00:00.000Z';

function identity(overrides: Partial<Identity> = {}): Identity {
  return { id: 'i1', userId: 'u1', type: 'personal', displayName: '测试用户', organizationId: null, status: 'active', isDefault: true, role: 'personal', ...overrides };
}

function authedAccounts(target: Identity): AccountRepository {
  const session: Session = { id: 's1', userId: target.userId, accessToken: 't', refreshToken: 'r', expiresAt: NOW };
  return { getSession: async () => session, listIdentities: async () => [target] } as unknown as AccountRepository;
}

type QueryResult = { rows: unknown[]; rowCount: number };
type SqlStub = (sql: string, params?: unknown[]) => QueryResult | undefined;

function repoWith(query: SqlStub, methods: Partial<ComputeRepository> = {}): ComputeRepository {
  return { pool: { query: async (sql: string, params?: unknown[]) => query(sql, params) ?? { rows: [], rowCount: 0 } }, ...methods } as unknown as ComputeRepository;
}

describe('buildProvisionSteps', () => {
  it('ready 展开为完整步骤链，仅末步带时间', () => {
    const steps = buildProvisionSteps('ready', NOW, null);
    expect(steps.map((step) => step.state)).toEqual(['pending', 'provisioning', 'user_created', 'balance_granted', 'default_key_created', 'ready']);
    expect(steps.at(-1)).toMatchObject({ state: 'ready', at: NOW });
    expect(steps[0]).toMatchObject({ state: 'pending', at: null });
  });

  it('failed 收敛为单步并带错误详情', () => {
    expect(buildProvisionSteps('failed', NOW, '建号失败')).toEqual([{ state: 'failed', at: NOW, detail: '建号失败' }]);
  });
});

describe('§7.1 当前身份与余额', () => {
  it('summary 返回余额与权限标志，且不包含任何密钥', async () => {
    const app = Fastify();
    const me = identity();
    const repo = repoWith(
      (sql, params) => {
        if (sql.includes('FROM models WHERE enabled')) return { rows: [{ total: 3 }], rowCount: 1 };
        // 权限来自 identity_roles → role_permissions 绑定：这里模拟「个人身份已绑定 Key/用量/模型权限」。
        if (sql.includes('FROM identity_roles')) {
          const granted = ['compute.key.view', 'compute.key.create', 'compute.key.update', 'compute.key.disable', 'compute.usage.view', 'model.use'];
          return granted.includes(String(params?.[1] ?? '')) ? { rows: [{ ok: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        return undefined;
      },
      {
        getEntitlement: async () => ({ id: 'e1', identityId: 'i1', organizationId: null, quotaTotal: 10000, quotaGranted: 0, quotaUsed: 1000, quotaReserved: 500, version: 1, createdAt: NOW, updatedAt: NOW }),
        getBinding: async () => ({ identityId: 'i1', sub2apiUserId: 'u1', sub2apiUsername: 'kla-personal-i1', managedPassword: 'plain-pass', status: 'ready', provisionJobId: null, lastError: null, createdAt: NOW, updatedAt: NOW }),
        listKeys: async () => [
          { id: 'k1', identityId: 'i1', sub2apiKeyId: 'sk1', keyPrefix: 'sk-kla-ab', keyFingerprint: 'fp', name: '默认工作站 Key', isDefault: true, status: 'active', groupId: 'group-personal', quotaUsd: null, rpm: null, ipAllowList: [], expiresAt: null, lastSyncedAt: null, createdAt: NOW, updatedAt: NOW },
        ],
      },
    );
    await registerComputeAccountRoutes(app, {
      accounts: authedAccounts(me),
      computeRepo: repo,
      sub2api: { health: async () => ({ ok: true }) } as unknown as Sub2ApiClient,
      provisioning: {} as unknown as ProvisioningService,
      quota: {} as unknown as QuotaService,
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/compute/summary', headers: { authorization: 'Bearer t' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toMatchObject({
      identityId: 'i1',
      identityType: 'personal',
      currency: 'point',
      balance: 8500,
      available: 8500,
      used: 1000,
      reserved: 500,
      provisionState: 'ready',
      availableModelCount: 3,
      sub2apiHealth: 'healthy',
    });
    expect(body.data.defaultKey).toMatchObject({ keyPrefix: 'sk-kla-ab', status: 'active' });
    expect(body.data.permissions).toMatchObject({ canViewKeys: true, canRecharge: true, canViewOrganizationUsage: false, canAllocate: false });
    expect(JSON.stringify(body.data)).not.toContain('secret');
    expect(JSON.stringify(body.data)).not.toContain('managedPassword');
    await app.close();
  });

  it('权限未绑定时标志为 false，与接口 403 保持一致（不再谎报可用）', async () => {
    const app = Fastify();
    const repo = repoWith(
      (sql) => (sql.includes('FROM models WHERE enabled') ? { rows: [{ total: 3 }], rowCount: 1 } : undefined),
      { getEntitlement: async () => null, getBinding: async () => null, listKeys: async () => [] },
    );
    await registerComputeAccountRoutes(app, {
      accounts: authedAccounts(identity()),
      computeRepo: repo,
      sub2api: { health: async () => ({ ok: true }) } as unknown as Sub2ApiClient,
      provisioning: {} as unknown as ProvisioningService,
      quota: {} as unknown as QuotaService,
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/compute/summary', headers: { authorization: 'Bearer t' } });
    expect(response.json().data.permissions).toMatchObject({
      canViewKeys: false, canCreateKey: false, canUpdateKey: false, canDisableKey: false, canViewUsage: false, canUseModel: false, canRecharge: true,
    });
    await app.close();
  });

  it('Sub2API 健康检查失败时标记 unavailable', async () => {
    const app = Fastify();
    const repo = repoWith(() => undefined, { getEntitlement: async () => null, getBinding: async () => null, listKeys: async () => [] });
    await registerComputeAccountRoutes(app, {
      accounts: authedAccounts(identity()),
      computeRepo: repo,
      sub2api: { health: async () => { throw new Error('down'); } } as unknown as Sub2ApiClient,
      provisioning: {} as unknown as ProvisioningService,
      quota: {} as unknown as QuotaService,
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/compute/summary', headers: { authorization: 'Bearer t' } });
    expect(response.json().data).toMatchObject({ sub2apiHealth: 'unavailable', provisionState: 'pending', balance: 0, defaultKey: null });
    await app.close();
  });

  it('密钥不匹配时不再把绑定报告为 ready，也不允许重试建号', async () => {
    const app = Fastify();
    const password = encryptField('upstream-pass', 'a'.repeat(64));
    const repo = repoWith(
      (sql) => sql.includes('FROM models WHERE enabled') ? { rows: [{ total: 1 }], rowCount: 1 } : undefined,
      { getEntitlement: async () => null, getBinding: async () => ({ identityId: 'i1', sub2apiUserId: 'u1',
        sub2apiUsername: 'person@example.test', managedPassword: password, status: 'ready',
        provisionJobId: null, lastError: null, createdAt: NOW, updatedAt: NOW }), listKeys: async () => [] },
    );
    await registerComputeAccountRoutes(app, { accounts: authedAccounts(identity()), computeRepo: repo,
      sub2api: { health: async () => ({ ok: true }) } as unknown as Sub2ApiClient,
      provisioning: { retryProvision: async () => { throw new Error('不能重新建号'); } } as unknown as ProvisioningService,
      encryptionKey: 'b'.repeat(64),
      quota: {} as unknown as QuotaService });
    const headers = { authorization: 'Bearer t' };
    expect((await app.inject({ method: 'GET', url: '/api/v1/compute/summary', headers })).json().data.provisionState).toBe('failed');
    const status = (await app.inject({ method: 'GET', url: '/api/v1/compute/provision-status', headers })).json().data;
    expect(status).toMatchObject({ state: 'failed', retryable: false });
    expect(status.lastError).toContain('COMPUTE_SECRET_ENCRYPTION_KEY');
    const retry = await app.inject({ method: 'POST', url: '/api/v1/compute/provision/retry', headers });
    expect(retry.statusCode).toBe(409);
    await app.close();
  });
});

describe('§7.6 充值占位', () => {
  it('企业身份不可自助充值', async () => {
    const app = Fastify();
    const me = identity({ id: 'org-i1', type: 'enterprise', organizationId: 'org1' });
    await registerComputeRoutes(app, { accounts: authedAccounts(me), computeRepo: repoWith(() => undefined), quota: {} as unknown as QuotaService });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/compute/recharge/orders',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: { amount: 5 },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('只创建 pending 订单，不增加余额', async () => {
    const app = Fastify();
    const executed: string[] = [];
    const repo = repoWith((sql) => { executed.push(sql); return undefined; }, {
      getOrCreateEntitlement: async () => ({ id: 'e1', identityId: 'i1', organizationId: null, quotaTotal: 0, quotaGranted: 0, quotaUsed: 0, quotaReserved: 0, version: 0, createdAt: NOW, updatedAt: NOW }),
      createLedger: async (input) => ({
        id: 'l1', entitlementId: input.entitlementId, operation: input.operation, amount: input.amount, status: input.status,
        idempotencyKey: input.idempotencyKey, requestId: input.requestId ?? null, relatedLedgerId: null, sub2apiSynced: false,
        operatorIdentityId: input.operatorIdentityId ?? null, metadata: input.metadata ?? {}, createdAt: NOW, updatedAt: NOW,
      }),
    });
    await registerComputeRoutes(app, { accounts: authedAccounts(identity()), computeRepo: repo, quota: {} as unknown as QuotaService });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/compute/recharge/orders',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: { amount: 5 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ status: 'pending', amount: 5 });
    expect(executed.some((sql) => /quota_total\s*=\s*quota_total\s*\+/.test(sql))).toBe(false);
    await app.close();
  });
});

describe('§7.5 企业额度管理鉴权', () => {
  it('目标身份不是企业成员时拒绝分配', async () => {
    const app = Fastify();
    const me = identity({ id: 'admin-i1', type: 'enterprise', organizationId: 'org1' });
    const repo = repoWith((sql) => (/FROM identity_roles/.test(sql) ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 }));
    await registerComputeRoutes(app, { accounts: authedAccounts(me), computeRepo: repo, quota: {} as unknown as QuotaService });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/org1/compute/allocations',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: { identityId: 'other-i2', amount: 5 },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain('不是该企业成员');
    await app.close();
  });

  it('非本企业身份访问企业额度概览被拒', async () => {
    const app = Fastify();
    const me = identity({ id: 'outsider', type: 'enterprise', organizationId: 'org2' });
    await registerComputeRoutes(app, { accounts: authedAccounts(me), computeRepo: repoWith(() => undefined), quota: {} as unknown as QuotaService });
    const response = await app.inject({ method: 'GET', url: '/api/v1/organizations/org1/compute/summary', headers: { authorization: 'Bearer t' } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
