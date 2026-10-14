// 算力模块数据访问层
// QueryClient = Pick<Pool, 'query'>，同时兼容 Pool 与 PoolClient。

import type { Pool } from 'pg';
import type {
  ComputeBinding,
  ComputeBindingStatus,
  ComputeKey,
  ComputeKeyStatus,
  ComputeUsage,
  Entitlement,
  AllocationLedger,
  LedgerOperation,
  LedgerStatus,
  ProvisionJob,
  ProvisionJobStatus,
  OutboxEvent,
  OutboxEventType,
  OutboxStatus,
  SyncLog,
  SyncLogType,
  SyncLogStatus,
  OrgMemberQuota,
} from './types.js';
import { createPointsConverter, type PointsConverter } from './points.js';
import { initializeDefaultAgentModels } from '../runtime/default-model.js';

export type QueryClient = Pick<Pool, 'query'>;

export class ComputeRepository {
  constructor(public readonly pool: Pool, private readonly points: PointsConverter = createPointsConverter()) {}

  // ---- compute_bindings ----

  /** Legacy shared upstream users cannot enforce per-identity spending limits. */
  async countBindingsForSub2apiUser(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM compute_bindings WHERE sub2api_user_id = $1 AND sub2api_status IN ($2, $3)',
      [userId, 'ready', 'default_key_created'],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async upsertBinding(input: {
    identityId: string;
    sub2apiUserId: string;
    sub2apiUsername: string;
    managedPassword: string | null;
    status: ComputeBindingStatus;
    provisionJobId?: string | null;
    lastError?: string | null;
  }, client?: QueryClient): Promise<ComputeBinding> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      `INSERT INTO compute_bindings (identity_id, sub2api_user_id, sub2api_username, managed_password, sub2api_status, provision_job_id, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (identity_id) DO UPDATE SET
         sub2api_user_id = EXCLUDED.sub2api_user_id,
         sub2api_username = EXCLUDED.sub2api_username,
         managed_password = COALESCE(EXCLUDED.managed_password, compute_bindings.managed_password),
         sub2api_status = EXCLUDED.sub2api_status,
         provision_job_id = COALESCE(EXCLUDED.provision_job_id, compute_bindings.provision_job_id),
         last_error = EXCLUDED.last_error,
         updated_at = now()
       RETURNING *`,
      [input.identityId, input.sub2apiUserId, input.sub2apiUsername, input.managedPassword, input.status, input.provisionJobId ?? null, input.lastError ?? null],
    );
    return this.binding(rows[0]);
  }

  async getBinding(identityId: string, client?: QueryClient): Promise<ComputeBinding | null> {
    const c = client ?? this.pool;
    const { rows } = await c.query('SELECT * FROM compute_bindings WHERE identity_id = $1', [identityId]);
    return rows[0] ? this.binding(rows[0]) : null;
  }

  async updateBindingStatus(identityId: string, status: ComputeBindingStatus, lastError?: string | null, client?: QueryClient): Promise<void> {
    const c = client ?? this.pool;
    await c.query(
      'UPDATE compute_bindings SET sub2api_status = $2, last_error = $3, updated_at = now() WHERE identity_id = $1',
      [identityId, status, lastError ?? null],
    );
  }

  // ---- compute_entitlements ----

  async getOrCreateEntitlement(owner: { identityId?: string; organizationId?: string }, client?: QueryClient): Promise<Entitlement> {
    const c = client ?? this.pool;
    if (owner.identityId) {
      const { rows } = await c.query('SELECT * FROM compute_entitlements WHERE identity_id = $1', [owner.identityId]);
      if (rows[0]) return this.entitlement(rows[0]);
    } else if (owner.organizationId) {
      const { rows } = await c.query('SELECT * FROM compute_entitlements WHERE organization_id = $1', [owner.organizationId]);
      if (rows[0]) return this.entitlement(rows[0]);
    }
    const { rows } = await c.query(
      `INSERT INTO compute_entitlements (identity_id, organization_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING *`,
      [owner.identityId ?? null, owner.organizationId ?? null],
    );
    if (rows[0]) return this.entitlement(rows[0]);
    // 并发插入后再查一次
    if (owner.identityId) {
      const r = await c.query('SELECT * FROM compute_entitlements WHERE identity_id = $1', [owner.identityId]);
      return this.entitlement(r.rows[0]);
    }
    const r = await c.query('SELECT * FROM compute_entitlements WHERE organization_id = $1', [owner.organizationId]);
    return this.entitlement(r.rows[0]);
  }

  /** 只读查询额度池；不存在时返回 null（不产生写入，供 §7.1 summary/balance 使用）。 */
  async getEntitlement(owner: { identityId?: string; organizationId?: string }, client?: QueryClient): Promise<Entitlement | null> {
    const c = client ?? this.pool;
    if (owner.identityId) {
      const { rows } = await c.query('SELECT * FROM compute_entitlements WHERE identity_id = $1', [owner.identityId]);
      return rows[0] ? this.entitlement(rows[0]) : null;
    }
    if (owner.organizationId) {
      const { rows } = await c.query('SELECT * FROM compute_entitlements WHERE organization_id = $1', [owner.organizationId]);
      return rows[0] ? this.entitlement(rows[0]) : null;
    }
    return null;
  }

  /** SELECT ... FOR UPDATE 锁定额度行，用于额度变更事务 */
  async lockEntitlement(client: QueryClient, owner: { identityId?: string; organizationId?: string }): Promise<Entitlement> {
    if (owner.identityId) {
      const { rows } = await client.query('SELECT * FROM compute_entitlements WHERE identity_id = $1 FOR UPDATE', [owner.identityId]);
      return this.entitlement(rows[0]);
    }
    const { rows } = await client.query('SELECT * FROM compute_entitlements WHERE organization_id = $1 FOR UPDATE', [owner.organizationId]);
    return this.entitlement(rows[0]);
  }

  async updateEntitlementAmounts(
    client: QueryClient,
    entitlementId: string,
    delta: { total?: number; granted?: number; used?: number; reserved?: number },
  ): Promise<Entitlement> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;
    for (const [name, amount] of Object.entries(delta)) {
      if (amount === undefined) continue;
      const column = name === 'total' ? 'total' : name === 'granted' ? 'granted' : name === 'used' ? 'used' : 'reserved';
      // reserved 下限保护：异常路径（重复释放等）不得把预扣占位打成负数，否则可用余额虚增
      const expr = name === 'reserved'
        ? `points_reserved = GREATEST(0, points_reserved + $${idx}), quota_reserved = GREATEST(0, quota_reserved + $${idx + 1})`
        : `points_${column} = points_${column} + $${idx}, quota_${column} = quota_${column} + $${idx + 1}`;
      sets.push(expr);
      vals.push(amount, this.points.toUsd(Math.abs(amount)) * Math.sign(amount));
      idx += 2;
    }
    sets.push(`version = version + 1`);
    sets.push(`updated_at = now()`);
    vals.push(entitlementId);
    const { rows } = await client.query(
      `UPDATE compute_entitlements SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      vals,
    );
    return this.entitlement(rows[0]);
  }

  // ---- compute_allocation_ledger ----

  async createLedger(input: {
    entitlementId: string;
    operation: LedgerOperation;
    amount: number;
    status: LedgerStatus;
    idempotencyKey: string;
    requestId?: string | null;
    relatedLedgerId?: string | null;
    operatorIdentityId?: string | null;
    /** 上游余额是否已生效：commit（源自上游用量）/reserve（本地占位不推上游）入账即为 true */
    sub2apiSynced?: boolean;
    metadata?: Record<string, unknown>;
  }, client?: QueryClient): Promise<AllocationLedger> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      `INSERT INTO compute_allocation_ledger
        (entitlement_id, operation, amount, amount_points, rate_snapshot, status, idempotency_key, request_id, related_ledger_id, operator_identity_id, sub2api_synced, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [input.entitlementId, input.operation, this.points.toUsd(input.amount), input.amount, this.points.pointsPerUsd, input.status, input.idempotencyKey, input.requestId ?? null, input.relatedLedgerId ?? null, input.operatorIdentityId ?? null, input.sub2apiSynced ?? false, input.metadata ?? {}],
    );
    return this.ledger(rows[0]);
  }

  async getLedgerByIdempotency(key: string, client?: QueryClient): Promise<AllocationLedger | null> {
    const c = client ?? this.pool;
    const { rows } = await c.query('SELECT * FROM compute_allocation_ledger WHERE idempotency_key = $1', [key]);
    return rows[0] ? this.ledger(rows[0]) : null;
  }

  /**
   * 计算某身份在 Sub2API 上的预期余额（USD）：仅汇总 sub2api_synced=true 的流水，
   * 按操作方向带符号。用于对账时判断 Sub2API 余额是否包含 KLA 未知的充值。
   *
   * 规则：
   * - grant：+amount（平台发放，已推上游）
   * - revoke：-amount（平台收回，已推上游）
   * - allocate/reclaim：metadata.direction='in' → +amount，'out' → -amount
   * - commit：-amount（用量扣费，已推上游）
   * - recharge：不参与（来自上游，sub2api_synced=false）
   * - reserve/release：不参与（不影响上游余额）
   */
  async getSyncedSub2ApiBalanceUsd(entitlementId: string, client?: QueryClient): Promise<number> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      `SELECT
         operation,
         amount,
         COALESCE(metadata->>'direction', '') AS direction
       FROM compute_allocation_ledger
       WHERE entitlement_id = $1 AND sub2api_synced = true AND status = 'completed'`,
      [entitlementId],
    );
    let total = 0;
    for (const row of rows) {
      const amt = Number(row.amount);
      switch (row.operation) {
        case 'grant':
          total += amt;
          break;
        case 'revoke':
          total -= amt;
          break;
        case 'allocate':
        case 'reclaim':
          total += row.direction === 'in' ? amt : -amt;
          break;
        case 'commit':
          total -= amt;
          break;
        // recharge / reserve / release: 不影响上游余额
      }
    }
    return total;
  }

  async getLedger(id: string, client?: QueryClient): Promise<AllocationLedger | null> {
    const c = client ?? this.pool;
    const { rows } = await c.query('SELECT * FROM compute_allocation_ledger WHERE id = $1', [id]);
    return rows[0] ? this.ledger(rows[0]) : null;
  }

  /** SELECT ... FOR UPDATE 锁定流水行，用于释放/结算的事务内状态复查 */
  async lockLedger(id: string, client: QueryClient): Promise<AllocationLedger | null> {
    const { rows } = await client.query('SELECT * FROM compute_allocation_ledger WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] ? this.ledger(rows[0]) : null;
  }

  /** 超龄仍未释放的预扣流水（兜底回收用） */
  async listExpiredPendingReserves(olderThanMs: number, limit = 200): Promise<AllocationLedger[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM compute_allocation_ledger
       WHERE operation = 'reserve' AND status = 'pending' AND created_at < now() - ($1::bigint * interval '1 millisecond')
       ORDER BY created_at ASC LIMIT $2`,
      [olderThanMs, limit],
    );
    return rows.map((r) => this.ledger(r));
  }

  async updateLedgerStatus(id: string, status: LedgerStatus, sub2apiSynced?: boolean, client?: QueryClient): Promise<void> {
    const c = client ?? this.pool;
    const sets = ['status = $2', 'updated_at = now()'];
    const vals: unknown[] = [id, status];
    if (sub2apiSynced !== undefined) { sets.push('sub2api_synced = $3'); vals.push(sub2apiSynced); }
    await c.query(`UPDATE compute_allocation_ledger SET ${sets.join(', ')} WHERE id = $1`, vals);
  }

  async listLedgerByEntitlement(entitlementId: string, limit = 100, client?: QueryClient): Promise<AllocationLedger[]> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      'SELECT * FROM compute_allocation_ledger WHERE entitlement_id = $1 ORDER BY created_at DESC LIMIT $2',
      [entitlementId, limit],
    );
    return rows.map((r) => this.ledger(r));
  }

  /**
   * 已同步流水的上游影响净额（USD），作为余额对账的 KLA 侧基准。
   * 口径：recharge/grant 为入账(+)，commit 为上游扣减(-)，allocate/reclaim 按 metadata.direction 定符号；
   * reserve/release 是本地占位流水（不推上游），不计入。仅统计 sub2api_synced = true 的行。
   */
  async sumSyncedLedgerNet(identityId: string, client?: QueryClient): Promise<number> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      `SELECT COALESCE(SUM(
         CASE
           WHEN l.operation IN ('recharge', 'grant') THEN l.amount
           WHEN l.operation = 'commit' THEN -l.amount
           WHEN l.operation IN ('allocate', 'reclaim') THEN
             CASE WHEN l.metadata->>'direction' = 'in' THEN l.amount ELSE -l.amount END
           ELSE 0
         END
       ), 0) AS net
       FROM compute_allocation_ledger l
       JOIN compute_entitlements e ON e.id = l.entitlement_id
       WHERE e.identity_id = $1 AND l.sub2api_synced = true`,
      [identityId],
    );
    return Number(rows[0]?.net ?? 0);
  }

  // ---- 企业视图聚合（§7.5：企业池 = 管理员持有 + 成员持有） ----

  async listOrgMembersWithQuota(orgId: string, client?: QueryClient): Promise<OrgMemberQuota[]> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      `SELECT i.id AS identity_id, i.display_name, i.user_id, i.created_at,
              u.nickname AS user_nickname, u.email AS user_email,
              COALESCE(MAX(CASE WHEN r.name = '管理员' THEN 'admin' END), 'member') AS role,
              b.sub2api_status,
              COALESCE(e.points_total, 0) AS quota_total,
              COALESCE(e.points_granted, 0) AS quota_granted,
              COALESCE(e.points_used, 0) AS quota_used,
              COALESCE(e.points_reserved, 0) AS quota_reserved
       FROM identities i
       JOIN users u ON u.id = i.user_id
       LEFT JOIN identity_roles ir ON ir.identity_id = i.id
       LEFT JOIN roles r ON r.id = ir.role_id AND r.organization_id = i.organization_id
       LEFT JOIN compute_bindings b ON b.identity_id = i.id
       LEFT JOIN compute_entitlements e ON e.identity_id = i.id
       WHERE i.organization_id = $1 AND i.type = 'enterprise' AND i.status = 'active'
       GROUP BY i.id, i.display_name, i.user_id, i.created_at, u.nickname, u.email, b.sub2api_status,
                e.points_total, e.points_granted, e.points_used, e.points_reserved
       ORDER BY role DESC, i.created_at ASC`,
      [orgId],
    );
    return rows.map((r) => ({
      identityId: r.identity_id as string,
      displayName: String(r.display_name ?? ''),
      userName: String(r.user_nickname ?? ''),
      userEmail: (r.user_email as string | null) ?? null,
      userId: r.user_id as string,
      role: r.role === 'admin' ? 'admin' as const : 'member' as const,
      provisionStatus: (r.sub2api_status as string | null) ?? null,
      quotaTotal: Number(r.quota_total ?? 0),
      quotaGranted: Number(r.quota_granted ?? 0),
      quotaUsed: Number(r.quota_used ?? 0),
      quotaReserved: Number(r.quota_reserved ?? 0),
    }));
  }

  /** 企业流水：企业池行 + 该企业所有企业身份的个人池行（分发/回收两侧都会落流水），并带出账户与对手方展示名（含角色后缀消歧）。 */
  async listOrgLedger(orgId: string, limit = 100, client?: QueryClient): Promise<AllocationLedger[]> {
    const c = client ?? this.pool;
    // 展示名规则：优先用户昵称（企业身份的 display_name 是企业名，多成员会重名），昵称为空回退身份名；
    // 企业身份追加（管理员）/（成员）后缀，个人身份（如充值）不加后缀
    const { rows } = await c.query(
      `SELECT l.*,
              COALESCE(NULLIF(ou.nickname, ''), owner.display_name) || CASE WHEN owner.type = 'enterprise' THEN
                CASE WHEN EXISTS (
                  SELECT 1 FROM identity_roles oir JOIN roles orr ON orr.id = oir.role_id
                  WHERE oir.identity_id = owner.id AND orr.organization_id = owner.organization_id AND orr.name = '管理员'
                ) THEN '（管理员）' ELSE '（成员）' END ELSE '' END AS identity_name,
              COALESCE(NULLIF(cu.nickname, ''), cp.display_name) || CASE WHEN cp.type = 'enterprise' THEN
                CASE WHEN EXISTS (
                  SELECT 1 FROM identity_roles cir JOIN roles crr ON crr.id = cir.role_id
                  WHERE cir.identity_id = cp.id AND crr.organization_id = cp.organization_id AND crr.name = '管理员'
                ) THEN '（管理员）' ELSE '（成员）' END ELSE '' END AS counterparty_name
       FROM compute_allocation_ledger l
       JOIN compute_entitlements e ON e.id = l.entitlement_id
       LEFT JOIN identities owner ON owner.id = e.identity_id
       LEFT JOIN users ou ON ou.id = owner.user_id
       LEFT JOIN identities cp ON cp.id::text = l.metadata->>'counterpartyIdentityId'
       LEFT JOIN users cu ON cu.id = cp.user_id
       WHERE e.organization_id = $1
          OR EXISTS (SELECT 1 FROM identities i WHERE i.id = e.identity_id AND i.organization_id = $1)
       ORDER BY l.created_at DESC
       LIMIT $2`,
      [orgId, limit],
    );
    return rows.map((r) => this.ledger(r));
  }

  // ---- compute_keys ----

  async initializeAgentModels(identityId: string, client?: QueryClient): Promise<void> {
    await initializeDefaultAgentModels(client ?? this.pool, identityId);
  }

  async recordDefaultKey(input: {
    identityId: string;
    sub2apiKeyId: string;
    keyPrefix: string;
    keyFingerprint: string;
    name: string;
    groupId?: string | null;
  }, client?: QueryClient): Promise<ComputeKey> {
    const c = client ?? this.pool;
    await c.query('UPDATE compute_keys SET is_default = false WHERE identity_id = $1', [input.identityId]);
    const { rows } = await c.query(
      `INSERT INTO compute_keys (identity_id, sub2api_key_id, key_prefix, key_fingerprint, name, is_default, group_id)
       VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING *`,
      [input.identityId, input.sub2apiKeyId, input.keyPrefix, input.keyFingerprint, input.name, input.groupId ?? null],
    );
    await this.initializeAgentModels(input.identityId, c);
    return this.key(rows[0]);
  }

  async listKeys(identityId: string, client?: QueryClient): Promise<ComputeKey[]> {
    const c = client ?? this.pool;
    const { rows } = await c.query('SELECT * FROM compute_keys WHERE identity_id = $1 ORDER BY created_at DESC', [identityId]);
    return rows.map((r) => this.key(r));
  }

  /** §7.2：创建非默认 Key。sub2api_key_id / 前缀 / 指纹来自上游，配额等元数据只落 KLA。 */
  async createKey(input: {
    identityId: string;
    sub2apiKeyId: string;
    keyPrefix: string;
    keyFingerprint: string;
    name: string;
    groupId: string | null;
    quota: number | null;
    rpm: number | null;
    ipAllowList: string[];
    expiresAt: string | null;
    createdBy: string | null;
  }, client?: QueryClient): Promise<ComputeKey> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      `INSERT INTO compute_keys
         (identity_id, sub2api_key_id, key_prefix, key_fingerprint, name, is_default,
          group_id, quota, rpm, ip_allow_list, expires_at, created_by_identity_id, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,$9::jsonb,$10,$11,now())
       RETURNING *`,
      [
        input.identityId,
        input.sub2apiKeyId,
        input.keyPrefix,
        input.keyFingerprint,
        input.name,
        input.groupId,
        input.quota,
        input.rpm,
        JSON.stringify(input.ipAllowList),
        input.expiresAt,
        input.createdBy,
      ],
    );
    return this.key(rows[0]);
  }

  async getKey(keyId: string, identityId: string, client?: QueryClient): Promise<ComputeKey | null> {
    const c = client ?? this.pool;
    const { rows } = await c.query('SELECT * FROM compute_keys WHERE id = $1 AND identity_id = $2', [keyId, identityId]);
    return rows[0] ? this.key(rows[0]) : null;
  }

  /** §7.2：更新 Key 级元数据（名称/配额/速率/白名单/有效期），均为 KLA 侧字段。 */
  async updateKeyMetadata(keyId: string, identityId: string, patch: {
    name?: string;
    quota?: number | null;
    rpm?: number | null;
    ipAllowList?: string[];
    expiresAt?: string | null;
  }): Promise<ComputeKey | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;
    if (patch.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(patch.name); }
    if (patch.quota !== undefined) { sets.push(`quota = $${idx++}`); vals.push(patch.quota); }
    if (patch.rpm !== undefined) { sets.push(`rpm = $${idx++}`); vals.push(patch.rpm); }
    if (patch.ipAllowList !== undefined) { sets.push(`ip_allow_list = $${idx++}::jsonb`); vals.push(JSON.stringify(patch.ipAllowList)); }
    if (patch.expiresAt !== undefined) { sets.push(`expires_at = $${idx++}`); vals.push(patch.expiresAt); }
    if (sets.length === 0) return this.getKey(keyId, identityId);
    sets.push('last_synced_at = now()', 'updated_at = now()');
    const keyParam = idx;
    const identityParam = idx + 1;
    vals.push(keyId, identityId);
    const { rows } = await this.pool.query(
      `UPDATE compute_keys SET ${sets.join(', ')} WHERE id = $${keyParam} AND identity_id = $${identityParam} RETURNING *`,
      vals,
    );
    return rows[0] ? this.key(rows[0]) : null;
  }

  async setKeyStatus(keyId: string, identityId: string, status: ComputeKeyStatus): Promise<ComputeKey | null> {
    const { rows } = await this.pool.query(
      'UPDATE compute_keys SET status = $3, last_synced_at = now(), updated_at = now() WHERE id = $1 AND identity_id = $2 RETURNING *',
      [keyId, identityId, status],
    );
    return rows[0] ? this.key(rows[0]) : null;
  }

  /** §9.2：Key 列表的"今日用量"（美元），按 key_id 聚合当日 compute_usage。 */
  async sumTodayUsageByKey(identityId: string, client?: QueryClient): Promise<Map<string, number>> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      `SELECT key_id, COALESCE(SUM(amount_points), 0) AS total
       FROM compute_usage
       WHERE identity_id = $1 AND key_id IS NOT NULL AND recorded_at >= date_trunc('day', now())
       GROUP BY key_id`,
      [identityId],
    );
    return new Map(rows.map((row) => [row.key_id as string, Number(row.total ?? 0)]));
  }

  // ---- compute_usage ----

  /** §8：按身份选当前可用 Key（默认优先、状态 active），用于用量归属与业务标签。 */
  async getActiveKey(identityId: string, client?: QueryClient): Promise<ComputeKey | null> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      `SELECT * FROM compute_keys WHERE identity_id = $1 AND status = 'active' ORDER BY is_default DESC, created_at ASC LIMIT 1`,
      [identityId],
    );
    return rows[0] ? this.key(rows[0]) : null;
  }

  /** §7.3/§8：服务端模型目录查询；前端传入的 URL/Key 一律不使用。 */
  async getCatalogModel(modelId: string, client?: QueryClient): Promise<{ id: string; provider: string; enabled: boolean } | null> {
    const c = client ?? this.pool;
    const { rows } = await c.query('SELECT id, provider, enabled FROM models WHERE id = $1', [modelId]);
    if (!rows[0]) return null;
    return { id: rows[0].id as string, provider: rows[0].provider as string, enabled: Boolean(rows[0].enabled) };
  }

  /** 模型费率（compute_model_pricing），用于 Gateway 成本换算；无记录返回 null。 */
  async getModelPricing(modelId: string, client?: QueryClient): Promise<{ inputPricePerMtokUsd: number | null; outputPricePerMtokUsd: number | null } | null> {
    const c = client ?? this.pool;
    const { rows } = await c.query('SELECT input_price_per_mtok_usd, output_price_per_mtok_usd FROM compute_model_pricing WHERE model_id = $1', [modelId]);
    if (!rows[0]) return null;
    return {
      inputPricePerMtokUsd: rows[0].input_price_per_mtok_usd != null ? Number(rows[0].input_price_per_mtok_usd) : null,
      outputPricePerMtokUsd: rows[0].output_price_per_mtok_usd != null ? Number(rows[0].output_price_per_mtok_usd) : null,
    };
  }

  /** §8：Gateway 写入用量时一并带上业务标签（0011 增量列）。 */
  async upsertUsage(input: {
    identityId: string | null;
    ledgerId: string | null;
    sub2apiUsageId: string | null;
    model: string | null;
    amountUsd: number;
    promptTokens: number | null;
    completionTokens: number | null;
    cacheCreationTokens?: number | null;
    cacheReadTokens?: number | null;
    metadata?: Record<string, unknown>;
    dedupeHash: string;
    recordedAt: string;
    organizationId?: string | null;
    keyId?: string | null;
    projectId?: string | null;
    conversationId?: string | null;
    taskId?: string | null;
    latencyMs?: number | null;
    status?: string;
  }, client?: QueryClient): Promise<ComputeUsage | null> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      `INSERT INTO compute_usage
        (identity_id, ledger_id, sub2api_usage_id, model, amount_usd, amount_points, prompt_tokens, completion_tokens, cache_creation_tokens, cache_read_tokens, metadata, dedupe_hash, recorded_at,
         organization_id, key_id, project_id, conversation_id, task_id, latency_ms, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (dedupe_hash) DO NOTHING RETURNING *`,
      [
        input.identityId, input.ledgerId, input.sub2apiUsageId, input.model, input.amountUsd, this.points.fromUsd(input.amountUsd), input.promptTokens, input.completionTokens,
        input.cacheCreationTokens ?? 0, input.cacheReadTokens ?? 0,
        input.metadata ?? {}, input.dedupeHash, input.recordedAt,
        input.organizationId ?? null, input.keyId ?? null, input.projectId ?? null, input.conversationId ?? null, input.taskId ?? null,
        input.latencyMs ?? null, input.status ?? 'success',
      ],
    );
    return rows[0] ? this.usage(rows[0]) : null;
  }

  /**
   * 补齐上游延迟回填的展示指标：Sub2API 计费明细的 duration_ms / 缓存 token 可能晚于明细行落库，
   * 导致首次同步读到空值且此后被幂等跳过。每轮同步幂等命中时调用，只补空缺列，不影响金额与台账。
   */
  async refreshUsageMetrics(client: QueryClient, input: {
    identityId: string;
    sub2apiUsageId: string;
    latencyMs: number | null;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }): Promise<void> {
    await client.query(
      `UPDATE compute_usage SET
         latency_ms = COALESCE(latency_ms, $3),
         cache_creation_tokens = GREATEST(cache_creation_tokens, $4),
         cache_read_tokens = GREATEST(cache_read_tokens, $5)
       WHERE identity_id = $1 AND sub2api_usage_id = $2`,
      [input.identityId, input.sub2apiUsageId, input.latencyMs, input.cacheCreationTokens, input.cacheReadTokens],
    );
  }

  async sumUsageByIdentity(identityId: string, client?: QueryClient): Promise<number> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      'SELECT COALESCE(SUM(amount_usd), 0) AS total FROM compute_usage WHERE identity_id = $1',
      [identityId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  // ---- compute_provision_jobs ----

  async createProvisionJob(identityId: string, client?: QueryClient): Promise<ProvisionJob> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      'INSERT INTO compute_provision_jobs (identity_id) VALUES ($1) RETURNING *',
      [identityId],
    );
    return this.provisionJob(rows[0]);
  }

  async updateProvisionJob(
    id: string,
    patch: Partial<Pick<ProvisionJob, 'status' | 'attempts' | 'lastError' | 'sub2apiUserId' | 'sub2apiKeyId'>>,
    client?: QueryClient,
  ): Promise<void> {
    const c = client ?? this.pool;
    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;
    if (patch.status !== undefined) { sets.push(`status = $${idx++}`); vals.push(patch.status); }
    if (patch.attempts !== undefined) { sets.push(`attempts = $${idx++}`); vals.push(patch.attempts); }
    if (patch.lastError !== undefined) { sets.push(`last_error = $${idx++}`); vals.push(patch.lastError); }
    if (patch.sub2apiUserId !== undefined) { sets.push(`sub2api_user_id = $${idx++}`); vals.push(patch.sub2apiUserId); }
    if (patch.sub2apiKeyId !== undefined) { sets.push(`sub2api_key_id = $${idx++}`); vals.push(patch.sub2apiKeyId); }
    sets.push('updated_at = now()');
    vals.push(id);
    await c.query(`UPDATE compute_provision_jobs SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
  }

  // ---- compute_sync_logs ----

  async insertSyncLog(input: {
    syncType: SyncLogType;
    identityId?: string | null;
    organizationId?: string | null;
    klaAmount?: number | null;
    sub2apiAmount?: number | null;
    driftUsd?: number | null;
    status: SyncLogStatus;
    message?: string | null;
  }, client?: QueryClient): Promise<SyncLog> {
    const c = client ?? this.pool;
    const { rows } = await c.query(
      `INSERT INTO compute_sync_logs (sync_type, identity_id, organization_id, kla_amount, sub2api_amount, drift_usd, status, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [input.syncType, input.identityId ?? null, input.organizationId ?? null, input.klaAmount ?? null, input.sub2apiAmount ?? null, input.driftUsd ?? null, input.status, input.message ?? null],
    );
    return this.syncLog(rows[0]);
  }

  // ---- outbox_events ----

  async enqueueOutbox(input: {
    aggregateType: string;
    aggregateId: string;
    eventType: OutboxEventType;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }, client?: QueryClient): Promise<void> {
    const c = client ?? this.pool;
    await c.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [input.aggregateType, input.aggregateId, input.eventType, input.payload, input.idempotencyKey],
    );
  }

  /** 同事务内入队（接收外部 client） */
  async enqueueOutboxTx(
    client: QueryClient,
    input: {
      aggregateType: string;
      aggregateId: string;
      eventType: OutboxEventType;
      payload: Record<string, unknown>;
      idempotencyKey: string;
    },
  ): Promise<void> {
    await this.enqueueOutbox(input, client);
  }

  /** 认领待处理事件（FOR UPDATE SKIP LOCKED） */
  async claimPendingOutbox(client: QueryClient, limit = 10): Promise<OutboxEvent[]> {
    const { rows } = await client.query(
      `UPDATE outbox_events SET status = 'processing', attempts = attempts + 1, updated_at = now()
       WHERE id IN (
         SELECT id FROM outbox_events
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at, created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit],
    );
    return rows.map((r) => this.outbox(r));
  }

  async completeOutbox(id: string, client?: QueryClient): Promise<void> {
    const c = client ?? this.pool;
    await c.query("UPDATE outbox_events SET status = 'completed', updated_at = now() WHERE id = $1", [id]);
  }

  async failOutbox(id: string, error: string, client?: QueryClient): Promise<void> {
    const c = client ?? this.pool;
    // 指数退避：attempts * 30s，最多 5 分钟
    await c.query(
      `UPDATE outbox_events SET
         status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
         last_error = $2,
         next_attempt_at = now() + LEAST(attempts * 30 * interval '1 second', interval '5 minutes'),
         updated_at = now()
       WHERE id = $1`,
      [id, error],
    );
  }

  // ---- row mappers ----

  private binding(r: Record<string, unknown>): ComputeBinding {
    return {
      identityId: r.identity_id as string,
      sub2apiUserId: r.sub2api_user_id as string,
      sub2apiUsername: r.sub2api_username as string,
      managedPassword: (r.managed_password as string | null) ?? null,
      status: r.sub2api_status as ComputeBindingStatus,
      provisionJobId: (r.provision_job_id as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  private entitlement(r: Record<string, unknown>): Entitlement {
    return {
      id: r.id as string,
      identityId: (r.identity_id as string | null) ?? null,
      organizationId: (r.organization_id as string | null) ?? null,
      quotaTotal: Number(r.points_total ?? 0),
      quotaGranted: Number(r.points_granted ?? 0),
      quotaUsed: Number(r.points_used ?? 0),
      quotaReserved: Number(r.points_reserved ?? 0),
      version: Number(r.version ?? 0),
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  private ledger(r: Record<string, unknown>): AllocationLedger {
    return {
      id: r.id as string,
      entitlementId: r.entitlement_id as string,
      operation: r.operation as LedgerOperation,
      amount: Number(r.amount_points ?? 0),
      status: r.status as LedgerStatus,
      idempotencyKey: r.idempotency_key as string,
      requestId: (r.request_id as string | null) ?? null,
      relatedLedgerId: (r.related_ledger_id as string | null) ?? null,
      sub2apiSynced: Boolean(r.sub2api_synced),
      operatorIdentityId: (r.operator_identity_id as string | null) ?? null,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
      // 企业流水查询带出的展示名；其他查询没有这些列，保持为 null
      identityName: (r.identity_name as string | null) ?? null,
      counterpartyName: (r.counterparty_name as string | null) ?? null,
    };
  }

  private key(r: Record<string, unknown>): ComputeKey {
    return {
      id: r.id as string,
      identityId: r.identity_id as string,
      sub2apiKeyId: r.sub2api_key_id as string,
      keyPrefix: r.key_prefix as string,
      keyFingerprint: r.key_fingerprint as string,
      name: r.name as string,
      isDefault: Boolean(r.is_default),
      status: r.status as ComputeKeyStatus,
      groupId: (r.group_id as string | null) ?? null,
      quotaUsd: r.quota != null ? Number(r.quota) : null,
      rpm: r.rpm != null ? Number(r.rpm) : null,
      ipAllowList: Array.isArray(r.ip_allow_list) ? (r.ip_allow_list as string[]) : [],
      expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : null,
      lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at as string).toISOString() : null,
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  private usage(r: Record<string, unknown>): ComputeUsage {
    return {
      id: r.id as string,
      identityId: (r.identity_id as string | null) ?? null,
      ledgerId: (r.ledger_id as string | null) ?? null,
      sub2apiUsageId: (r.sub2api_usage_id as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      amountUsd: Number(r.amount_usd ?? 0),
      promptTokens: r.prompt_tokens != null ? Number(r.prompt_tokens) : null,
      completionTokens: r.completion_tokens != null ? Number(r.completion_tokens) : null,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
      dedupeHash: r.dedupe_hash as string,
      recordedAt: new Date(r.recorded_at as string).toISOString(),
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }

  private provisionJob(r: Record<string, unknown>): ProvisionJob {
    return {
      id: r.id as string,
      identityId: r.identity_id as string,
      status: r.status as ProvisionJobStatus,
      attempts: Number(r.attempts ?? 0),
      maxAttempts: Number(r.max_attempts ?? 5),
      lastError: (r.last_error as string | null) ?? null,
      sub2apiUserId: (r.sub2api_user_id as string | null) ?? null,
      sub2apiKeyId: (r.sub2api_key_id as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  private outbox(r: Record<string, unknown>): OutboxEvent {
    return {
      id: r.id as string,
      aggregateType: r.aggregate_type as string,
      aggregateId: r.aggregate_id as string,
      eventType: r.event_type as OutboxEventType,
      payload: (r.payload as Record<string, unknown>) ?? {},
      idempotencyKey: r.idempotency_key as string,
      status: r.status as OutboxStatus,
      attempts: Number(r.attempts ?? 0),
      maxAttempts: Number(r.max_attempts ?? 5),
      nextAttemptAt: new Date(r.next_attempt_at as string).toISOString(),
      lastError: (r.last_error as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  private syncLog(r: Record<string, unknown>): SyncLog {
    return {
      id: r.id as string,
      syncType: r.sync_type as SyncLogType,
      identityId: (r.identity_id as string | null) ?? null,
      organizationId: (r.organization_id as string | null) ?? null,
      klaAmount: r.kla_amount != null ? Number(r.kla_amount) : null,
      sub2apiAmount: r.sub2api_amount != null ? Number(r.sub2api_amount) : null,
      driftUsd: r.drift_usd != null ? Number(r.drift_usd) : null,
      status: r.status as SyncLogStatus,
      message: (r.message as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }
}
