// 额度台账：发放 / 分配 / 回收 / 预扣 / 扣减 / 释放
// 所有变更走事务 + SELECT FOR UPDATE 行锁，保证并发安全。
// commit 后异步同步余额到 Sub2API（通过 Outbox 事件）。
//
// 口径（P1-11 / docs/DESIGN_POINTS_BASED_BILLING.md §5）：
// - 本服务全部以"算力点"为权威口径（1 USD = 1000 点，换算收敛在 points.ts）；
// - 流水双写：amount_points/rate_snapshot 权威 + amount（USD 影子，pointsToUsd 换算）；
// - Sub2API 余额同步/转账按 USD：toUsd(points)；上游用量回流按 USD：fromUsd(usd)。

import type { Pool } from 'pg';
import type { PointsConverter } from './points.js';
import type { ComputeRepository, QueryClient } from './compute-repository.js';
import type { Sub2ApiClient } from './sub2api-client.js';
import { availableBalance } from './types.js';

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
    /** 算力点换算器（P1-11）：points↔USD 的唯一入口 */
    private readonly points: PointsConverter,
  ) {}

  /** 发放额度（平台充值/运营发放，增加 points_total）；入参为算力点。 */
  async grant(owner: { identityId?: string; organizationId?: string }, amountPoints: number, requestId: string): Promise<{ entitlementId: string; ledgerId: string }> {
    if (amountPoints <= 0) throw new Error('发放额度必须大于 0');
    const idempotencyKey = `grant:${owner.identityId ?? owner.organizationId}:${requestId}`;
    const existing = await this.repo.getLedgerByIdempotency(idempotencyKey);
    if (existing) return { entitlementId: existing.entitlementId, ledgerId: existing.id };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ent = await this.repo.getOrCreateEntitlement(owner, client as unknown as QueryClient);
      const locked = await this.repo.lockEntitlement(client as unknown as QueryClient, owner);
      await this.repo.updateEntitlementAmounts(client as unknown as QueryClient, locked.id, { total: amountPoints });
      const ledger = await this.repo.createLedger({
        entitlementId: ent.id,
        operation: 'grant',
        amountPoints,
        rateSnapshot: this.points.pointsPerUsd,
        status: 'completed',
        idempotencyKey,
        requestId,
        metadata: { source: 'platform_grant' },
      }, client as unknown as QueryClient);
      // 充值需同步到 Sub2API
      await this.syncBalanceToSub2Api(client as unknown as QueryClient, ent.id, owner);
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
   * 分发额度（企业管理员 → 企业成员），入参为算力点。
   *
   * 业务口径（§4 企业额度）：
   * - 管理员的企业身份在 Sub2API 上的用户余额 = 企业池中尚未分发的部分；
   * - 分发 = 管理员 Sub2API 用户 -amount、成员 Sub2API 用户 +amount（USD 影子口径），
   *   KLA 台账两侧各落一条算力点流水；
   * - 企业池总额 = 管理员持有 + 全部成员持有，分发前后不变。
   *
   * KLA 台账是唯一事实源：DB 事务先落账，Sub2API 转账失败仅置 sub2api_synced=false 并写 sync_log，
   * 由后续对账补偿（上游不可用时也不阻断台账）。
   */
  async allocate(
    adminIdentityId: string,
    orgId: string,
    memberIdentityId: string,
    amountPoints: number,
    requestId: string,
  ): Promise<{ ledgerId: string; counterpartyLedgerId: string; sub2apiSynced: boolean }> {
    if (amountPoints <= 0) throw new Error('分配额度必须大于 0');
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
      if (availableBalance(adminEnt) < amountPoints) {
        throw new QuotaInsufficientError(availableBalance(adminEnt), amountPoints);
      }
      const memberEnt = await this.repo.lockEntitlement(client, { identityId: memberIdentityId });
      await this.repo.updateEntitlementAmounts(client, adminEnt.id, { total: -amountPoints });
      await this.repo.updateEntitlementAmounts(client, memberEnt.id, { total: amountPoints });
      const adminLedger = await this.repo.createLedger({
        entitlementId: adminEnt.id,
        operation: 'allocate',
        amountPoints,
        rateSnapshot: this.points.pointsPerUsd,
        status: 'completed',
        idempotencyKey: outKey,
        requestId,
        operatorIdentityId: adminIdentityId,
        metadata: { direction: 'out', organizationId: orgId, counterpartyIdentityId: memberIdentityId },
      }, client);
      const memberLedger = await this.repo.createLedger({
        entitlementId: memberEnt.id,
        operation: 'allocate',
        amountPoints,
        rateSnapshot: this.points.pointsPerUsd,
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
      adminIdentityId, memberIdentityId, -amountPoints, amountPoints, requestId, 'allocate', orgId,
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
   * 回收额度（企业成员 → 企业管理员），allocate 的逆向；入参为算力点。
   * 已消耗（points_used）/预扣中的额度不可回收。
   */
  async reclaim(
    adminIdentityId: string,
    orgId: string,
    memberIdentityId: string,
    amountPoints: number,
    requestId: string,
  ): Promise<{ ledgerId: string; counterpartyLedgerId: string; sub2apiSynced: boolean }> {
    if (amountPoints <= 0) throw new Error('回收额度必须大于 0');
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
      if (reclaimable < amountPoints) {
        throw new QuotaInsufficientError(reclaimable, amountPoints);
      }
      const adminEnt = await this.repo.lockEntitlement(client, { identityId: adminIdentityId });
      await this.repo.updateEntitlementAmounts(client, memberEnt.id, { total: -amountPoints });
      await this.repo.updateEntitlementAmounts(client, adminEnt.id, { total: amountPoints });
      const memberLedger = await this.repo.createLedger({
        entitlementId: memberEnt.id,
        operation: 'reclaim',
        amountPoints,
        rateSnapshot: this.points.pointsPerUsd,
        status: 'completed',
        idempotencyKey: outKey,
        requestId,
        operatorIdentityId: adminIdentityId,
        metadata: { direction: 'out', organizationId: orgId, counterpartyIdentityId: adminIdentityId },
      }, client);
      const adminLedger = await this.repo.createLedger({
        entitlementId: adminEnt.id,
        operation: 'reclaim',
        amountPoints,
        rateSnapshot: this.points.pointsPerUsd,
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
      memberIdentityId, adminIdentityId, -amountPoints, amountPoints, requestId, 'reclaim', orgId,
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
   * Sub2API 侧余额转账：from -delta、to +delta（入参为算力点，内部换算 USD）。
   * 任一方未建号或调用失败均返回 false（台账已落，等待对账补偿），不抛异常影响主流程。
   */
  private async transferSub2apiBalances(
    fromIdentityId: string,
    toIdentityId: string,
    fromDeltaPoints: number,
    toDeltaPoints: number,
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
    // 共享上游账号模式下双方映射到同一账号，转账无意义（净零），跳过并告警。
    if (fromBinding.sub2apiUserId === toBinding.sub2apiUserId) {
      await this.repo.insertSyncLog({
        syncType: 'balance',
        organizationId: orgId,
        status: 'warning',
        message: `${operation} ${requestId}：双方映射到同一 Sub2API 账号（${fromBinding.sub2apiUserId}），跳过转账，需切换为每身份独立账号模式`,
      });
      return false;
    }
    try {
      await this.sub2api.adjustBalance(fromBinding.sub2apiUserId, this.points.toUsd(fromDeltaPoints));
      await this.sub2api.adjustBalance(toBinding.sub2apiUserId, this.points.toUsd(toDeltaPoints));
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

  /** 预扣额度（reserve，供 Model Gateway / 工具网关在调用前调用）；入参为算力点。 */
  async reserve(identityId: string, amountPoints: number, requestId: string): Promise<{ ledgerId: string }> {
    if (amountPoints <= 0) throw new Error('预扣额度必须大于 0');
    const idempotencyKey = `reserve:${identityId}:${requestId}`;
    const existing = await this.repo.getLedgerByIdempotency(idempotencyKey);
    if (existing) return { ledgerId: existing.id };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.repo.getOrCreateEntitlement({ identityId }, client as unknown as QueryClient);
      const ent = await this.repo.lockEntitlement(client as unknown as QueryClient, { identityId });
      if (availableBalance(ent) < amountPoints) {
        throw new QuotaInsufficientError(availableBalance(ent), amountPoints);
      }
      await this.repo.updateEntitlementAmounts(client as unknown as QueryClient, ent.id, { reserved: amountPoints });
      const ledger = await this.repo.createLedger({
        entitlementId: ent.id,
        operation: 'reserve',
        amountPoints,
        rateSnapshot: this.points.pointsPerUsd,
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

  /** 实际扣减（commit，收到用量后调用）；入参为算力点。 */
  async commit(ledgerId: string, amountPoints: number): Promise<void> {
    const ledger = await this.repo.getLedger(ledgerId);
    if (!ledger) throw new Error('流水不存在');
    if (ledger.status !== 'pending') return; // 幂等

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ent = await this.repo.lockEntitlement(client as unknown as QueryClient, { identityId: await this.identityIdByLedger(client, ledgerId) });
      // reserved → used：先释放预扣，再增加已用
      await this.repo.updateEntitlementAmounts(client as unknown as QueryClient, ent.id, { reserved: -this.pendingPointsOf(ledger), used: amountPoints });
      await this.repo.updateLedgerStatus(ledgerId, 'completed', false, client as unknown as QueryClient);
      // 同步到 Sub2API
      await this.syncBalanceToSub2Api(client as unknown as QueryClient, ent.id, { identityId: ent.identityId ?? undefined });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 释放预扣（release，调用失败时调用）；amount 为算力点，缺省释放全部预扣。 */
  async release(ledgerId: string, amountPoints?: number): Promise<void> {
    const ledger = await this.repo.getLedger(ledgerId);
    if (!ledger) throw new Error('流水不存在');
    if (ledger.status !== 'pending') return;

    const releaseAmount = amountPoints ?? this.pendingPointsOf(ledger);
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

  /**
   * 迁移期兜底：0013 时期产生的 pending 流水没有 amount_points（=0），
   * 用其 amount（USD 影子）按当前汇率回推；新流水始终有权威 points。
   */
  private pendingPointsOf(ledger: { amountPoints: number; amount: number }): number {
    return ledger.amountPoints > 0 ? ledger.amountPoints : this.points.fromUsd(ledger.amount);
  }

  /** 同步余额到 Sub2API（commit / grant 后调用）：KLA 可用点数 ÷ 汇率 → 上游 USD 余额。 */
  private async syncBalanceToSub2Api(client: QueryClient, entitlementId: string, owner: { identityId?: string; organizationId?: string }): Promise<void> {
    if (!owner.identityId) return; // 企业池不同步到 Sub2API
    const binding = await this.repo.getBinding(owner.identityId, client);
    if (!binding || !binding.sub2apiUserId) return;
    try {
      const ent = await this.repo.getOrCreateEntitlement(owner, client);
      const balancePoints = availableBalance(ent);
      await this.sub2api.adjustBalance(binding.sub2apiUserId, this.points.toUsd(balancePoints));
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

  private async identityIdByLedger(client: QueryClient, ledgerId: string): Promise<string> {
    const { rows } = await client.query(
      'SELECT e.identity_id FROM compute_allocation_ledger l JOIN compute_entitlements e ON e.id = l.entitlement_id WHERE l.id = $1',
      [ledgerId],
    );
    if (!rows[0]?.identity_id) throw new Error('流水对应的身份不存在');
    return rows[0].identity_id as string;
  }

  /**
   * 从 Sub2API 拉取实时余额，回写到 KLA 台账（正向漂移视为上游充值，按当前汇率换算为算力点补记）。
   * 仅处理正向漂移（上游余额 > KLA 应有余额），负向漂移只记日志不改台账。
   */
  async reconcileBalanceFromSub2api(identityId: string): Promise<{ synced: boolean; driftPoints: number; sub2apiBalance: number; klaAvailablePoints: number }> {
    const binding = await this.repo.getBinding(identityId);
    if (!binding || !binding.sub2apiUserId) {
      return { synced: false, driftPoints: 0, sub2apiBalance: 0, klaAvailablePoints: 0 };
    }
    let sub2apiBalance = 0;
    try {
      const user = await this.sub2api.getUser(binding.sub2apiUserId);
      sub2apiBalance = user?.balance ?? 0;
    } catch (error) {
      await this.repo.insertSyncLog({
        syncType: 'balance', identityId, status: 'error',
        message: error instanceof Error ? error.message : 'Sub2API 余额查询失败',
      });
      return { synced: false, driftPoints: 0, sub2apiBalance: 0, klaAvailablePoints: 0 };
    }

    const owner = { identityId };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ent = await this.repo.getOrCreateEntitlement(owner, client as unknown as QueryClient);
      const klaAvailablePoints = availableBalance(ent);
      const driftUsd = Math.round((sub2apiBalance - this.points.toUsd(klaAvailablePoints)) * 1e8) / 1e8;
      const driftPoints = this.points.fromUsd(Math.max(driftUsd, 0));

      if (driftPoints > 0) {
        // 上游余额多于 KLA 应有余额 → 视为充值，按当前汇率换算成算力点补记到 points_total
        const idempotencyKey = `reconcile_recharge:${identityId}:${sub2apiBalance}`;
        const existing = await this.repo.getLedgerByIdempotency(idempotencyKey, client as unknown as QueryClient);
        if (!existing) {
          await this.repo.updateEntitlementAmounts(client as unknown as QueryClient, ent.id, { total: driftPoints });
          await this.repo.createLedger({
            entitlementId: ent.id, operation: 'recharge',
            amountPoints: driftPoints, rateSnapshot: this.points.pointsPerUsd,
            // 上游漂移是真实 USD 事件，影子口径直接采用实测值而不是 pointsToUsd 回算
            amountUsd: driftPoints > 0 ? sub2apiBalance - this.points.toUsd(klaAvailablePoints) : 0,
            status: 'completed',
            idempotencyKey, requestId: `reconcile-${Date.now()}`, operatorIdentityId: identityId,
            metadata: { source: 'sub2api_reconciliation', sub2apiBalance, klaAvailablePoints },
          }, client as unknown as QueryClient);
        }
        await this.repo.insertSyncLog({
          syncType: 'balance', identityId, klaAmount: klaAvailablePoints, sub2apiAmount: sub2apiBalance,
          driftUsd, status: 'ok', message: `检测到上游充值 ${driftUsd} USD，已换算为 ${driftPoints} 点同步到台账`,
        }, client);
        await client.query('COMMIT');
        return { synced: true, driftPoints, sub2apiBalance, klaAvailablePoints };
      }

      // 负向漂移：只记日志，不改台账（避免误扣；用量漂移由用量对账处理）
      if (driftUsd < -0.0001) {
        await this.repo.insertSyncLog({
          syncType: 'balance', identityId, klaAmount: klaAvailablePoints, sub2apiAmount: sub2apiBalance,
          driftUsd, status: 'warning', message: `上游余额低于台账 ${-driftUsd} USD，等待用量对账`,
        }, client);
      }
      await client.query('COMMIT');
      return { synced: false, driftPoints: 0, sub2apiBalance, klaAvailablePoints };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
