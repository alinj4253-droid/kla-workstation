import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ApiErrorBody } from '@kla-workstation/contracts';
import type { AccountRepository, Identity } from './repositories/types.js';
import type { ComputeGateway } from './compute/gateway.js';
import type { PostgresDatabase } from './database/postgres.js';
import type { RedisDatabase } from './infrastructure/redis.js';
import { PermissionDeniedError, requirePermission, type PermissionAction } from './auth/permission-service.js';
import type { Session } from './repositories/types.js';
import type { AgentLoopWorker } from './infrastructure/agent-loop.js';
import { ensureRuntimeRegistry, roomRegistry } from './runtime/registry.js';
import { createConversationRequestSchema, memoryBrowserQuerySchema } from '@kla-workstation/contracts';
import { createRoomWithAgents, InvalidConversationAgents } from './runtime/create-room.js';
import { MemoryBrowserRepository } from './memories/browser.js';
import { ShortTermMemoryService } from './memories/short-term.js';
import { canAccessConversation, canManageProject, resolveKnowledgeAccessScope } from './auth/resource-scope.js';
import { scopedSearchInputSchema, searchScopedKnowledge } from './auth/knowledge-search.js';
import { serviceUrl } from './knowledge-api/config.js';

/** pino 子 logger 支持运行时 setBindings；FastifyBaseLogger 类型未暴露，且 logger:false 的 noop 实现没有该方法（规范 §3）。 */
function bindRequestLog(request: FastifyRequest, bindings: Record<string, unknown>): void {
  const log = request.log as FastifyRequest['log'] & Partial<{ setBindings: (bindings: Record<string, unknown>) => void }>;
  log.setBindings?.(bindings);
}

export async function registerRoutes(app: FastifyInstance, deps: { accounts: AccountRepository; database?: PostgresDatabase; redis?: RedisDatabase; gateway?: Pick<ComputeGateway, 'completeChat'>; shortTermMemory?: ShortTermMemoryService; loopWorker?: Pick<AgentLoopWorker, 'kick' | 'cancel'>; mode?: 'postgres' | 'mock' }): Promise<void> {
  const auth = async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = request.headers.authorization;
    const token = typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : '';
    const session = token ? await deps.accounts.getSession(token) : null;
    if (!session) { reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录', retryable: false }, meta: { requestId: request.id } } satisfies ApiErrorBody); return null; }
    // 可观测性：认证通过后把操作者绑定到该请求的后续日志（规范 §3）
    bindRequestLog(request, { userId: session.userId });
    return session;
  };
  const identityFor = async (userId: string, request: { headers: Record<string, string | string[] | undefined> }) => {
    const identities = await deps.accounts.listIdentities(userId); const requested = request.headers['x-identity-id']; const requestedId = typeof requested === 'string' ? requested : '';
    if (requestedId) return identities.find((item) => item.id === requestedId && item.status === 'active') ?? null;
    return identities.find((item) => item.isDefault && item.status === 'active') ?? identities.find((item) => item.status === 'active') ?? null;
  };
  const enforce = async (session: Session, request: { headers: Record<string, string | string[] | undefined> }, action: PermissionAction, reply: { code: (n: number) => { send: (v: unknown) => unknown } }) => {
    if (!deps.database?.rawPool) return null; const identity = await identityFor(session.userId, request); if (!identity) { reply.code(403).send({ ok: false, error: { code: 'IDENTITY_REQUIRED', message: '当前身份不可用' } }); return null; }
    try {
      await requirePermission(deps.database.rawPool, identity.id, action);
      return identity;
    } catch (error) {
      if (!(error instanceof PermissionDeniedError)) throw error;
      reply.code(403).send({ ok: false, error: { code: 'PERMISSION_DENIED', message: `缺少 ${action} 权限` } });
      return null;
    }
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.get('/api/health', async () => ({
    ok: true,
    service: 'kla-backend' as const,
    version: '0.1.0',
    mode: deps.mode ?? ('postgres' as const),
  }));
  app.get('/api/health/database', async (_request, reply) => {
    if (!deps.database) return reply.code(503).send({ ok: false, error: { code: 'DATABASE_NOT_CONFIGURED', message: 'DATABASE_URL 未配置' } });
    const check = await deps.database.check();
    return reply.code(check.connected ? 200 : 503).send({ ok: check.connected, data: check });
  });
  app.get('/api/health/redis', async (_request, reply) => {
    if (!deps.redis) return reply.code(503).send({ ok: false, error: { code: 'REDIS_NOT_CONFIGURED', message: 'REDIS_URL 未配置' } });
    const check = await deps.redis.check();
    return reply.code(check.connected ? 200 : 503).send({ ok: check.connected, data: check });
  });

  app.get('/api/v1/me', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    const user = await deps.accounts.getUser(session.userId);
    return reply.send({ ok: true, data: user });
  });

  app.post('/api/v1/auth/register', async (request, reply) => {
    const body = request.body as { email?: string; phone?: string; password?: string; nickname?: string };
    const email = body.email?.trim().toLowerCase(); const phone = body.phone?.trim(); const nickname = body.nickname?.trim();
    if (!body.password || body.password.length < 8 || (!email && !phone) || !nickname) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '邮箱或手机号、至少 8 位密码、昵称均为必填', retryable: false }, meta: { requestId: request.id } } satisfies ApiErrorBody);
    try {
      const result = await deps.accounts.register({ email, phone, password: body.password, nickname });
      const session = await deps.accounts.createSession(result.user.id, { deviceId: typeof request.headers['x-device-id'] === 'string' ? request.headers['x-device-id'] : undefined, deviceName: typeof request.headers['x-device-name'] === 'string' ? request.headers['x-device-name'] : undefined, userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined, ipAddress: request.ip || undefined });
      return reply.code(201).send({ ok: true, data: { ...result, identities: await deps.accounts.listIdentities(result.user.id), session } });
    } catch (error) {
      if (error instanceof Error && /duplicate key|unique constraint/i.test(error.message)) return reply.code(409).send({ ok: false, error: { code: 'ACCOUNT_EXISTS', message: '邮箱或手机号已注册', retryable: false } });
      throw error;
    }
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = request.body as { identifier?: string; password?: string };
    const result = body.identifier?.trim() && body.password ? await deps.accounts.authenticate(body.identifier.trim().toLowerCase(), body.password) : null;
    if (!result) return reply.code(401).send({ ok: false, error: { code: 'INVALID_CREDENTIALS', message: '账号或密码错误', retryable: false }, meta: { requestId: request.id } } satisfies ApiErrorBody);
    const session = await deps.accounts.createSession(result.user.id, { deviceId: typeof request.headers['x-device-id'] === 'string' ? request.headers['x-device-id'] : undefined, deviceName: typeof request.headers['x-device-name'] === 'string' ? request.headers['x-device-name'] : undefined, userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined, ipAddress: request.ip || undefined });
    return reply.send({ ok: true, data: { ...result, session, identities: await deps.accounts.listIdentities(result.user.id) } });
  });
  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const body = request.body as { refreshToken?: string; deviceId?: string; deviceName?: string }; if (!body.refreshToken) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'refreshToken 为必填项' } });
    const session = await deps.accounts.rotateSession(body.refreshToken, { deviceId: body.deviceId, deviceName: body.deviceName, userAgent: String(request.headers['user-agent'] ?? ''), ipAddress: request.ip }); if (!session) return reply.code(401).send({ ok: false, error: { code: 'REFRESH_REJECTED', message: '刷新令牌无效、已使用或已过期' } }); return reply.send({ ok: true, data: { session } });
  });
  app.get('/api/v1/auth/sessions', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const rows = await deps.accounts.listSessions(session.userId); return reply.send({ ok: true, data: rows.map((item) => ({ ...item, current: item.id === session.id })) }); });
  app.delete('/api/v1/auth/sessions/:sessionId', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const { sessionId } = request.params as { sessionId: string }; if (!deps.database?.rawPool) return reply.code(503).send({ ok: false, error: { code: 'DATABASE_NOT_CONFIGURED', message: '数据库未配置' } }); const result = await deps.database.rawPool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id', [sessionId, session.userId]); if (!result.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'SESSION_NOT_FOUND', message: '会话不存在' } }); return reply.send({ ok: true, data: null });
  });
  app.post('/api/v1/auth/sessions/revoke-all', async (request, reply) => { const session = await auth(request, reply); if (!session) return; await deps.accounts.revokeAllSessions(session.userId, session.id); return reply.send({ ok: true, data: { revokedExceptCurrent: true } }); });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const raw = request.headers.authorization; const body = request.body as { refreshToken?: string } | undefined;
    if (typeof raw === 'string' && raw.startsWith('Bearer ')) await deps.accounts.revokeSession(raw.slice(7));
    if (body?.refreshToken) await deps.accounts.revokeSessionByRefreshToken(body.refreshToken);
    if ((!raw || !raw.startsWith('Bearer ')) && !body?.refreshToken) return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录', retryable: false } });
    return reply.send({ ok: true, data: null });
  });

  app.get('/api/v1/me/identities', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    const identities = await deps.accounts.listIdentities(session.userId);
    return reply.send({ ok: true, data: identities });
  });
  app.post('/api/v1/organizations', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    const body = request.body as { name?: string; licenseNumber?: string };
    if (!body.name?.trim() || !body.licenseNumber?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '企业名称和营业执照编码均为必填', retryable: false } });
    try {
      const identity = await deps.accounts.createOrganization(session.userId, body.name.trim(), body.licenseNumber.trim());
      const organization = deps.database?.rawPool ? await deps.database.rawPool.query('SELECT id, name, invite_code, status FROM organizations WHERE id=$1', [identity.organizationId]) : { rows: [] };
      return reply.send({ ok: true, data: { ...identity, inviteCode: organization.rows[0]?.invite_code ?? null, organization: organization.rows[0] ?? null } });
    } catch (error) { if (error instanceof Error && error.message.includes('unique')) return reply.code(409).send({ ok: false, error: { code: 'ORGANIZATION_EXISTS', message: '企业信息已存在', retryable: false } }); throw error; }
  });
  app.post('/api/v1/organizations/join', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    const body = request.body as { inviteCode?: string }; if (!body.inviteCode?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '企业邀请码不能为空', retryable: false } });
    const identity = await deps.accounts.joinOrganization(session.userId, body.inviteCode); if (!identity) return reply.code(404).send({ ok: false, error: { code: 'INVITE_NOT_FOUND', message: '企业邀请码无效或企业已停用', retryable: false } }); return reply.send({ ok: true, data: identity });
  });
  app.post('/api/v1/me/identities/:identityId/activate', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return; const params = request.params as { identityId: string };
    const identity = await deps.accounts.activateIdentity(session.userId, params.identityId);
    if (!identity) return reply.code(404).send({ ok: false, error: { code: 'IDENTITY_NOT_FOUND', message: '身份不存在或已停用', retryable: false } });
    return reply.send({ ok: true, data: identity });
  });
  app.put('/api/v1/me/identities/:identityId/default', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return; const params = request.params as { identityId: string }; const identity = await deps.accounts.activateIdentity(session.userId, params.identityId); if (!identity) return reply.code(404).send({ ok: false, error: { code: 'IDENTITY_NOT_FOUND', message: '身份不存在或已停用' } });
    const org = identity.organizationId ? await deps.accounts.getOrganization(identity.organizationId) : null;
    return reply.send({ ok: true, data: { ...identity, inviteCode: org?.inviteCode ?? null } });
  });

  // Enterprise administration is scoped by both the authenticated identity and organization id.
  // The client may send X-Identity-Id, but it can never select another user's identity.
  const organizationAdmin = async (session: Session, request: { headers: Record<string, string | string[] | undefined> }, organizationId: string, reply: { code: (n: number) => { send: (v: unknown) => unknown } }) => {
    const identity = await enforce(session, request, 'manage', reply);
    if (!identity) return null;
    if (identity.type !== 'enterprise' || identity.organizationId !== organizationId) {
      reply.code(404).send({ ok: false, error: { code: 'ORGANIZATION_NOT_FOUND', message: '企业不存在或当前身份无权访问' } });
      return null;
    }
    return identity;
  };

  app.get('/api/v1/organizations', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await identityFor(session.userId, request);
    if (!identity) return reply.code(403).send({ ok: false, error: { code: 'IDENTITY_REQUIRED', message: '当前身份不可用' } });
    const result = await deps.database.rawPool.query(`
      SELECT o.id, o.name, o.license_number, o.invite_code, o.status, o.created_at,
             i.id AS identity_id, i.display_name AS identity_name
      FROM identities i JOIN organizations o ON o.id=i.organization_id
      WHERE i.user_id=$1 AND i.type='enterprise' ORDER BY o.created_at DESC`, [session.userId]);
    return reply.send({ ok: true, data: result.rows.map((row) => ({ id: row.id, name: row.name, licenseNumber: row.license_number, inviteCode: row.invite_code, status: row.status, createdAt: row.created_at, identityId: row.identity_id, identityName: row.identity_name })) });
  });

  // 企业基本信息（含邀请码）：仅本企业成员可查
  app.get('/api/v1/organizations/:orgId', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    const { orgId } = request.params as { orgId: string };
    if (!(await deps.accounts.isOrganizationMember(session.userId, orgId))) {
      return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权查看该企业信息' } });
    }
    const org = await deps.accounts.getOrganization(orgId);
    if (!org) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '企业不存在' } });
    return reply.send({ ok: true, data: { id: org.id, name: org.name, inviteCode: org.inviteCode, status: org.status } });
  });

  app.get('/api/v1/organizations/:organizationId/members', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { organizationId } = request.params as { organizationId: string };
    if (!await organizationAdmin(session, request, organizationId, reply)) return;
    const result = await deps.database.rawPool.query(`
      SELECT i.id AS identity_id, i.user_id, i.display_name, i.status, i.is_default,
             u.email, u.phone, u.nickname,
             COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id',r.id,'name',r.name,'description',r.description,'isSystem',r.is_system)) FILTER (WHERE r.id IS NOT NULL), '[]'::jsonb) AS roles
      FROM identities i JOIN users u ON u.id=i.user_id
      LEFT JOIN identity_roles ir ON ir.identity_id=i.id
      LEFT JOIN roles r ON r.id=ir.role_id
      WHERE i.organization_id=$1 AND i.type='enterprise'
      GROUP BY i.id,u.id ORDER BY i.created_at`, [organizationId]);
    return reply.send({ ok: true, data: result.rows.map((row) => ({ identityId: row.identity_id, userId: row.user_id, displayName: row.display_name, status: row.status, isDefault: row.is_default, email: row.email, phone: row.phone, nickname: row.nickname, roles: row.roles })) });
  });

  app.get('/api/v1/organizations/:organizationId/roles', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { organizationId } = request.params as { organizationId: string };
    if (!await organizationAdmin(session, request, organizationId, reply)) return;
    const result = await deps.database.rawPool.query(`
      SELECT r.id,r.name,r.description,r.is_system,
        COALESCE(jsonb_agg(DISTINCT jsonb_build_object('code',p.code,'description',p.description)) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS permissions
      FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
      WHERE r.organization_id=$1 GROUP BY r.id ORDER BY r.is_system DESC,r.name`, [organizationId]);
    return reply.send({ ok: true, data: result.rows });
  });

  app.post('/api/v1/organizations/:organizationId/roles', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { organizationId } = request.params as { organizationId: string }; if (!await organizationAdmin(session, request, organizationId, reply)) return;
    const body = request.body as { name?: string; description?: string; permissions?: string[] };
    const name = body.name?.trim(); const permissions = Array.isArray(body.permissions) ? body.permissions : [];
    if (!name) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '角色名称不能为空' } });
    const allowed = await deps.database.rawPool.query('SELECT code FROM permissions WHERE code = ANY($1::text[])', [permissions]);
    if (allowed.rowCount !== permissions.length) return reply.code(400).send({ ok: false, error: { code: 'INVALID_PERMISSION', message: '包含不存在的权限代码' } });
    try {
      const client = await deps.database.rawPool.connect();
      try { await client.query('BEGIN'); const role = await client.query('INSERT INTO roles (organization_id,name,description,is_system) VALUES ($1,$2,$3,false) RETURNING id,name,description,is_system', [organizationId, name, body.description?.trim() ?? '']); await client.query("INSERT INTO role_permissions (role_id,permission_id) SELECT $1,id FROM permissions WHERE code=ANY($2::text[])", [role.rows[0].id, permissions]); await client.query('COMMIT'); return reply.code(201).send({ ok: true, data: { ...role.rows[0], permissions } }); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } catch (error) { if (error instanceof Error && /duplicate key|unique constraint/i.test(error.message)) return reply.code(409).send({ ok: false, error: { code: 'ROLE_EXISTS', message: '角色名称已存在' } }); throw error; }
  });

  app.patch('/api/v1/organizations/:organizationId/roles/:roleId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { organizationId, roleId } = request.params as { organizationId: string; roleId: string }; if (!await organizationAdmin(session, request, organizationId, reply)) return;
    const body = request.body as { name?: string; description?: string; permissions?: string[] };
    const existing = await deps.database.rawPool.query('SELECT id,is_system FROM roles WHERE id=$1 AND organization_id=$2', [roleId, organizationId]);
    if (!existing.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'ROLE_NOT_FOUND', message: '角色不存在' } });
    if (existing.rows[0].is_system) return reply.code(400).send({ ok: false, error: { code: 'SYSTEM_ROLE_IMMUTABLE', message: '系统角色不可编辑' } });
    const permissions = Array.isArray(body.permissions) ? body.permissions : null;
    if (permissions) { const allowed = await deps.database.rawPool.query('SELECT code FROM permissions WHERE code=ANY($1::text[])', [permissions]); if (allowed.rowCount !== permissions.length) return reply.code(400).send({ ok: false, error: { code: 'INVALID_PERMISSION', message: '包含不存在的权限代码' } }); }
    const client = await deps.database.rawPool.connect();
    try { await client.query('BEGIN'); const result = await client.query('UPDATE roles SET name=COALESCE($3,name),description=COALESCE($4,description) WHERE id=$1 AND organization_id=$2 RETURNING id,name,description,is_system', [roleId, organizationId, body.name?.trim() || null, body.description === undefined ? null : body.description.trim()]); if (permissions) { await client.query('DELETE FROM role_permissions WHERE role_id=$1',[roleId]); await client.query("INSERT INTO role_permissions (role_id,permission_id) SELECT $1,id FROM permissions WHERE code=ANY($2::text[])",[roleId,permissions]); } await client.query('COMMIT'); return reply.send({ ok: true, data: { ...result.rows[0], permissions: permissions ?? undefined } }); } catch (error) { await client.query('ROLLBACK'); if (error instanceof Error && /duplicate key|unique constraint/i.test(error.message)) return reply.code(409).send({ ok: false, error: { code: 'ROLE_EXISTS', message: '角色名称已存在' } }); throw error; } finally { client.release(); }
  });

  app.delete('/api/v1/organizations/:organizationId/roles/:roleId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { organizationId, roleId } = request.params as { organizationId: string; roleId: string }; if (!await organizationAdmin(session, request, organizationId, reply)) return;
    const existing = await deps.database.rawPool.query('SELECT is_system FROM roles WHERE id=$1 AND organization_id=$2', [roleId, organizationId]); if (!existing.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'ROLE_NOT_FOUND', message: '角色不存在' } }); if (existing.rows[0].is_system) return reply.code(400).send({ ok: false, error: { code: 'SYSTEM_ROLE_IMMUTABLE', message: '系统角色不可删除' } });
    const used = await deps.database.rawPool.query('SELECT 1 FROM identity_roles WHERE role_id=$1 LIMIT 1', [roleId]); if (used.rows[0]) return reply.code(409).send({ ok: false, error: { code: 'ROLE_IN_USE', message: '角色仍被成员使用，无法删除' } }); await deps.database.rawPool.query('DELETE FROM roles WHERE id=$1 AND organization_id=$2', [roleId, organizationId]); return reply.send({ ok: true, data: null });
  });

  app.put('/api/v1/organizations/:organizationId/members/:identityId/roles', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { organizationId, identityId } = request.params as { organizationId: string; identityId: string }; if (!await organizationAdmin(session, request, organizationId, reply)) return;
    const body = request.body as { roleIds?: string[] }; const roleIds = Array.isArray(body.roleIds) ? [...new Set(body.roleIds)] : [];
    const member = await deps.database.rawPool.query('SELECT id FROM identities WHERE id=$1 AND organization_id=$2 AND type=\'enterprise\' AND status=\'active\'', [identityId, organizationId]); if (!member.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'MEMBER_NOT_FOUND', message: '企业成员不存在' } });
    const roles = await deps.database.rawPool.query('SELECT id FROM roles WHERE organization_id=$1 AND id=ANY($2::uuid[])', [organizationId, roleIds]); if (roles.rowCount !== roleIds.length) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ROLE', message: '包含不属于该企业的角色' } });
    const client = await deps.database.rawPool.connect(); try { await client.query('BEGIN'); await client.query('DELETE FROM identity_roles WHERE identity_id=$1',[identityId]); if (roleIds.length) await client.query('INSERT INTO identity_roles(identity_id,role_id) SELECT $1,id FROM roles WHERE organization_id=$2 AND id=ANY($3::uuid[])',[identityId,organizationId,roleIds]); await client.query('COMMIT'); return reply.send({ ok: true, data: { identityId, roleIds } }); } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });

  app.get('/api/v1/me/entitlements', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await identityFor(session.userId, request); if (!identity) return reply.code(403).send({ ok: false, error: { code: 'IDENTITY_REQUIRED', message: '当前身份不可用' } });
    const organization = identity.organizationId ? (await deps.database.rawPool.query('SELECT id,name,status FROM organizations WHERE id=$1',[identity.organizationId])).rows[0] : null;
    if (identity.type === 'enterprise' && (!organization || organization.status !== 'active')) return reply.code(403).send({ ok: false, error: { code: 'ORGANIZATION_DISABLED', message: '企业已停用，当前身份不可用' } });
    return reply.send({ ok: true, data: { identityId: identity.id, organizationId: identity.organizationId, organization, planCode: identity.type === 'personal' ? 'personal' : 'enterprise', tokenQuota: null, storageQuota: null, source: 'default' } });
  });

  app.get('/api/v1/bootstrap', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply);
    if (!identity) return reply.code(409).send({ ok: false, error: { code: 'IDENTITY_REQUIRED', message: '当前账号没有可用身份', retryable: false } });
    const identities = await deps.accounts.listIdentities(session.userId);
    const pool = deps.database.rawPool;
    let projects = await deps.accounts.listProjects(identity.id);
    if (projects.length === 0) projects = [await deps.accounts.createProject(identity.id, '我的协作项目')];
    let conversations = await deps.accounts.listConversations(undefined, identity.id);
    if (conversations.length === 0) {
      const owned = projects.find(project => project.ownerIdentityId === identity.id);
      if (owned) conversations = [await deps.accounts.createConversation(owned.id, '默认协作群聊')];
    }
    if (deps.mode !== 'mock') await ensureRuntimeRegistry(pool, identity.id);
    const [workspaces, agents, models, tasks] = await Promise.all([
      pool.query('SELECT id, type, name, project_id FROM workspaces WHERE identity_id = $1 ORDER BY created_at', [identity.id]),
      pool.query('SELECT id, name, role, type, model_id, model_id AS "modelId", model_key_id, model_key_id AS "modelKeyId", execution_location AS "executionLocation", device_id AS "deviceId", enabled, version FROM agents WHERE identity_id = $1 ORDER BY created_at', [identity.id]),
      pool.query('SELECT id, name, provider, capabilities, enabled FROM models WHERE enabled = true ORDER BY name'),
      pool.query('SELECT id, title, status, result, created_at FROM tasks WHERE identity_id = $1 ORDER BY created_at DESC LIMIT 50', [identity.id]),
    ]);
    return reply.send({ ok: true, data: { user: await deps.accounts.getUser(session.userId), identity, identities, projects, conversations, workspaces: workspaces.rows, agents: agents.rows, models: models.rows, tasks: tasks.rows } });
  });
  app.get('/api/v1/workspaces', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    return reply.send({ ok: true, data: (await deps.database.rawPool.query('SELECT id, type, name, project_id FROM workspaces WHERE identity_id = $1 ORDER BY created_at', [identity?.id ?? ''])).rows });
  });
  app.get('/api/v1/agents', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    if (deps.mode !== 'mock') await ensureRuntimeRegistry(deps.database.rawPool, identity.id);
    return reply.send({ ok: true, data: (await deps.database.rawPool.query('SELECT id, name, role, type, model_id, model_id AS "modelId", model_key_id, model_key_id AS "modelKeyId", execution_location AS "executionLocation", device_id AS "deviceId", enabled, version FROM agents WHERE identity_id = $1 ORDER BY created_at', [identity?.id ?? ''])).rows });
  });
  app.get('/api/v1/models', async (_request, reply) => {
    if (!deps.database?.rawPool) return reply.code(503).send({ ok: false, error: { code: 'DATABASE_NOT_CONFIGURED', message: '数据库未配置' } });
    const result = await deps.database.rawPool.query('SELECT id, name, provider, base_url, capabilities, enabled, is_official FROM models WHERE enabled = true ORDER BY is_official DESC, name');
    const keys: Record<string, string | undefined> = { deepseek: process.env.DEEPSEEK_API_KEY, zhipu: process.env.GLM_API_KEY ?? (process.env.MODEL_ID?.startsWith('zhipu/') ? process.env.MODEL_API_KEY : undefined), qwen: process.env.QWEN_API_KEY, openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
    return reply.send({ ok: true, data: result.rows.map((row) => ({ ...row, configured: Boolean(keys[row.provider]) })) });
  });
  app.post('/api/v1/models/:modelId/test', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    if (!deps.database?.rawPool) return reply.code(503).send({ ok: false, error: { code: 'DATABASE_NOT_CONFIGURED', message: '数据库未配置', retryable: false } });
    const { modelId } = request.params as { modelId: string };
    const result = await deps.database.rawPool.query('SELECT id, provider, base_url FROM models WHERE id=$1 AND enabled=true', [modelId]);
    const model = result.rows[0];
    if (!model) return reply.code(404).send({ ok: false, error: { code: 'MODEL_NOT_FOUND', message: '模型不存在', retryable: false } });
    const key = model.provider === 'zhipu' ? (process.env.GLM_API_KEY ?? (process.env.MODEL_ID?.startsWith('zhipu/') ? process.env.MODEL_API_KEY : undefined)) : process.env[`${String(model.provider).toUpperCase()}_API_KEY`];
    if (!key) return reply.send({ ok: true, data: { success: false, error: '该模型尚未配置服务端 API Key' } });
    const endpoint = model.base_url?.replace(/\/$/, '') + '/chat/completions';
    const started = Date.now();
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: '只回复：连接成功' }], max_tokens: 16, temperature: 0 }) });
      const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      return reply.send({ ok: true, data: { success: response.ok, latencyMs: Date.now() - started, reply: payload.choices?.[0]?.message?.content ?? '', error: response.ok ? undefined : payload.error?.message ?? `HTTP ${response.status}` } });
    } catch (error) { return reply.send({ ok: true, data: { success: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) } }); }
  });

  app.get('/api/v1/projects', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return; return reply.send({ ok: true, data: await deps.accounts.listProjects(identity.id) }); });
  app.post('/api/v1/projects', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const identity = await enforce(session, request, 'write', reply); if (!identity) return; const body = request.body as { name?: string }; if (!body.name?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '项目名称不能为空', retryable: false } }); return reply.send({ ok: true, data: await deps.accounts.createProject(identity.id, body.name.trim()) }); });
  app.get('/api/v1/me/knowledge-access-scope', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    return reply.send({ ok: true, data: await resolveKnowledgeAccessScope(deps.database.rawPool, identity.id) });
  });
  app.get('/api/v1/projects/:projectId/members', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    const { projectId } = request.params as { projectId: string };
    if (!(await deps.accounts.listProjects(identity.id)).some(project => project.id === projectId)) return reply.code(404).send({ ok: false, error: { code: 'PROJECT_NOT_FOUND', message: '项目不存在或无权访问' } });
    const members = await deps.database.rawPool.query(`SELECT pm.identity_id,pm.role,pm.joined_at,i.display_name
      FROM project_members pm JOIN identities i ON i.id=pm.identity_id
      WHERE pm.project_id=$1 AND i.status='active' ORDER BY pm.joined_at`, [projectId]);
    return reply.send({ ok: true, data: members.rows });
  });
  app.delete('/api/v1/projects/:projectId/members/:memberIdentityId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'manage', reply); if (!identity) return;
    const { projectId, memberIdentityId } = request.params as { projectId: string; memberIdentityId: string };
    if (!(await canManageProject(deps.database.rawPool, identity.id, projectId))) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权管理该项目' } });
    const result = await deps.database.rawPool.query(`DELETE FROM project_members WHERE project_id=$1 AND identity_id=$2 AND role<>'owner' RETURNING identity_id`, [projectId, memberIdentityId]);
    if (!result.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'MEMBER_NOT_FOUND', message: '项目成员不存在或不可移除' } });
    return reply.send({ ok: true, data: null });
  });
  app.get('/api/v1/conversations/:conversationId/members', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    const { conversationId } = request.params as { conversationId: string };
    if (!(await canAccessConversation(deps.database.rawPool, identity.id, conversationId))) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问' } });
    const members = await deps.database.rawPool.query(`SELECT cm.identity_id,cm.role,cm.joined_at,i.display_name FROM conversation_members cm
      JOIN identities i ON i.id=cm.identity_id WHERE cm.conversation_id=$1 AND i.status='active' ORDER BY cm.joined_at`, [conversationId]);
    return reply.send({ ok: true, data: members.rows });
  });
  app.post('/api/v1/conversations/:conversationId/members', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'manage', reply); if (!identity) return;
    const { conversationId } = request.params as { conversationId: string };
    const { identityId } = (request.body ?? {}) as { identityId?: string };
    if (!identityId || !/^[0-9a-f-]{36}$/i.test(identityId)) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'identityId 必须为有效 UUID' } });
    const room = await deps.database.rawPool.query(`SELECT c.project_id,p.organization_id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1`, [conversationId]);
    if (!room.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在' } });
    const projectId = room.rows[0].project_id as string;
    if (!(await canManageProject(deps.database.rawPool, identity.id, projectId))) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权邀请该群聊成员' } });
    const target = await deps.database.rawPool.query(`SELECT id FROM identities WHERE id=$1 AND type='enterprise' AND status='active' AND organization_id=$2::uuid`, [identityId, room.rows[0].organization_id]);
    if (!room.rows[0].organization_id || !target.rows[0]) return reply.code(403).send({ ok: false, error: { code: 'IDENTITY_SCOPE_MISMATCH', message: '仅可邀请同企业身份；个人身份不能加入企业项目' } });
    const client = await deps.database.rawPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO project_members(project_id,identity_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING`, [projectId, identityId]);
      const added = await client.query(`INSERT INTO conversation_members(conversation_id,project_id,identity_id,role)
        VALUES($1,$2,$3,'member') ON CONFLICT (conversation_id,identity_id) DO UPDATE SET role=conversation_members.role
        RETURNING identity_id,role,joined_at`, [conversationId, projectId, identityId]);
      await client.query('COMMIT');
      return reply.code(201).send({ ok: true, data: added.rows[0] });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
  app.delete('/api/v1/conversations/:conversationId/members/:memberIdentityId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'manage', reply); if (!identity) return;
    const { conversationId, memberIdentityId } = request.params as { conversationId: string; memberIdentityId: string };
    const room = await deps.database.rawPool.query('SELECT project_id FROM conversations WHERE id=$1', [conversationId]);
    if (!room.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在' } });
    if (!(await canManageProject(deps.database.rawPool, identity.id, room.rows[0].project_id))) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权管理该群聊' } });
    const result = await deps.database.rawPool.query(`DELETE FROM conversation_members WHERE conversation_id=$1 AND identity_id=$2 AND role<>'owner' RETURNING identity_id`, [conversationId, memberIdentityId]);
    if (!result.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'MEMBER_NOT_FOUND', message: '群聊成员不存在或不可移除' } });
    return reply.send({ ok: true, data: null });
  });
  app.get('/api/v1/conversations', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return; return reply.send({ ok: true, data: await deps.accounts.listAllConversations(identity.id) }); });
  app.get('/api/v1/projects/:projectId/agents', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    if (!deps.database?.rawPool) return reply.code(503).send({ ok: false, error: { code: 'DATABASE_NOT_CONFIGURED', message: '数据库未配置，无法加载可用智能体' } });
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    const { projectId } = request.params as { projectId: string };
    if (!(await canManageProject(deps.database.rawPool, identity.id, projectId))) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权管理该项目' } });
    const project = (await deps.database.rawPool.query('SELECT owner_identity_id FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!project) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '项目不存在' } });
    await ensureRuntimeRegistry(deps.database.rawPool, project.owner_identity_id);
    const agents = await deps.database.rawPool.query('SELECT id,name,role,type,execution_location,enabled,version FROM agents WHERE identity_id=$1 AND enabled ORDER BY created_at,name', [project.owner_identity_id]);
    return reply.send({ ok: true, data: agents.rows });
  });
  app.post('/api/v1/conversations', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    const identity = await enforce(session, request, 'write', reply); if (!identity) return;
    // Retain project-less legacy requests while validating before any database writes.
    const parsed = createConversationRequestSchema.extend({ projectId: createConversationRequestSchema.shape.projectId.optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '请输入群组名称，并选择有效且不重复的协作智能体', retryable: false } });
    const body = parsed.data;
    let projectId = body.projectId;
    if (!projectId) {
      const projects = await deps.accounts.listProjects(identity.id);
      projectId = projects.find(project => project.ownerIdentityId === identity.id)?.id ?? (await deps.accounts.createProject(identity.id, '我的协作项目')).id;
    }
    if (deps.mode !== 'mock' && deps.database?.rawPool) {
      if (!(await canManageProject(deps.database.rawPool, identity.id, projectId))) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权管理该项目' } });
      try { return reply.send({ ok: true, data: await createRoomWithAgents(deps.database.rawPool, projectId, body.name, body.agentIds) }); }
      catch (error) {
        if (error instanceof InvalidConversationAgents) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: error.message, retryable: false } });
        throw error;
      }
    }
    const projects = await deps.accounts.listProjects(identity.id);
    if (!projects.some(project => project.id === projectId)) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权访问该项目' } });
    return reply.send({ ok: true, data: await deps.accounts.createConversation(projectId, body.name) });
  });
  app.get('/api/v1/conversations/:conversationId/messages', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return; const params = request.params as { conversationId: string }; const conversations = await deps.accounts.listAllConversations(identity.id); if (!conversations.some((item) => item.id === params.conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问', retryable: false } }); return reply.send({ ok: true, data: await deps.accounts.listMessages(params.conversationId) }); });
  app.post('/api/v1/conversations/:conversationId/messages', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    // Sending a chat message is a write operation. The execute permission is
    // reserved for invoking tools, operation platforms, or queued actions.
    const identity = await enforce(session, request, 'write', reply); if (!identity) return;
    const params = request.params as { conversationId: string }; const body = request.body as { text?: string; mode?: string };
    if (!body.text?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '消息不能为空', retryable: false }, meta: { requestId: request.id } } satisfies ApiErrorBody);
    if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === params.conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问', retryable: false } });
    const userMessage = await deps.accounts.createMessage(params.conversationId, session.userId, body.text.trim());
    if (deps.mode !== 'mock' && deps.database?.rawPool) {
      const owner = await deps.database.rawPool.query(`SELECT p.owner_identity_id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1`, [params.conversationId]);
      if (owner.rows[0]?.owner_identity_id !== identity.id) return reply.send({ ok: true, data: { message: userMessage, run: null } });
    }
    const run = await deps.accounts.createRun(params.conversationId, userMessage.id, body.mode ?? 'balanced');
    if (!deps.loopWorker) { await deps.accounts.completeRun(run.id, 'failed', '统筹智能体', {error:'执行器未启动'}); }
    else deps.loopWorker.kick();
    return reply.send({ ok: true, data: { message: userMessage, run } });
  });

  app.get('/api/v1/conversations/:conversationId/runs', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return; const { conversationId } = request.params as { conversationId: string }; if (!(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问', retryable: false } }); return reply.send({ ok: true, data: await deps.accounts.listConversationRuns(conversationId) }); });
  app.get('/api/v1/conversations/:conversationId/artifacts', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return; const { conversationId } = request.params as { conversationId: string }; if (!(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问', retryable: false } }); return reply.send({ ok: true, data: await deps.accounts.listArtifacts(identity.id, conversationId) }); });
  app.get('/api/v1/artifacts/:artifactId', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return; const { artifactId } = request.params as { artifactId: string }; const artifact = await deps.accounts.getArtifact(identity.id, artifactId); if (!artifact) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '成果文件不存在' } }); return reply.send({ ok: true, data: artifact }); });

  // REST migration surface for the former local IPC capabilities.
  app.get('/api/v1/conversations/:conversationId/agents', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    const { conversationId } = request.params as { conversationId: string };
    if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问' } });
    await roomRegistry(deps.database.rawPool, conversationId);
    const result = await deps.database.rawPool.query(`SELECT a.id, a.name, a.role, a.type, a.model_id, a.execution_location, a.device_id, a.enabled, ca.role AS conversation_role FROM conversation_agents ca JOIN agents a ON a.id = ca.agent_id WHERE ca.conversation_id = $1 ORDER BY ca.created_at`, [conversationId]);
    return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/conversations/:conversationId/agents', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'manage', reply); if (!identity) return;
    const { conversationId } = request.params as { conversationId: string }; const body = request.body as { agentId?: string; role?: string };
    if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问' } });
    if (!body.agentId) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'agentId 为必填项' } });
    const agent = await deps.database.rawPool.query('SELECT id, name, role, type, model_id, enabled FROM agents WHERE id=$1 AND identity_id=$2', [body.agentId, identity.id]);
    if (!agent.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'AGENT_NOT_FOUND', message: '智能体不存在或无权使用' } });
    if (!agent.rows[0].enabled) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '智能体已禁用' } });
    const role = agent.rows[0].name === '统筹智能体' ? 'coordinator' : 'member';
    if (body.role && body.role !== role) return reply.code(400).send({ ok: false, error: { code: 'COORDINATOR_REQUIRED', message: '群主固定为统筹智能体，其他智能体只能作为协作成员' } });
    await deps.database.rawPool.query('INSERT INTO conversation_agents (conversation_id, agent_id, role) VALUES ($1,$2,$3) ON CONFLICT (conversation_id, agent_id) DO UPDATE SET role=EXCLUDED.role', [conversationId, body.agentId, role]);
    return reply.send({ ok: true, data: agent.rows[0] });
  });
  app.delete('/api/v1/conversations/:conversationId/agents/:agentId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'manage', reply); if (!identity) return;
    const { conversationId, agentId } = request.params as { conversationId: string; agentId: string };
    if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问' } });
    if ((await deps.database.rawPool.query('SELECT name FROM agents WHERE id=$1', [agentId])).rows[0]?.name === '统筹智能体') return reply.code(400).send({ok:false,error:{code:'COORDINATOR_REQUIRED',message:'统筹智能体不能移出群聊'}});
    await deps.database.rawPool.query('DELETE FROM conversation_agents WHERE conversation_id=$1 AND agent_id=$2', [conversationId, agentId]); return reply.send({ ok: true, data: null });
  });
  // Read-only history browser; viewing records never reinforces their decay timestamp.
  app.get('/api/v1/memories/browser/scopes', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    return reply.send({ ok: true, data: await new MemoryBrowserRepository(deps.database.rawPool).scopes(identity.id) });
  });
  app.get('/api/v1/memories/browser', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    const query = memoryBrowserQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '记忆筛选参数不合法', retryable: false } });
    return reply.send({ ok: true, data: await new MemoryBrowserRepository(deps.database.rawPool).entries(identity.id, query.data) });
  });
  app.get('/api/v1/memories', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    const query = request.query as { workspaceId?: string; kind?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
    const result = await deps.database.rawPool.query(`SELECT m.id,m.workspace_id,m.content,m.kind,m.metadata,m.created_at,m.updated_at
      FROM memories m JOIN workspaces w ON w.id=m.workspace_id WHERE w.identity_id=$1
        AND ($2::uuid IS NULL OR m.workspace_id=$2) AND ($3::text IS NULL OR m.kind=$3)
        AND (m.expires_at IS NULL OR m.expires_at>now()) AND (m.retained_until IS NULL OR m.retained_until>now())
      ORDER BY m.created_at DESC LIMIT $4`, [identity.id, query.workspaceId ?? null, query.kind ?? null, limit]);
    return reply.send({ ok: true, data: result.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, content: row.content, kind: row.kind, metadata: row.metadata ?? {}, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() })) });
  });
  app.post('/api/v1/memories', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'write', reply); if (!identity) return;
    const body = request.body as { workspaceId?: string; content?: string; kind?: string; metadata?: Record<string, unknown> }; if (!body.workspaceId || !body.content?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'workspaceId 和 content 为必填项' } });
    const owner = await deps.database.rawPool.query('SELECT id FROM workspaces WHERE id=$1 AND identity_id=$2', [body.workspaceId, identity.id]); if (!owner.rows[0]) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权写入该工作区记忆' } });
    const result = await deps.database.rawPool.query('INSERT INTO memories (workspace_id,content,kind,metadata) VALUES ($1,$2,$3,$4) RETURNING id,workspace_id,content,kind,metadata,created_at', [body.workspaceId, body.content.trim(), body.kind ?? 'long_term', JSON.stringify(body.metadata ?? {})]); return reply.send({ ok: true, data: result.rows[0] });
  });
  app.patch('/api/v1/memories/:memoryId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'write', reply); if (!identity) return;
    const { memoryId } = request.params as { memoryId: string }; const body = request.body as { content?: string; kind?: string; metadata?: Record<string, unknown> };
    const result = await deps.database.rawPool.query(`UPDATE memories m SET content=COALESCE($2,m.content), kind=COALESCE($3,m.kind), metadata=COALESCE($4,m.metadata),updated_at=now(),
      last_reinforced_at=CASE WHEN $2::text IS NOT NULL AND $2<>m.content THEN now() ELSE m.last_reinforced_at END
      FROM workspaces w WHERE m.id=$1 AND m.workspace_id=w.id AND w.identity_id=$5 RETURNING m.id,m.workspace_id,m.content,m.kind,m.metadata,m.created_at`, [memoryId, body.content?.trim() || null, body.kind ?? null, body.metadata ? JSON.stringify(body.metadata) : null, identity?.id ?? '']); if (!result.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'MEMORY_NOT_FOUND', message: '记忆不存在或无权修改' } }); return reply.send({ ok: true, data: result.rows[0] });
  });
  app.delete('/api/v1/memories/:memoryId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'manage', reply); if (!identity) return;
    const { memoryId } = request.params as { memoryId: string }; const result = await deps.database.rawPool.query('DELETE FROM memories m USING workspaces w WHERE m.id=$1 AND m.workspace_id=w.id AND w.identity_id=$2 RETURNING m.id', [memoryId, identity.id]); if (!result.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'MEMORY_NOT_FOUND', message: '记忆不存在或无权删除' } }); return reply.send({ ok: true, data: null });
  });
  app.get('/api/v1/files', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    const query = request.query as { workspaceId?: string; projectId?: string; status?: string; limit?: string }; const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
    const result = await deps.database.rawPool.query(`SELECT f.id,f.workspace_id,f.name,f.storage_key,f.checksum,f.content_type,f.size_bytes,f.status,f.created_at FROM files f JOIN workspaces w ON w.id=f.workspace_id WHERE w.identity_id=$1 AND ($2::uuid IS NULL OR f.workspace_id=$2) AND ($3::text IS NULL OR f.status=$3) ORDER BY f.created_at DESC LIMIT $4`, [identity?.id ?? '', query.workspaceId ?? null, query.status ?? null, limit]);
    return reply.send({ ok: true, data: result.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, name: row.name, storageKey: row.storage_key, checksum: row.checksum, contentType: row.content_type, sizeBytes: Number(row.size_bytes), status: row.status, createdAt: new Date(row.created_at).toISOString() })) });
  });
  app.get('/api/v1/files/:fileId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    const { fileId } = request.params as { fileId: string };
    const result = await deps.database.rawPool.query('SELECT f.id,f.workspace_id,f.name,f.storage_key,f.checksum,f.content_type,f.size_bytes,f.status,f.created_at FROM files f JOIN workspaces w ON w.id=f.workspace_id WHERE f.id=$1 AND w.identity_id=$2', [fileId, identity?.id ?? '']);
    if (!result.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'FILE_NOT_FOUND', message: '文件不存在或无权访问' } }); const row = result.rows[0]; return reply.send({ ok: true, data: { id: row.id, workspaceId: row.workspace_id, name: row.name, storageKey: row.storage_key, checksum: row.checksum, contentType: row.content_type, sizeBytes: Number(row.size_bytes), status: row.status, createdAt: new Date(row.created_at).toISOString() } });
  });
  app.post('/api/v1/files/upload-sessions', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'write', reply); if (!identity) return;
    const body = request.body as { workspaceId?: string; fileName?: string; contentType?: string; sizeBytes?: number; checksum?: string }; if (!body.workspaceId || !body.fileName) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'workspaceId 和 fileName 为必填项' } });
    const owned = await deps.database.rawPool.query('SELECT id FROM workspaces WHERE id=$1 AND identity_id=$2', [body.workspaceId, identity.id]); if (!owned.rows[0]) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权上传到该工作区' } });
    const result = await deps.database.rawPool.query('INSERT INTO upload_sessions (identity_id,workspace_id,file_name,content_type,size_bytes,checksum) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,file_name,content_type,size_bytes,checksum,status,expires_at', [identity?.id, body.workspaceId, body.fileName, body.contentType ?? null, body.sizeBytes ?? 0, body.checksum ?? null]); return reply.code(201).send({ ok: true, data: { ...result.rows[0], uploadUrl: null, mode: 'server-multipart-placeholder' } });
  });
  app.get('/api/v1/me/permissions', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    if (identity?.type === 'personal') return reply.send({ ok: true, data: ['read', 'write', 'execute', 'manage', 'export'].map((code) => ({ code, description: '个人身份默认权限' })) });
    const result = await deps.database.rawPool.query('SELECT DISTINCT p.code,p.description FROM identity_roles ir JOIN role_permissions rp ON rp.role_id=ir.role_id JOIN permissions p ON p.id=rp.permission_id WHERE ir.identity_id=$1', [identity?.id ?? '']); return reply.send({ ok: true, data: result.rows });
  });
  app.get('/api/v1/skills', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    if (deps.mode !== 'mock') await ensureRuntimeRegistry(deps.database.rawPool, identity.id); const result = await deps.database.rawPool.query('SELECT code,name,description,tool_codes,enabled FROM runtime_skill_catalog WHERE identity_id=$1 ORDER BY created_at,code', [identity.id]); return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/conversations/:conversationId/runs/:runId/cancel', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await enforce(session, request, 'write', reply); if (!identity) return; const { conversationId, runId } = request.params as { conversationId: string; runId: string }; if (!(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '运行记录不存在或无权访问' } }); const result = await deps.database.rawPool.query("UPDATE conversation_runs SET status='cancelled', result=jsonb_build_object('cancelled',true), updated_at=now() WHERE id=$1 AND conversation_id=$2 AND status IN('queued','running','waiting_device','waiting_tool','waiting_approval') RETURNING *", [runId, conversationId]); if (!result.rows[0]) return reply.code(409).send({ ok: false, error: { code: 'RUN_NOT_ACTIVE', message: '运行已结束，无法取消' } }); await deps.database.rawPool.query("UPDATE runtime_tool_calls SET status='cancelled' WHERE step_id IN(SELECT id FROM conversation_run_steps WHERE run_id=$1) AND status IN('queued','running')", [runId]); await deps.database.rawPool.query("UPDATE conversation_run_steps SET status='cancelled' WHERE run_id=$1 AND status NOT IN('completed','failed')",[runId]); deps.loopWorker?.cancel(runId); return reply.send({ ok: true, data: result.rows[0] });
  });
  app.get('/api/v1/conversations/:conversationId/runs/:runId/steps', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { conversationId, runId } = request.params as { conversationId: string; runId: string }; const identity = await identityFor(session.userId, request);
    if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '运行记录不存在或无权访问' } });
    await requirePermission(deps.database.rawPool, identity.id, 'read');
    const result = await deps.database.rawPool.query('SELECT st.id,st.run_id,st.step_index,st.title,st.instruction,st.assigned_agent_id,st.status,st.result,st.depends_on,st.agent_snapshot,st.created_at,st.updated_at FROM conversation_run_steps st JOIN conversation_runs r ON r.id=st.run_id WHERE st.run_id=$1 AND r.conversation_id=$2 ORDER BY st.step_index', [runId,conversationId]); return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/conversations/:conversationId/runs/:runId/retry', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return; const { conversationId, runId } = request.params as { conversationId: string; runId: string }; const identity = await enforce(session, request, 'execute', reply); if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '运行记录不存在或无权访问' } });
    const run = await deps.accounts.listConversationRuns(conversationId); const source = run.find((item) => item.id === runId); if (!source) return reply.code(404).send({ ok: false, error: { code: 'RUN_NOT_FOUND', message: '运行记录不存在' } }); if (['queued','running','waiting_tool','waiting_device','waiting_approval'].includes(source.status)) return reply.code(409).send({ ok: false, error: { code: 'RUN_ACTIVE', message: '运行仍在执行中' } });
    if (!source.triggerMessageId) return reply.code(400).send({ ok: false, error: { code: 'RUN_NOT_RETRYABLE', message: '该运行没有可重试的触发消息' } }); const retried = await deps.accounts.createRun(conversationId, source.triggerMessageId, source.mode); deps.loopWorker?.kick(); return reply.send({ ok: true, data: retried });
  });
  app.post('/api/v1/memories/search', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    const body = request.body as { query?: string; workspaceId?: string; limit?: number };
    if (!body.query?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'query 不能为空' } });
    const limit = Math.min(Math.max(Number(body.limit ?? 10) || 10, 1), 50);
    // Long-term application is deliberately disabled; browsing and writes remain available.
    const result = await deps.database.rawPool.query(`SELECT m.id,m.workspace_id,m.content,m.kind,m.metadata,m.created_at,
      ts_rank(to_tsvector('simple',m.content), plainto_tsquery('simple',$2)) AS score
      FROM memories m JOIN workspaces w ON w.id=m.workspace_id WHERE w.identity_id=$1
        AND ($3::uuid IS NULL OR m.workspace_id=$3)
        AND m.kind IN ('short_term','short-term','task_summary','task_context')
        AND m.retained_until>now() AND (m.expires_at IS NULL OR m.expires_at>now())
        AND m.last_reinforced_at>now()-interval '30 days'
        AND to_tsvector('simple',m.content) @@ plainto_tsquery('simple',$2)
      ORDER BY score DESC,m.created_at DESC LIMIT $4`, [identity.id, body.query.trim(), body.workspaceId ?? null, limit]);
    return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/knowledge/search', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identity = await enforce(session, request, 'read', reply); if (!identity) return;
    const parsed = scopedSearchInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '请提供检索词和知识库或群聊 ID' } });
    const endpoint = serviceUrl;
    try {
      const data = await searchScopedKnowledge(deps.database.rawPool, identity.id, parsed.data, async (_collection, payload) => {
        const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/search`, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.KB_API_KEY ? { 'x-api-key': process.env.KB_API_KEY } : {}) }, body: JSON.stringify(payload) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
      return reply.send({ ok: true, data });
    } catch (error) {
      return reply.code(error instanceof Error && error.message === 'KNOWLEDGE_SCOPE_DENIED' ? 403 : 503)
        .send({ ok: false, error: { code: 'KNOWLEDGE_SCOPE_UNAVAILABLE', message: '知识检索权限过滤尚不可用，请稍后重试', retryable: true } });
    }
  });
  app.post('/api/v1/knowledge/read-document', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return; const body = request.body as { text?: string; offset?: number; maxChars?: number }; if (!body.text) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'text 不能为空' } }); const offset = Math.max(Number(body.offset ?? 0) || 0, 0); const maxChars = Math.min(Math.max(Number(body.maxChars ?? 12000) || 12000, 1000), 30000); return reply.send({ ok: true, data: { content: body.text.slice(offset, offset + maxChars), startOffset: offset, endOffset: Math.min(body.text.length, offset + maxChars), hasMore: offset + maxChars < body.text.length } });
  });
  app.get('/api/v1/operations/platforms', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return; const result = await deps.database.rawPool.query('SELECT id,name,base_url,description,status,metadata,created_at,updated_at FROM operation_platforms WHERE identity_id=$1 ORDER BY created_at DESC', [identity.id]); return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/operations/platforms', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await enforce(session, request, 'write', reply); if (!identity) return; const body = request.body as { name?: string; baseUrl?: string; description?: string; metadata?: Record<string, unknown> }; if (!body.name?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '平台名称不能为空' } }); const result = await deps.database.rawPool.query('INSERT INTO operation_platforms (identity_id,name,base_url,description,metadata) VALUES ($1,$2,$3,$4,$5) RETURNING *', [identity.id, body.name.trim(), body.baseUrl ?? '', body.description ?? '', JSON.stringify(body.metadata ?? {})]); return reply.code(201).send({ ok: true, data: result.rows[0] });
  });
  app.get('/api/v1/operations/platforms/:platformId/skills', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return; const { platformId } = request.params as { platformId: string }; const result = await deps.database.rawPool.query('SELECT s.* FROM operation_skills s JOIN operation_platforms p ON p.id=s.platform_id WHERE s.platform_id=$1 AND p.identity_id=$2 ORDER BY s.created_at DESC', [platformId, identity.id]); return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/operations/platforms/:platformId/skills', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await enforce(session, request, 'write', reply); if (!identity) return; const { platformId } = request.params as { platformId: string }; const body = request.body as { name?: string; description?: string; definition?: Record<string, unknown> }; if (!body.name?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '技能名称不能为空' } }); const owned = await deps.database.rawPool.query('SELECT id FROM operation_platforms WHERE id=$1 AND identity_id=$2', [platformId, identity.id]); if (!owned.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'PLATFORM_NOT_FOUND', message: '操作平台不存在' } }); const result = await deps.database.rawPool.query('INSERT INTO operation_skills (platform_id,name,description,definition) VALUES ($1,$2,$3,$4) RETURNING *', [platformId, body.name.trim(), body.description ?? '', JSON.stringify(body.definition ?? {})]); return reply.code(201).send({ ok: true, data: result.rows[0] });
  });
  app.post('/api/v1/operations/platforms/:platformId/execute', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await enforce(session, request, 'execute', reply); if (!identity) return; const { platformId } = request.params as { platformId: string }; const body = request.body as { instruction?: string; skillId?: string; mode?: string }; if (!body.instruction?.trim() && !body.skillId) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'instruction 或 skillId 至少提供一个' } }); const owned = await deps.database.rawPool.query('SELECT id FROM operation_platforms WHERE id=$1 AND identity_id=$2', [platformId, identity.id]); if (!owned.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'PLATFORM_NOT_FOUND', message: '操作平台不存在' } }); return reply.code(202).send({ ok: true, data: { taskId: randomUUID(), platformId, status: 'queued', executionMode: body.mode ?? 'visual_dom', message: '操作任务已进入执行队列' } });
  });
  app.get('/api/v1/meetings', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return; const result = await deps.database.rawPool.query('SELECT id,project_id,name,description,input_type,status,created_at,updated_at FROM meetings WHERE identity_id=$1 ORDER BY created_at DESC', [identity.id]); return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/meetings', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await enforce(session, request, 'write', reply); if (!identity) return; const body = request.body as { name?: string; description?: string; inputType?: 'audio_upload' | 'realtime'; projectId?: string }; if (!body.name?.trim() || !body.inputType) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '会议名称和输入类型不能为空' } }); const result = await deps.database.rawPool.query('INSERT INTO meetings (identity_id,project_id,name,description,input_type,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [identity.id, body.projectId ?? null, body.name.trim(), body.description ?? '', body.inputType, body.inputType === 'realtime' ? 'hardware_check_required' : 'waiting_upload']); return reply.code(201).send({ ok: true, data: result.rows[0] });
  });
  app.get('/api/v1/meetings/:meetingId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await enforce(session, request, 'read', reply); if (!identity) return; const { meetingId } = request.params as { meetingId: string }; const meeting = await deps.database.rawPool.query('SELECT m.* FROM meetings m WHERE m.id=$1 AND m.identity_id=$2', [meetingId, identity.id]); if (!meeting.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'MEETING_NOT_FOUND', message: '会议不存在或无权访问' } }); const segments = await deps.database.rawPool.query('SELECT id,speaker,content,start_ms,end_ms,confidence,created_at FROM meeting_segments WHERE meeting_id=$1 ORDER BY created_at', [meetingId]); return reply.send({ ok: true, data: { ...meeting.rows[0], segments: segments.rows } });
  });
  app.post('/api/v1/meetings/:meetingId/transcript', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identity = await enforce(session, request, 'write', reply); if (!identity) return; const { meetingId } = request.params as { meetingId: string }; const body = request.body as { speaker?: string; content?: string; startMs?: number; endMs?: number; confidence?: number }; if (!body.content?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '转写内容不能为空' } }); const owned = await deps.database.rawPool.query('SELECT id FROM meetings WHERE id=$1 AND identity_id=$2', [meetingId, identity.id]); if (!owned.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'MEETING_NOT_FOUND', message: '会议不存在' } }); const result = await deps.database.rawPool.query('INSERT INTO meeting_segments (meeting_id,speaker,content,start_ms,end_ms,confidence) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [meetingId, body.speaker ?? '未识别说话人', body.content.trim(), body.startMs ?? null, body.endMs ?? null, body.confidence ?? null]); await deps.database.rawPool.query("UPDATE meetings SET status='transcribing', transcript=concat(transcript, CASE WHEN transcript='' THEN '' ELSE E'\\n' END, $2), updated_at=now() WHERE id=$1", [meetingId, body.content.trim()]); return reply.send({ ok: true, data: result.rows[0] });
  });

  const placeholder = (path: string, method: string) => app.route({
    method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: `/api/v1${path}`,
    handler: async (_request, reply) => reply.code(501).send({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: `${method} ${path} 接口已完成契约占位，待接入服务实现。`, retryable: false }, meta: { requestId: _request.id } } satisfies ApiErrorBody),
  });
  const placeholders: Array<[string, string]> = [
    ['/knowledge/jobs', 'GET'],
    ['/projects/:projectId', 'GET'],
    ['/tasks', 'GET'], ['/tasks/:taskId', 'GET'], ['/usage/summary', 'GET'],
  ];
  for (const [path, method] of placeholders) placeholder(path, method);

  app.all('/api/v1/*', async (_request, reply) => reply.code(501).send({
    ok: false,
    error: { code: 'NOT_IMPLEMENTED', message: '该接口将在后续版本实现。', retryable: false },
    meta: { requestId: _request.id },
  } satisfies ApiErrorBody));
}
