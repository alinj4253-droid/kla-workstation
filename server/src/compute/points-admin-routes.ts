import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ComputeRepository } from './compute-repository.js';
import type { QuotaService } from './quota-service.js';
import { QuotaInsufficientError } from './quota-service.js';
import { availableBalance } from './types.js';

type AdminSession = { expiresAt: number };
const sessions = new Map<string, AdminSession>();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function tokenFrom(request: FastifyRequest): string {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
}

function error(reply: FastifyReply, status: number, code: string, message: string): void {
  reply.code(status).send({ ok: false, error: { code, message } });
}

export type PointsAdminRouteDeps = {
  computeRepo: ComputeRepository;
  quota: QuotaService;
  username?: string;
  password?: string;
};

export async function registerPointsAdminRoutes(app: FastifyInstance, deps: PointsAdminRouteDeps): Promise<void> {
  const username = deps.username ?? 'admin';
  const password = deps.password ?? 'admin123456';
  const pool = deps.computeRepo.pool;

  const authenticate = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const token = tokenFrom(request);
    const session = token ? sessions.get(token) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token);
      error(reply, 401, 'ADMIN_UNAUTHENTICATED', '管理后台登录已失效');
      return false;
    }
    return true;
  };

  app.post('/api/v1/admin/points/login', async (request, reply) => {
    const body = (request.body ?? {}) as { username?: string; password?: string };
    if (body.username !== username || body.password !== password) {
      return reply.code(401).send({ ok: false, error: { code: 'ADMIN_INVALID_CREDENTIALS', message: '管理员账号或密码错误' } });
    }
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
    return reply.send({ ok: true, data: { token, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(), username } });
  });

  app.post('/api/v1/admin/points/logout', async (request, reply) => {
    const token = tokenFrom(request);
    if (token) sessions.delete(token);
    return reply.send({ ok: true, data: null });
  });

  app.get('/api/v1/admin/points/companies', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    const query = request.query as { page?: string; pageSize?: string };
    const page = Math.max(1, Math.floor(Number(query.page ?? 1) || 1));
    // 后台统一固定 20 条/页，避免客户端任意放大单次查询。
    const pageSize = 20;
    const offset = (page - 1) * pageSize;
    const companyRowsSql = `
      WITH company_totals AS (
        SELECT i.organization_id,
          COALESCE(SUM(COALESCE(e.points_total, 0) + COALESCE(e.points_granted, 0) - COALESCE(e.points_used, 0) - COALESCE(e.points_reserved, 0)), 0) AS company_points
        FROM identities i
        LEFT JOIN compute_entitlements e ON e.identity_id = i.id
        WHERE i.type = 'enterprise' AND i.status = 'active' AND i.organization_id IS NOT NULL
        GROUP BY i.organization_id
      ), company_admins AS (
        SELECT i.organization_id,
          jsonb_agg(jsonb_build_object(
            'identityId', i.id,
            'email', u.email,
            'displayName', i.display_name,
            'available', COALESCE(e.points_total, 0) + COALESCE(e.points_granted, 0) - COALESCE(e.points_used, 0) - COALESCE(e.points_reserved, 0)
          ) ORDER BY u.email) AS admins
        FROM identities i
        JOIN users u ON u.id = i.user_id
        JOIN identity_roles ir ON ir.identity_id = i.id
        JOIN roles r ON r.id = ir.role_id AND r.organization_id = i.organization_id AND r.name = '管理员'
        LEFT JOIN compute_entitlements e ON e.identity_id = i.id
        WHERE i.type = 'enterprise' AND i.status = 'active'
        GROUP BY i.organization_id
      )
      SELECT o.id AS organization_id, o.name AS organization_name, o.status AS organization_status,
             COALESCE(a.admins, '[]'::jsonb) AS admins,
             COALESCE(t.company_points, 0) AS company_points
      FROM organizations o
      LEFT JOIN company_totals t ON t.organization_id = o.id
      LEFT JOIN company_admins a ON a.organization_id = o.id
      WHERE a.organization_id IS NOT NULL
      ORDER BY o.created_at DESC`;
    const [result, summaryResult] = await Promise.all([
      pool.query(`${companyRowsSql} LIMIT $1 OFFSET $2`, [pageSize, offset]),
      pool.query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(company_points), 0) AS total_points FROM (${companyRowsSql}) company_rows`),
    ]);
    const total = Number(summaryResult.rows[0]?.total ?? 0);
    const totalPoints = Number(summaryResult.rows[0]?.total_points ?? 0);
    return reply.send({ ok: true, data: {
      items: result.rows.map(row => ({
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      status: row.organization_status,
      companyPoints: Number(row.company_points ?? 0),
      admins: row.admins,
      })),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      summary: { totalCompanies: total, totalPoints },
    } });
  });

  app.post('/api/v1/admin/points/companies/:organizationId/grant', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    const { organizationId } = request.params as { organizationId: string };
    const body = (request.body ?? {}) as { identityId?: string; points?: number; requestId?: string };
    if (!body.identityId || !Number.isFinite(body.points) || Number(body.points) <= 0) {
      return error(reply, 400, 'INVALID_ARGUMENT', 'identityId 和正数 points 为必填项');
    }
    const member = await pool.query(`
      SELECT i.id
      FROM identities i
      JOIN identity_roles ir ON ir.identity_id = i.id
      JOIN roles r ON r.id = ir.role_id AND r.organization_id = i.organization_id AND r.name = '管理员'
      WHERE i.id = $1 AND i.organization_id = $2 AND i.type = 'enterprise' AND i.status = 'active'`, [body.identityId, organizationId]);
    if (!member.rows[0]) return error(reply, 404, 'ADMIN_NOT_FOUND', '该企业管理员身份不存在');
    try {
      const result = await deps.quota.grant({ identityId: body.identityId }, Number(body.points), body.requestId ?? randomBytes(12).toString('hex'));
      return reply.send({ ok: true, data: result });
    } catch (cause) {
      return error(reply, 500, 'GRANT_FAILED', cause instanceof Error ? cause.message : '增加积分失败');
    }
  });

  app.post('/api/v1/admin/points/companies/:organizationId/revoke', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    const { organizationId } = request.params as { organizationId: string };
    const body = (request.body ?? {}) as { identityId?: string; points?: number; requestId?: string };
    if (!body.identityId || !Number.isFinite(body.points) || Number(body.points) <= 0) {
      return error(reply, 400, 'INVALID_ARGUMENT', 'identityId 和正数 points 为必填项');
    }
    const member = await pool.query(`
      SELECT i.id
      FROM identities i
      JOIN identity_roles ir ON ir.identity_id = i.id
      JOIN roles r ON r.id = ir.role_id AND r.organization_id = i.organization_id AND r.name = '管理员'
      WHERE i.id = $1 AND i.organization_id = $2 AND i.type = 'enterprise' AND i.status = 'active'`, [body.identityId, organizationId]);
    if (!member.rows[0]) return error(reply, 404, 'ADMIN_NOT_FOUND', '该企业管理员身份不存在');
    try {
      const result = await deps.quota.revoke({ identityId: body.identityId }, Number(body.points), body.requestId ?? randomBytes(12).toString('hex'));
      return reply.send({ ok: true, data: result });
    } catch (cause) {
      const insufficient = cause instanceof QuotaInsufficientError;
      return error(reply, insufficient ? 409 : 500, insufficient ? 'INSUFFICIENT_BALANCE' : 'REVOKE_FAILED', cause instanceof Error ? cause.message : '收回积分失败');
    }
  });
}
