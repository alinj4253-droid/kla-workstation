import { z } from 'zod';
import { pageQuerySchema } from './envelope.js';

// 面向用户的余额、额度、费用统一为算力点；Sub2API 的 USD 仅留在服务端成本边界。
export const COMPUTE_CURRENCY = 'point' as const;

/**
 * 权限码（§10）。服务端在每次请求内从 Session 重新计算并二次校验，前端开关与按钮状态一律不可信。
 * compute.allocate / reclaim / recharge 的执行接口由 A 侧提供，B 侧仅负责权限校验口径对齐。
 */
export const COMPUTE_PERMISSIONS = {
  view: 'compute.view',
  keyView: 'compute.key.view',
  keyCreate: 'compute.key.create',
  keyUpdate: 'compute.key.update',
  keyDisable: 'compute.key.disable',
  usageView: 'compute.usage.view',
  organizationUsageView: 'compute.organization.usage.view',
  allocate: 'compute.allocate',
  reclaim: 'compute.reclaim',
  recharge: 'compute.recharge',
  modelUse: 'model.use',
  modelCatalogView: 'model.catalog.view',
  /** 工具类计费项：联网搜索（docs/DESIGN_BOCHA_SEARCH_INTEGRATION.md §6） */
  toolSearchUse: 'tool.search.use',
} as const;

export type ComputePermission = (typeof COMPUTE_PERMISSIONS)[keyof typeof COMPUTE_PERMISSIONS];

export const COMPUTE_PERMISSION_CODES: readonly ComputePermission[] = Object.values(COMPUTE_PERMISSIONS);

/** Sub2API 连通性；unavailable 时新请求快速失败，正在进行的流式请求允许自然结束（§12）。 */
export const sub2apiHealthSchema = z.enum(['healthy', 'degraded', 'unavailable', 'unknown']);
export type Sub2ApiHealth = z.infer<typeof sub2apiHealthSchema>;

/** 身份算力初始化状态机（§5.3）；disabled 对应 §3.5 身份被禁用。 */
export const provisionStateSchema = z.enum([
  'pending',
  'provisioning',
  'user_created',
  'balance_granted',
  'default_key_created',
  'ready',
  'disabled',
  'failed',
  'retrying',
  'dead_letter',
]);
export type ProvisionState = z.infer<typeof provisionStateSchema>;

/** §7.2：默认 Key 不可删除，只能停用后重新生成；expiresAt 到期后为 expired，DELETE 后为 deleted。 */
export const computeKeyStatusSchema = z.enum(['active', 'disabled', 'expired', 'deleted']);
export type ComputeKeyStatus = z.infer<typeof computeKeyStatusSchema>;

/** 权限标志：summary 直接下发，前端据此决定入口展示；真实拦截仍由服务端完成。 */
export const computePermissionFlagsSchema = z.object({
  canViewKeys: z.boolean(),
  canCreateKey: z.boolean(),
  canUpdateKey: z.boolean(),
  canDisableKey: z.boolean(),
  canViewUsage: z.boolean(),
  canViewOrganizationUsage: z.boolean(),
  canUseModel: z.boolean(),
  canAllocate: z.boolean(),
  canReclaim: z.boolean(),
  canRecharge: z.boolean(),
});
export type ComputePermissionFlags = z.infer<typeof computePermissionFlagsSchema>;

/** 默认 Key 摘要；仅含前缀，不包含任何完整密钥。 */
export const computeDefaultKeySummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  keyPrefix: z.string(),
  status: computeKeyStatusSchema,
});
export type ComputeDefaultKeySummary = z.infer<typeof computeDefaultKeySummarySchema>;

/** §7.1 GET /compute/summary —— 不返回任何密钥。 */
export const computeSummarySchema = z.object({
  identityId: z.string().min(1),
  identityType: z.enum(['personal', 'enterprise']),
  organizationId: z.string().min(1).nullable(),
  currency: z.literal(COMPUTE_CURRENCY),
  balance: z.number(),
  used: z.number(),
  reserved: z.number(),
  available: z.number(),
  provisionState: provisionStateSchema,
  defaultKey: computeDefaultKeySummarySchema.nullable(),
  availableModelCount: z.number().int().min(0),
  sub2apiHealth: sub2apiHealthSchema,
  permissions: computePermissionFlagsSchema,
  lastSyncedAt: z.string().datetime().nullable(),
});
export type ComputeSummary = z.infer<typeof computeSummarySchema>;

/** §7.1 GET /compute/balance */
export const computeBalanceSchema = z.object({
  currency: z.literal(COMPUTE_CURRENCY),
  balance: z.number(),
  used: z.number(),
  reserved: z.number(),
  available: z.number(),
  updatedAt: z.string().datetime(),
});
export type ComputeBalance = z.infer<typeof computeBalanceSchema>;

export const provisionStepSchema = z.object({
  state: provisionStateSchema,
  at: z.string().datetime().nullable(),
  detail: z.string().nullable(),
});
export type ProvisionStep = z.infer<typeof provisionStepSchema>;

/** §7.1 GET /compute/provision-status */
export const provisionStatusSchema = z.object({
  identityId: z.string().min(1),
  state: provisionStateSchema,
  steps: z.array(provisionStepSchema),
  lastError: z.string().nullable(),
  retryable: z.boolean(),
});
export type ProvisionStatus = z.infer<typeof provisionStatusSchema>;

/** §7.1 POST /compute/provision/retry —— 幂等，不重复建号或重复发放额度。 */
export const provisionRetryResponseSchema = z.object({
  identityId: z.string().min(1),
  state: provisionStateSchema,
  accepted: z.boolean(),
});
export type ProvisionRetryResponse = z.infer<typeof provisionRetryResponseSchema>;

/** §7.2 Key DTO；keyPrefix 为可展示前缀，fingerprint 仅服务端使用，不下发。 */
export const computeKeySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  keyPrefix: z.string(),
  groupId: z.string().nullable(),
  isDefault: z.boolean(),
  status: computeKeyStatusSchema,
  quotaPoints: z.number().nullable(),
  rpm: z.number().int().nullable(),
  ipAllowList: z.array(z.string()),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  lastSyncedAt: z.string().datetime().nullable(),
  todayUsagePoints: z.number(),
});
export type ComputeKey = z.infer<typeof computeKeySchema>;

export const computeKeyListSchema = z.object({
  items: z.array(computeKeySchema),
});
export type ComputeKeyList = z.infer<typeof computeKeyListSchema>;

/** §7.2 POST /compute/keys 创建参数。 */
export const createComputeKeyRequestSchema = z.object({
  name: z.string().min(1).max(64),
  groupId: z.string().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
  quota: z.number().positive().optional(),
  rpm: z.number().int().positive().optional(),
  ipAllowList: z.array(z.string().min(1)).max(64).optional(),
});
export type CreateComputeKeyRequest = z.infer<typeof createComputeKeyRequestSchema>;

/**
 * 完整 secret 只在创建响应中出现一次，服务端不落库（§7.2、§12）。
 * 说明：secret 标记为可选，是因为 Sub2API 建 Key 响应是否回传完整 Key 属 §16 待联调确认项；
 * 若上游不回传，此处为 undefined，客户端应提示用户在 Sub2API 侧确认，而不是伪造或缓存密钥。
 */
export const createComputeKeyResponseSchema = z.object({
  key: computeKeySchema,
  secret: z.string().min(1).optional(),
});
export type CreateComputeKeyResponse = z.infer<typeof createComputeKeyResponseSchema>;

/** §7.2 PATCH /compute/keys/:keyId；默认 Key 不允许删除，仅可停用后重新生成。 */
export const updateComputeKeyRequestSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  quota: z.number().positive().nullable().optional(),
  rpm: z.number().int().positive().nullable().optional(),
  ipAllowList: z.array(z.string().min(1)).max(64).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type UpdateComputeKeyRequest = z.infer<typeof updateComputeKeyRequestSchema>;

/** §7.3 模型广场：只读，不提供任何模型编辑或上游 Key 填写能力。 */
export const computeModelCapabilitiesSchema = z.object({
  vision: z.boolean(),
  reasoning: z.boolean(),
  tools: z.boolean(),
  streaming: z.boolean(),
});
export type ComputeModelCapabilities = z.infer<typeof computeModelCapabilitiesSchema>;

export const computeModelStatusSchema = z.enum(['active', 'disabled']);
export type ComputeModelStatus = z.infer<typeof computeModelStatusSchema>;

export const computeModelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  provider: z.string(),
  capabilities: computeModelCapabilitiesSchema,
  contextWindow: z.number().int().positive().nullable(),
  inputPricePerMillionTokensPoints: z.number().nullable(),
  outputPricePerMillionTokensPoints: z.number().nullable(),
  available: z.boolean(),
  availableGroups: z.array(z.string()),
  status: computeModelStatusSchema,
});
export type ComputeModel = z.infer<typeof computeModelSchema>;

export const computeModelListSchema = z.object({
  items: z.array(computeModelSchema),
});
export type ComputeModelList = z.infer<typeof computeModelListSchema>;

/** §7.4 用量查询；scope=organization 仅企业管理员可用，服务端二次校验。 */
export const computeUsageScopeSchema = z.enum(['self', 'organization']);
export type ComputeUsageScope = z.infer<typeof computeUsageScopeSchema>;

export const computeUsageQuerySchema = pageQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  modelId: z.string().min(1).optional(),
  keyId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  scope: computeUsageScopeSchema.default('self'),
});
export type ComputeUsageQuery = z.infer<typeof computeUsageQuerySchema>;

export const computeUsageRecordSchema = z.object({
  id: z.string().min(1),
  identityId: z.string().min(1),
  modelId: z.string().min(1).nullable(),
  keyId: z.string().nullable(),
  keyPrefix: z.string().nullable(),
  projectId: z.string().nullable(),
  conversationId: z.string().nullable(),
  taskId: z.string().nullable(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  requestCount: z.number().int().min(0),
  latencyMs: z.number().int().min(0).nullable(),
  status: z.string(),
  costPoints: z.number(),
  usageAt: z.string().datetime(),
});
export type ComputeUsageRecord = z.infer<typeof computeUsageRecordSchema>;

export const computeUsageSummaryQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  scope: computeUsageScopeSchema.default('self'),
});
export type ComputeUsageSummaryQuery = z.infer<typeof computeUsageSummaryQuerySchema>;

export const computeUsageBucketSchema = z.object({
  key: z.string().min(1),
  requestCount: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  costPoints: z.number(),
});
export type ComputeUsageBucket = z.infer<typeof computeUsageBucketSchema>;

/** §7.4 GET /compute/usage/summary */
export const computeUsageSummarySchema = z.object({
  from: z.string().datetime().nullable(),
  to: z.string().datetime().nullable(),
  requestCount: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  costPoints: z.number(),
  successCount: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  avgLatencyMs: z.number().nullable(),
  byModel: z.array(computeUsageBucketSchema),
  byDay: z.array(computeUsageBucketSchema),
});
export type ComputeUsageSummary = z.infer<typeof computeUsageSummarySchema>;

/** §7.4 GET /compute/usage/export —— 由服务端生成 CSV 并完成权限校验。 */
export const computeUsageExportQuerySchema = computeUsageSummaryQuerySchema.extend({
  format: z.literal('csv').default('csv'),
  modelId: z.string().min(1).optional(),
  keyId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});
export type ComputeUsageExportQuery = z.infer<typeof computeUsageExportQuerySchema>;

// ---- §7.5 企业额度管理（企业管理员视角） ----
// 说明：这些接口由 A 侧实现（server/src/compute/routes.ts），B 侧前端只读展示与发起分配。

export const computeLedgerOperationSchema = z.enum(['grant', 'allocate', 'reclaim', 'reserve', 'commit', 'release', 'recharge']);
export type ComputeLedgerOperation = z.infer<typeof computeLedgerOperationSchema>;

export const computeLedgerStatusSchema = z.enum(['pending', 'completed', 'failed', 'released']);
export type ComputeLedgerStatus = z.infer<typeof computeLedgerStatusSchema>;

/** 额度池（personal = identity 池；organization = 企业池）。 */
export const computeEntitlementSchema = z.object({
  id: z.string().min(1),
  identityId: z.string().nullable(),
  organizationId: z.string().nullable(),
  quotaTotal: z.number(),
  quotaGranted: z.number(),
  quotaUsed: z.number(),
  quotaReserved: z.number(),
  version: z.number().int(),
  available: z.number(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ComputeEntitlement = z.infer<typeof computeEntitlementSchema>;

export const computeLedgerEntrySchema = z.object({
  id: z.string().min(1),
  entitlementId: z.string().min(1),
  operation: computeLedgerOperationSchema,
  amount: z.number(),
  status: computeLedgerStatusSchema,
  idempotencyKey: z.string(),
  requestId: z.string().nullable(),
  relatedLedgerId: z.string().nullable(),
  sub2apiSynced: z.boolean(),
  operatorIdentityId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** 流水归属账户展示名（企业流水接口返回；个人流水可能缺省） */
  identityName: z.string().nullable().optional(),
  /** 交易对手方账户展示名（分配/回收流水的另一侧） */
  counterpartyName: z.string().nullable().optional(),
});
export type ComputeLedgerEntry = z.infer<typeof computeLedgerEntrySchema>;

/** GET /organizations/:orgId/compute/summary */
export const computeOrgSummarySchema = z.object({
  entitlement: computeEntitlementSchema,
  recentLedger: z.array(computeLedgerEntrySchema),
});
export type ComputeOrgSummary = z.infer<typeof computeOrgSummarySchema>;

export const computeOrgMemberSchema = z.object({
  identityId: z.string().min(1),
  displayName: z.string(),
  /** 成员真实姓名（来自 users.nickname），用于成员管理页展示 */
  userName: z.string(),
  /** 成员登录邮箱（来自 users.email），同时也是其 Sub2API 账号派生基准 */
  userEmail: z.string().email().nullable(),
  userId: z.string().min(1),
  /** 企业内角色：创建者为 admin（管理员），邀请加入为 member（成员） */
  role: z.enum(['admin', 'member']).default('member'),
  /** 该身份的算力账号初始化状态（来自 compute_bindings.sub2api_status） */
  provisionStatus: z.string().nullable().default(null),
  quotaTotal: z.number(),
  quotaGranted: z.number(),
  quotaUsed: z.number(),
  quotaReserved: z.number(),
  available: z.number(),
});
export type ComputeOrgMember = z.infer<typeof computeOrgMemberSchema>;

/** GET /organizations/:orgId/compute/members */
export const computeOrgMemberListSchema = z.object({ members: z.array(computeOrgMemberSchema) });
export type ComputeOrgMemberList = z.infer<typeof computeOrgMemberListSchema>;

/** 企业池聚合口径：管理员持有 + 成员持有 = 企业总额（额度只在企业内流转，总额不因分发变化） */
export const computeOrgPoolSchema = z.object({
  quotaTotal: z.number(),
  quotaGranted: z.number(),
  quotaUsed: z.number(),
  quotaReserved: z.number(),
  available: z.number(),
  /** 管理员身份上尚未分发的可用额度 */
  adminHeld: z.number(),
  /** 已分发到成员身份上的可用额度之和 */
  memberHeld: z.number(),
});
export type ComputeOrgPool = z.infer<typeof computeOrgPoolSchema>;

/** GET /organizations/:orgId/compute/overview（成员管理页一次性数据） */
export const computeOrgOverviewSchema = z.object({
  organizationId: z.string().min(1),
  organizationName: z.string(),
  inviteCode: z.string(),
  pool: computeOrgPoolSchema,
  members: z.array(computeOrgMemberSchema),
  recentLedger: z.array(computeLedgerEntrySchema),
});
export type ComputeOrgOverview = z.infer<typeof computeOrgOverviewSchema>;

/** GET /organizations/:orgId（企业基本信息，仅本企业成员可查） */
export const organizationInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  inviteCode: z.string(),
  status: z.string(),
});
export type OrganizationInfo = z.infer<typeof organizationInfoSchema>;

/** GET /organizations/:orgId/compute/ledger */
export const computeOrgLedgerSchema = z.object({ ledger: z.array(computeLedgerEntrySchema) });
export type ComputeOrgLedger = z.infer<typeof computeOrgLedgerSchema>;

/** POST /organizations/:orgId/compute/allocations（分配）与 .../:id/reclaim（回收）共用入参。 */
export const computeAllocationRequestSchema = z.object({
  identityId: z.string().min(1),
  amount: z.number().positive(),
  requestId: z.string().min(1).optional(),
});
export type ComputeAllocationRequest = z.infer<typeof computeAllocationRequestSchema>;

export const computeAllocationResponseSchema = z.object({
  ledgerId: z.string().min(1),
  /** 转账对手方（成员/管理员）侧流水 ID */
  counterpartyLedgerId: z.string().min(1).optional(),
  reclaimedFromLedgerId: z.string().min(1).optional(),
  /** 双方 Sub2API 余额是否已同步；false 表示已入 KLA 台账，等待对账补偿 */
  sub2apiSynced: z.boolean().optional(),
});
export type ComputeAllocationResponse = z.infer<typeof computeAllocationResponseSchema>;
