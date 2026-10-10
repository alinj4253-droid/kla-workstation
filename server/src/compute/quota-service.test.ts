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
  sub2api: { adjustments: Array<{ userId: string; delta: number }> };
}

function buildService(opts: { adminBalance: number; memberBalance: number }): { service: QuotaService; deps: StubDeps } {
  const adminEnt = makeEntitlement('ent-admin', 'admin-i', opts.adminBalance);
  const memberEnt = makeEntitlement('ent-member', 'member-i', opts.memberBalance);
  const find = (owner: { identityId?: string }) => (owner.identityId === 'admin-i' ? adminEnt : memberEnt);

  const deps: StubDeps = {
    repo: { calls: [], ledgerSeq: 0 },
    sub2api: { adjustments: [] },
  };

  const adminBinding = { identityId: 'admin-i', sub2apiUserId: 'sub-admin', sub2apiUsername: 'a', managedPassword: null, status: 'ready' as const, provisionJobId: null, lastError: null, createdAt: NOW, updatedAt: NOW };
  const memberBinding = {
    identityId: 'member-i',
    sub2apiUserId: 'sub-member',
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
  it('发放只向 Sub2API 同步本次增量', async () => {
    const { service, deps } = buildService({ adminBalance: 0, memberBalance: 0 });
    await service.grant({ identityId: 'admin-i' }, 0.1, 'grant-1');
    await service.grant({ identityId: 'admin-i' }, 0.2, 'grant-2');
    expect(deps.sub2api.adjustments).toEqual([
      { userId: 'sub-admin', delta: 0.00001 },
      { userId: 'sub-admin', delta: 0.00002 },
    ]);
    expect(deps.sub2api.adjustments).toHaveLength(2);
  });

  it('allocate：管理员减、成员加，两侧各落一条流水并同步 Sub2API', async () => {
    const { service, deps } = buildService({ adminBalance: 100, memberBalance: 0 });
    const result = await service.allocate('admin-i', 'org1', 'member-i', 30, 'req-1');

    expect(result.sub2apiSynced).toBe(true);
    expect(result.counterpartyLedgerId).toBeTruthy();
    expect(deps.sub2api.adjustments).toEqual([
      { userId: 'sub-admin', delta: -0.003 },
      { userId: 'sub-member', delta: 0.003 },
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

  it('reclaim：成员减、管理员加，上限为成员可用额度', async () => {
    const { service, deps } = buildService({ adminBalance: 80, memberBalance: 20 });
    const result = await service.reclaim('admin-i', 'org1', 'member-i', 12, 'req-4');
    expect(result.sub2apiSynced).toBe(true);
    expect(deps.sub2api.adjustments).toEqual([
      { userId: 'sub-member', delta: -0.0012 },
      { userId: 'sub-admin', delta: 0.0012 },
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

describe('QuotaService actual usage billing', () => {
  it('holds only the available points when the fixed hold is larger', async () => {
    const entitlement = makeEntitlement('e1', 'i1', 1);
    const updates: number[] = [];
    const repo = {
      getLedgerByIdempotency: async () => null,
      getOrCreateEntitlement: async () => entitlement,
      lockEntitlement: async () => entitlement,
      updateEntitlementAmounts: async (_client: unknown, _id: string, delta: { reserved: number }) => { updates.push(delta.reserved); return entitlement; },
      createLedger: async (input: { amount: number }) => ({ id: 'hold-1', amount: input.amount }),
    } as unknown as ComputeRepository;
    const pool = { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) } as unknown as Pool;
    const service = new QuotaService(pool, repo, {} as never);

    expect(await service.reserve('i1', 10, 'r1')).toEqual({ ledgerId: 'hold-1' });
    expect(updates).toEqual([1]);
  });

  it('books one upstream usage row exactly once and never adjusts the upstream balance again', async () => {
    const ledgerKeys = new Set<string>();
    const entitlement = makeEntitlement('e1', 'i1', 100);
    const deltas: number[] = [];
    const recorded: Array<Parameters<ComputeRepository['upsertUsage']>[0]> = [];
    const sql: string[] = [];
    const client = {
      query: async (statement: string) => { sql.push(statement); return { rows: [] }; },
      release: () => {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const repo = {
      getLedgerByIdempotency: async (key: string) => ledgerKeys.has(key) ? { id: 'ledger-1' } : null,
      getOrCreateEntitlement: async () => entitlement,
      lockEntitlement: async () => entitlement,
      updateEntitlementAmounts: async (_client: unknown, _id: string, delta: { used: number }) => { deltas.push(delta.used); return entitlement; },
      createLedger: async (input: { idempotencyKey: string }) => { ledgerKeys.add(input.idempotencyKey); return { id: 'ledger-1' }; },
      upsertUsage: async (input: Parameters<ComputeRepository['upsertUsage']>[0]) => { recorded.push(input); return { id: 'usage-1' }; },
    } as unknown as ComputeRepository;
    const adjustBalance = vi.fn();
    const service = new QuotaService(pool, repo, { adjustBalance } as never);
    const item = {
      id: '39', userId: '52', apiKeyId: '65', requestId: 'r-39', model: 'glm-4',
      amountUsd: 0.00036205, promptTokens: 120, completionTokens: 40, timestamp: NOW,
    };

    expect(await service.recordUpstreamUsage('i1', item, 'k1')).toBe(true);
    expect(await service.recordUpstreamUsage('i1', item, 'k1')).toBe(false);
    expect(deltas).toEqual([3.621]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ identityId: 'i1', keyId: 'k1', sub2apiUsageId: '39', amountUsd: 0.00036205 });
    expect(sql).toContain("SELECT set_config('kla.upstream_usage', 'on', true)");
    expect(adjustBalance).not.toHaveBeenCalled();
  });
});
