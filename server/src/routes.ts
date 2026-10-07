import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ApiErrorBody } from '@kla-workstation/contracts';
import type { AccountRepository } from './repositories/types.js';
import type { PostgresDatabase } from './database/postgres.js';
import type { RedisDatabase } from './infrastructure/redis.js';

/** pino 子 logger 支持运行时 setBindings；FastifyBaseLogger 类型未暴露，且 logger:false 的 noop 实现没有该方法（规范 §3）。 */
function bindRequestLog(request: FastifyRequest, bindings: Record<string, unknown>): void {
  const log = request.log as FastifyRequest['log'] & Partial<{ setBindings: (bindings: Record<string, unknown>) => void }>;
  log.setBindings?.(bindings);
}

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

export async function registerRoutes(app: FastifyInstance, deps: { accounts: AccountRepository; database?: PostgresDatabase; redis?: RedisDatabase; mode?: 'postgres' | 'mock' }): Promise<void> {
  const auth = async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = request.headers.authorization;
    const token = typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : '';
    const session = token ? await deps.accounts.getSession(token) : null;
    if (!session) { reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录', retryable: false }, meta: { requestId: request.id } } satisfies ApiErrorBody); return null; }
    // 可观测性：认证通过后把操作者绑定到该请求的后续日志（规范 §3）
    bindRequestLog(request, { userId: session.userId });
    return session;
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

  // REST migration surface for the former local IPC capabilities.
  app.get('/api/v1/conversations/:conversationId/agents', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { conversationId } = request.params as { conversationId: string };
    const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问' } });
    const result = await deps.database.rawPool.query(`SELECT a.id, a.name, a.role, a.type, a.model_id, a.enabled, ca.role AS conversation_role FROM conversation_agents ca JOIN agents a ON a.id = ca.agent_id WHERE ca.conversation_id = $1 ORDER BY ca.created_at`, [conversationId]);
    return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/conversations/:conversationId/agents', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { conversationId } = request.params as { conversationId: string }; const body = request.body as { agentId?: string; role?: string };
    const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问' } });
    if (!body.agentId) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'agentId 为必填项' } });
    const agent = await deps.database.rawPool.query('SELECT id, name, role, type, model_id, enabled FROM agents WHERE id=$1 AND identity_id=$2', [body.agentId, identity.id]);
    if (!agent.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'AGENT_NOT_FOUND', message: '智能体不存在或无权使用' } });
    await deps.database.rawPool.query('INSERT INTO conversation_agents (conversation_id, agent_id, role) VALUES ($1,$2,$3) ON CONFLICT (conversation_id, agent_id) DO UPDATE SET role=EXCLUDED.role', [conversationId, body.agentId, body.role ?? 'member']);
    return reply.send({ ok: true, data: agent.rows[0] });
  });
  app.delete('/api/v1/conversations/:conversationId/agents/:agentId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { conversationId, agentId } = request.params as { conversationId: string; agentId: string };
    const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '群聊不存在或无权访问' } });
    await deps.database.rawPool.query('DELETE FROM conversation_agents WHERE conversation_id=$1 AND agent_id=$2', [conversationId, agentId]); return reply.send({ ok: true, data: null });
  });
  app.get('/api/v1/memories', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const query = request.query as { workspaceId?: string; kind?: string; limit?: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
    const result = await deps.database.rawPool.query(`SELECT m.id,m.workspace_id,m.content,m.kind,m.metadata,m.created_at FROM memories m JOIN workspaces w ON w.id=m.workspace_id WHERE w.identity_id=$1 AND ($2::uuid IS NULL OR m.workspace_id=$2) AND ($3::text IS NULL OR m.kind=$3) ORDER BY m.created_at DESC LIMIT $4`, [identity?.id ?? '', query.workspaceId ?? null, query.kind ?? null, limit]);
    return reply.send({ ok: true, data: result.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, content: row.content, kind: row.kind, metadata: row.metadata ?? {}, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.created_at).toISOString() })) });
  });
  app.post('/api/v1/memories', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const body = request.body as { workspaceId?: string; content?: string; kind?: string; metadata?: Record<string, unknown> }; if (!body.workspaceId || !body.content?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'workspaceId 和 content 为必填项' } });
    const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const owner = await deps.database.rawPool.query('SELECT id FROM workspaces WHERE id=$1 AND identity_id=$2', [body.workspaceId, identity?.id ?? '']); if (!owner.rows[0]) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权写入该工作区记忆' } });
    const result = await deps.database.rawPool.query('INSERT INTO memories (workspace_id,content,kind,metadata) VALUES ($1,$2,$3,$4) RETURNING id,workspace_id,content,kind,metadata,created_at', [body.workspaceId, body.content.trim(), body.kind ?? 'long_term', JSON.stringify(body.metadata ?? {})]); return reply.send({ ok: true, data: result.rows[0] });
  });
  app.patch('/api/v1/memories/:memoryId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { memoryId } = request.params as { memoryId: string }; const body = request.body as { content?: string; kind?: string; metadata?: Record<string, unknown> }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    const result = await deps.database.rawPool.query(`UPDATE memories m SET content=COALESCE($2,m.content), kind=COALESCE($3,m.kind), metadata=COALESCE($4,m.metadata) FROM workspaces w WHERE m.id=$1 AND m.workspace_id=w.id AND w.identity_id=$5 RETURNING m.id,m.workspace_id,m.content,m.kind,m.metadata,m.created_at`, [memoryId, body.content?.trim() || null, body.kind ?? null, body.metadata ? JSON.stringify(body.metadata) : null, identity?.id ?? '']); if (!result.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'MEMORY_NOT_FOUND', message: '记忆不存在或无权修改' } }); return reply.send({ ok: true, data: result.rows[0] });
  });
  app.delete('/api/v1/memories/:memoryId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { memoryId } = request.params as { memoryId: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const result = await deps.database.rawPool.query('DELETE FROM memories m USING workspaces w WHERE m.id=$1 AND m.workspace_id=w.id AND w.identity_id=$2 RETURNING m.id', [memoryId, identity?.id ?? '']); if (!result.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'MEMORY_NOT_FOUND', message: '记忆不存在或无权删除' } }); return reply.send({ ok: true, data: null });
  });
  app.get('/api/v1/files', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const query = request.query as { workspaceId?: string; projectId?: string; status?: string; limit?: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
    const result = await deps.database.rawPool.query(`SELECT f.id,f.workspace_id,f.name,f.storage_key,f.checksum,f.content_type,f.size_bytes,f.status,f.created_at FROM files f JOIN workspaces w ON w.id=f.workspace_id WHERE w.identity_id=$1 AND ($2::uuid IS NULL OR f.workspace_id=$2) AND ($3::text IS NULL OR f.status=$3) ORDER BY f.created_at DESC LIMIT $4`, [identity?.id ?? '', query.workspaceId ?? null, query.status ?? null, limit]);
    return reply.send({ ok: true, data: result.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, name: row.name, storageKey: row.storage_key, checksum: row.checksum, contentType: row.content_type, sizeBytes: Number(row.size_bytes), status: row.status, createdAt: new Date(row.created_at).toISOString() })) });
  });
  app.get('/api/v1/files/:fileId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { fileId } = request.params as { fileId: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    const result = await deps.database.rawPool.query('SELECT f.id,f.workspace_id,f.name,f.storage_key,f.checksum,f.content_type,f.size_bytes,f.status,f.created_at FROM files f JOIN workspaces w ON w.id=f.workspace_id WHERE f.id=$1 AND w.identity_id=$2', [fileId, identity?.id ?? '']);
    if (!result.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'FILE_NOT_FOUND', message: '文件不存在或无权访问' } }); const row = result.rows[0]; return reply.send({ ok: true, data: { id: row.id, workspaceId: row.workspace_id, name: row.name, storageKey: row.storage_key, checksum: row.checksum, contentType: row.content_type, sizeBytes: Number(row.size_bytes), status: row.status, createdAt: new Date(row.created_at).toISOString() } });
  });
  app.post('/api/v1/files/upload-sessions', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const body = request.body as { workspaceId?: string; fileName?: string; contentType?: string; sizeBytes?: number; checksum?: string }; if (!body.workspaceId || !body.fileName) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'workspaceId 和 fileName 为必填项' } });
    const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const owned = await deps.database.rawPool.query('SELECT id FROM workspaces WHERE id=$1 AND identity_id=$2', [body.workspaceId, identity?.id ?? '']); if (!owned.rows[0]) return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: '无权上传到该工作区' } });
    const result = await deps.database.rawPool.query('INSERT INTO upload_sessions (identity_id,workspace_id,file_name,content_type,size_bytes,checksum) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,file_name,content_type,size_bytes,checksum,status,expires_at', [identity?.id, body.workspaceId, body.fileName, body.contentType ?? null, body.sizeBytes ?? 0, body.checksum ?? null]); return reply.code(201).send({ ok: true, data: { ...result.rows[0], uploadUrl: null, mode: 'server-multipart-placeholder' } });
  });
  app.get('/api/v1/me/permissions', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    const result = await deps.database.rawPool.query('SELECT DISTINCT p.code,p.description FROM identity_roles ir JOIN role_permissions rp ON rp.role_id=ir.role_id JOIN permissions p ON p.id=rp.permission_id WHERE ir.identity_id=$1', [identity?.id ?? '']); return reply.send({ ok: true, data: result.rows });
  });
  app.get('/api/v1/skills', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    const result = await deps.database.rawPool.query('SELECT s.id,s.agent_id,s.name,s.description,s.definition,s.enabled,s.version,a.name AS agent_name FROM skills s JOIN agents a ON a.id=s.agent_id WHERE a.identity_id=$1 ORDER BY s.created_at', [identity?.id ?? '']); return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/conversations/:conversationId/runs/:runId/cancel', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const { conversationId, runId } = request.params as { conversationId: string; runId: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '运行记录不存在或无权访问' } }); const result = await deps.database.rawPool.query("UPDATE conversation_runs SET status='failed', result=jsonb_build_object('cancelled',true), updated_at=now() WHERE id=$1 AND conversation_id=$2 AND status='running' RETURNING *", [runId, conversationId]); if (!result.rows[0]) return reply.code(409).send({ ok: false, error: { code: 'RUN_NOT_ACTIVE', message: '运行已结束，无法取消' } }); return reply.send({ ok: true, data: result.rows[0] });
  });
  app.get('/api/v1/conversations/:conversationId/runs/:runId/steps', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { conversationId, runId } = request.params as { conversationId: string; runId: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0];
    if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '运行记录不存在或无权访问' } });
    const result = await deps.database.rawPool.query('SELECT id,run_id,step_index,title,instruction,assigned_agent_id,status,result,created_at,updated_at FROM conversation_run_steps WHERE run_id=$1 ORDER BY step_index', [runId]); return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/conversations/:conversationId/runs/:runId/steps', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return;
    const { conversationId, runId } = request.params as { conversationId: string; runId: string }; const body = request.body as { steps?: Array<{ title?: string; instruction?: string; assignedAgentId?: string }> };
    const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '运行记录不存在或无权访问' } });
    if (!Array.isArray(body.steps) || body.steps.length === 0) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'steps 不能为空' } });
    const client = await deps.database.rawPool.connect(); try { await client.query('BEGIN'); await client.query('DELETE FROM conversation_run_steps WHERE run_id=$1', [runId]); for (const [index, step] of body.steps.entries()) { if (!step.title?.trim()) throw new Error('STEP_TITLE_REQUIRED'); await client.query('INSERT INTO conversation_run_steps (run_id,step_index,title,instruction,assigned_agent_id) VALUES ($1,$2,$3,$4,$5)', [runId, index + 1, step.title.trim(), step.instruction?.trim() ?? '', step.assignedAgentId ?? null]); } await client.query('COMMIT'); } catch (error) { await client.query('ROLLBACK'); return reply.code(400).send({ ok: false, error: { code: 'INVALID_STEPS', message: error instanceof Error ? error.message : '步骤保存失败' } }); } finally { client.release(); }
    return reply.send({ ok: true, data: { runId, count: body.steps.length } });
  });
  app.post('/api/v1/conversations/:conversationId/runs/:runId/retry', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return; const { conversationId, runId } = request.params as { conversationId: string; runId: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; if (!identity || !(await deps.accounts.listAllConversations(identity.id)).some((item) => item.id === conversationId)) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '运行记录不存在或无权访问' } });
    const run = await deps.accounts.listConversationRuns(conversationId); const source = run.find((item) => item.id === runId); if (!source) return reply.code(404).send({ ok: false, error: { code: 'RUN_NOT_FOUND', message: '运行记录不存在' } }); if (source.status === 'running') return reply.code(409).send({ ok: false, error: { code: 'RUN_ACTIVE', message: '运行仍在执行中' } });
    if (!source.triggerMessageId) return reply.code(400).send({ ok: false, error: { code: 'RUN_NOT_RETRYABLE', message: '该运行没有可重试的触发消息' } }); const retried = await deps.accounts.createRun(conversationId, source.triggerMessageId, source.mode); return reply.send({ ok: true, data: retried });
  });
  app.post('/api/v1/memories/search', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const body = request.body as { query?: string; workspaceId?: string; limit?: number }; if (!body.query?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'query 不能为空' } }); const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const limit = Math.min(Math.max(Number(body.limit ?? 10) || 10, 1), 50); const result = await deps.database.rawPool.query(`SELECT m.id,m.workspace_id,m.content,m.kind,m.metadata,m.created_at, ts_rank(to_tsvector('simple',m.content), plainto_tsquery('simple',$2)) AS score FROM memories m JOIN workspaces w ON w.id=m.workspace_id WHERE w.identity_id=$1 AND ($3::uuid IS NULL OR m.workspace_id=$3) AND to_tsvector('simple',m.content) @@ plainto_tsquery('simple',$2) ORDER BY score DESC,m.created_at DESC LIMIT $4`, [identity?.id ?? '', body.query.trim(), body.workspaceId ?? null, limit]); return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/knowledge/search', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return; const body = request.body as { query?: string; collection?: string; mode?: string; topK?: number }; if (!body.query?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'query 不能为空' } }); const endpoint = process.env.KNOWLEDGE_SERVICE_URL ?? 'http://127.0.0.1:8120';
    try { const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/search`, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.KB_API_KEY ? { 'x-api-key': process.env.KB_API_KEY } : {}) }, body: JSON.stringify({ query: body.query.trim(), collection: body.collection ?? 'kb_m3', mode: body.mode ?? 'hybrid', top_k: Math.min(Math.max(Number(body.topK ?? 5) || 5, 1), 20) }) }); const data = await response.json().catch(() => ({})); if (!response.ok) return reply.code(502).send({ ok: false, error: { code: 'KNOWLEDGE_SERVICE_ERROR', message: `知识服务返回 HTTP ${response.status}` } }); return reply.send({ ok: true, data }); } catch (error) { return reply.code(503).send({ ok: false, error: { code: 'KNOWLEDGE_SERVICE_UNAVAILABLE', message: error instanceof Error ? error.message : '知识服务不可用', retryable: true } }); }
  });
  app.post('/api/v1/knowledge/read-document', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return; const body = request.body as { text?: string; offset?: number; maxChars?: number }; if (!body.text) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'text 不能为空' } }); const offset = Math.max(Number(body.offset ?? 0) || 0, 0); const maxChars = Math.min(Math.max(Number(body.maxChars ?? 12000) || 12000, 1000), 30000); return reply.send({ ok: true, data: { content: body.text.slice(offset, offset + maxChars), startOffset: offset, endOffset: Math.min(body.text.length, offset + maxChars), hasMore: offset + maxChars < body.text.length } });
  });
  app.get('/api/v1/operations/platforms', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const result = await deps.database.rawPool.query('SELECT id,name,base_url,description,status,metadata,created_at,updated_at FROM operation_platforms WHERE identity_id=$1 ORDER BY created_at DESC', [identity?.id ?? '']); return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/operations/platforms', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const body = request.body as { name?: string; baseUrl?: string; description?: string; metadata?: Record<string, unknown> }; if (!body.name?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '平台名称不能为空' } }); const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const result = await deps.database.rawPool.query('INSERT INTO operation_platforms (identity_id,name,base_url,description,metadata) VALUES ($1,$2,$3,$4,$5) RETURNING *', [identity?.id, body.name.trim(), body.baseUrl ?? '', body.description ?? '', JSON.stringify(body.metadata ?? {})]); return reply.code(201).send({ ok: true, data: result.rows[0] });
  });
  app.get('/api/v1/operations/platforms/:platformId/skills', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const { platformId } = request.params as { platformId: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const result = await deps.database.rawPool.query('SELECT s.* FROM operation_skills s JOIN operation_platforms p ON p.id=s.platform_id WHERE s.platform_id=$1 AND p.identity_id=$2 ORDER BY s.created_at DESC', [platformId, identity?.id ?? '']); return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/operations/platforms/:platformId/skills', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const { platformId } = request.params as { platformId: string }; const body = request.body as { name?: string; description?: string; definition?: Record<string, unknown> }; if (!body.name?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '技能名称不能为空' } }); const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const owned = await deps.database.rawPool.query('SELECT id FROM operation_platforms WHERE id=$1 AND identity_id=$2', [platformId, identity?.id ?? '']); if (!owned.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'PLATFORM_NOT_FOUND', message: '操作平台不存在' } }); const result = await deps.database.rawPool.query('INSERT INTO operation_skills (platform_id,name,description,definition) VALUES ($1,$2,$3,$4) RETURNING *', [platformId, body.name.trim(), body.description ?? '', JSON.stringify(body.definition ?? {})]); return reply.code(201).send({ ok: true, data: result.rows[0] });
  });
  app.post('/api/v1/operations/platforms/:platformId/execute', async (request, reply) => {
    const session = await auth(request, reply); if (!session) return; const { platformId } = request.params as { platformId: string }; const body = request.body as { instruction?: string; skillId?: string; mode?: string }; if (!body.instruction?.trim() && !body.skillId) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'instruction 或 skillId 至少提供一个' } }); return reply.code(202).send({ ok: true, data: { taskId: randomUUID(), platformId, status: 'queued', executionMode: body.mode ?? 'visual_dom', message: '操作任务已进入执行队列' } });
  });
  app.get('/api/v1/meetings', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const result = await deps.database.rawPool.query('SELECT id,project_id,name,description,input_type,status,created_at,updated_at FROM meetings WHERE identity_id=$1 ORDER BY created_at DESC', [identity?.id ?? '']); return reply.send({ ok: true, data: result.rows });
  });
  app.post('/api/v1/meetings', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const body = request.body as { name?: string; description?: string; inputType?: 'audio_upload' | 'realtime'; projectId?: string }; if (!body.name?.trim() || !body.inputType) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '会议名称和输入类型不能为空' } }); const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const result = await deps.database.rawPool.query('INSERT INTO meetings (identity_id,project_id,name,description,input_type,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [identity?.id, body.projectId ?? null, body.name.trim(), body.description ?? '', body.inputType, body.inputType === 'realtime' ? 'hardware_check_required' : 'waiting_upload']); return reply.code(201).send({ ok: true, data: result.rows[0] });
  });
  app.get('/api/v1/meetings/:meetingId', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const { meetingId } = request.params as { meetingId: string }; const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const meeting = await deps.database.rawPool.query('SELECT m.* FROM meetings m WHERE m.id=$1 AND m.identity_id=$2', [meetingId, identity?.id ?? '']); if (!meeting.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'MEETING_NOT_FOUND', message: '会议不存在或无权访问' } }); const segments = await deps.database.rawPool.query('SELECT id,speaker,content,start_ms,end_ms,confidence,created_at FROM meeting_segments WHERE meeting_id=$1 ORDER BY created_at', [meetingId]); return reply.send({ ok: true, data: { ...meeting.rows[0], segments: segments.rows } });
  });
  app.post('/api/v1/meetings/:meetingId/transcript', async (request, reply) => {
    const session = await auth(request, reply); if (!session || !deps.database?.rawPool) return; const { meetingId } = request.params as { meetingId: string }; const body = request.body as { speaker?: string; content?: string; startMs?: number; endMs?: number; confidence?: number }; if (!body.content?.trim()) return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '转写内容不能为空' } }); const identities = await deps.accounts.listIdentities(session.userId); const identity = identities.find((item) => item.isDefault) ?? identities[0]; const owned = await deps.database.rawPool.query('SELECT id FROM meetings WHERE id=$1 AND identity_id=$2', [meetingId, identity?.id ?? '']); if (!owned.rows[0]) return reply.code(404).send({ ok: false, error: { code: 'MEETING_NOT_FOUND', message: '会议不存在' } }); const result = await deps.database.rawPool.query('INSERT INTO meeting_segments (meeting_id,speaker,content,start_ms,end_ms,confidence) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [meetingId, body.speaker ?? '未识别说话人', body.content.trim(), body.startMs ?? null, body.endMs ?? null, body.confidence ?? null]); await deps.database.rawPool.query("UPDATE meetings SET status='transcribing', transcript=concat(transcript, CASE WHEN transcript='' THEN '' ELSE E'\\n' END, $2), updated_at=now() WHERE id=$1", [meetingId, body.content.trim()]); return reply.send({ ok: true, data: result.rows[0] });
  });

  const placeholder = (path: string, method: string) => app.route({
    method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: `/api/v1${path}`,
    handler: async (_request, reply) => reply.code(501).send({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: `${method} ${path} 接口已完成契约占位，待接入服务实现。`, retryable: false }, meta: { requestId: _request.id } } satisfies ApiErrorBody),
  });
  const placeholders: Array<[string, string]> = [
    ['/auth/refresh', 'POST'], ['/auth/sessions', 'GET'],
    ['/me/entitlements', 'GET'], ['/me/identities/:identityId/default', 'PUT'],
    ['/organizations', 'GET'],
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
