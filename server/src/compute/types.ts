// KLA 算力模块领域类型
// 权威口径为"算力点"（1 USD = 1000 点，换算收敛在 points.ts）；USD 仅作为影子口径：
// - Entitlement/OrgMemberQuota 的 quota* 字段单位均为算力点（DB 列 points_*）；
// - ComputeKey.quotaUsd 是同步到 Sub2API 的上游口径（Key 级限额），展示层换算成点；
// - ComputeUsage.amountUsd 是上游真实成本（对账/财务），用户侧只看 amountPoints。

export type Usd = number;

/** 额度池 owner：个人（identity）或企业（organization） */
export type EntitlementOwner =
  | { type: 'identity'; identityId: string }
  | { type: 'organization'; organizationId: string };

export type ComputeBindingStatus =
  | 'pending'
  | 'provisioning'
  | 'user_created'
  | 'balance_granted'
  | 'default_key_created'
  | 'ready'
  | 'disabled'
  | 'failed'
  | 'dead_letter';

export type ComputeBinding = {
  identityId: string;
  sub2apiUserId: string;
  sub2apiUsername: string;
  managedPassword: string | null;
  status: ComputeBindingStatus;
  provisionJobId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Entitlement = {
  id: string;
  identityId: string | null;
  organizationId: string | null;
  /** 算力点口径（DB 列 points_*）；USD 影子列仅由 Sub2API 同步路径写入 */
  quotaTotal: number;
  quotaGranted: number;
  quotaUsed: number;
  quotaReserved: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LedgerOperation = 'grant' | 'allocate' | 'reclaim' | 'reserve' | 'commit' | 'release' | 'recharge';

export type LedgerStatus = 'pending' | 'completed' | 'failed' | 'released';

export type AllocationLedger = {
  id: string;
  entitlementId: string;
  operation: LedgerOperation;
  /** USD 影子口径（历史兼容 + 财务对账） */
  amount: Usd;
  /** 算力点金额（权威口径） */
  amountPoints: number;
  /** 落账时的汇率快照（点/USD） */
  rateSnapshot: number;
  status: LedgerStatus;
  idempotencyKey: string;
  requestId: string | null;
  relatedLedgerId: string | null;
  sub2apiSynced: boolean;
  operatorIdentityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/** §5.3：算力账号已经可以调用模型 / 管理 Key 的状态 */
export const COMPUTE_READY_STATES: ReadonlySet<ComputeBindingStatus> = new Set<ComputeBindingStatus>(['ready', 'default_key_created']);

export type ComputeKeyStatus = 'active' | 'disabled' | 'expired' | 'deleted';

export type ComputeKey = {
  id: string;
  identityId: string;
  sub2apiKeyId: string;
  keyPrefix: string;
  keyFingerprint: string;
  name: string;
  isDefault: boolean;
  status: ComputeKeyStatus;
  /** KLA 侧元数据（0011 增量列）；quotaUsd 为同步到上游的 USD 口径，展示层换算成点 */
  groupId: string | null;
  quotaUsd: number | null;
  rpm: number | null;
  ipAllowList: string[];
  expiresAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ComputeUsage = {
  id: string;
  identityId: string | null;
  ledgerId: string | null;
  sub2apiUsageId: string | null;
  model: string | null;
  /** 上游真实成本（USD），对账/财务口径 */
  amountUsd: Usd;
  /** 算力点实扣（权威口径） */
  amountPoints: number;
  /** 计费通道：model = 模型调用；tool = 工具调用（model 列存 toolId） */
  kind: 'model' | 'tool';
  toolId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  metadata: Record<string, unknown>;
  dedupeHash: string;
  recordedAt: string;
  createdAt: string;
};

export type ProvisionJobStatus =
  | 'pending'
  | 'provisioning'
  | 'user_created'
  | 'balance_granted'
  | 'default_key_created'
  | 'ready'
  | 'failed'
  | 'dead_letter';

export type ProvisionJob = {
  id: string;
  identityId: string;
  status: ProvisionJobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  sub2apiUserId: string | null;
  sub2apiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OutboxEventType =
  | 'provision_identity_compute'
  | 'disable_identity_compute'
  | 'sync_balance_to_sub2api';

export type OutboxStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';

export type OutboxEvent = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: OutboxEventType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SyncLogType = 'usage' | 'reconciliation' | 'balance';
export type SyncLogStatus = 'ok' | 'warning' | 'error';

export type SyncLog = {
  id: string;
  syncType: SyncLogType;
  identityId: string | null;
  organizationId: string | null;
  klaAmount: Usd | null;
  sub2apiAmount: Usd | null;
  driftUsd: Usd | null;
  status: SyncLogStatus;
  message: string | null;
  createdAt: string;
};

/** 可用额度（点）= 总额度 + 已分配 - 已使用 - 预扣中 */
export function availableBalance(e: Pick<Entitlement, 'quotaTotal' | 'quotaGranted' | 'quotaUsed' | 'quotaReserved'>): number {
  return roundUsd(e.quotaTotal + e.quotaGranted - e.quotaUsed - e.quotaReserved);
}

/** 企业成员（企业身份）+ 角色 + 额度 + 算力账号状态，成员管理页聚合行。额度单位为算力点。 */
export type OrgMemberQuota = {
  identityId: string;
  displayName: string;
  userName: string;
  userEmail: string | null;
  userId: string;
  role: 'admin' | 'member';
  provisionStatus: string | null;
  quotaTotal: number;
  quotaGranted: number;
  quotaUsed: number;
  quotaReserved: number;
};

/** USD 精度：保留 8 位小数（与 NUMERIC(20,8) 对齐） */
export function roundUsd(value: number): Usd {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}
