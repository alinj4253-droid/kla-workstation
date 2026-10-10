// 算力模块路由（B 侧 §7.1）：当前身份与余额、初始化状态与重试
// 鉴权：身份一律从 Session 重新计算（§7）；§10 规定本人余额/用量对三种身份类型均可见，故仅做登录校验。
// 不返回任何密钥。

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ComputeBalance, ComputeDefaultKeySummary, ComputePermissionFlags, ComputeSummary, ProvisionState, ProvisionStatus, Sub2ApiHealth } from '@kla-workstation/contracts';
import type { AccountRepository } from '../repositories/types.js';
import type { ComputeRepository } from './compute-repository.js';
import type { ProvisioningService } from './provisioning-service.js';
import type { Sub2ApiClient } from './sub2api-client.js';
import { COMPUTE_PERMISSION, errorBody, hasPermission, requireIdentity } from './permissions.js';
import { availableBalance } from './types.js';

export type ComputeAccountRouteDeps = {
  accounts: AccountRepository;
  computeRepo: ComputeRepository;
  sub2api: Sub2ApiClient;
  provisioning: ProvisioningService;
};

/** §5.3 建号状态机的正向顺序，用于生成进度步骤。 */
const PROVISION_ORDER: ProvisionState[] = ['pending', 'provisioning', 'user_created', 'balance_granted', 'default_key_created', 'ready'];
const RETRYABLE_STATES: ReadonlySet<ProvisionState> = new Set<ProvisionState>(['pending', 'failed', 'dead_letter']);

export function buildProvisionSteps(state: ProvisionState, at: string | null, lastError: string | null): ProvisionStatus['steps'] {
  const index = PROVISION_ORDER.indexOf(state);
  if (index < 0) return [{ state, at, detail: lastError }];
  return PROVISION_ORDER.slice(0, index + 1).map((step) => ({ state: step, at: step === state ? at : null, detail: step === state ? lastError : null }));
}

export async function registerComputeAccountRoutes(app: FastifyInstance, deps: ComputeAccountRouteDeps): Promise<void> {
  const pool = deps.computeRepo.pool;

  const checkHealth = async (): Promise<Sub2ApiHealth> => {
    try {
      const result = await deps.sub2api.health();
      return result.ok ? 'healthy' : 'degraded';
    } catch {
      return 'unavailable';
    }
  };

  app.get('/api/v1/compute/summary', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    const identity = ctx.identity;
    const [entitlement, binding, keys, modelCount, health, canViewKeys, canCreateKey, canUpdateKey, canDisableKey, canViewUsage, canUseModel, canViewOrganizationUsage, canAllocate, canReclaim] = await Promise.all([
      deps.computeRepo.getEntitlement({ identityId: identity.id }),
      deps.computeRepo.getBinding(identity.id),
      deps.computeRepo.listKeys(identity.id),
      pool.query<{ total: number }>('SELECT count(*)::int AS total FROM models WHERE enabled = true'),
      checkHealth(),
      hasPermission(pool, identity.id, COMPUTE_PERMISSION.keyView),
      hasPermission(pool, identity.id, COMPUTE_PERMISSION.keyCreate),
      hasPermission(pool, identity.id, COMPUTE_PERMISSION.keyUpdate),
      hasPermission(pool, identity.id, COMPUTE_PERMISSION.keyDisable),
      hasPermission(pool, identity.id, COMPUTE_PERMISSION.usageView),
      hasPermission(pool, identity.id, COMPUTE_PERMISSION.modelUse),
      hasPermission(pool, identity.id, COMPUTE_PERMISSION.organizationUsageView),
      hasPermission(pool, identity.id, COMPUTE_PERMISSION.allocate),
      hasPermission(pool, identity.id, COMPUTE_PERMISSION.reclaim),
    ]);
    // 只读当前身份台账。上游账号可能被多个身份共用，不能把其余额当作本身份充值。
    const quota = {
      quotaTotal: entitlement?.quotaTotal ?? 0,
      quotaGranted: entitlement?.quotaGranted ?? 0,
      quotaUsed: entitlement?.quotaUsed ?? 0,
      quotaReserved: entitlement?.quotaReserved ?? 0,
    };
    const defaultKeyRow = keys.find((key) => key.isDefault && key.status !== 'deleted') ?? null;
    const defaultKey: ComputeDefaultKeySummary | null = defaultKeyRow
      ? { id: defaultKeyRow.id, name: defaultKeyRow.name, keyPrefix: defaultKeyRow.keyPrefix, status: defaultKeyRow.status }
      : null;
    const permissions: ComputePermissionFlags = {
      canViewKeys,
      canCreateKey,
      canUpdateKey,
      canDisableKey,
      canViewUsage,
      canViewOrganizationUsage,
      canUseModel,
      canAllocate,
      canReclaim,
      canRecharge: identity.type === 'personal',
    };
    const data: ComputeSummary = {
      identityId: identity.id,
      identityType: identity.type,
      organizationId: identity.organizationId,
      currency: 'point',
      balance: availableBalance(quota),
      used: quota.quotaUsed,
      reserved: quota.quotaReserved,
      available: availableBalance(quota),
      provisionState: (binding?.status ?? 'pending') as ProvisionState,
      defaultKey,
      availableModelCount: modelCount.rows[0]?.total ?? 0,
      sub2apiHealth: health,
      permissions,
      lastSyncedAt: binding?.updatedAt ?? null,
    };
    return reply.send({ ok: true, data });
  });

  app.get('/api/v1/compute/balance', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    const entitlement = await deps.computeRepo.getEntitlement({ identityId: ctx.identity.id });
    const available = availableBalance({
      quotaTotal: entitlement?.quotaTotal ?? 0,
      quotaGranted: entitlement?.quotaGranted ?? 0,
      quotaUsed: entitlement?.quotaUsed ?? 0,
      quotaReserved: entitlement?.quotaReserved ?? 0,
    });
    const data: ComputeBalance = {
      currency: 'point',
      balance: available,
      used: entitlement?.quotaUsed ?? 0,
      reserved: entitlement?.quotaReserved ?? 0,
      available,
      updatedAt: entitlement?.updatedAt ?? new Date().toISOString(),
    };
    return reply.send({ ok: true, data });
  });

  app.get('/api/v1/compute/provision-status', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    const binding = await deps.computeRepo.getBinding(ctx.identity.id);
    const state = (binding?.status ?? 'pending') as ProvisionState;
    const data: ProvisionStatus = {
      identityId: ctx.identity.id,
      state,
      steps: buildProvisionSteps(state, binding?.updatedAt ?? null, binding?.lastError ?? null),
      lastError: binding?.lastError ?? null,
      retryable: RETRYABLE_STATES.has(state),
    };
    return reply.send({ ok: true, data });
  });

  /** §5.3：失败时允许重试初始化；已 ready 时不重复建号。 */
  app.post('/api/v1/compute/provision/retry', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    const identity = ctx.identity;
    const binding = await deps.computeRepo.getBinding(identity.id);
    const current = (binding?.status ?? 'pending') as ProvisionState;
    if (current === 'ready') {
      return reply.send({ ok: true, data: { identityId: identity.id, state: current, accepted: false } });
    }
    try {
      await deps.provisioning.retryProvision({ identityId: identity.id, identityType: identity.type, displayName: identity.displayName });
    } catch (error) {
      return reply.code(503).send(errorBody('UNAVAILABLE', error instanceof Error ? error.message : '初始化重试失败', request.id));
    }
    const updated = await deps.computeRepo.getBinding(identity.id);
    return reply.send({ ok: true, data: { identityId: identity.id, state: (updated?.status ?? current) as ProvisionState, accepted: true } });
  });
}
