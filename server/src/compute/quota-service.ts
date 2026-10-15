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

/** 余额对账补记阈值（积分）：净额差额不超过该值视为换算/时序噪声，不补记 */
const BALANCE_RECONCILE_THRESHOLD_POINTS = 100;

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
        // 上游 duration_ms / 缓存 token 是延迟回填的：首次入账时可能读到空值，
        // 幂等命中时顺手补齐展示指标，下一轮同步（≤60s）自愈，无需独立回填任务
        await this.repo.refreshUsageMetrics(client, {
          identityId, sub2apiUsageId: item.id,
          latencyMs: item.durationMs,
          cacheCreationTokens: item.cacheCreationTokens,
          cacheReadTokens: item.cacheReadTokens,
        });
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
        // 扣减的扣费源自上游用量明细（已在上游生效），无需再推送
        sub2apiSynced: true,
        metadata: { source: 'sub2api_usage', upstreamUsageId: item.id },
      }, client);
      const usage = await this.repo.upsertUsage({
        identityId, ledgerId: ledger.id, sub2apiUsageId: item.id, model: item.model,
        amountUsd: item.amountUsd, promptTokens: item.promptTokens,
        completionTokens: item.completionTokens,
        cacheCreationTokens: item.cacheCreationTokens, cacheReadTokens: item.cacheReadTokens,
        // 成功记录的耗时以上游计费明细的 duration_ms 为准（上游端到端口径）
        latencyMs: item.durationMs,
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

  /**
   * 预扣额度（reserve，供 Model Gateway 在调用前调用）。
   * 先锁额度行再复查幂等：并发同 requestId 只预扣一次，避免双倍占位。
   */
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
      const dup = await this.repo.getLedgerByIdempotency(idempotencyKey, client as unknown as QueryClient);
      if (dup) {
        await client.query('COMMIT');
        return { ledgerId: dup.id };
      }
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
        // 预扣是本地占位，不推送上游，不存在同步概念
        sub2apiSynced: true,
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

  /**
   * 释放预扣（release，调用结算时调用）。
   * 事务内锁定流水行并复查状态：重复/并发释放只生效一次，防止 reserved 被减成负数。
   */
  async release(ledgerId: string, amount?: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ledger = await this.repo.lockLedger(ledgerId, client as unknown as QueryClient);
      if (!ledger || ledger.status !== 'pending') {
        await client.query('ROLLBACK');
        return;
      }
      const releaseAmount = amount ?? ledger.amount;
      const ent = await this.repo.lockEntitlement(client as unknown as QueryClient, { identityId: await this.identityIdByLedger(client as unknown as QueryClient, ledgerId) });
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
   * 兜底：释放超龄仍未结算的预扣流水（进程异常终止、释放失败等残留），
   * 保证可用余额自愈，不依赖调用方一定走到 release。
   */
  async releaseExpiredReserves(timeoutMs: number, limit = 200): Promise<number> {
    if (timeoutMs <= 0) return 0;
    const expired = await this.repo.listExpiredPendingReserves(timeoutMs, limit);
    let released = 0;
    for (const ledger of expired) {
      try {
        await this.release(ledger.id);
        released += 1;
      } catch (error) {
        await this.repo.insertSyncLog({
          syncType: 'balance', identityId: null, status: 'error',
          message: `释放超龄预扣失败 ledger=${ledger.id}：${error instanceof Error ? error.message : 'unknown'}`,
        });
      }
    }
    return released;
  }

  private async identityIdByLedger(client: QueryClient, ledgerId: string): Promise<string> {
    const { rows } = await client.query(
      'SELECT e.identity_id FROM compute_allocation_ledger l JOIN compute_entitlements e ON e.id = l.entitlement_id WHERE l.id = $1',
      [ledgerId],
    );
    if (!rows[0]?.identity_id) throw new Error('流水对应的身份不存在');
    return rows[0].identity_id as string;
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
      // 充值需同步到 Sub2API；同步失败仅记 sync_log，流水保持待同步
      const synced = await this.syncBalanceToSub2Api(client as unknown as QueryClient, owner, amount);
      if (!synced) await this.repo.updateLedgerStatus(ledger.id, 'completed', false, client as unknown as QueryClient);
      await client.query('COMMIT');
      return { entitlementId: ent.id, ledgerId: ledger.id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 平台收回额度，只允许从指定身份的可用余额中扣减。 */
  async revoke(owner: { identityId?: string; organizationId?: string }, amount: number, requestId: string): Promise<{ entitlementId: string; ledgerId: string; sub2apiSynced: boolean }> {
    if (amount <= 0) throw new Error('收回金额必须大于 0');
    const idempotencyKey = `revoke:${owner.identityId ?? owner.organizationId}:${requestId}`;
    const existing = await this.repo.getLedgerByIdempotency(idempotencyKey);
    if (existing) return { entitlementId: existing.entitlementId, ledgerId: existing.id, sub2apiSynced: existing.sub2apiSynced };

    const client = await this.pool.connect();
    let entitlementId = '';
    let ledgerId = '';
    let synced = false;
    try {
      await client.query('BEGIN');
      const ent = await this.repo.getOrCreateEntitlement(owner, client as unknown as QueryClient);
      const locked = await this.repo.lockEntitlement(client as unknown as QueryClient, owner);
      const available = availableBalance(locked);
      if (available < amount) throw new QuotaInsufficientError(available, amount);
      await this.repo.updateEntitlementAmounts(client as unknown as QueryClient, locked.id, { total: -amount });
      const ledger = await this.repo.createLedger({
        entitlementId: ent.id,
        operation: 'revoke',
        amount,
        status: 'completed',
        idempotencyKey,
        requestId,
        metadata: { source: 'platform_revoke' },
      }, client as unknown as QueryClient);
      entitlementId = ent.id;
      ledgerId = ledger.id;
      await client.query('COMMIT');
      synced = await this.syncBalanceToSub2Api(client as unknown as QueryClient, owner, -amount);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (synced) await this.repo.updateLedgerStatus(ledgerId, 'completed', true);
    return { entitlementId, ledgerId, sub2apiSynced: synced };
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

  /** 发放额度时同步本次增量；Sub2API 的余额接口不是设置绝对值。 */
  private async syncBalanceToSub2Api(client: QueryClient, owner: { identityId?: string; organizationId?: string }, delta: number): Promise<boolean> {
    if (!owner.identityId) return false; // 企业池不同步到 Sub2API
    const binding = await this.repo.getBinding(owner.identityId, client);
    if (!binding || !binding.sub2apiUserId) return false;
    try {
      await this.sub2api.adjustBalance(binding.sub2apiUserId, this.points.toUsd(delta));
      return true;
    } catch (error) {
      // 同步失败仅记录，不影响主事务；后续由对账/重试修复
      await this.repo.insertSyncLog({
        syncType: 'balance',
        identityId: owner.identityId,
        status: 'error',
        message: error instanceof Error ? error.message : 'Sub2API 余额同步失败',
      }, client);
      return false;
    }
  }

  // ==================== 上游余额对账（双向同步：上游 → KLA） ====================

  /**
   * 余额对账：对每个已绑定身份，比对 Sub2API 侧实际余额与 KLA 已同步流水净额。
   * 上游余额高于净额（如直接在上游管理面充值、注册赠送）时补记充值流水，实现两边同步；
   * 负差额不处理：用量部分由用量同步追平，KLA 多记的部分保持台账原样（上游是消费事实源）。
   * 基准在补记后自愈，周期执行天然幂等。
   */
  async reconcileUpstreamBalances(opts: { thresholdPoints?: number } = {}): Promise<{ checked: number; recorded: number }> {
    const thresholdPoints = opts.thresholdPoints ?? BALANCE_RECONCILE_THRESHOLD_POINTS;
    const { rows } = await this.pool.query<{ identity_id: string; sub2api_user_id: string }>(
      "SELECT identity_id, sub2api_user_id FROM compute_bindings WHERE sub2api_user_id IS NOT NULL AND sub2api_status = 'ready'",
    );
    let recorded = 0;
    for (const row of rows) {
      try {
        const upstream = await this.sub2api.getUser(row.sub2api_user_id);
        if (!upstream) continue; // 上游账号不存在（环境重置/已删除）：等待重新建号，不做本地推断
        if (await this.recordUpstreamRecharge(row.identity_id, row.sub2api_user_id, upstream.balance, thresholdPoints)) recorded += 1;
      } catch (error) {
        await this.repo.insertSyncLog({
          syncType: 'balance', identityId: row.identity_id, status: 'error',
          message: `余额对账失败（上游用户 ${row.sub2api_user_id}）：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { checked: rows.length, recorded };
  }

  /**
   * 单身份余额补记：事务内锁定台账行后重读净额（与并发对账/用量落库串行化，防双倍补记），
   * 正向差额超过阈值才落一条 recharge 流水（差额源自上游实际余额，补记即视为已在上游生效）。
   */
  private async recordUpstreamRecharge(identityId: string, sub2apiUserId: string, upstreamBalanceUsd: number, thresholdPoints: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.repo.getOrCreateEntitlement({ identityId }, client);
      const ent = await this.repo.lockEntitlement(client, { identityId });
      const klaNetUsd = await this.repo.sumSyncedLedgerNet(identityId, client);
      const deltaUsd = roundUsd(upstreamBalanceUsd - klaNetUsd);
      const amountPoints = deltaUsd > 0 ? this.points.fromUsd(deltaUsd) : 0;
      if (amountPoints <= thresholdPoints) {
        await client.query('COMMIT');
        return false;
      }
      await this.repo.updateEntitlementAmounts(client, ent.id, { total: amountPoints });
      const at = new Date().toISOString();
      await this.repo.createLedger({
        entitlementId: ent.id,
        operation: 'recharge',
        amount: amountPoints,
        status: 'completed',
        idempotencyKey: `upstream-recharge:${sub2apiUserId}:${at}`,
        requestId: `upstream-reconcile:${at}`,
        sub2apiSynced: true,
        metadata: { source: 'upstream_reconciliation', upstreamUserId: sub2apiUserId, upstreamBalanceUsd, klaNetUsd },
      }, client);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

}
