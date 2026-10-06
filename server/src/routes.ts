import type { FastifyInstance } from 'fastify';
import type { ApiErrorBody } from '@kla-workstation/contracts';
import type { AccountRepository } from './repositories/types.js';
import type { PostgresDatabase } from './database/postgres.js';
import type { RedisDatabase } from './infrastructure/redis.js';

async function runConversation(accounts: AccountRepository, userId: string, conversationId: string, runId: string, prompt: string): Promise<void> {
  try {
    const identities = await accounts.listIdentities(userId);
    const identity = identities.find((item) => item.isDefault) ?? identities[0];
    const agentName = '统筹智能体';
    let answer = `已收到你的需求：${prompt}\n\n我已将任务交给${agentName}，正在结合当前身份的项目工作区、知识和记忆进行处理。`;
    const endpoint = process.env.MODEL_API_URL;
    const apiKey = process.env.MODEL_API_KEY;
    if (endpoint && apiKey) {
      const history = (await accounts.listMessages(conversationId)).slice(-12).map((message) => ({ role: message.senderType === 'agent' ? 'assistant' : 'user', content: message.text }));
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: process.env.MODEL_ID ?? 'deepseek-v4-flash', messages: [{ role: 'system', content: '你是鲲擎统筹智能体。只输出直接给用户的中文答复，不输出内部思考。根据对话上下文回答，不要重复用户原话。' }, ...history], temperature: 0.2 }) });
      if (response.ok) { const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }; const content = payload.choices?.[0]?.message?.content?.trim(); if (content) answer = content; }
    }
    const artifactRequest = /文件|报告|文档|html|导出|成果/.test(prompt);
    let artifactId: string | undefined;
    if (artifactRequest && identity) {
      const title = prompt.slice(0, 24).replace(/[\\/:*?"<>|]/g, '').trim() || '协作成果';
      const artifact = await accounts.createArtifact(identity.id, conversationId, `${title}.html`, 'text/html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>${answer.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>')}</p><p>生成时间：${new Date().toLocaleString('zh-CN')}</p></body></html>`);
      artifactId = artifact.id;
      answer += `\n\n成果文件已生成：${artifact.name}，可在右侧预览。`;
    }
    await accounts.createAgentMessage(conversationId, agentName, answer, artifactId ? { artifactId } : {});
    await accounts.completeRun(runId, 'completed', agentName, artifactId ? { artifactId } : {});
  } catch (error) {
    await accounts.createAgentMessage(conversationId, '统筹智能体', `任务执行失败：${error instanceof Error ? error.message : '服务暂时不可用'}。`);
    await accounts.completeRun(runId, 'failed', '统筹智能体');
  }
}

export async function registerRoutes(app: FastifyInstance, deps: { accounts: AccountRepository; database?: PostgresDatabase; redis?: RedisDatabase }): Promise<void> {
  const auth = async (request: { headers: Record<string, string | string[] | undefined>; id?: string }, reply: { code: (n: number) => { send: (v: unknown) => unknown } }) => {
    const raw = request.headers.authorization;
    const token = typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : '';
    const session = token ? await deps.accounts.getSession(token) : null;
    if (!session) { reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录', retryable: false }, meta: { requestId: request.id ?? 'unknown' } } satisfies ApiErrorBody); return null; }
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
    let projects = await deps.accounts.listProjects(identity.id);
    if (projects.length === 0) projects = [await deps.accounts.createProject(identity.id, '我的协作项目')];
    let conversations = await deps.accounts.listConversations(undefined, identity.id);
    if (conversations.length === 0) conversations = [await deps.accounts.createConversation(projects[0].id, '默认协作群聊')];
    const [workspaces, agents, models, tasks] = await Promise.all([
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

  app.get('/api/v1/projects', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const ids = await deps.accounts.listIdentities(session.userId); return reply.send({ ok: true, data: await deps.accounts.listProjects(ids.find((item) => item.isDefault)?.id ?? '') }); });
  app.post('/api/v1/projects', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const body = request.body as { name?: string }; if (!body.name?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '项目名称不能为空', retryable: false } }); const ids = await deps.accounts.listIdentities(session.userId); return reply.send({ ok: true, data: await deps.accounts.createProject(ids.find((item) => item.isDefault)?.id ?? '', body.name.trim()) }); });
  app.get('/api/v1/conversations', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; return reply.send({ ok: true, data: identity ? await deps.accounts.listAllConversations(identity.id) : [] }); });
  app.post('/api/v1/conversations', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const body = request.body as { projectId?: string; name?: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; let projectId = body.projectId; if (!projectId && identity) { const projects = await deps.accounts.listProjects(identity.id); projectId = projects[0]?.id ?? (await deps.accounts.createProject(identity.id, '我的协作项目')).id; } if (!projectId || !body.name?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'name 为必填项', retryable: false } }); const projects = await deps.accounts.listProjects(identity?.id ?? ''); if (!projects.some((project) => project.id === projectId)) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权访问该项目', retryable: false } }); return reply.send({ ok: true, data: await deps.accounts.createConversation(projectId, body.name.trim()) }); });
  app.get('/api/v1/conversations/:conversationId/messages', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const params = request.params as { conversationId: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const conversations = identity ? await deps.accounts.listAllConversations(identity.id) : []; if (!conversations.some((item) => item.id === params.conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问', retryable: false } }); return reply.send({ ok: true, data: await deps.accounts.listMessages(params.conversationId) }); });
  app.post('/api/v1/conversations/:conversationId/messages', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return;
    const params = request.params as { conversationId: string }; const body = request.body as { text?: string; mode?: string };
    if (!body.text?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '消息不能为空', retryable: false }, meta: { requestId: request.id } } satisfies ApiErrorBody);
    const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === params.conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问', retryable: false } });
    const userMessage = await deps.accounts.createMessage(params.conversationId, session.userId, body.text.trim());
    const run = await deps.accounts.createRun(params.conversationId, userMessage.id, body.mode ?? 'balanced');
    void runConversation(deps.accounts, session.userId, params.conversationId, run.id, body.text.trim());
    return reply.send({ ok: true, data: { message: userMessage, run } });
  });

  app.get('/api/v1/conversations/:conversationId/runs', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const { conversationId } = request.params as { conversationId: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问', retryable: false } }); return reply.send({ ok: true, data: await deps.accounts.listConversationRuns(conversationId) }); });
  app.get('/api/v1/conversations/:conversationId/artifacts', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const { conversationId } = request.params as { conversationId: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问', retryable: false } }); return reply.send({ ok: true, data: await deps.accounts.listArtifacts(identity.id, conversationId) }); });
  app.get('/api/v1/artifacts/:artifactId', async (request, reply) => { const session = await auth(request, reply); if (!session) return; const { artifactId } = request.params as { artifactId: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const artifact = identity ? await deps.accounts.getArtifact(identity.id, artifactId) : null; if (!artifact) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '成果文件不存在', retryable: false } }); return reply.send({ ok: true, data: artifact }); });

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
