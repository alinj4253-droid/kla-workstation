// 算力模块路由（A 侧）：企业额度管理（§7.5）+ 充值占位（§7.6）
// 不实现 B 侧路由（Model Gateway、Key 管理、模型广场、用量 API）。
// 鉴权（§10、§12）：§7.5 仅该企业管理员或拥有显式权限的角色可调用；§7.6 仅个人身份可自助充值。

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AccountRepository, Identity } from '../repositories/types.js';
import type { ComputeRepository } from './compute-repository.js';
import type { QuotaService } from './quota-service.js';
import { COMPUTE_PERMISSION, errorBody, requireIdentity, requirePermission } from './permissions.js';
import { availableBalance, type OrgMemberQuota } from './types.js';

/** §4.3 幂等键：recharge:{identityId}:{paymentOrderId} */
function rechargeOrderKey(identityId: string, orderId: string): string {
  return `recharge:${identityId}:${orderId}`;
}

/** 企业池聚合：管理员持有的未分发额度 + 成员持有的已分发额度 = 企业总额。 */
function aggregatePool(members: OrgMemberQuota[]) {
  const sum = (pick: (m: OrgMemberQuota) => number) => members.reduce((acc, m) => acc + pick(m), 0);
  const quotaTotal = sum((m) => m.quotaTotal);
  const quotaGranted = sum((m) => m.quotaGranted);
  const quotaUsed = sum((m) => m.quotaUsed);
  const quotaReserved = sum((m) => m.quotaReserved);
  return {
    quotaTotal,
    quotaGranted,
    quotaUsed,
    quotaReserved,
    available: sum((m) => availableBalance(m)),
    adminHeld: members.filter((m) => m.role === 'admin').reduce((acc, m) => acc + availableBalance(m), 0),
    memberHeld: members.filter((m) => m.role === 'member').reduce((acc, m) => acc + availableBalance(m), 0),
  };
}

function mapMember(m: OrgMemberQuota) {
  return {
    identityId: m.identityId,
    displayName: m.displayName,
    userName: m.userName,
    userEmail: m.userEmail,
    userId: m.userId,
    role: m.role,
    provisionStatus: m.provisionStatus,
    quotaTotal: m.quotaTotal,
    quotaGranted: m.quotaGranted,
    quotaUsed: m.quotaUsed,
    quotaReserved: m.quotaReserved,
    available: availableBalance(m),
  };
}

export async function registerComputeRoutes(
  app: FastifyInstance,
  deps: { accounts: AccountRepository; computeRepo: ComputeRepository; quota: QuotaService },
): Promise<void> {
  const pool = deps.computeRepo.pool;

  /** §7.5：调用方身份必须属于该企业，并具备对应权限码。 */
  const requireOrganizationAccess = async (
    request: FastifyRequest,
    reply: FastifyReply,
    organizationId: string,
    permission: string,
    message: string,
  ): Promise<Identity | null> => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return null;
    if (ctx.identity.organizationId !== organizationId) {
      reply.code(403).send(errorBody('FORBIDDEN', '无权访问该企业算力数据', request.id));
      return null;
    }
    if (!(await requirePermission(pool, ctx.identity, permission, request, reply, message))) return null;
    return ctx.identity;
  };

  /** §7.5：分配/回收的目标必须是该企业成员，防止把企业额度发给任意身份。 */
  const isOrganizationMember = async (organizationId: string, identityId: string): Promise<boolean> => {
    const { rowCount } = await pool.query('SELECT 1 FROM identities WHERE id = $1 AND organization_id = $2', [identityId, organizationId]);
    return (rowCount ?? 0) > 0;
  };

  // ---- 企业额度管理（§7.5） ----

  /** 成员管理页一次性数据：企业池聚合 + 成员列表（含角色/额度/建号状态）+ 近期流水 + 邀请码。 */
  app.get('/api/v1/organizations/:orgId/compute/overview', async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const identity = await requireOrganizationAccess(request, reply, orgId, COMPUTE_PERMISSION.organizationUsageView, '无权查看企业算力额度');
    if (!identity) return;
    const [org, memberRows, recentLedger] = await Promise.all([
      deps.accounts.getOrganization(orgId),
      deps.computeRepo.listOrgMembersWithQuota(orgId),
      deps.computeRepo.listOrgLedger(orgId, 50),
    ]);
    if (!org) return reply.code(404).send(errorBody('NOT_FOUND', '企业不存在', request.id));
    return reply.send({
      ok: true,
      data: {
        organizationId: orgId,
        organizationName: org.name,
        inviteCode: org.inviteCode,
        pool: aggregatePool(memberRows),
        members: memberRows.map(mapMember),
        recentLedger,
      },
    });
  });

  app.get('/api/v1/organizations/:orgId/compute/summary', async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const identity = await requireOrganizationAccess(request, reply, orgId, COMPUTE_PERMISSION.organizationUsageView, '无权查看企业算力额度');
    if (!identity) return;
    const [memberRows, recentLedger] = await Promise.all([
      deps.computeRepo.listOrgMembersWithQuota(orgId),
      deps.computeRepo.listOrgLedger(orgId, 50),
    ]);
    // 企业池口径与 overview 一致：企业总额 = 管理员持有 + 成员持有（按企业身份额度池聚合）
    return reply.send({ ok: true, data: { entitlement: aggregatePool(memberRows), recentLedger } });
  });

  app.get('/api/v1/organizations/:orgId/compute/members', async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const identity = await requireOrganizationAccess(request, reply, orgId, COMPUTE_PERMISSION.organizationUsageView, '无权查看企业成员额度');
    if (!identity) return;
    const memberRows = await deps.computeRepo.listOrgMembersWithQuota(orgId);
    return reply.send({ ok: true, data: { members: memberRows.map(mapMember) } });
  });

  app.post('/api/v1/organizations/:orgId/compute/allocations', async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const identity = await requireOrganizationAccess(request, reply, orgId, COMPUTE_PERMISSION.allocate, '无权分配企业额度');
    if (!identity) return;
    const body = request.body as { identityId?: string; amount?: number; requestId?: string };
    if (!body.identityId || !body.amount || body.amount <= 0) {
      return reply.code(400).send(errorBody('INVALID_ARGUMENT', 'identityId 和 amount(>0) 必填', request.id));
    }
    if (!(await isOrganizationMember(orgId, body.identityId))) {
      return reply.code(403).send(errorBody('FORBIDDEN', '目标身份不是该企业成员', request.id));
    }
    if (body.identityId === identity.id) {
      return reply.code(400).send(errorBody('INVALID_ARGUMENT', '不能向管理员本人分发额度', request.id));
    }
    const requestId = body.requestId ?? randomUUID();
    try {
      // 从管理员本人的企业身份额度（= 企业池未分发部分）转给成员，同时在 Sub2API 两侧账号间转账
      const result = await deps.quota.allocate(identity.id, orgId, body.identityId, body.amount, requestId);
      return reply.send({ ok: true, data: { ledgerId: result.ledgerId, counterpartyLedgerId: result.counterpartyLedgerId, sub2apiSynced: result.sub2apiSynced } });
    } catch (error) {
      const insufficient = error instanceof Error && error.name === 'QuotaInsufficientError';
      return reply
        .code(insufficient ? 403 : 500)
        .send(errorBody(insufficient ? 'FORBIDDEN' : 'INTERNAL', error instanceof Error ? error.message : '分配失败', request.id));
    }
  });

  app.post('/api/v1/organizations/:orgId/compute/allocations/:id/reclaim', async (request, reply) => {
    const { orgId, id } = request.params as { orgId: string; id: string };
    const identity = await requireOrganizationAccess(request, reply, orgId, COMPUTE_PERMISSION.reclaim, '无权限回收成员额度');
    if (!identity) return;
    const body = request.body as { identityId?: string; amount?: number; requestId?: string };
    if (!body.identityId || !body.amount || body.amount <= 0) {
      return reply.code(400).send(errorBody('INVALID_ARGUMENT', 'identityId 和 amount(>0) 必填', request.id));
    }
    if (!(await isOrganizationMember(orgId, body.identityId))) {
      return reply.code(403).send(errorBody('FORBIDDEN', '目标身份不是该企业成员', request.id));
    }
    if (body.identityId === identity.id) {
      return reply.code(400).send(errorBody('INVALID_ARGUMENT', '不能从管理员本人回收额度', request.id));
    }
    const requestId = body.requestId ?? randomUUID();
    try {
      const result = await deps.quota.reclaim(identity.id, orgId, body.identityId, body.amount, requestId);
      return reply.send({ ok: true, data: { ledgerId: result.ledgerId, counterpartyLedgerId: result.counterpartyLedgerId, reclaimedFromLedgerId: id, sub2apiSynced: result.sub2apiSynced } });
    } catch (error) {
      const insufficient = error instanceof Error && error.name === 'QuotaInsufficientError';
      return reply
        .code(insufficient ? 403 : 500)
        .send(errorBody(insufficient ? 'FORBIDDEN' : 'INTERNAL', error instanceof Error ? error.message : '回收失败', request.id));
    }
  });

  app.get('/api/v1/organizations/:orgId/compute/ledger', async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const identity = await requireOrganizationAccess(request, reply, orgId, COMPUTE_PERMISSION.organizationUsageView, '无权查看企业额度流水');
    if (!identity) return;
    // 流水取企业池行 + 全部企业成员身份行（分发/回收两侧都有流水，不再恒为空）
    const ledger = await deps.computeRepo.listOrgLedger(orgId, 200);
    return reply.send({ ok: true, data: { ledger } });
  });

  // ---- 充值占位（§7.6） ----

  // 创建充值订单：本期未接入支付，只创建 pending 订单，不得增加余额（§7.6、§14）
  app.post('/api/v1/compute/recharge/orders', async (request, reply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    // §4.1：仅个人身份可自助充值；企业成员不允许，企业管理员也用个人身份充值
    if (ctx.identity.type !== 'personal') {
      return reply.code(403).send(errorBody('FORBIDDEN', '仅个人身份可自助充值，企业额度请联系企业管理员', request.id));
    }
    const body = request.body as { identityId?: string; amount?: number; paymentMethod?: string };
    if (body.identityId && body.identityId !== ctx.identity.id) {
      return reply.code(403).send(errorBody('FORBIDDEN', '只能为本人个人身份充值', request.id));
    }
    if (!body.amount || body.amount <= 0) {
      return reply.code(400).send(errorBody('INVALID_ARGUMENT', 'amount(>0) 必填', request.id));
    }
    const orderId = randomUUID();
    const entitlement = await deps.computeRepo.getOrCreateEntitlement({ identityId: ctx.identity.id });
    const ledger = await deps.computeRepo.createLedger({
      entitlementId: entitlement.id,
      operation: 'recharge',
      amount: body.amount,
      status: 'pending',
      idempotencyKey: rechargeOrderKey(ctx.identity.id, orderId),
      requestId: orderId,
      operatorIdentityId: ctx.identity.id,
      metadata: { paymentMethod: body.paymentMethod ?? null, awaitingPaymentCallback: true },
    });
    return reply.code(201).send({ ok: true, data: { orderId, ledgerId: ledger.id, status: 'pending', amount: body.amount } });
  });

  app.get('/api/v1/compute/recharge/orders/:orderId', async (request, reply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    const { orderId } = request.params as { orderId: string };
    const ledger = await deps.computeRepo.getLedgerByIdempotency(rechargeOrderKey(ctx.identity.id, orderId));
    if (!ledger) {
      return reply.code(404).send(errorBody('NOT_FOUND', '订单不存在', request.id));
    }
    return reply.send({ ok: true, data: { orderId, ledgerId: ledger.id, status: ledger.status, amount: ledger.amount } });
  });
}