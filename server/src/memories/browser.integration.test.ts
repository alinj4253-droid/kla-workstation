import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { memoryBrowserPageSchema, memoryBrowserScopesSchema } from '@kla-workstation/contracts';
import { loadConfig } from '../config.js';
import { PostgresDatabase } from '../database/postgres.js';
import { PostgresAccountRepository } from '../repositories/index.js';
import { registerRoutes } from '../routes.js';

const config = loadConfig();
const testCase = config.databaseUrl ? it : it.skip;

describe('memory browser Postgres and authenticated routes', () => {
  testCase('isolates identities, maps real sources and browses historical conversation context', async () => {
    const schema = `kla_memory_test_${randomUUID().replaceAll('-', '')}`;
    const database = new PostgresDatabase(config.databaseUrl, schema);
    const pool = database.rawPool!;
    const app = Fastify({ logger: false });
    try {
      await database.migrate(schema);
      const accounts = new PostgresAccountRepository(pool);
      await registerRoutes(app, { accounts, database });
      const owner = await accounts.register({ email: 'memory-owner@example.test', nickname: '记忆测试', password: 'TestPass2026!' });
      const identity = owner.identity;
      const other = await accounts.register({ email: 'memory-other@example.test', nickname: '其他用户', password: 'TestPass2026!' });
      const otherIdentity = other.identity;
      const secondary = await accounts.createOrganization(owner.user.id, '隔离企业', 'memory-test-license');
      const session = await accounts.createSession(owner.user.id);
      const headers = { authorization: `Bearer ${session.accessToken}`, 'x-identity-id': identity.id };
      const project = await accounts.createProject(identity.id, '项目甲');
      const projectTwo = await accounts.createProject(identity.id, '项目乙');
      const chat = await accounts.createConversation(project.id, '群组甲');
      const otherProject = await accounts.createProject(otherIdentity.id, '外部项目');
      const otherChat = await accounts.createConversation(otherProject.id, '外部群组');
      const agent = (await pool.query("INSERT INTO agents(identity_id,name) VALUES($1,'记忆编写智能体') RETURNING id", [identity.id])).rows[0];
      const projectOnlyAgent = (await pool.query("INSERT INTO agents(identity_id,name) VALUES($1,'项目分析智能体') RETURNING id", [identity.id])).rows[0];
      await pool.query('INSERT INTO conversation_agents(conversation_id,agent_id) VALUES($1,$2)', [chat.id, agent.id]);
      const workspace = (await pool.query("INSERT INTO workspaces(identity_id,type,project_id,name) VALUES($1,'project',$2,'项目甲工作区') RETURNING id", [identity.id, project.id])).rows[0];
      const workspaceTwo = (await pool.query("INSERT INTO workspaces(identity_id,type,project_id,name) VALUES($1,'project',$2,'项目乙工作区') RETURNING id", [identity.id, projectTwo.id])).rows[0];
      const otherWorkspace = (await pool.query("SELECT id FROM workspaces WHERE identity_id=$1 AND type='personal'", [otherIdentity.id])).rows[0];
      const addMemory = async (workspaceId: string, content: string, kind: string, metadata: object, expired = false) => pool.query('INSERT INTO memories(workspace_id,content,kind,metadata,expires_at) VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now()-interval \'1 hour\' ELSE NULL END)', [workspaceId, content, kind, JSON.stringify(metadata), expired]);
      await addMemory(workspace.id, '长期业务约定', 'long_term', { conversationId: chat.id, agentId: agent.id });
      await addMemory(workspace.id, '短期任务摘要', 'task_summary', { chatId: chat.id, agentName: '记忆编写智能体' });
      await addMemory(workspaceTwo.id, '项目级约定', 'long_term', { agentId: projectOnlyAgent.id });
      await addMemory(workspace.id, '过期任务', 'short_term', { conversationId: chat.id }, true);
      await addMemory(workspace.id, '错误跨群组关联', 'long_term', { conversationId: otherChat.id });
      await addMemory(workspace.id, '错误跨项目关联', 'long_term', { projectId: otherProject.id });
      await addMemory(workspace.id, '无效历史关联', 'long_term', { conversationId: 'bad-uuid' });
      await addMemory(otherWorkspace.id, '其他身份私密约定', 'long_term', {});
      for (let index = 0; index < 15; index++) {
        await pool.query('INSERT INTO messages(conversation_id,sender_id,text,sender_type,sender_name,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [chat.id, owner.user.id, `上下文 ${index}`, index % 2 ? 'agent' : 'user', index % 2 ? '记忆编写智能体' : null, JSON.stringify(index % 2 ? { agentId: agent.id } : {}), new Date(Date.now() - 60_000 + index * 1000)]);
      }
      const get = (url: string, requestHeaders = headers) => app.inject({ method: 'GET', url, headers: requestHeaders });
      expect((await app.inject({ method: 'GET', url: '/api/v1/memories/browser/scopes' })).statusCode).toBe(401);
      expect((await get('/api/v1/memories/browser/scopes', { ...headers, 'x-identity-id': otherIdentity.id })).statusCode).toBe(403);
      const scopeResponse = await get('/api/v1/memories/browser/scopes');
      expect(scopeResponse.statusCode).toBe(200);
      const scopes = memoryBrowserScopesSchema.parse(scopeResponse.json().data);
      expect(scopes.counts).toEqual({ longTerm: 1, shortTerm: 16 });
      expect(scopes.projects.some(item => item.id === otherProject.id)).toBe(false);
      expect(scopes.projects.find(item => item.id === project.id)?.agents).toContainEqual({ key: agent.id, name: '记忆编写智能体' });
      expect(scopes.projects.find(item => item.id === project.id)?.agents.some(item => item.key === projectOnlyAgent.id)).toBe(false);
      expect(scopes.projects.some(item => item.id === projectTwo.id)).toBe(false);
      const longResponse = await get(`/api/v1/memories/browser?projectId=${project.id}&conversationId=${chat.id}&agentKey=${agent.id}`);
      expect(longResponse.statusCode).toBe(200);
      const longPage = memoryBrowserPageSchema.parse(longResponse.json().data);
      expect(longPage.items.map(item => item.content)).toEqual(['长期业务约定']);
      expect(longPage.items[0]).toMatchObject({ projectId: project.id, conversationId: chat.id, agentName: '记忆编写智能体', source: 'stored_memory' });
      const shortResponse = await get(`/api/v1/memories/browser?conversationId=${chat.id}&term=short_term&agentKey=${agent.id}&pageSize=5`);
      expect(shortResponse.statusCode).toBe(200);
      const shortPage = memoryBrowserPageSchema.parse(shortResponse.json().data);
      expect(shortPage.page).toEqual({ page: 1, pageSize: 5, total: 16 });
      expect(shortPage.items).toHaveLength(5);
      expect(shortPage.items.some(item => item.shared && item.agentKey === 'shared')).toBe(true);
      const allShort = memoryBrowserPageSchema.parse((await get(`/api/v1/memories/browser?conversationId=${chat.id}&term=short_term`)).json().data);
      expect(allShort.items.filter(item => item.source === 'conversation_context')).toHaveLength(15);
      expect(allShort.items.some(item => item.content === '上下文 0')).toBe(true);
      expect(allShort.items.some(item => item.content === '短期任务摘要')).toBe(true);
      const secondPage = memoryBrowserPageSchema.parse((await get(`/api/v1/memories/browser?conversationId=${chat.id}&term=short_term&page=3&pageSize=5`)).json().data);
      expect(secondPage.items).toHaveLength(5);
      expect(secondPage.items.some(item => shortPage.items.some(first => first.id === item.id))).toBe(false);
      expect((await get('/api/v1/memories/browser?projectId=invalid')).statusCode).toBe(400);
      const forbiddenScope = memoryBrowserPageSchema.parse((await get(`/api/v1/memories/browser?conversationId=${otherChat.id}`)).json().data);
      expect(forbiddenScope.page.total).toBe(0);
      const separate = await get('/api/v1/memories/browser', { ...headers, 'x-identity-id': secondary.id });
      expect(separate.statusCode).toBe(200);
      expect(separate.json().data.items).toEqual([]);
    } finally {
      await app.close();
      // Only this test's isolated, randomly named schema is removed; user data is untouched.
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await database.close();
    }
  }, 30_000);
});
