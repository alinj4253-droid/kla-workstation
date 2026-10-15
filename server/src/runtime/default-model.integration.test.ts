import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_MODEL_ID } from '@kla-workstation/contracts';
import { loadConfig } from '../config.js';
import { runMigrations } from '../database/migrations.js';
import { ComputeRepository } from '../compute/compute-repository.js';
import { PostgresAccountRepository } from '../repositories/postgres-account-repository.js';
import { AgentLoopWorker } from '../infrastructure/agent-loop.js';
import { ShortTermMemoryService } from '../memories/short-term.js';
import { ensureRuntimeRegistry, roomRegistry } from './registry.js';
import { registerRuntimeRoutes } from './routes.js';

const config = loadConfig();
const dbCase = config.databaseUrl ? it : it.skip;
async function withDatabase(work: (pool: Pool, accounts: PostgresAccountRepository, compute: ComputeRepository) => Promise<void>) {
  const schema = `kla_default_model_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema},public`, max: 6, connectionTimeoutMillis: 5000 });
  try {
    await runMigrations(pool, schema);
    await work(pool, new PostgresAccountRepository(pool), new ComputeRepository(pool));
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}
function defaultKey(compute: ComputeRepository, identityId: string) {
  return compute.recordDefaultKey({ identityId, sub2apiKeyId: randomUUID(), keyPrefix: 'test-prefix', keyFingerprint: randomUUID(), name: '默认工作站 Key' });
}

describe('persisted default agent mounts', () => {
  dbCase('handles both provisioning orders and keeps personal, enterprise admin and member keys isolated', async () => {
    await withDatabase(async (pool, accounts, compute) => {
      const owner = await accounts.register({ email: 'owner@example.test', nickname: '创建者', password: 'TestPass2026!' });
      await ensureRuntimeRegistry(pool, owner.identity.id);
      expect((await pool.query('SELECT model_key_id,model_mount_initialized FROM agents WHERE identity_id=$1', [owner.identity.id])).rows)
        .toEqual(expect.arrayContaining([expect.objectContaining({ model_key_id: null, model_mount_initialized: false })]));
      const personalKey = await defaultKey(compute, owner.identity.id);
      const enterprise = await accounts.createOrganization(owner.user.id, '默认挂载测试企业', 'LICENSE-TEST');
      const enterpriseKey = await defaultKey(compute, enterprise.id);
      await ensureRuntimeRegistry(pool, enterprise.id);
      const other = await accounts.register({ email: 'member@example.test', nickname: '成员', password: 'TestPass2026!' });
      const code = (await pool.query('SELECT invite_code FROM organizations WHERE id=$1', [enterprise.organizationId])).rows[0].invite_code;
      const member = (await accounts.joinOrganization(other.user.id, code))!;
      await ensureRuntimeRegistry(pool, member.id);
      const memberKey = await defaultKey(compute, member.id);
      for (const [identityId, keyId] of [[owner.identity.id, personalKey.id], [enterprise.id, enterpriseKey.id], [member.id, memberKey.id]]) {
        const agents = (await pool.query('SELECT name,model_id,model_key_id,model_mount_initialized FROM agents WHERE identity_id=$1', [identityId])).rows;
        expect(agents).toHaveLength(6);
        expect(agents.map(agent => agent.name)).toEqual(expect.arrayContaining(['统筹智能体', '本地执行智能体', 'PPT助手', '路线规划助手', '建潘-三一规划智能体', '经营分析助手']));
        for (const agent of agents) expect(agent).toMatchObject({ model_id: DEFAULT_AGENT_MODEL_ID, model_key_id: keyId, model_mount_initialized: true });
      }
      const versions = (await pool.query('SELECT id,version FROM agents ORDER BY id')).rows;
      await Promise.all([ensureRuntimeRegistry(pool, owner.identity.id), compute.initializeAgentModels(owner.identity.id)]);
      expect((await pool.query('SELECT id,version FROM agents ORDER BY id')).rows).toEqual(versions);
      expect((await pool.query('SELECT count(*)::int AS count FROM agents WHERE identity_id=$1 AND model_key_id IS NOT NULL', [other.identity.id])).rows[0].count).toBe(0);
    });
  }, 25_000);

  dbCase('returns defaults for created agents, preserves user overrides/unmounts and rejects another identity key', async () => {
    await withDatabase(async (pool, accounts, compute) => {
      const account = await accounts.register({ email: 'agent@example.test', nickname: '默认挂载', password: 'TestPass2026!' });
      const key = await defaultKey(compute, account.identity.id);
      await compute.upsertBinding({ identityId: account.identity.id, sub2apiUserId: 'test-user', sub2apiUsername: 'test@example.test', managedPassword: 'test-password', status: 'ready' });
      const alternate = await compute.createKey({ identityId: account.identity.id, sub2apiKeyId: randomUUID(), keyPrefix: 'alternate', keyFingerprint: randomUUID(), name: '自选 Key', groupId: null, quota: null, rpm: null, ipAllowList: [], expiresAt: null, createdBy: account.identity.id });
      const session = await accounts.createSession(account.user.id);
      const headers = { authorization: `Bearer ${session.accessToken}`, 'x-identity-id': account.identity.id };
      const app = Fastify();
      try {
        await app.register(sensible);
        await registerRuntimeRoutes(app, { pool, accounts, worker: { kick() {}, cancel() {} } as never, computeRepo: compute,
          sub2api: { getUserJwt: async () => 'test-jwt', resolveApiKeySecret: async () => 'test-secret', listModels: async () => [DEFAULT_AGENT_MODEL_ID, 'deepseek-chat'] } as never });
        const create = await app.inject({ method: 'POST', url: '/api/v1/agents', headers, payload: { name: '自建助手', role: '回答问题', modelId: null, modelKeyId: null } });
        expect(create.statusCode, create.body).toBe(201);
        const agent = create.json().data;
        expect(agent).toMatchObject({ model_id: DEFAULT_AGENT_MODEL_ID, model_key_id: key.id });
        const url = `/api/v1/agents/${agent.id}`;
        const changed = await app.inject({ method: 'PATCH', url, headers, payload: { modelId: 'deepseek-chat', modelKeyId: alternate.id } });
        expect(changed.statusCode, changed.body).toBe(200);
        await compute.initializeAgentModels(account.identity.id);
        await ensureRuntimeRegistry(pool, account.identity.id);
        expect((await pool.query('SELECT model_id,model_key_id FROM agents WHERE id=$1', [agent.id])).rows[0])
          .toEqual({ model_id: 'deepseek-chat', model_key_id: alternate.id });
        const other = await accounts.register({ email: 'isolated@example.test', nickname: '另一身份', password: 'TestPass2026!' });
        const otherKey = await defaultKey(compute, other.identity.id);
        const denied = await app.inject({ method: 'PATCH', url, headers, payload: { modelId: DEFAULT_AGENT_MODEL_ID, modelKeyId: otherKey.id } });
        expect(denied.statusCode).toBe(400);
        const cleared = await app.inject({ method: 'PATCH', url, headers, payload: { modelId: null, modelKeyId: null } });
        expect(cleared.statusCode, cleared.body).toBe(200);
        await compute.initializeAgentModels(account.identity.id);
        await ensureRuntimeRegistry(pool, account.identity.id);
        expect((await pool.query('SELECT model_id,model_key_id,model_mount_initialized FROM agents WHERE id=$1', [agent.id])).rows[0])
          .toEqual({ model_id: null, model_key_id: null, model_mount_initialized: true });
      } finally { await app.close(); }
    });
  }, 25_000);

  dbCase('uses the persisted default key and GLM model throughout planning, execution and summary', async () => {
    await withDatabase(async (pool, accounts, compute) => {
      const account = await accounts.register({ email: 'loop-default@example.test', nickname: '默认对话', password: 'TestPass2026!' });
      const key = await defaultKey(compute, account.identity.id);
      const project = await accounts.createProject(account.identity.id, '默认模型项目');
      const room = await accounts.createConversation(project.id, '默认模型群聊');
      const agent = (await roomRegistry(pool, room.id)).find(item => item.name === '本地执行智能体')!;
      await pool.query("UPDATE agents SET execution_location='server' WHERE id=$1", [agent.id]);
      const trigger = await accounts.createMessage(room.id, account.user.id, '你好');
      const requests: string[] = [];
      const completeChat = vi.fn(async (_identity, input: { model: string; keyId: string; requestId: string }) => {
        expect(input.model).toBe(DEFAULT_AGENT_MODEL_ID);
        expect(input.keyId).toBe(key.id);
        requests.push(input.requestId);
        return { payload: { choices: [{ message: input.requestId.endsWith(':plan')
          ? { tool_calls: [{ id: 'plan', type: 'function', function: { name: 'delegate_tasks', arguments: JSON.stringify({ tasks: [
            { title: '回答', instruction: '回答用户', agentId: agent.id, dependsOn: [] },
            { title: '检查', instruction: '检查回答', agentId: agent.id, dependsOn: [1] },
          ] }) } }] }
          : { content: '你好，已收到。' } }] } };
      });
      const worker = new AgentLoopWorker(pool, accounts, { completeChat } as never, new ShortTermMemoryService(pool));
      try {
        await accounts.createRun(room.id, trigger.id, 'balanced');
        worker.start(50);
        await vi.waitFor(async () => expect((await accounts.listConversationRuns(room.id))[0]?.status).toBe('completed'), { timeout: 15_000, interval: 100 });
        expect(requests.some(id => id.endsWith(':plan'))).toBe(true);
        expect(requests.some(id => id.includes(':step:'))).toBe(true);
        expect(requests.some(id => id.endsWith(':summary'))).toBe(true);
      } finally { await worker.stop(); }
    });
  }, 25_000);
});
