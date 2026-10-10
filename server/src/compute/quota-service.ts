// 算力点台账：发放 / 分配 / 回收 / 预扣 / 释放 / 上游实际用量扣减。
// 所有变更走事务 + SELECT FOR UPDATE 行锁，保证并发安全。

import type { Pool } from 'pg';
import type { ComputeRepository, QueryClient } from './compute-repository.js';
import type { Sub2ApiClient } from './sub2api-client.js';
import { availableBalance, roundUsd } from './types.js';
import { createPointsConverter, type PointsConverter } from './points.js';
import { createHash } from 'node:crypto';
import type { Sub2ApiUsageItem } from './sub2api-client.js';

export class QuotaInsufficientError extends Error {
  constructor(public readonly available: number, public readonly requested: number) {
    super(`算力点不足：可用 ${available} 点，请求 ${requested} 点`);
    this.name = 'QuotaInsufficientError';
  }
}

export class QuotaService {
  constructor(
    private readonly pool: Pool,
    private readonly repo: ComputeRepository,
    private readonly sub2api: Sub2ApiClient,
    private readonly points: PointsConverter = createPointsConverter(),
  ) {}

  /** An upstream usage row is the only source of an actual model charge. */
  async recordUpstreamUsage(identityId: string, item: Sub2ApiUsageItem, keyId: string | null): Promise<boolean> {
    if (!Number.isFinite(item.amountUsd) || item.amountUsd < 0) throw new Error('Sub2API 用量金额无效');
    const amountPoints = this.points.fromUsd(item.amountUsd);
    const idempotencyKey = `sub2api-usage:${item.userId}:${item.id}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (await this.repo.getLedgerByIdempotency(idempotencyKey, client)) {
        await client.query('COMMIT');
        return false;
      }
      await this.repo.getOrCreateEntitlement({ identityId }, client);
      const entitlement = await this.repo.lockEntitlement(client, { identityId });
      if (await this.repo.getLedgerByIdempotency(idempotencyKey, client)) {
        await client.query('COMMIT');
        return false;
      }
      await client.query("SELECT set_config('kla.upstream_usage', 'on', true)");
      await this.repo.updateEntitlementAmounts(client, entitlement.id, { used: amountPoints });
      const ledger = await this.repo.createLedger({
        entitlementId: entitlement.id, operation: 'commit', amount: amountPoints,
        status: 'completed', idempotencyKey, requestId: item.requestId,
        metadata: { source: 'sub2api_usage', upstreamUsageId: item.id },
      }, client);
      const usage = await this.repo.upsertUsage({
        identityId, ledgerId: ledger.id, sub2apiUsageId: item.id, model: item.model,
        amountUsd: item.amountUsd, promptTokens: item.promptTokens,
        completionTokens: item.completionTokens,
        dedupeHash: createHash('sha256').update(idempotencyKey).digest('hex'),
        recordedAt: item.timestamp, keyId,
        metadata: { source: 'sub2api_usage', upstreamRequestId: item.requestId },
      }, client);
      if (!usage) throw new Error('Sub2API 用量与现有记录冲突');
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 发放额度（平台充值/运营发放，增加 quota_total） */
  async grant(owner: { identityId?: string; organizationId?: string }, amount: number, requestId: string): Promise<{ entitlementId: string; ledgerId: string }> {
    if (amount <= 0) throw new Error('发放金额必须大于 0');
    const idempotencyKey = `grant:${owner.identityId ?? owner.organizationId}:${requestId}`;
    const existing = await this.repo.getLedgerByIdempotency(idempotencyKey);
    if (existing) return { entitlementId: existing.entitlementId, ledgerId: existing.id };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ent = await this.repo.getOrCreateEntitlement(owner, client as unknown as QueryClient);
      const locked = await this.repo.lockEntitlement(client as unknown as QueryClient, owner);
      await this.repo.updateEntitlementAmounts(client as unknown as QueryClient, locked.id, { total: amount });
      const ledger = await this.repo.createLedger({
        entitlementId: ent.id,
        operation: 'grant',
        amount,
        status: 'completed',
        idempotencyKey,
        requestId,
        metadata: { source: 'platform_grant' },
      }, client as unknown as QueryClient);
      // 充值需同步到 Sub2API
      await this.syncBalanceToSub2Api(client as unknown as QueryClient, owner, amount);
      await client.query('COMMIT');
      return { entitlementId: ent.id, ledgerId: ledger.id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 分发额度（企业管理员 → 企业成员）。
   *
   * 业务口径（§4 企业额度）：
   * - 管理员的企业身份在 Sub2API 上的用户余额 = 企业池中尚未分发的部分；
   * - 分发 = 管理员 Sub2API 用户 -amount、成员 Sub2API 用户 +amount，KLA 台账两侧各落一条流水；
   * - 企业池总额 = 管理员持有 + 全部成员持有，分发前后不变。
   *
   * KLA 台账是唯一事实源：DB 事务先落账，Sub2API 转账失败仅置 sub2api_synced=false 并写 sync_log，
   * 由后续对账补偿（上游不可用时也不阻断台账）。
   */
  async allocate(
    adminIdentityId: string,
    orgId: string,
    memberIdentityId: string,
    amount: number,
    requestId: string,
  ): Promise<{ ledgerId: string; counterpartyLedgerId: string; sub2apiSynced: boolean }> {
    if (amount <= 0) throw new Error('分配金额必须大于 0');
    if (adminIdentityId === memberIdentityId) throw new Error('不能向管理员本人分发额度');
    const outKey = `allocate:out:${orgId}:${requestId}`;
    const inKey = `allocate:in:${orgId}:${requestId}`;
    const existing = await this.repo.getLedgerByIdempotency(outKey);
    if (existing) {
      return { ledgerId: existing.id, counterpartyLedgerId: existing.relatedLedgerId ?? existing.id, sub2apiSynced: existing.sub2apiSynced };
    }

    const client = await this.pool.connect();
    let adminLedgerId = '';
    let memberLedgerId = '';
    try {
      await client.query('BEGIN');
      await this.repo.getOrCreateEntitlement({ identityId: adminIdentityId }, client);
      await this.repo.getOrCreateEntitlement({ identityId: memberIdentityId }, client);
      const adminEnt = await this.repo.lockEntitlement(client, { identityId: adminIdentityId });
      if (availableBalance(adminEnt) < amount) {
        throw new QuotaInsufficientError(availableBalance(adminEnt), amount);
      }
      const memberEnt = await this.repo.lockEntitlement(client, { identityId: memberIdentityId });
      await this.repo.updateEntitlementAmounts(client, adminEnt.id, { total: -amount });
      await this.repo.updateEntitlementAmounts(client, memberEnt.id, { total: amount });
      const adminLedger = await this.repo.createLedger({
        entitlementId: adminEnt.id,
        operation: 'allocate',
        amount,
        status: 'completed',
        idempotencyKey: outKey,
        requestId,
        operatorIdentityId: adminIdentityId,
        metadata: { direction: 'out', organizationId: orgId, counterpartyIdentityId: memberIdentityId },
      }, client);
      const memberLedger = await this.repo.createLedger({
        entitlementId: memberEnt.id,
        operation: 'allocate',
        amount,
        status: 'completed',
        idempotencyKey: inKey,
        requestId,
        operatorIdentityId: adminIdentityId,
        relatedLedgerId: adminLedger.id,
        metadata: { direction: 'in', organizationId: orgId, counterpartyIdentityId: adminIdentityId },
      }, client);
      adminLedgerId = adminLedger.id;
      memberLedgerId = memberLedger.id;
      await client.query(
        'UPDATE compute_allocation_ledger SET related_ledger_id = $2 WHERE id = $1',
        [adminLedgerId, memberLedgerId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const synced = await this.transferSub2apiBalances(
      adminIdentityId, memberIdentityId, -this.points.toUsd(amount), this.points.toUsd(amount), requestId, 'allocate', orgId,
    );
    if (synced) {
      await Promise.all([
        this.repo.updateLedgerStatus(adminLedgerId, 'completed', true),
        this.repo.updateLedgerStatus(memberLedgerId, 'completed', true),
      ]);
    }
    return { ledgerId: adminLedgerId, counterpartyLedgerId: memberLedgerId, sub2apiSynced: synced };
  }

  /**
   * 回收额度（企业成员 → 企业管理员）：allocate 的逆向。
   * 已消耗（quota_used）/预扣中的额度不可回收。
   */
  async reclaim(
    adminIdentityId: string,
    orgId: string,
    memberIdentityId: string,
    amount: number,
    requestId: string,
  ): Promise<{ ledgerId: string; counterpartyLedgerId: string; sub2apiSynced: boolean }> {
    if (amount <= 0) throw new Error('回收金额必须大于 0');
    if (adminIdentityId === memberIdentityId) throw new Error('不能从管理员本人回收额度');
    const outKey = `reclaim:out:${orgId}:${requestId}`;
    const inKey = `reclaim:in:${orgId}:${requestId}`;
    const existing = await this.repo.getLedgerByIdempotency(outKey);
    if (existing) {
      return { ledgerId: existing.id, counterpartyLedgerId: existing.relatedLedgerId ?? existing.id, sub2apiSynced: existing.sub2apiSynced };
    }

    const client = await this.pool.connect();
    let memberLedgerId = '';
    let adminLedgerId = '';
    try {
      await client.query('BEGIN');
      await this.repo.getOrCreateEntitlement({ identityId: memberIdentityId }, client);
      await this.repo.getOrCreateEntitlement({ identityId: adminIdentityId }, client);
      const memberEnt = await this.repo.lockEntitlement(client, { identityId: memberIdentityId });
      const reclaimable = availableBalance(memberEnt);
      if (reclaimable < amount) {
        throw new QuotaInsufficientError(reclaimable, amount);
      }
      const adminEnt = await this.repo.lockEntitlement(client, { identityId: adminIdentityId });
      await this.repo.updateEntitlementAmounts(client, memberEnt.id, { total: -amount });
      await this.repo.updateEntitlementAmounts(client, adminEnt.id, { total: amount });
      const memberLedger = await this.repo.createLedger({
        entitlementId: memberEnt.id,
        operation: 'reclaim',
        amount,
        status: 'completed',
        idempotencyKey: outKey,
        requestId,
        operatorIdentityId: adminIdentityId,
        metadata: { direction: 'out', organizationId: orgId, counterpartyIdentityId: adminIdentityId },
      }, client);
      const adminLedger = await this.repo.createLedger({
        entitlementId: adminEnt.id,
        operation: 'reclaim',
        amount,
        status: 'completed',
        idempotencyKey: inKey,
        requestId,
        operatorIdentityId: adminIdentityId,
        relatedLedgerId: memberLedger.id,
        metadata: { direction: 'in', organizationId: orgId, counterpartyIdentityId: memberIdentityId },
      }, client);
      memberLedgerId = memberLedger.id;
      adminLedgerId = adminLedger.id;
      await client.query(
        'UPDATE compute_allocation_ledger SET related_ledger_id = $2 WHERE id = $1',
        [memberLedgerId, adminLedgerId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const synced = await this.transferSub2apiBalances(
      memberIdentityId, adminIdentityId, -this.points.toUsd(amount), this.points.toUsd(amount), requestId, 'reclaim', orgId,
    );
    if (synced) {
      await Promise.all([
        this.repo.updateLedgerStatus(memberLedgerId, 'completed', true),
        this.repo.updateLedgerStatus(adminLedgerId, 'completed', true),
      ]);
    }
    return { ledgerId: adminLedgerId, counterpartyLedgerId: memberLedgerId, sub2apiSynced: synced };
  }

  /**
   * Sub2API 侧余额转账：from -delta、to +delta。
   * 任一方未建号或调用失败均返回 false（台账已落，等待对账补偿），不抛异常影响主流程。
   */
  private async transferSub2apiBalances(
    fromIdentityId: string,
    toIdentityId: string,
    fromDelta: number,
    toDelta: number,
    requestId: string,
    operation: 'allocate' | 'reclaim',
    orgId: string,
  ): Promise<boolean> {
    const [fromBinding, toBinding] = await Promise.all([
      this.repo.getBinding(fromIdentityId),
      this.repo.getBinding(toIdentityId),
    ]);
    if (!fromBinding?.sub2apiUserId || !toBinding?.sub2apiUserId) {
      await this.repo.insertSyncLog({
        syncType: 'balance',
        organizationId: orgId,
        status: 'warning',
        message: `${operation} ${requestId}：存在未完成初始化的算力账号，Sub2API 余额转账延后到对账`,
      });
      return false;
    }
    try {
      await this.sub2api.adjustBalance(fromBinding.sub2apiUserId, fromDelta);
      await this.sub2api.adjustBalance(toBinding.sub2apiUserId, toDelta);
      return true;
    } catch (error) {
      await this.repo.insertSyncLog({
        syncType: 'balance',
        organizationId: orgId,
        message: `${operation} ${requestId}：Sub2API 余额转账失败（${error instanceof Error ? error.message : 'unknown'}），等待对账补偿`,
        status: 'error',
      });
      return false;
    }
  }

  /** 预扣额度（reserve，供 Model Gateway 在调用前调用） */
  async reserve(identityId: string, amount: number, requestId: string): Promise<{ ledgerId: string }> {
    if (amount <= 0) throw new Error('预扣金额必须大于 0');
    const idempotencyKey = `reserve:${identityId}:${requestId}`;
    const existing = await this.repo.getLedgerByIdempotency(idempotencyKey);
    if (existing) return { ledgerId: existing.id };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.repo.getOrCreateEntitlement({ identityId }, client as unknown as QueryClient);
      const ent = await this.repo.lockEntitlement(client as unknown as QueryClient, { identityId });
      const available = availableBalance(ent);
      if (available <= 0) throw new QuotaInsufficientError(available, amount);
      // This is a concurrency hold, not the charge. Sub2API enforces the real
      // balance, so a small positive balance must not fail a larger fixed hold.
      const reserved = Math.min(amount, available);
      await this.repo.updateEntitlementAmounts(client as unknown as QueryClient, ent.id, { reserved });
      const ledger = await this.repo.createLedger({
        entitlementId: ent.id,
        operation: 'reserve',
        amount: reserved,
        status: 'pending',
        idempotencyKey,
        requestId,
      }, client as unknown as QueryClient);
      await client.query('COMMIT');
      return { ledgerId: ledger.id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 释放预扣（release，调用失败时调用） */
  async release(ledgerId: string, amount?: number): Promise<void> {
    const ledger = await this.repo.getLedger(ledgerId);
    if (!ledger) throw new Error('流水不存在');
    if (ledger.status !== 'pending') return;

    const releaseAmount = amount ?? ledger.amount;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ent = await this.repo.lockEntitlement(client as unknown as QueryClient, { identityId: await this.identityIdByLedger(client, ledgerId) });
      await this.repo.updateEntitlementAmounts(client as unknown as QueryClient, ent.id, { reserved: -releaseAmount });
      await this.repo.updateLedgerStatus(ledgerId, 'released', undefined, client as unknown as QueryClient);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 发放额度时同步本次增量；Sub2API 的余额接口不是设置绝对值。 */
  private async syncBalanceToSub2Api(client: QueryClient, owner: { identityId?: string; organizationId?: string }, delta: number): Promise<void> {
    if (!owner.identityId) return; // 企业池不同步到 Sub2API
    const binding = await this.repo.getBinding(owner.identityId, client);
    if (!binding || !binding.sub2apiUserId) return;
    try {
      await this.sub2api.adjustBalance(binding.sub2apiUserId, this.points.toUsd(delta));
    } catch (error) {
      // 同步失败仅记录，不影响主事务；后续由对账/重试修复
      await this.repo.insertSyncLog({
        syncType: 'balance',
        identityId: owner.identityId,
        status: 'error',
        message: error instanceof Error ? error.message : 'Sub2API 余额同步失败',
      }, client);
    }
  }

  /**
   * Sub2API → KLA 余额对账：上游直接充值后，把差额补进 KLA 台账。
   *
   * 方向约束：仅当 Sub2API 实际余额 > KLA 已同步到上游的预期余额时才补记（充值方向）。
   * 绝不从 KLA 扣减（KLA → Sub2API 的方向由 grant/allocate/reclaim 负责）。
   *
   * 防幽灵充值：用「已同步流水净额」而非 KLA 可用余额作为对比基准。
   * 若某笔 grant 在 KLA 台账存在但未真正推送到 Sub2API（如手动 SQL 误设 synced=true），
   * 它会被计入预期余额，从而避免把「KLA 多记」误判为「上游充值」。
   *
   * 幂等：idempotency_key 包含按百位取整的 Sub2API 积分余额，
   * 同一上游余额不会重复入账；余额变化（再次充值）会生成新流水。
   *
   * 阈值：漂移需超过 100 积分（$0.01）才入账，避免浮点/舍入噪声产生幽灵流水。
   * 失败不抛异常，仅记日志，不阻塞余额查询。
   */
  async reconcileBalanceFromSub2api(identityId: string): Promise<{ driftPoints: number; applied: boolean }> {
    const THRESHOLD_POINTS = 100; // $0.01
    const binding = await this.repo.getBinding(identityId);
    if (!binding?.sub2apiUserId) return { driftPoints: 0, applied: false };

    let sub2apiUsd: number;
    try {
      const user = await this.sub2api.getUser(binding.sub2apiUserId);
      if (!user) return { driftPoints: 0, applied: false };
      sub2apiUsd = user.balance;
    } catch {
      return { driftPoints: 0, applied: false };
    }

    // 用已同步流水净额作为 KLA 在 Sub2API 的预期余额，而非 KLA 可用余额。
    // 这样未真正同步到上游的 grant 不会制造虚假漂移。
    const entitlement = await this.repo.getEntitlement({ identityId });
    if (!entitlement) return { driftPoints: 0, applied: false };
    const expectedUsd = await this.repo.getSyncedSub2ApiBalanceUsd(entitlement.id);
    const driftUsd = sub2apiUsd - expectedUsd;
    const driftPoints = Math.round(driftUsd * this.points.pointsPerUsd * 1000) / 1000;
    if (driftPoints <= THRESHOLD_POINTS) return { driftPoints, applied: false };

    // 按百位取整上游余额作为幂等键，避免同余额重复入账
    const sub2apiPoints = Math.round(sub2apiUsd * this.points.pointsPerUsd);
    const roundedSub2api = Math.round(sub2apiPoints / 100) * 100;
    const idempotencyKey = `sub2api-recharge:${identityId}:${roundedSub2api}`;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (await this.repo.getLedgerByIdempotency(idempotencyKey, client)) {
        await client.query('COMMIT');
        return { driftPoints, applied: false };
      }
      const ent = await this.repo.lockEntitlement(client, { identityId });
      await this.repo.updateEntitlementAmounts(client, ent.id, { total: driftPoints });
      await this.repo.createLedger({
        entitlementId: ent.id,
        operation: 'recharge',
        amount: driftPoints,
        status: 'completed',
        idempotencyKey,
        requestId: `balance-sync:${roundedSub2api}`,
        metadata: { source: 'sub2api_reconcile', sub2apiBalanceUsd: roundUsd(sub2apiUsd), sub2apiUserId: binding.sub2apiUserId },
      }, client);
      await client.query('COMMIT');
      return { driftPoints, applied: true };
    } catch (error) {
      await client.query('ROLLBACK');
      await this.repo.insertSyncLog({
        syncType: 'balance',
        identityId,
        status: 'error',
        message: `Sub2API→KLA 余额对账失败：${error instanceof Error ? error.message : 'unknown'}`,
      });
      return { driftPoints, applied: false };
    } finally {
      client.release();
    }
  }

  private async identityIdByLedger(client: QueryClient, ledgerId: string): Promise<string> {
    const { rows } = await client.query(
      'SELECT e.identity_id FROM compute_allocation_ledger l JOIN compute_entitlements e ON e.id = l.entitlement_id WHERE l.id = $1',
      [ledgerId],
    );
    if (!rows[0]?.identity_id) throw new Error('流水对应的身份不存在');
    return rows[0].identity_id as string;
  }

}
