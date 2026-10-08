import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PostgresDatabase } from './database/postgres.js';
import type { ComputeGateway } from './compute/gateway.js';
import { CatalogPool } from './mock/catalog-pool.js';
import { MemoryAccountRepository } from './mock/memory-account-repository.js';
import { registerRoutes } from './routes.js';

afterEach(() => vi.unstubAllEnvs());

async function setup(completeChat: ComputeGateway['completeChat']) {
  const accounts = new MemoryAccountRepository();
  const { user } = await accounts.register({ email: 'route-test@example.test', password: 'TestPass2026!', nickname: '网关回归' });
  const identity = await accounts.createOrganization(user.id, '回归企业', 'test-license');
  const session = await accounts.createSession(user.id);
  const project = await accounts.createProject(identity.id, '网关项目');
  const conversation = await accounts.createConversation(project.id, '网关群聊');
  const app = Fastify({ logger: false });
  const database = { rawPool: new CatalogPool(accounts) } as unknown as PostgresDatabase;
  await registerRoutes(app, { accounts, database, gateway: { completeChat }, mode: 'postgres' });
  return { app, accounts, identity, conversation, headers: { authorization: `Bearer ${session.accessToken}`, 'x-identity-id': identity.id } };
}

describe('conversation model gateway wiring', () => {
  it('uses the selected identity and conversation context without legacy model credentials', async () => {
    vi.stubEnv('MODEL_API_URL', '');
    vi.stubEnv('MODEL_API_KEY', '');
    const completeChat = vi.fn().mockResolvedValue({ payload: { choices: [{ message: { content: '蓝鲸项目由小林负责。' } }] } });
    const runtime = await setup(completeChat);
    try {
      await runtime.accounts.createMessage(runtime.conversation.id, runtime.identity.userId, '项目代号蓝鲸，负责人小林。');
      const response = await runtime.app.inject({ method: 'POST', url: `/api/v1/conversations/${runtime.conversation.id}/messages`, headers: runtime.headers, payload: { text: '按之前的信息写一份报告' } });
      expect(response.statusCode).toBe(200);
      const runId = response.json().data.run.id;
      await vi.waitFor(async () => expect((await runtime.accounts.listConversationRuns(runtime.conversation.id))[0].status).toBe('completed'));
      expect(completeChat).toHaveBeenCalledOnce();
      expect(completeChat.mock.calls[0][0]).toMatchObject({ id: runtime.identity.id, type: 'enterprise' });
      expect(completeChat.mock.calls[0][1]).toMatchObject({ requestId: `run:${runId}`, tags: { conversationId: runtime.conversation.id } });
      expect(completeChat.mock.calls[0][1].messages).toContainEqual({ role: 'user', content: '项目代号蓝鲸，负责人小林。' });
      const artifacts = await runtime.accounts.listArtifacts(runtime.identity.id, runtime.conversation.id);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].content).toContain('蓝鲸项目由小林负责。');
      const messages = await runtime.accounts.listMessages(runtime.conversation.id);
      expect(messages.at(-1)?.metadata?.artifactId).toBe(artifacts[0].id);
    } finally {
      await runtime.app.close();
    }
  });

  it.each(['gateway failure', 'empty model response'])('marks %s as failed without a fabricated artifact', async (failure) => {
    const completeChat = failure === 'gateway failure'
      ? vi.fn().mockRejectedValue(new Error('上游暂不可用'))
      : vi.fn().mockResolvedValue({ payload: { choices: [{ message: { content: '   ' } }] } });
    const runtime = await setup(completeChat);
    try {
      const response = await runtime.app.inject({ method: 'POST', url: `/api/v1/conversations/${runtime.conversation.id}/messages`, headers: runtime.headers, payload: { text: '输出成果报告' } });
      expect(response.statusCode).toBe(200);
      await vi.waitFor(async () => expect((await runtime.accounts.listConversationRuns(runtime.conversation.id))[0].status).toBe('failed'));
      expect(await runtime.accounts.listArtifacts(runtime.identity.id, runtime.conversation.id)).toEqual([]);
      expect((await runtime.accounts.listMessages(runtime.conversation.id)).at(-1)?.text).toContain('任务执行失败');
    } finally {
      await runtime.app.close();
    }
  });
});
