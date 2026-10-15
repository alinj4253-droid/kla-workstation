import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { PostgresDatabase } from '../database/postgres.js';
import { PostgresAccountRepository } from '../repositories/index.js';
import { registerRoutes } from '../routes.js';
import { ensureRuntimeRegistry, roomRegistry, validatePlan } from './registry.js';

const config = loadConfig();
const testCase = config.databaseUrl ? it : it.skip;

describe('群组选择智能体真实数据库链路', () => {
  testCase('固定统筹，只保存所选成员，拒绝跨身份和无效选择且不留下半成品群组', async () => {
    const schema = `kla_group_test_${randomUUID().replaceAll('-', '')}`;
    const database = new PostgresDatabase(config.databaseUrl, schema);
    const pool = database.rawPool!;
    const app = Fastify({ logger: false });
    try {
      await database.migrate(schema);
      const accounts = new PostgresAccountRepository(pool);
      await registerRoutes(app, { accounts, database });
      const account = await accounts.register({ email: 'group-owner@example.test', nickname: '群主', password: 'TestPass2026!' });
      const other = await accounts.register({ email: 'group-other@example.test', nickname: '其他身份', password: 'TestPass2026!' });
      const session = await accounts.createSession(account.user.id);
      const otherSession = await accounts.createSession(other.user.id);
      const headers = { authorization: `Bearer ${session.accessToken}`, 'x-identity-id': account.identity.id };
      const otherHeaders = { authorization: `Bearer ${otherSession.accessToken}`, 'x-identity-id': other.identity.id };
      const project = await accounts.createProject(account.identity.id, '选择智能体项目');
      const candidates = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/agents`, headers });
      expect(candidates.statusCode, candidates.body).toBe(200);
      const agents = candidates.json().data as Array<{ id: string; name: string }>;
      const coordinator = agents.find(agent => agent.name === '统筹智能体')!;
      const local = agents.find(agent => agent.name === '本地执行智能体')!;
      const ppt = agents.find(agent => agent.name === 'PPT助手')!;
      expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/agents`, headers: otherHeaders })).statusCode).toBe(403);
      const created = await app.inject({ method: 'POST', url: '/api/v1/conversations', headers, payload: { projectId: project.id, name: '  PPT群组  ', agentIds: [ppt.id] } });
      expect(created.statusCode, created.body).toBe(200);
      const room = created.json().data;
      expect(room.name).toBe('PPT群组');
      for (let i = 0; i < 2; i++) {
        const registry = await roomRegistry(pool, room.id);
        expect(registry.map(agent => agent.id).sort()).toEqual([coordinator.id, ppt.id].sort());
      }
      const members = await app.inject({ method: 'GET', url: `/api/v1/conversations/${room.id}/agents`, headers });
      expect(members.json().data).toHaveLength(2);
      expect(members.json().data.find((agent: { id: string }) => agent.id === coordinator.id).conversation_role).toBe('coordinator');
      expect((await accounts.listAllConversations(account.identity.id)).some(item => item.id === room.id)).toBe(true);
      await ensureRuntimeRegistry(pool, other.identity.id);
      const foreign = (await pool.query('SELECT id FROM agents WHERE identity_id=$1 LIMIT 1', [other.identity.id])).rows[0].id;
      await pool.query('UPDATE agents SET enabled=false WHERE id=$1', [local.id]);
      const countBefore = (await pool.query('SELECT count(*)::int AS total FROM conversations')).rows[0].total;
      for (const agentIds of [[], [ppt.id, ppt.id], [coordinator.id], [foreign], [local.id], [randomUUID()]]) {
        const failed = await app.inject({ method: 'POST', url: '/api/v1/conversations', headers, payload: { projectId: project.id, name: '不应创建', agentIds } });
        expect(failed.statusCode, failed.body).toBe(400);
      }
      expect((await pool.query('SELECT count(*)::int AS total FROM conversations')).rows[0].total).toBe(countBefore);
      expect((await app.inject({ method: 'POST', url: '/api/v1/conversations', headers: otherHeaders, payload: { projectId: project.id, name: '越权群组', agentIds: [ppt.id] } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/conversations/${room.id}/agents/${coordinator.id}`, headers })).statusCode).toBe(400);
      for (const [agentId, role] of [[coordinator.id, 'member'], [ppt.id, 'coordinator']]) {
        expect((await app.inject({ method: 'POST', url: `/api/v1/conversations/${room.id}/agents`, headers, payload: { agentId, role } })).statusCode).toBe(400);
      }
      const legacy = await app.inject({ method: 'POST', url: '/api/v1/conversations', headers, payload: { projectId: project.id, name: '原有调用' } });
      expect(legacy.statusCode, legacy.body).toBe(200);
      // HTTP 创建接口为兼容旧客户端，在省略 agentIds 时把当前可用智能体
      // 明确写入该群聊成员池；这仍然是“已加入”而不是运行时动态可见。
      const enabledPool = (await pool.query(`SELECT id FROM agents WHERE identity_id=$1 AND enabled AND name<>'统筹智能体'`, [account.identity.id])).rows.map(row => row.id as string);
      expect((await roomRegistry(pool, legacy.json().data.id)).map(agent => agent.id).sort()).toEqual([...enabledPool, coordinator.id].sort());
      // 直接创建的历史空群聊只惰性补齐必选群聊秘书，绝不把全局智能体目录
      // 当作成员池；后续必须通过群聊成员管理显式加入执行智能体。
      const emptyLegacy = (await pool.query('INSERT INTO conversations(project_id,name) VALUES($1,$2) RETURNING id', [project.id, '历史空群聊'])).rows[0] as { id: string };
      const emptyRegistry = await roomRegistry(pool, emptyLegacy.id);
      expect(emptyRegistry.map(agent => agent.id)).toEqual([coordinator.id]);
      expect(() => validatePlan({ tasks: [{ title: '越界任务', instruction: '不能执行', agentId: ppt.id, dependsOn: [] }] }, emptyRegistry)).toThrow('群聊外');
    } finally {
      await app.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await database.close();
    }
  }, 30_000);
});
