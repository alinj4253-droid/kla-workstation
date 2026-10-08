import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { AccountRepository, Identity, Session } from '../repositories/types.js';
import type { ComputeKey } from './types.js';
import type { ComputeRepository } from './compute-repository.js';
import type { Sub2ApiClient } from './sub2api-client.js';
import { encryptField, resolveManagedPassword } from './encryption.js';
import { registerComputeKeyRoutes, toKeyDto } from './routes-b-keys.js';

const NOW = '2026-10-07T00:00:00.000Z';
const PERMISSION_SQL = /FROM identity_roles/;

function identity(overrides: Partial<Identity> = {}): Identity {
  return { id: 'i1', userId: 'u1', type: 'personal', displayName: '测试用户', organizationId: null, status: 'active', isDefault: true, role: 'personal', ...overrides };
}

function authedAccounts(target: Identity): AccountRepository {
  const session: Session = { id: 's1', userId: target.userId, accessToken: 't', refreshToken: 'r', expiresAt: NOW };
  return { getSession: async () => session, listIdentities: async () => [target] } as unknown as AccountRepository;
}

function keyFixture(overrides: Partial<ComputeKey> = {}): ComputeKey {
  return {
    id: 'k1', identityId: 'i1', sub2apiKeyId: 'sk-1', keyPrefix: 'sk-kla-ab', keyFingerprint: 'fp-1',
    name: '生产 Key', isDefault: false, status: 'active', groupId: 'group-personal', quotaUsd: 12.5,
    rpm: 60, ipAllowList: ['10.0.0.0/8'], expiresAt: null, lastSyncedAt: NOW, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

type QueryResult = { rows: unknown[]; rowCount: number };
type SqlStub = (sql: string, params?: unknown[]) => QueryResult | undefined;

function repoWith(query: SqlStub, methods: Partial<ComputeRepository> = {}): ComputeRepository {
  return { pool: { query: async (sql: string, params?: unknown[]) => query(sql, params) ?? { rows: [], rowCount: 0 } }, ...methods } as unknown as ComputeRepository;
}

function grantPermissions(): SqlStub {
  return (sql) => (PERMISSION_SQL.test(sql) ? { rows: [{}], rowCount: 1 } : undefined);
}

async function buildApp(repo: ComputeRepository, sub2api: Partial<Sub2ApiClient>, target = identity()) {
  const app = Fastify();
  await registerComputeKeyRoutes(app, {
    accounts: authedAccounts(target),
    computeRepo: repo,
    sub2api: sub2api as unknown as Sub2ApiClient,
    encryptionKey: '',
    defaultGroupId: 'group-default',
  });
  return app;
}

const AUTH = { authorization: 'Bearer t', 'content-type': 'application/json' };

describe('resolveManagedPassword', () => {
  it('加密托管密码可解密', () => {
    const encryptionKey = 'a'.repeat(64);
    const ciphertext = encryptField('managed-pass', encryptionKey);
    expect(resolveManagedPassword(ciphertext, encryptionKey)).toBe('managed-pass');
  });

  it('明文（未配置加密密钥）原样返回', () => {
    expect(resolveManagedPassword('plain-pass', '')).toBe('plain-pass');
  });

  it('缺失或无法解密时返回 null', () => {
    expect(resolveManagedPassword(null, '')).toBeNull();
    expect(resolveManagedPassword('a:b:c', 'a'.repeat(64))).toBeNull();
  });
});

describe('toKeyDto', () => {
  it('永不包含 secret 与指纹', () => {
    const dto = toKeyDto(keyFixture(), 3.5);
    expect(dto).toMatchObject({ keyPrefix: 'sk-kla-ab', todayUsageUsd: 3.5, quotaUsd: 12.5, rpm: 60, ipAllowList: ['10.0.0.0/8'] });
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('keyFingerprint');
    expect(serialized).not.toContain('fp-1');
  });
});

describe('§7.2 GET /compute/keys', () => {
  it('返回当前身份 Key 与今日用量，且不含 secret', async () => {
    const repo = repoWith(grantPermissions(), {
      listKeys: async () => [keyFixture({ isDefault: true }), keyFixture({ id: 'k2', sub2apiKeyId: 'sk-2' })],
      sumTodayUsageByKey: async () => new Map([['k1', 1.25]]),
    });
    const app = await buildApp(repo, {});
    const response = await app.inject({ method: 'GET', url: '/api/v1/compute/keys', headers: { authorization: 'Bearer t' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0]).toMatchObject({ todayUsageUsd: 1.25, isDefault: true });
    expect(body.data.items[1]).toMatchObject({ todayUsageUsd: 0 });
    expect(JSON.stringify(body.data)).not.toContain('secret');
    expect(JSON.stringify(body.data)).not.toContain('fp-1');
    await app.close();
  });

  it('无 compute.key.view 权限时 403', async () => {
    const repo = repoWith(() => ({ rows: [], rowCount: 0 }), { listKeys: async () => [] });
    const app = await buildApp(repo, {});
    const response = await app.inject({ method: 'GET', url: '/api/v1/compute/keys', headers: { authorization: 'Bearer t' } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

describe('§7.2 POST /compute/keys', () => {
  it('完整 secret 只在创建响应出现一次，配额等元数据落 KLA', async () => {
    let captured: Parameters<ComputeRepository['createKey']>[0] | null = null;
    const repo = repoWith(grantPermissions(), {
      getBinding: async () => ({ identityId: 'i1', sub2apiUserId: 'u1', sub2apiUsername: 'kla-personal-i1', managedPassword: 'plain-pass', status: 'ready', provisionJobId: null, lastError: null, createdAt: NOW, updatedAt: NOW }),
      createKey: async (input) => { captured = input; return keyFixture({ id: 'k9', sub2apiKeyId: input.sub2apiKeyId, keyPrefix: input.keyPrefix, groupId: input.groupId }); },
    });
    const sub2api = {
      getUserJwt: async () => 'jwt-token',
      createApiKey: async () => ({ id: 'sk-new', name: '生产 Key', keyPrefix: 'sk-kla-cd', keyFingerprint: 'fp-new', status: 'active', secret: 'sk-kla-cd-FULL-SECRET' }),
    };
    const app = await buildApp(repo, sub2api);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/compute/keys',
      headers: AUTH,
      payload: { name: '生产 Key', quota: 12.5, rpm: 60, ipAllowList: ['10.0.0.0/8'], expiresAt: '2026-12-31T00:00:00Z' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.data.secret).toBe('sk-kla-cd-FULL-SECRET');
    expect(body.data.key).toMatchObject({ keyPrefix: 'sk-kla-cd', groupId: 'group-default', quotaUsd: 12.5, rpm: 60, ipAllowList: ['10.0.0.0/8'] });
    expect(captured).toMatchObject({ identityId: 'i1', sub2apiKeyId: 'sk-new', quota: 12.5, rpm: 60, ipAllowList: ['10.0.0.0/8'], expiresAt: '2026-12-31T00:00:00.000Z' });
    await app.close();
  });

  it('上游未回传完整 Key 时省略 secret，不伪造', async () => {
    const repo = repoWith(grantPermissions(), {
      getBinding: async () => ({ identityId: 'i1', sub2apiUserId: 'u1', sub2apiUsername: 'u', managedPassword: 'plain-pass', status: 'ready', provisionJobId: null, lastError: null, createdAt: NOW, updatedAt: NOW }),
      createKey: async () => keyFixture(),
    });
    const sub2api = { getUserJwt: async () => 'jwt', createApiKey: async () => ({ id: 'sk-x', name: 'n', keyPrefix: 'sk-kla-ef', keyFingerprint: 'fp', status: 'active' }) };
    const app = await buildApp(repo, sub2api);
    const response = await app.inject({ method: 'POST', url: '/api/v1/compute/keys', headers: AUTH, payload: { name: '生产 Key' } });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.secret).toBeUndefined();
    await app.close();
  });

  it('算力账号未就绪时 409，且不创建 KLA 记录', async () => {
    let created = false;
    const repo = repoWith(grantPermissions(), {
      getBinding: async () => ({ identityId: 'i1', sub2apiUserId: 'u1', sub2apiUsername: 'u', managedPassword: 'pass', status: 'pending', provisionJobId: null, lastError: null, createdAt: NOW, updatedAt: NOW }),
      createKey: async () => { created = true; return keyFixture(); },
    });
    const app = await buildApp(repo, { getUserJwt: async () => 'jwt' });
    const response = await app.inject({ method: 'POST', url: '/api/v1/compute/keys', headers: AUTH, payload: { name: '生产 Key' } });
    expect(response.statusCode).toBe(409);
    expect(created).toBe(false);
    await app.close();
  });

  it('参数非法时 400', async () => {
    const repo = repoWith(grantPermissions(), {});
    const app = await buildApp(repo, {});
    const bad = await app.inject({ method: 'POST', url: '/api/v1/compute/keys', headers: AUTH, payload: { name: 'x', quota: -1 } });
    expect(bad.statusCode).toBe(400);
    const missingName = await app.inject({ method: 'POST', url: '/api/v1/compute/keys', headers: AUTH, payload: {} });
    expect(missingName.statusCode).toBe(400);
    await app.close();
  });
});

describe('§7.2 停用与删除', () => {
  it('默认 Key 不可删除（409）', async () => {
    const repo = repoWith(grantPermissions(), { getKey: async () => keyFixture({ isDefault: true }) });
    const app = await buildApp(repo, {});
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/compute/keys/k1', headers: { authorization: 'Bearer t' } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('默认 Key 不可删除');
    await app.close();
  });

  it('非默认 Key 停用会调用上游并落 disabled', async () => {
    const disabledCalls: string[] = [];
    const repo = repoWith(grantPermissions(), {
      getKey: async () => keyFixture({ isDefault: false }),
      getBinding: async () => ({ identityId: 'i1', sub2apiUserId: 'u1', sub2apiUsername: 'u', managedPassword: 'pass', status: 'ready', provisionJobId: null, lastError: null, createdAt: NOW, updatedAt: NOW }),
      setKeyStatus: async (_id, _identityId, status) => keyFixture({ status }),
    });
    const sub2api = { getUserJwt: async () => 'jwt', disableApiKey: async (_jwt: string, keyId: string) => { disabledCalls.push(keyId); } };
    const app = await buildApp(repo, sub2api);
    const response = await app.inject({ method: 'POST', url: '/api/v1/compute/keys/k1/disable', headers: { authorization: 'Bearer t' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('disabled');
    expect(disabledCalls).toEqual(['sk-1']);
    await app.close();
  });

  it('删除非默认 Key 会调用上游并落 deleted', async () => {
    const deleteCalls: string[] = [];
    const repo = repoWith(grantPermissions(), {
      getKey: async () => keyFixture({ isDefault: false }),
      getBinding: async () => ({ identityId: 'i1', sub2apiUserId: 'u1', sub2apiUsername: 'u', managedPassword: 'pass', status: 'ready', provisionJobId: null, lastError: null, createdAt: NOW, updatedAt: NOW }),
      setKeyStatus: async (_id, _identityId, status) => keyFixture({ status }),
    });
    const sub2api = { getUserJwt: async () => 'jwt', deleteApiKey: async (_jwt: string, keyId: string) => { deleteCalls.push(keyId); } };
    const app = await buildApp(repo, sub2api);
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/compute/keys/k1', headers: { authorization: 'Bearer t' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('deleted');
    expect(deleteCalls).toEqual(['sk-1']);
    await app.close();
  });

  it('无 compute.key.disable 权限时 403', async () => {
    const repo = repoWith(() => ({ rows: [], rowCount: 0 }), { getKey: async () => keyFixture() });
    const app = await buildApp(repo, {});
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/compute/keys/k1', headers: { authorization: 'Bearer t' } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});