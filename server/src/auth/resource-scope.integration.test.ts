import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { PostgresDatabase } from '../database/postgres.js';
import { PostgresAccountRepository } from '../repositories/index.js';
import { registerRoutes } from '../routes.js';

const config = loadConfig();
const testCase = config.databaseUrl ? it : it.skip;

describe('project and conversation membership boundaries', () => {
  testCase('requires same-enterprise group membership for project knowledge and memory scope', async () => {
    const schema = `kla_scope_test_${randomUUID().replaceAll('-', '')}`;
    const database = new PostgresDatabase(config.databaseUrl, schema);
    const pool = database.rawPool!;
    const app = Fastify({ logger: false });
    try {
      await database.migrate(schema);
      const accounts = new PostgresAccountRepository(pool);
      await registerRoutes(app, { accounts, database });
      const owner = await accounts.register({ email: 'scope-owner@example.test', nickname: '创建者', password: 'TestPass2026!' });
      const member = await accounts.register({ email: 'scope-member@example.test', nickname: '成员', password: 'TestPass2026!' });
      const outsider = await accounts.register({ email: 'scope-outsider@example.test', nickname: '外部', password: 'TestPass2026!' });
      const adminIdentity = await accounts.createOrganization(owner.user.id, '同企业', 'scope-license');
      const organization = await accounts.getOrganization(adminIdentity.organizationId!);
      const memberIdentity = await accounts.joinOrganization(member.user.id, organization!.inviteCode);
      const otherEnterprise = await accounts.createOrganization(outsider.user.id, '其他企业', 'other-license');
      const project = await accounts.createProject(adminIdentity.id, '企业项目');
      const chat = await accounts.createConversation(project.id, '项目群聊');
      await accounts.createMessage(chat.id, owner.user.id, '项目内部讨论');
      const adminSession = await accounts.createSession(owner.user.id);
      const memberSession = await accounts.createSession(member.user.id);
      const outsiderSession = await accounts.createSession(outsider.user.id);
      const adminHeaders = { authorization: `Bearer ${adminSession.accessToken}`, 'x-identity-id': adminIdentity.id };
      const memberHeaders = { authorization: `Bearer ${memberSession.accessToken}`, 'x-identity-id': memberIdentity!.id };
      const personalHeaders = { authorization: `Bearer ${memberSession.accessToken}`, 'x-identity-id': member.identity.id };
      const otherHeaders = { authorization: `Bearer ${outsiderSession.accessToken}`, 'x-identity-id': otherEnterprise.id };
      const scope = async (headers: Record<string, string>) => (await app.inject({ method: 'GET', url: '/api/v1/me/knowledge-access-scope', headers })).json().data;

      expect((await scope(memberHeaders)).projectIds).toEqual([]);
      expect((await scope(personalHeaders)).organizationId).toBeNull();
      expect((await app.inject({ method: 'GET', url: '/api/v1/conversations', headers: memberHeaders })).json().data).toEqual([]);
      expect((await app.inject({ method: 'POST', url: `/api/v1/conversations/${chat.id}/members`, headers: adminHeaders, payload: { identityId: member.identity.id } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/v1/conversations/${chat.id}/members`, headers: adminHeaders, payload: { identityId: otherEnterprise.id } })).statusCode).toBe(403);

      const invited = await app.inject({ method: 'POST', url: `/api/v1/conversations/${chat.id}/members`, headers: adminHeaders, payload: { identityId: memberIdentity!.id } });
      expect(invited.statusCode).toBe(201);
      expect((await scope(memberHeaders)).projectIds).toEqual([project.id]);
      expect((await scope(personalHeaders)).projectIds).not.toContain(project.id);
      expect((await scope(otherHeaders)).projectIds).not.toContain(project.id);
      expect((await app.inject({ method: 'GET', url: '/api/v1/projects', headers: memberHeaders })).json().data.map((row: { id: string }) => row.id)).toContain(project.id);
      expect((await app.inject({ method: 'GET', url: '/api/v1/conversations', headers: memberHeaders })).json().data.map((row: { id: string }) => row.id)).toContain(chat.id);
      const remembered = await app.inject({ method: 'GET', url: `/api/v1/memories/browser?conversationId=${chat.id}&term=short_term`, headers: memberHeaders });
      expect(remembered.json().data.items.some((item: { content: string }) => item.content === '项目内部讨论')).toBe(true);
      expect((await app.inject({ method: 'GET', url: `/api/v1/memories/browser?conversationId=${chat.id}&term=short_term`, headers: personalHeaders })).json().data.page.total).toBe(0);
      const sent = await app.inject({ method: 'POST', url: `/api/v1/conversations/${chat.id}/messages`, headers: memberHeaders, payload: { text: '成员讨论' } });
      expect(sent.statusCode).toBe(200);
      expect(sent.json().data.run).toBeNull();

      expect((await app.inject({ method: 'DELETE', url: `/api/v1/conversations/${chat.id}/members/${memberIdentity!.id}`, headers: adminHeaders })).statusCode).toBe(200);
      expect((await scope(memberHeaders)).projectIds).toEqual([]);
      expect((await app.inject({ method: 'GET', url: `/api/v1/conversations/${chat.id}/messages`, headers: memberHeaders })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/v1/memories/browser?conversationId=${chat.id}&term=short_term`, headers: memberHeaders })).json().data.page.total).toBe(0);
    } finally {
      await app.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await database.close();
    }
  }, 30_000);
});
