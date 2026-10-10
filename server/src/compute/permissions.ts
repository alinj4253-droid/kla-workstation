// 算力模块共享鉴权：会话与身份解析、权限码校验（§7、§10、§12）
//
// 说明：权限码以字符串常量在此重复声明，而不是运行时 import 自 @kla-workstation/contracts。
// 原因：契约包的 exports 运行时入口指向 dist，而 ci-check 顺序是 test → build，
// 运行时 import 会导致干净检出下 `pnpm test` 失败（见 docs/API_CONTRACTS.md §4 的 M0 策略）。
// 契约包中的 COMPUTE_PERMISSIONS 仍是唯一事实源，此处仅做编译期对齐。

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ApiErrorBody, ErrorCode } from '@kla-workstation/contracts';
import type { AccountRepository, Identity, Session } from '../repositories/types.js';

export const COMPUTE_PERMISSION = {
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

const RETRYABLE_CODES: ReadonlySet<string> = new Set(['RATE_LIMITED', 'UNAVAILABLE', 'INTERNAL']);

export function errorBody(code: ErrorCode, message: string, requestId?: string): ApiErrorBody {
  return {
    ok: false,
    error: { code, message, retryable: RETRYABLE_CODES.has(code) },
    ...(requestId ? { meta: { requestId } } : {}),
  };
}

export function bearerToken(request: FastifyRequest): string {
  const raw = request.headers.authorization;
  return typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : '';
}

export type ComputeContext = { session: Session; identity: Identity };

/**
 * §7：服务端从 Session 重新计算当前 identity；X-Identity-Id 仅作选择提示，不能直接授权。
 */
export async function requireIdentity(accounts: AccountRepository, request: FastifyRequest, reply: FastifyReply): Promise<ComputeContext | null> {
  const token = bearerToken(request);
  const session = token ? await accounts.getSession(token) : null;
  if (!session) {
    reply.code(401).send(errorBody('UNAUTHENTICATED', '请先登录', request.id));
    return null;
  }
  const identities = await accounts.listIdentities(session.userId);
  const active = identities.filter((item) => item.status === 'active');
  const hint = request.headers['x-identity-id'];
  const hinted = typeof hint === 'string' ? active.find((item) => item.id === hint) : undefined;
  const identity = hinted ?? active.find((item) => item.isDefault) ?? active[0];
  if (!identity) {
    reply.code(409).send(errorBody('FORBIDDEN', '当前账号没有可用身份', request.id));
    return null;
  }
  return { session, identity };
}

/** 权限绑定来自 identity_roles / role_permissions（角色由 C 组维护）。 */
export async function hasPermission(pool: Pool, identityId: string, code: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM identity_roles ir
     JOIN role_permissions rp ON rp.role_id = ir.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ir.identity_id = $1 AND p.code = $2 LIMIT 1`,
    [identityId, code],
  );
  return (result.rowCount ?? 0) > 0;
}

/** §12：前端按钮状态不可信，服务端二次校验；无权限直接 403。 */
export async function requirePermission(
  pool: Pool,
  identity: Identity,
  code: string,
  request: FastifyRequest,
  reply: FastifyReply,
  message = '无权执行该操作',
): Promise<boolean> {
  if (await hasPermission(pool, identity.id, code)) return true;
  reply.code(403).send(errorBody('FORBIDDEN', message, request.id));
  return false;
}