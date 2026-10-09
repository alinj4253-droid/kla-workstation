import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { runMigrations } from '../database/migrations.js';
import { PostgresAccountRepository } from '../repositories/postgres-account-repository.js';
import { roomRegistry } from './registry.js';
import { registerRuntimeRoutes } from './routes.js';

const config = loadConfig();
const dbCase = config.databaseUrl ? it : it.skip;

describe('authenticated desktop execution protocol', () => {
  dbCase('claims a local call once and stores a validated artifact in the correct identity', async () => {
    const schema = `kla_device_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema},public`, max: 5, connectionTimeoutMillis: 5000 });
    const app = Fastify();
    try {
      await runMigrations(pool, schema);
      await app.register(sensible);
      const accounts = new PostgresAccountRepository(pool);
      const account = await accounts.register({ email: 'device@example.test', nickname: '设备测试', password: 'TestPass2026!' });
      const session = await accounts.createSession(account.user.id);
      const project = await accounts.createProject(account.identity.id, '本地项目');
      const room = await accounts.createConversation(project.id, '本地群聊');
      const agent = (await roomRegistry(pool, room.id)).find(item => item.name === '本地执行智能体')!;
      const trigger = await accounts.createMessage(room.id, account.user.id, '写入代码文件');
      const run = await accounts.createRun(room.id, trigger.id, 'balanced');
      const step = (await pool.query('INSERT INTO conversation_run_steps(run_id,step_index,title,instruction,assigned_agent_id) VALUES($1,1,$2,$3,$4) RETURNING id', [run.id, '写代码', '保存代码', agent.id])).rows[0];
      const worker = { kick() {}, cancel() {} };
      await registerRuntimeRoutes(app, { pool, accounts, worker: worker as never });
      const headers = { authorization: `Bearer ${session.accessToken}`, 'x-identity-id': account.identity.id };
      const registered = await app.inject({ method: 'POST', url: '/api/v1/runtime/devices', headers, payload: {
        installationId: randomUUID(), name: '测试桌面', platform: 'win32', capabilities: ['local_code'],
      } });
      expect(registered.statusCode).toBe(200);
      const deviceId = registered.json().data.id;
      const call = (await pool.query("INSERT INTO runtime_tool_calls(step_id,identity_id,device_id,model_call_id,tool_name,arguments) VALUES($1,$2,$3,'call-1','local_code',$4) RETURNING id", [step.id, account.identity.id, deviceId, JSON.stringify({ fileName: 'app.py', content: 'print(1)' })])).rows[0];
      await pool.query("UPDATE conversation_runs SET status='waiting_tool' WHERE id=$1", [run.id]);
      const url = `/api/v1/runtime/devices/${deviceId}/poll`;
      const first = await app.inject({ method: 'POST', url, headers });
      expect(first.statusCode).toBe(200);
      expect(first.json().data.call.id).toBe(call.id);
      const second = await app.inject({ method: 'POST', url, headers });
      expect(second.json().data.call).toBeNull();
      const content = 'print(1)\n';
      const receiptId = randomUUID();
      const receiptUrl = `/api/v1/runtime/devices/${deviceId}/calls/${call.id}/receipt`;
      const payload = { receiptId, status: 'completed', result: { stored: true }, artifact: { fileName: 'app.py', mimeType: 'text/plain', content, checksum: createHash('sha256').update(content).digest('hex') } };
      const receipt = await app.inject({ method: 'POST', url: receiptUrl, headers, payload });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json().data.artifactId).toBeTruthy();
      expect((await app.inject({ method: 'POST', url: receiptUrl, headers, payload })).statusCode).toBe(200);
      const artifacts = await accounts.listArtifacts(account.identity.id, room.id);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].content).toBe(content);
      const other = await accounts.register({ email: 'other-device@example.test', nickname: '其他身份', password: 'TestPass2026!' });
      const otherSession = await accounts.createSession(other.user.id);
      const denied = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${otherSession.accessToken}`, 'x-identity-id': other.identity.id } });
      expect(denied.statusCode).toBe(404);
    } finally {
      await app.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }, 25_000);
});
