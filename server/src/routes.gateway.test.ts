import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { PostgresDatabase } from './database/postgres.js';
import { CatalogPool } from './mock/catalog-pool.js';
import { MemoryAccountRepository } from './mock/memory-account-repository.js';
import { registerRoutes } from './routes.js';

describe('durable conversation entry point', () => {
  it('never fabricates a model answer or an artifact when no loop worker is installed', async () => {
    const accounts = new MemoryAccountRepository();
    const { user } = await accounts.register({ email: 'route-test@example.test', password: 'TestPass2026!', nickname: '网关回归' });
    const identity = await accounts.createOrganization(user.id, '回归企业', 'test-license');
    const session = await accounts.createSession(user.id);
    const project = await accounts.createProject(identity.id, '网关项目');
    const conversation = await accounts.createConversation(project.id, '网关群聊');
    const app = Fastify({ logger: false });
    const gateway = { completeChat: vi.fn() };
    const database = { rawPool: new CatalogPool(accounts) } as unknown as PostgresDatabase;
    await registerRoutes(app, { accounts, database, gateway, mode: 'mock' });
    try {
      const response = await app.inject({ method: 'POST', url: `/api/v1/conversations/${conversation.id}/messages`,
        headers: { authorization: `Bearer ${session.accessToken}`, 'x-identity-id': identity.id }, payload: { text: '请写报告', submitObject: [{ type: 'command', id: 'task_execution' }] } });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.run.status).toBe('failed');
      expect(gateway.completeChat).not.toHaveBeenCalled();
      expect(await accounts.listArtifacts(identity.id, conversation.id)).toEqual([]);
      expect((await accounts.listMessages(conversation.id)).map(message => message.senderType)).toEqual(['user']);
    } finally { await app.close(); }
  });

  it('returns the original message and run for a retried idempotent send', async () => {
    const accounts = new MemoryAccountRepository();
    const { user } = await accounts.register({ email: 'idempotency@example.test', password: 'TestPass2026!', nickname: '幂等测试' });
    const identity = await accounts.createOrganization(user.id, '幂等企业', 'idempotency-license');
    const session = await accounts.createSession(user.id);
    const project = await accounts.createProject(identity.id, '幂等项目');
    const conversation = await accounts.createConversation(project.id, '幂等群聊');
    const app = Fastify({ logger: false });
    const database = { rawPool: new CatalogPool(accounts) } as unknown as PostgresDatabase;
    await registerRoutes(app, { accounts, database, mode: 'mock' });
    try {
      const payload = { text: '只执行一次', idempotencyKey: '4f3c7b1b-53f4-4c07-a1e8-1c2c3a8a5e21', submitObject: [{ type: 'command', id: 'task_execution' }] };
      const headers = { authorization: `Bearer ${session.accessToken}`, 'x-identity-id': identity.id };
      const first = await app.inject({ method: 'POST', url: `/api/v1/conversations/${conversation.id}/messages`, headers, payload });
      const second = await app.inject({ method: 'POST', url: `/api/v1/conversations/${conversation.id}/messages`, headers, payload });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().data.message.id).toBe(first.json().data.message.id);
      expect(second.json().data.run.id).toBe(first.json().data.run.id);
      expect(await accounts.listMessages(conversation.id)).toHaveLength(1);
      expect(await accounts.listConversationRuns(conversation.id)).toHaveLength(1);
    } finally { await app.close(); }
  });
});
