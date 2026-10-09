import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { QuotaService, QuotaInsufficientError } from './quota-service.js';
import type { ComputeRepository } from './compute-repository.js';
import type { Entitlement } from './types.js';

const NOW = '2026-10-07T00:00:00.000Z';

function makeEntitlement(id: string, identityId: string, total: number): Entitlement {
  return {
    id, identityId, organizationId: null,
    quotaTotal: total, quotaGranted: 0, quotaUsed: 0, quotaReserved: 0,
    version: 0, createdAt: NOW, updatedAt: NOW,
  };
}

type StubDeps = {
  repo: { calls: string[]; ledgerSeq: number };
  sub2api: { adjustments: Array<{ userId: string; delta: number }>; sameUser: boolean };
}

function buildService(opts: { adminBalance: number; memberBalance: number; sameSub2apiUser?: boolean }): { service: QuotaService; deps: StubDeps } {
  const adminEnt = makeEntitlement('ent-admin', 'admin-i', opts.adminBalance);
  const memberEnt = makeEntitlement('ent-member', 'member-i', opts.memberBalance);
  const find = (owner: { identityId?: string }) => (owner.identityId === 'admin-i' ? adminEnt : memberEnt);

  const deps: StubDeps = {
    repo: { calls: [], ledgerSeq: 0 },
    sub2api: { adjustments: [], sameUser: opts.sameSub2apiUser ?? false },
  };

  const adminBinding = { identityId: 'admin-i', sub2apiUserId: 'sub-admin', sub2apiUsername: 'a', managedPassword: null, status: 'ready' as const, provisionJobId: null, lastError: null, createdAt: NOW, updatedAt: NOW };
  const memberBinding = {
    identityId: 'member-i',
    sub2apiUserId: opts.sameSub2apiUser ? 'sub-admin' : 'sub-member',
    sub2apiUsername: 'm', managedPassword: null, status: 'ready' as const, provisionJobId: null, lastError: null, createdAt: NOW, updatedAt: NOW,
  };

  const repo = {
    getLedgerByIdempotency: async () => null,
    getLedger: async () => ({ id: 'led-1', status: 'pending', amount: 0.01 }),
    getOrCreateEntitlement: async (owner: { identityId?: string }) => find(owner),
    lockEntitlement: async (_client: unknown, owner: { identityId?: string }) => find(owner),
    updateEntitlementAmounts: async (_client: unknown, id: string, delta: { total?: number }) => {
      const target = id === 'ent-admin' ? adminEnt : memberEnt;
      if (delta.total !== undefined) target.quotaTotal += delta.total;
      return target;
    },
    createLedger: async (input: { entitlementId: string; operation: string; amount: number; idempotencyKey: string; requestId?: string | null; operatorIdentityId?: string | null; relatedLedgerId?: string | null; metadata?: Record<string, unknown> }) => {
      deps.repo.ledgerSeq += 1;
      return {
        id: `led-${deps.repo.ledgerSeq}`,
        entitlementId: input.entitlementId, operation: input.operation, amount: input.amount, status: 'completed',
        idempotencyKey: input.idempotencyKey, requestId: input.requestId ?? null, relatedLedgerId: input.relatedLedgerId ?? null,
        sub2apiSynced: false, operatorIdentityId: input.operatorIdentityId ?? null, metadata: input.metadata ?? {}, createdAt: NOW, updatedAt: NOW,
      };
    },
    getBinding: async (identityId: string) => (identityId === 'admin-i' ? adminBinding : memberBinding),
    updateLedgerStatus: async (id: string, _status: string, synced?: boolean) => { deps.repo.calls.push(`sync:${id}:${String(synced)}`); },
    insertSyncLog: async () => ({ id: 'log-1', syncType: 'balance', identityId: null, organizationId: 'org1', klaAmount: null, sub2apiAmount: null, driftUsd: null, status: 'warning', message: null, createdAt: NOW }),
  } as unknown as ComputeRepository;

  const sub2api = {
    adjustBalance: vi.fn(async (userId: string, delta: number) => { deps.sub2api.adjustments.push({ userId, delta }); return { balance: 0 }; }),
  };

  const pool = {
    connect: async () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('UPDATE compute_allocation_ledger')) deps.repo.calls.push('link-ledgers');
        if (sql.startsWith('SELECT e.identity_id FROM compute_allocation_ledger')) return { rows: [{ identity_id: 'admin-i' }] };
        return { rows: [] };
      }),
      release: () => {},
    }),
  } as unknown as Pool;

  const service = new QuotaService(pool, repo, sub2api as never);
  return { service, deps };
}

describe('QuotaService 企业额度转账', () => {
  it('发放只向 Sub2API 同步本次增量，模型结算不重复加余额', async () => {
    const { service, deps } = buildService({ adminBalance: 0, memberBalance: 0 });
    await service.grant({ identityId: 'admin-i' }, 0.1, 'grant-1');
    await service.grant({ identityId: 'admin-i' }, 0.2, 'grant-2');
    expect(deps.sub2api.adjustments).toEqual([
      { userId: 'sub-admin', delta: 0.1 },
      { userId: 'sub-admin', delta: 0.2 },
    ]);
    await service.commit('led-1', 0.005);
    expect(deps.sub2api.adjustments).toHaveLength(2);
  });

  it('allocate：管理员减、成员加，两侧各落一条流水并同步 Sub2API', async () => {
    const { service, deps } = buildService({ adminBalance: 100, memberBalance: 0 });
    const result = await service.allocate('admin-i', 'org1', 'member-i', 30, 'req-1');

    expect(result.sub2apiSynced).toBe(true);
    expect(result.counterpartyLedgerId).toBeTruthy();
    expect(deps.sub2api.adjustments).toEqual([
      { userId: 'sub-admin', delta: -30 },
      { userId: 'sub-member', delta: 30 },
    ]);
    // 两条流水都被标记为已同步
    expect(deps.repo.calls).toContain('sync:led-1:true');
    expect(deps.repo.calls).toContain('sync:led-2:true');
    expect(deps.repo.calls).toContain('link-ledgers');
  });

  it('allocate：管理员余额不足抛 QuotaInsufficientError', async () => {
    const { service, deps } = buildService({ adminBalance: 5, memberBalance: 0 });
    await expect(service.allocate('admin-i', 'org1', 'member-i', 10, 'req-2')).rejects.toBeInstanceOf(QuotaInsufficientError);
    expect(deps.sub2api.adjustments).toHaveLength(0);
  });

  it('allocate：双方映射同一 Sub2API 账号时跳过转账，台账仍成功（sub2apiSynced=false）', async () => {
    const { service, deps } = buildService({ adminBalance: 50, memberBalance: 0, sameSub2apiUser: true });
    const result = await service.allocate('admin-i', 'org1', 'member-i', 20, 'req-3');
    expect(result.sub2apiSynced).toBe(false);
    expect(deps.sub2api.adjustments).toHaveLength(0);
  });

  it('reclaim：成员减、管理员加，上限为成员可用额度', async () => {
    const { service, deps } = buildService({ adminBalance: 80, memberBalance: 20 });
    const result = await service.reclaim('admin-i', 'org1', 'member-i', 12, 'req-4');
    expect(result.sub2apiSynced).toBe(true);
    expect(deps.sub2api.adjustments).toEqual([
      { userId: 'sub-member', delta: -12 },
      { userId: 'sub-admin', delta: 12 },
    ]);
  });

  it('reclaim：成员可用不足抛 QuotaInsufficientError', async () => {
    const { service } = buildService({ adminBalance: 100, memberBalance: 3 });
    await expect(service.reclaim('admin-i', 'org1', 'member-i', 5, 'req-5')).rejects.toBeInstanceOf(QuotaInsufficientError);
  });

  it('不能向/从管理员本人划转', async () => {
    const { service } = buildService({ adminBalance: 100, memberBalance: 0 });
    await expect(service.allocate('admin-i', 'org1', 'admin-i', 1, 'req-6')).rejects.toThrow('管理员本人');
    await expect(service.reclaim('admin-i', 'org1', 'admin-i', 1, 'req-7')).rejects.toThrow('管理员本人');
  });
});
