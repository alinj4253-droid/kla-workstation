import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEMO_ACCOUNT, MemoryAccountRepository } from './memory-account-repository.js';
import { createMockServer } from './mock-server.js';

describe('mock server 契约联调', () => {
  let app: FastifyInstance;
  let accounts: MemoryAccountRepository;
  let token = '';

  const get = <T>(url: string, authToken = token) => app.inject({ method: 'GET', url, headers: authToken ? { authorization: `Bearer ${authToken}` } : {} }).then((response) => ({ status: response.statusCode, body: response.json() as T }));
  const post = <T>(url: string, payload?: Record<string, unknown>, authToken = token) => app.inject({ method: 'POST', url, headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...(authToken ? { authorization: `Bearer ${authToken}` } : {}) }, payload }).then((response) => ({ status: response.statusCode, body: response.json() as T }));

  beforeAll(async () => {
    ({ app, accounts } = await createMockServer({ logger: false }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('健康检查报告 mock 模式', async () => {
    const { status, body } = await get<{ ok: boolean; mode: string; service: string }>('/api/health');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, service: 'kla-backend', mode: 'mock' });
  });

  it('注册返回用户、默认身份与会话，/me 可访问', async () => {
    const register = await post<{ ok: boolean; data: { user: { nickname: string }; identity: { type: string; isDefault: boolean }; session: { accessToken: string } } }>('/api/v1/auth/register', { email: 'alice@example.com', password: 'password123', nickname: '爱丽丝' });
    expect(register.status).toBe(200);
    expect(register.body.data.user.nickname).toBe('爱丽丝');
    expect(register.body.data.identity).toMatchObject({ type: 'personal', isDefault: true });
    expect(register.body.data.session.accessToken).toBeTruthy();
    token = register.body.data.session.accessToken;

    const me = await get<{ ok: boolean; data: { nickname: string } }>('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.data.nickname).toBe('爱丽丝');
  });

  it('未携带令牌访问受保护接口返回统一错误信封', async () => {
    const { status, body } = await get<{ ok: boolean; error: { code: string } }>('/api/v1/me', '');
    expect(status).toBe(401);
    expect(body).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('演示账号可登录，bootstrap 返回种子目录', async () => {
    const login = await post<{ ok: boolean; data: { session: { accessToken: string }; identities: Array<{ type: string }> } }>('/api/v1/auth/login', { identifier: DEMO_ACCOUNT.identifier, password: DEMO_ACCOUNT.password });
    expect(login.status).toBe(200);
    expect(login.body.data.identities[0]?.type).toBe('personal');
    token = login.body.data.session.accessToken;

    const bootstrap = await get<{ ok: boolean; data: { projects: unknown[]; conversations: unknown[]; workspaces: unknown[]; agents: unknown[]; models: unknown[]; tasks: unknown[] } }>('/api/v1/bootstrap');
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.data.projects.length).toBeGreaterThanOrEqual(1);
    expect(bootstrap.body.data.conversations.length).toBeGreaterThanOrEqual(1);
    expect(bootstrap.body.data.workspaces.length).toBeGreaterThanOrEqual(1);
    expect(bootstrap.body.data.agents.map((agent) => (agent as { name: string }).name)).toEqual(expect.arrayContaining(['统筹智能体', '本地执行智能体']));
    expect(bootstrap.body.data.models.length).toBeGreaterThanOrEqual(6);
    expect(bootstrap.body.data.tasks).toEqual([]);
  });

  it('模型广场返回官方目录且 configured=false', async () => {
    const models = await get<{ ok: boolean; data: Array<{ id: string; is_official: boolean; configured: boolean }> }>('/api/v1/models');
    expect(models.status).toBe(200);
    expect(models.body.data.some((model) => model.id === 'deepseek-v4-flash')).toBe(true);
    expect(models.body.data.every((model) => model.configured === false)).toBe(true);
  });

  it('群聊消息触发智能体回复并生成成果文件', async () => {
    const conversations = await get<{ data: Array<{ id: string }> }>('/api/v1/conversations');
    const conversationId = conversations.body.data[0]!.id;
    const sent = await post<{ ok: boolean; data: { message: { id: string }; run: { id: string; status: string } } }>(`/api/v1/conversations/${conversationId}/messages`, { text: '请生成一份项目周报文档', mode: 'balanced' });
    expect(sent.status).toBe(200);
    expect(sent.body.data.run.status).toBe('running');

    await vi.waitFor(async () => {
      const messages = await get<{ data: Array<{ senderType: string; metadata?: { artifactId?: string } }> }>(`/api/v1/conversations/${conversationId}/messages`);
      const agentMessage = messages.body.data.find((message) => message.senderType === 'agent');
      expect(agentMessage).toBeDefined();
      expect(agentMessage?.metadata?.artifactId).toBeTruthy();
    }, { timeout: 3000 });

    const runs = await get<{ data: Array<{ status: string }> }>(`/api/v1/conversations/${conversationId}/runs`);
    expect(runs.body.data[0]?.status).toBe('completed');
  });

  it('模型测速能按 id 查到目录模型，未知 id 返回 404', async () => {
    const found = await post<{ ok: boolean; data: { success: boolean; error?: string } }>('/api/v1/models/deepseek-v4-flash/test');
    expect(found.status).toBe(200);
    expect(found.body.data.success).toBe(false);
    expect(found.body.data.error).toContain('API Key');
    const missing = await post<{ ok: boolean; error: { code: string } }>('/api/v1/models/no-such-model/test');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('MODEL_NOT_FOUND');
  });

  it('群聊添加智能体返回智能体信息', async () => {
    const conversations = await get<{ data: Array<{ id: string }> }>('/api/v1/conversations');
    const conversationId = conversations.body.data[0]!.id;
    const agents = await get<{ data: Array<{ id: string; name: string }> }>('/api/v1/agents');
    const agent = agents.body.data.find((item) => item.name === '本地执行智能体');
    expect(agent).toBeDefined();
    const added = await post<{ ok: boolean; data: { id: string; name: string } }>(`/api/v1/conversations/${conversationId}/agents`, { agentId: agent!.id });
    expect(added.status).toBe(200);
    expect(added.body.data).toMatchObject({ id: agent!.id, name: '本地执行智能体' });
  });

  it('企业身份可创建，凭有效邀请码可加入', async () => {
    const created = await post<{ ok: boolean; data: { id: string; type: string; organizationId: string | null } }>('/api/v1/organizations', { name: '鲲擎科技', licenseNumber: '91330100MA27XK8X00' });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ type: 'enterprise', organizationId: expect.any(String) });
    const inviteCode = accounts.getInviteCodeByName('鲲擎科技');
    expect(inviteCode).toBeTruthy();

    const joiner = await post<{ ok: boolean; data: { session: { accessToken: string } } }>('/api/v1/auth/register', { email: 'bob@example.com', password: 'password123', nickname: '鲍勃' });
    const joined = await post<{ ok: boolean; data: { type: string; organizationId: string | null } }>('/api/v1/organizations/join', { inviteCode }, joiner.body.data.session.accessToken);
    expect(joined.status).toBe(200);
    expect(joined.body.data).toMatchObject({ type: 'enterprise' });

    const invalid = await post<{ ok: boolean }>('/api/v1/organizations/join', { inviteCode: 'INVALID' }, joiner.body.data.session.accessToken);
    expect(invalid.status).toBe(404);
  });

  it('身份切换生效', async () => {
    const identities = await get<{ data: Array<{ id: string; type: string; isDefault: boolean }> }>('/api/v1/me/identities');
    const enterprise = identities.body.data.find((identity) => identity.type === 'enterprise');
    expect(enterprise).toBeDefined();
    const activated = await post<{ ok: boolean; data: { isDefault: boolean } }>(`/api/v1/me/identities/${enterprise!.id}/activate`);
    expect(activated.status).toBe(200);
    expect(activated.body.data.isDefault).toBe(true);
  });

  it('登出后会话失效', async () => {
    const logout = await post<{ ok: boolean }>('/api/v1/auth/logout');
    expect(logout.status).toBe(200);
    const me = await get<{ ok: boolean }>('/api/v1/me');
    expect(me.status).toBe(401);
    token = '';
  });
});
