import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { runMigrations } from '../database/migrations.js';
import { PostgresAccountRepository } from '../repositories/postgres-account-repository.js';
import { effectiveToolCodes, ensureRuntimeRegistry, roomRegistry } from './registry.js';
import { registerRuntimeRoutes } from './routes.js';
import { ToolGateway } from './tool-gateway.js';
import type { RuntimeTools } from './tools.js';

const config = loadConfig();
const dbCase = config.databaseUrl ? it : it.skip;

describe('PPT assistant local gateway and artifact transport', () => {
  dbCase('registers an isolated preset, dispatches via gateway and commits a binary batch once', async () => {
    const schema = `kla_ppt_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema},public`, max: 5, connectionTimeoutMillis: 5000 });
    const app = Fastify();
    try {
      await runMigrations(pool, schema);
      await app.register(sensible);
      const accounts = new PostgresAccountRepository(pool);
      const account = await accounts.register({ email: 'ppt@example.test', nickname: 'PPT测试', password: 'TestPass2026!' });
      const session = await accounts.createSession(account.user.id);
      const project = await accounts.createProject(account.identity.id, 'PPT项目');
      const room = await accounts.createConversation(project.id, 'PPT群聊');
      const agent = (await roomRegistry(pool, room.id)).find(a => a.name === 'PPT助手')!;
      expect(agent.execution_location).toBe('local');
      expect(agent.skills).toContain('local_ppt_build');
      const other = await accounts.register({ email: 'other-ppt@example.test', nickname: '其他身份', password: 'TestPass2026!' });
      const otherSession = await accounts.createSession(other.user.id);
      await ensureRuntimeRegistry(pool, other.identity.id);
      expect((await pool.query("SELECT id FROM agents WHERE identity_id=$1 AND name='PPT助手'", [other.identity.id])).rows[0].id).not.toBe(agent.id);
      // User-edited mounts must not be restored by a later catalog read.
      await pool.query("DELETE FROM agent_skill_mounts WHERE agent_id=$1 AND skill_code='memory_context'", [agent.id]);
      await ensureRuntimeRegistry(pool, account.identity.id);
      expect(await effectiveToolCodes(pool, agent.id)).not.toContain('memory_recall');
      const trigger = await accounts.createMessage(room.id, account.user.id, '已确认大纲，生成 PPT');
      const run = await accounts.createRun(room.id, trigger.id, 'balanced');
      const step = (await pool.query('INSERT INTO conversation_run_steps(run_id,step_index,title,instruction,assigned_agent_id) VALUES($1,1,$2,$3,$4) RETURNING id', [run.id, '制作PPT', '生成', agent.id])).rows[0];
      await registerRuntimeRoutes(app, { pool, accounts, worker: { kick() {}, cancel() {} } as never });
      const headers = { authorization: `Bearer ${session.accessToken}`, 'x-identity-id': account.identity.id };
      const registered = await app.inject({ method: 'POST', url: '/api/v1/runtime/devices', headers, payload: {
        installationId: randomUUID(), name: 'PPT桌面', platform: 'win32', capabilities: ['local_ppt_doctor', 'local_ppt_build', 'local_ppt_inspect', 'local_ppt_render'],
      } });
      expect(registered.statusCode, registered.body).toBe(200);
      const deviceId = registered.json().data.id;
      const catalog = await app.inject({ method: 'GET', url: '/api/v1/runtime/tools', headers });
      expect(catalog.json().data.filter((t: { code: string }) => t.code.startsWith('local_ppt_'))).toHaveLength(6);
      expect(catalog.json().data.find((t: { code: string }) => t.code === 'local_ppt_build')).toMatchObject({ deviceOnline: true });
      const gateway = new ToolGateway(pool, {} as RuntimeTools);
      const scope = { identityId: account.identity.id, conversationId: room.id, runId: run.id, stepId: step.id, agent, deviceId };
      expect(gateway.discover(agent).some(t => t.function.name === 'local_ppt_build')).toBe(true);
      await expect(gateway.prepare({ ...scope, deviceId: null }, { id: 'no-device', function: { name: 'local_ppt_build', arguments: '{"specJson":"{}"}' } })).rejects.toThrow('本地执行设备');
      const prepared = await gateway.prepare(scope, { id: 'ppt-build-1', function: { name: 'local_ppt_build', arguments: '{"specJson":"{}","fileName":"方案.pptx"}' } });
      const client = await pool.connect();
      try { await client.query('BEGIN'); await gateway.enqueue(client, scope, prepared); await client.query('COMMIT'); }
      finally { client.release(); }
      await pool.query("UPDATE conversation_runs SET status='waiting_tool' WHERE id=$1", [run.id]);
      const pollUrl = `/api/v1/runtime/devices/${deviceId}/poll`;
      const poll = await app.inject({ method: 'POST', url: pollUrl, headers });
      expect(poll.statusCode, poll.body).toBe(200);
      const call = poll.json().data.call;
      expect(call.tool).toBe('local_ppt_build');
      const bytes = Buffer.from([80, 75, 3, 4, 1, 2, 3]);
      const makeFile = (fileName: string, mimeType: string, source: Buffer) => ({ fileName, mimeType, content: source.toString('base64'), contentEncoding: 'base64', checksum: createHash('sha256').update(source).digest('hex') });
      const payload = { receiptId: randomUUID(), status: 'completed', approval: { approved: true, decidedAt: new Date().toISOString() }, result: { qc: { ok: true, blocked: 0 }, renderStatus: 'completed' }, artifacts: [
        makeFile('方案.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes),
        makeFile('方案.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n')),
      ] };
      const url = `/api/v1/runtime/devices/${deviceId}/calls/${call.id}/receipt`;
      const corrupt = { ...payload, artifacts: [payload.artifacts[0], { ...payload.artifacts[1], checksum: '0'.repeat(64) }] };
      expect((await app.inject({ method: 'POST', url, headers, payload: corrupt })).statusCode).toBe(400);
      expect(await accounts.listArtifacts(account.identity.id, room.id)).toHaveLength(0);
      expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, result: { qc: { ok: false, blocked: 1 } } } })).statusCode).toBe(400);
      const receipt = await app.inject({ method: 'POST', url, headers, payload });
      expect(receipt.statusCode, receipt.body).toBe(200);
      const ids = receipt.json().data.artifactIds;
      expect(ids).toHaveLength(2);
      expect((await app.inject({ method: 'POST', url, headers, payload })).json().data.artifactIds).toEqual(ids);
      expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, receiptId: randomUUID() } })).statusCode).toBe(409);
      const files = await accounts.listArtifacts(account.identity.id, room.id);
      expect(files).toHaveLength(2);
      expect(files.every(file => file.contentEncoding === 'base64' && file.content === '')).toBe(true);
      const download = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${ids[0]}/download`, headers });
      expect(download.statusCode, download.body).toBe(200);
      expect(download.rawPayload).toEqual(bytes);
      expect(await accounts.getArtifact(other.identity.id, ids[0])).toBeNull();
      const foreignHeaders = { authorization: `Bearer ${otherSession.accessToken}`, 'x-identity-id': other.identity.id };
      expect((await app.inject({ method: 'GET', url: `/api/v1/artifacts/${ids[0]}/download`, headers: foreignHeaders })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: pollUrl, headers: foreignHeaders })).statusCode).toBe(404);
    } finally {
      await app.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }, 30_000);
});
