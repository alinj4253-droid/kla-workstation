import type { FastifyInstance } from 'fastify';
import type { AccountRepository } from './repositories/types.js';

export async function registerRoutes(app: FastifyInstance, deps: { accounts: AccountRepository }): Promise<void> {
  const auth = async (request: { headers: Record<string, string | string[] | undefined> }, reply: { code: (n: number) => { send: (v: unknown) => unknown } }) => {
    const raw = request.headers.authorization;
    const token = typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : '';
    const session = token ? await deps.accounts.getSession(token) : null;
    if (!session) { reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录', retryable: false } }); return null; }
    return session;
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.get('/api/health', async () => ({
    ok: true,
    service: 'kla-backend' as const,
    version: '0.1.0',
    mode: 'placeholder' as const,
  }));

  app.get('/api/v1/me', async (_request, reply) => {
    const user = await deps.accounts.getUser('placeholder-user');
    return reply.send({ ok: true, data: user });
  });

  app.post('/api/v1/auth/register', async (request, reply) => {
    const body = request.body as { email?: string; phone?: string; password?: string; nickname?: string };
    if (!body.password || (!body.email && !body.phone) || !body.nickname) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'email/phone、password、nickname 均为必填', retryable: false } });
    const result = await deps.accounts.register({ email: body.email, phone: body.phone, password: body.password, nickname: body.nickname });
    const session = await deps.accounts.createSession(result.user.id);
    return reply.send({ ok: true, data: { ...result, session } });
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = request.body as { identifier?: string; password?: string };
    const result = body.identifier && body.password ? await deps.accounts.authenticate(body.identifier, body.password) : null;
    if (!result) return reply.code(401).send({ ok: false, error: { code: 'INVALID_CREDENTIALS', message: '账号或密码错误', retryable: false } });
    const session = await deps.accounts.createSession(result.user.id);
    return reply.send({ ok: true, data: { ...result, session } });
  });
  app.post('/api/v1/auth/logout', async (request, reply) => { const raw = request.headers.authorization; if (typeof raw === 'string') await deps.accounts.revokeSession(raw.slice(7)); return reply.send({ ok: true, data: null }); });

  app.get('/api/v1/me/identities', async (_request, reply) => {
    const identities = await deps.accounts.listIdentities('placeholder-user');
    return reply.send({ ok: true, data: identities });
  });

  app.get('/api/v1/projects', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const ids = await deps.accounts.listIdentities(session.userId); return reply.send({ ok: true, data: await deps.accounts.listProjects(ids.find((item) => item.isDefault)?.id ?? '') }); });
  app.post('/api/v1/projects', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const body = request.body as { name?: string }; if (!body.name?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '项目名称不能为空', retryable: false } }); const ids = await deps.accounts.listIdentities(session.userId); return reply.send({ ok: true, data: await deps.accounts.createProject(ids.find((item) => item.isDefault)?.id ?? '', body.name.trim()) }); });
  app.get('/api/v1/conversations', async (request, reply) => { const session = await auth(request, reply); if (!session) return; return reply.send({ ok: true, data: await deps.accounts.listConversations() }); });
  app.post('/api/v1/conversations', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const body = request.body as { projectId?: string; name?: string }; if (!body.projectId || !body.name?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'projectId 和 name 为必填', retryable: false } }); return reply.send({ ok: true, data: await deps.accounts.createConversation(body.projectId, body.name.trim()) }); });
  app.get('/api/v1/conversations/:conversationId/messages', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const params = request.params as { conversationId: string }; return reply.send({ ok: true, data: await deps.accounts.listMessages(params.conversationId) }); });
  app.post('/api/v1/conversations/:conversationId/messages', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const params = request.params as { conversationId: string }; const body = request.body as { text?: string }; if (!body.text?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '消息不能为空', retryable: false } }); return reply.send({ ok: true, data: await deps.accounts.createMessage(params.conversationId, session.userId, body.text.trim()) }); });

  const placeholder = (path: string, method: string) => app.route({
    method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: `/api/v1${path}`,
    handler: async (_request, reply) => reply.code(501).send({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: `${method} ${path} 接口已完成契约占位，待接入服务实现。`, retryable: false }, meta: { requestId: _request.id } }),
  });
  const placeholders: Array<[string, string]> = [
    ['/auth/register', 'POST'], ['/auth/login', 'POST'], ['/auth/refresh', 'POST'], ['/auth/logout', 'POST'], ['/auth/sessions', 'GET'],
    ['/me/permissions', 'GET'], ['/me/entitlements', 'GET'], ['/me/identities/:identityId/activate', 'POST'], ['/me/identities/:identityId/default', 'PUT'],
    ['/organizations', 'GET'], ['/organizations', 'POST'], ['/workspaces', 'GET'], ['/files', 'GET'], ['/files/upload-sessions', 'POST'],
    ['/files/:fileId', 'GET'], ['/knowledge/search', 'POST'], ['/knowledge/read-document', 'POST'], ['/knowledge/jobs', 'GET'],
    ['/projects', 'GET'], ['/projects/:projectId', 'GET'], ['/conversations', 'GET'], ['/conversations/:conversationId/messages', 'GET'],
    ['/tasks', 'GET'], ['/tasks/:taskId', 'GET'], ['/agents', 'GET'], ['/skills', 'GET'], ['/models', 'GET'], ['/usage/summary', 'GET'],
  ];
  for (const [path, method] of placeholders) placeholder(path, method);

  app.all('/api/v1/*', async (_request, reply) => reply.code(501).send({
    ok: false,
    error: { code: 'NOT_IMPLEMENTED', message: '该接口将在后续版本实现。', retryable: false },
    meta: { requestId: _request.id },
  }));
}
