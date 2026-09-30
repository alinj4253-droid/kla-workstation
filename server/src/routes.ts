import type { FastifyInstance } from 'fastify';
import type { ApiErrorBody } from '@kla-workstation/contracts';
import type { AccountRepository } from './repositories/types.js';
import type { PostgresDatabase } from './database/postgres.js';
import type { RedisDatabase } from './infrastructure/redis.js';

export async function registerRoutes(app: FastifyInstance, deps: { accounts: AccountRepository; database?: PostgresDatabase; redis?: RedisDatabase }): Promise<void> {
  const auth = async (request: { headers: Record<string, string | string[] | undefined> }, reply: { code: (n: number) => { send: (v: unknown) => unknown } }) => {
    const raw = request.headers.authorization;
    const token = typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : '';
    const session = token ? await deps.accounts.getSession(token) : null;
    if (!session) { reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录', retryable: false }, meta: { requestId: request.id } } satisfies ApiErrorBody); return null; }
    return session;
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.get('/api/health', async () => ({
    ok: true,
    service: 'kla-backend' as const,
    version: '0.1.0',
    mode: 'postgres' as const,
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
    if (!body.password || (!body.email && !body.phone) || !body.nickname) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'email/phone、password、nickname 均为必填', retryable: false }, meta: { requestId: request.id } } satisfies ApiErrorBody);
    const result = await deps.accounts.register({ email: body.email, phone: body.phone, password: body.password, nickname: body.nickname });
    const session = await deps.accounts.createSession(result.user.id);
    return reply.send({ ok: true, data: { ...result, session } });
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = request.body as { identifier?: string; password?: string };
    const result = body.identifier && body.password ? await deps.accounts.authenticate(body.identifier, body.password) : null;
    if (!result) return reply.code(401).send({ ok: false, error: { code: 'INVALID_CREDENTIALS', message: '账号或密码错误', retryable: false }, meta: { requestId: request.id } } satisfies ApiErrorBody);
    const session = await deps.accounts.createSession(result.user.id);
    return reply.send({ ok: true, data: { ...result, session, identities: await deps.accounts.listIdentities(result.user.id) } });
  });
  app.post('/api/v1/auth/logout', async (request, reply) => { const raw = request.headers.authorization; if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录', retryable: false } }); await deps.accounts.revokeSession(raw.slice(7)); return reply.send({ ok: true, data: null }); });

  app.get('/api/v1/me/identities', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    const identities = await deps.accounts.listIdentities(session.userId);
    return reply.send({ ok: true, data: identities });
  });
  app.post('/api/v1/organizations', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    const body = request.body as { name?: string; licenseNumber?: string };
    if (!body.name?.trim() || !body.licenseNumber?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '企业名称和营业执照编码均为必填', retryable: false } });
    try { const identity = await deps.accounts.createOrganization(session.userId, body.name.trim(), body.licenseNumber.trim()); return reply.send({ ok: true, data: identity }); } catch (error) { if (error instanceof Error && error.message.includes('unique')) return reply.code(409).send({ ok: false, error: { code: 'ORGANIZATION_EXISTS', message: '企业信息已存在', retryable: false } }); throw error; }
  });
  app.post('/api/v1/organizations/join', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    const body = request.body as { inviteCode?: string }; if (!body.inviteCode?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '企业邀请码不能为空', retryable: false } });
    const identity = await deps.accounts.joinOrganization(session.userId, body.inviteCode); if (!identity) return reply.code(404).send({ ok: false, error: { code: 'INVITE_NOT_FOUND', message: '企业邀请码无效或企业已停用', retryable: false } }); return reply.send({ ok: true, data: identity });
  });
  app.post('/api/v1/me/identities/:identityId/activate', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return; const params = request.params as { identityId: string }; const identity = await deps.accounts.activateIdentity(session.userId, params.identityId); if (!identity) return reply.code(404).send({ ok: false, error: { code: 'IDENTITY_NOT_FOUND', message: '身份不存在或已停用', retryable: false } }); return reply.send({ ok: true, data: identity });
  });

  app.get('/api/v1/bootstrap', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identities = await deps.accounts.listIdentities(session.userId);
    const identity = identities.find((item) => item.isDefault && item.status === 'active') ?? identities[0];
    if (!identity) return reply.code(409).send({ ok: false, error: { code: 'IDENTITY_REQUIRED', message: '当前账号没有可用身份', retryable: false } });
    const pool = deps.database.rawPool;
    const [projects, conversations, workspaces, agents, models, tasks] = await Promise.all([
      deps.accounts.listProjects(identity.id),
      deps.accounts.listConversations(undefined, identity.id),
      pool.query('SELECT id, type, name, project_id FROM workspaces WHERE identity_id = $1 ORDER BY created_at', [identity.id]),
      pool.query('SELECT id, name, role, type, model_id, enabled, version FROM agents WHERE identity_id = $1 ORDER BY created_at', [identity.id]),
      pool.query('SELECT id, name, provider, capabilities, enabled FROM models WHERE enabled = true ORDER BY name'),
      pool.query('SELECT id, title, status, result, created_at FROM tasks WHERE identity_id = $1 ORDER BY created_at DESC LIMIT 50', [identity.id]),
    ]);
    return reply.send({ ok: true, data: { user: await deps.accounts.getUser(session.userId), identity, identities, projects, conversations, workspaces: workspaces.rows, agents: agents.rows, models: models.rows, tasks: tasks.rows } });
  });
  app.get('/api/v1/workspaces', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    return reply.send({ ok: true, data: (await deps.database.rawPool.query('SELECT id, type, name, project_id FROM workspaces WHERE identity_id = $1 ORDER BY created_at', [identity?.id ?? ''])).rows });
  });
  app.get('/api/v1/agents', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    return reply.send({ ok: true, data: (await deps.database.rawPool.query('SELECT id, name, role, type, model_id, enabled, version FROM agents WHERE identity_id = $1 ORDER BY created_at', [identity?.id ?? ''])).rows });
  });
  app.get('/api/v1/models', async (_request, reply) => {
    if (!deps.database?.rawPool) return reply.code(503).send({ ok: false, error: { code: 'DATABASE_NOT_CONFIGURED', message: '数据库未配置' } });
    return reply.send({ ok: true, data: (await deps.database.rawPool.query('SELECT id, name, provider, capabilities, enabled FROM models WHERE enabled = true ORDER BY name')).rows });
  });

  app.get('/api/v1/projects', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const ids = await deps.accounts.listIdentities(session.userId); return reply.send({ ok: true, data: await deps.accounts.listProjects(ids.find((item) => item.isDefault)?.id ?? '') }); });
  app.post('/api/v1/projects', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const body = request.body as { name?: string }; if (!body.name?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '项目名称不能为空', retryable: false } }); const ids = await deps.accounts.listIdentities(session.userId); return reply.send({ ok: true, data: await deps.accounts.createProject(ids.find((item) => item.isDefault)?.id ?? '', body.name.trim()) }); });
  app.get('/api/v1/conversations', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; return reply.send({ ok: true, data: await deps.accounts.listConversations(undefined, identity?.id) }); });
  app.post('/api/v1/conversations', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const body = request.body as { projectId?: string; name?: string }; if (!body.projectId || !body.name?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'projectId 和 name 为必填', retryable: false } }); const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const projects = await deps.accounts.listProjects(identity?.id ?? ''); if (!projects.some((project) => project.id === body.projectId)) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权访问该项目', retryable: false } }); return reply.send({ ok: true, data: await deps.accounts.createConversation(body.projectId, body.name.trim()) }); });
  app.get('/api/v1/conversations/:conversationId/messages', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const params = request.params as { conversationId: string }; return reply.send({ ok: true, data: await deps.accounts.listMessages(params.conversationId) }); });
  app.post('/api/v1/conversations/:conversationId/messages', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const params = request.params as { conversationId: string }; const body = request.body as { text?: string }; if (!body.text?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '消息不能为空', retryable: false }, meta: { requestId: request.id } } satisfies ApiErrorBody); return reply.send({ ok: true, data: await deps.accounts.createMessage(params.conversationId, session.userId, body.text.trim()) }); });

  const placeholder = (path: string, method: string) => app.route({
    method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: `/api/v1${path}`,
    handler: async (_request, reply) => reply.code(501).send({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: `${method} ${path} 接口已完成契约占位，待接入服务实现。`, retryable: false }, meta: { requestId: _request.id } } satisfies ApiErrorBody),
  });
  const placeholders: Array<[string, string]> = [
    ['/auth/refresh', 'POST'], ['/auth/sessions', 'GET'],
    ['/me/permissions', 'GET'], ['/me/entitlements', 'GET'], ['/me/identities/:identityId/default', 'PUT'],
    ['/organizations', 'GET'], ['/files', 'GET'], ['/files/upload-sessions', 'POST'],
    ['/files/:fileId', 'GET'], ['/knowledge/search', 'POST'], ['/knowledge/read-document', 'POST'], ['/knowledge/jobs', 'GET'],
    ['/projects/:projectId', 'GET'],
    ['/tasks', 'GET'], ['/tasks/:taskId', 'GET'], ['/skills', 'GET'], ['/usage/summary', 'GET'],
  ];
  for (const [path, method] of placeholders) placeholder(path, method);

  app.all('/api/v1/*', async (_request, reply) => reply.code(501).send({
    ok: false,
    error: { code: 'NOT_IMPLEMENTED', message: '该接口将在后续版本实现。', retryable: false },
    meta: { requestId: _request.id },
  } satisfies ApiErrorBody));
}
