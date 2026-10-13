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
      { userId: 'sub-admin', delta: 0.0001 },
      { userId: 'sub-admin', delta: 0.0002 },
    ]);
    expect(deps.sub2api.adjustments).toHaveLength(2);
  });

  it('allocate：管理员减、成员加，两侧各落一条流水并同步 Sub2API', async () => {
    const { service, deps } = buildService({ adminBalance: 100, memberBalance: 0 });
    const result = await service.allocate('admin-i', 'org1', 'member-i', 30, 'req-1');

    expect(result.sub2apiSynced).toBe(true);
    expect(result.counterpartyLedgerId).toBeTruthy();
    expect(deps.sub2api.adjustments).toEqual([
      { userId: 'sub-admin', delta: -0.03 },
      { userId: 'sub-member', delta: 0.03 },
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
      { userId: 'sub-member', delta: -0.012 },
      { userId: 'sub-admin', delta: 0.012 },
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
      refreshUsageMetrics: async () => {},
    } as unknown as ComputeRepository;
    const adjustBalance = vi.fn();
    const service = new QuotaService(pool, repo, { adjustBalance } as never);
    const item = {
      id: '39', userId: '52', apiKeyId: '65', requestId: 'r-39', model: 'glm-4',
      amountUsd: 0.00036205, promptTokens: 120, completionTokens: 40, timestamp: NOW,
      cacheCreationTokens: 0, cacheReadTokens: 0, durationMs: 1200, firstTokenMs: null,
    };

    expect(await service.recordUpstreamUsage('i1', item, 'k1')).toBe(true);
    expect(await service.recordUpstreamUsage('i1', item, 'k1')).toBe(false);
    expect(deltas).toEqual([0.362]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ identityId: 'i1', keyId: 'k1', sub2apiUsageId: '39', amountUsd: 0.00036205 });
    expect(sql).toContain("SELECT set_config('kla.upstream_usage', 'on', true)");
    expect(adjustBalance).not.toHaveBeenCalled();
  });
});

describe('QuotaService 预扣与释放', () => {
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

  it('reserve：同 requestId 重复预扣命中幂等，不再二次占位', async () => {
    const entitlement = makeEntitlement('e1', 'i1', 100);
    const updates: number[] = [];
    const repo = {
      getLedgerByIdempotency: async () => ({ id: 'hold-1', entitlementId: 'e1' }),
      getOrCreateEntitlement: async () => entitlement,
      lockEntitlement: async () => entitlement,
      updateEntitlementAmounts: async (_client: unknown, _id: string, delta: { reserved: number }) => { updates.push(delta.reserved); return entitlement; },
      createLedger: async () => ({ id: 'hold-2' }),
    } as unknown as ComputeRepository;
    const pool = { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) } as unknown as Pool;
    const service = new QuotaService(pool, repo, {} as never);

    expect(await service.reserve('i1', 10, 'r1')).toEqual({ ledgerId: 'hold-1' });
    expect(updates).toEqual([]);
  });

  it('release：仅 pending 流水生效一次，重复释放不再扣减 reserved', async () => {
    const entitlement = makeEntitlement('e1', 'i1', 100);
    const updates: number[] = [];
    const states = [{ id: 'hold-1', status: 'pending', amount: 10 }];
    const repo = {
      lockLedger: async (_id: string) => states[0],
      lockEntitlement: async () => entitlement,
      updateEntitlementAmounts: async (_client: unknown, _id: string, delta: { reserved: number }) => { updates.push(delta.reserved); return entitlement; },
      updateLedgerStatus: async (_id: string, status: string) => { states[0].status = status; },
    } as unknown as ComputeRepository;
    const client = { query: async (statement: string) => (statement.includes('JOIN compute_entitlements') ? { rows: [{ identity_id: 'i1' }] } : { rows: [] }), release: () => {} };
    const pool = { connect: async () => client } as unknown as Pool;
    const service = new QuotaService(pool, repo, {} as never);

    await service.release('hold-1');
    await service.release('hold-1');
    expect(updates).toEqual([-10]);
  });

  it('releaseExpiredReserves：逐条释放超龄预扣，失败的记 syncLog 不中断', async () => {
    const entitlement = makeEntitlement('e1', 'i1', 100);
    const logs: Array<{ message: string }> = [];
    const repo = {
      listExpiredPendingReserves: async () => [{ id: 'l1', status: 'pending', amount: 10 }, { id: 'l2', status: 'pending', amount: 10 }],
      lockLedger: async (id: string) => (id === 'l2' ? Promise.reject(new Error('db down')) : { id, status: 'pending', amount: 10 }),
      lockEntitlement: async () => entitlement,
      updateEntitlementAmounts: async () => entitlement,
      updateLedgerStatus: async () => {},
      insertSyncLog: async (input: { message: string }) => { logs.push(input); },
    } as unknown as ComputeRepository;
    const client = { query: async (statement: string) => (statement.includes('JOIN compute_entitlements') ? { rows: [{ identity_id: 'i1' }] } : { rows: [] }), release: () => {} };
    const pool = { connect: async () => client } as unknown as Pool;
    const service = new QuotaService(pool, repo, {} as never);

    expect(await service.releaseExpiredReserves(600_000)).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toContain('l2');
  });

  it('releaseExpiredReserves：timeoutMs<=0 时关闭兜底', async () => {
    const repo = { listExpiredPendingReserves: async () => { throw new Error('不应查询'); } } as unknown as ComputeRepository;
    const service = new QuotaService({} as Pool, repo, {} as never);
    expect(await service.releaseExpiredReserves(0)).toBe(0);
  });
});

describe('QuotaService 上游余额对账补记（上游 → KLA）', () => {
  /**
   * bindings: 上游用户 ID → 余额（USD）；null 表示上游账号不存在，'error' 表示查询抛错。
   * 所有身份共用一个台账（netUsd 初始值可配），补记后模拟基准自愈（净额 += 补记额）。
   */
  function buildReconcileService(bindings: Record<string, number | null | 'error'>, netUsd = 0) {
    const ent = makeEntitlement('ent-r', 'identity-r', 0);
    const state = { netUsd, ledgers: [] as Array<{ operation: string; amount: number; synced: boolean; metadata: Record<string, unknown> }>, logs: [] as string[] };
    const repo = {
      getOrCreateEntitlement: async () => ent,
      lockEntitlement: async () => ent,
      updateEntitlementAmounts: async (_c: unknown, _id: string, delta: { total?: number }) => { ent.quotaTotal += delta.total ?? 0; return ent; },
      createLedger: async (input: { operation: string; amount: number; sub2apiSynced?: boolean; metadata?: Record<string, unknown> }) => {
        state.ledgers.push({ operation: input.operation, amount: input.amount, synced: input.sub2apiSynced === true, metadata: input.metadata ?? {} });
        state.netUsd += input.amount / 1000; // 默认汇率 1000 点/USD
        return { id: `led-${state.ledgers.length}` };
      },
      sumSyncedLedgerNet: async () => state.netUsd,
      insertSyncLog: async (input: { message: string }) => { state.logs.push(input.message); },
    } as unknown as ComputeRepository;
    const sub2api = {
      getUser: async (userId: string) => {
        if (bindings[userId] === 'error') throw new Error('upstream down');
        const balance = bindings[userId];
        if (balance == null) return null;
        return { id: userId, username: 'u', balance, status: 'active', allowedGroups: [], restrictPublicGroups: false };
      },
    };
    const rows = Object.keys(bindings).map((userId) => ({ identity_id: 'identity-r', sub2api_user_id: userId }));
    const pool = {
      query: async (statement: string) => (statement.includes('FROM compute_bindings') ? { rows } : { rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    } as unknown as Pool;
    const service = new QuotaService(pool, repo, sub2api as never);
    return { service, state, ent };
  }

  it('上游余额高于净额且超过阈值：补记充值流水并累加 total', async () => {
    const { service, state, ent } = buildReconcileService({ 'u-rich': 100 });
    const result = await service.reconcileUpstreamBalances();

    expect(result).toEqual({ checked: 1, recorded: 1 });
    expect(state.ledgers).toHaveLength(1);
    expect(state.ledgers[0]).toMatchObject({
      operation: 'recharge', amount: 100_000, synced: true,
      metadata: { source: 'upstream_reconciliation', upstreamUserId: 'u-rich', upstreamBalanceUsd: 100, klaNetUsd: 0 },
    });
    expect(ent.quotaTotal).toBe(100_000);
  });

  it('正差额但不超过阈值（≤100 积分）：不补记', async () => {
    const { service, state, ent } = buildReconcileService({ 'u-50': 0.05, 'u-100': 0.1 });
    const result = await service.reconcileUpstreamBalances();

    expect(result).toEqual({ checked: 2, recorded: 0 });
    expect(state.ledgers).toHaveLength(0);
    expect(ent.quotaTotal).toBe(0);
  });

  it('负差额（上游低于 KLA 已同步净额）：不补记', async () => {
    const { service, state } = buildReconcileService({ 'u-rich': 100 }, 500);
    const result = await service.reconcileUpstreamBalances();

    expect(result).toEqual({ checked: 1, recorded: 0 });
    expect(state.ledgers).toHaveLength(0);
  });

  it('补记后基准自愈：重跑不重复补记', async () => {
    const { service, state } = buildReconcileService({ 'u-rich': 100 });
    await service.reconcileUpstreamBalances();
    const second = await service.reconcileUpstreamBalances();

    expect(second.recorded).toBe(0);
    expect(state.ledgers).toHaveLength(1);
  });

  it('上游账号不存在或查询失败：跳过并记 sync_log，不阻断其他身份', async () => {
    const { service, state } = buildReconcileService({ 'u-rich': 100, 'u-err': 'error', 'u-gone': null });
    const result = await service.reconcileUpstreamBalances();

    expect(result).toEqual({ checked: 3, recorded: 1 });
    expect(state.ledgers).toHaveLength(1);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toContain('u-err');
  });
});
