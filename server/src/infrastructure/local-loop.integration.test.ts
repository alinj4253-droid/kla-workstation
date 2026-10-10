import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { runMigrations } from '../database/migrations.js';
import { PostgresAccountRepository } from '../repositories/postgres-account-repository.js';
import { ShortTermMemoryService } from '../memories/short-term.js';
import { registerRuntimeRoutes } from '../runtime/routes.js';
import { roomRegistry } from '../runtime/registry.js';
import { AgentLoopWorker } from './agent-loop.js';

const config = loadConfig();
const dbCase = config.databaseUrl ? it : it.skip;

describe('local multi-agent conversation loop', () => {
  dbCase.each(['local_code', 'local_ppt_build'] as const)('delegates %s through the gateway, receives all desktop artifacts, and completes the chat', async (tool) => {
    const schema = `kla_local_loop_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema},public`, max: 6, connectionTimeoutMillis: 5000 });
    const app = Fastify();
    let worker: AgentLoopWorker | undefined;
    try {
      await runMigrations(pool, schema);
      await app.register(sensible);
      const accounts = new PostgresAccountRepository(pool);
      const account = await accounts.register({ email: 'local-loop@example.test', nickname: '本地链路测试', password: 'TestPass2026!' });
      const session = await accounts.createSession(account.user.id);
      const project = await accounts.createProject(account.identity.id, '本地联调项目');
      const room = await accounts.createConversation(project.id, '本地联调群聊');
      const agent = (await roomRegistry(pool, room.id)).find(item => item.name === (tool === 'local_code' ? '本地执行智能体' : 'PPT助手'))!;
      expect(agent.execution_location).toBe('local');
      const completeChat = vi.fn(async (_identity, request: { requestId: string }) => {
        let message: unknown;
        if (request.requestId.endsWith(':plan')) message = { tool_calls: [{ id: 'plan-local', type: 'function', function: {
          name: 'delegate_tasks', arguments: JSON.stringify({ tasks: [{ title: '编写代码', instruction: '保存 app.py', agentId: agent.id, dependsOn: [] }] }),
        } }] };
        else if (request.requestId.endsWith(':turn:0')) message = { tool_calls: [{ id: 'code-local', type: 'function', function: {
          name: tool, arguments: JSON.stringify(tool === 'local_code' ? { fileName: 'app.py', content: 'print(42)\n' } : { fileName: '方案.pptx', specJson: '{}' }),
        } }] };
        else message = { content: '代码文件已完成，可以预览。' };
        return { payload: { choices: [{ message }] } };
      });
      worker = new AgentLoopWorker(pool, accounts, { completeChat } as never, new ShortTermMemoryService(pool));
      await registerRuntimeRoutes(app, { pool, accounts, worker });
      const headers = { authorization: `Bearer ${session.accessToken}`, 'x-identity-id': account.identity.id };
      const registered = await app.inject({ method: 'POST', url: '/api/v1/runtime/devices', headers, payload: {
        installationId: randomUUID(), name: '本地测试设备', platform: 'win32', capabilities: [tool],
      } });
      expect(registered.statusCode).toBe(200);
      const deviceId = registered.json().data.id;
      const second = await app.inject({ method: 'POST', url: '/api/v1/runtime/devices', headers, payload: {
        installationId: randomUUID(), name: '第二台本地设备', platform: 'win32', capabilities: [tool],
      } });
      expect(second.statusCode).toBe(200);
      const trigger = await accounts.createMessage(room.id, account.user.id, '编写一份代码文件');
      const run = await accounts.createRun(room.id, trigger.id, 'balanced');
      worker.start(50);
      await vi.waitFor(async () => {
        const queued = await pool.query("SELECT id FROM runtime_tool_calls WHERE tool_name=$1 AND status='queued'", [tool]);
        expect(queued.rows).toHaveLength(1);
      }, { timeout: 15_000, interval: 100 });
      const assigned = (await pool.query('SELECT device_id FROM runtime_tool_calls WHERE tool_name=$1 LIMIT 1', [tool])).rows[0].device_id;
      expect([deviceId, second.json().data.id]).toContain(assigned);
      const polled = await app.inject({ method: 'POST', url: `/api/v1/runtime/devices/${assigned}/poll`, headers });
      expect(polled.statusCode, polled.body).toBe(200);
      const call = polled.json().data.call;
      expect(call.tool).toBe(tool);
      const content = 'print(42)\n';
      const files = [
        { fileName: '方案.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: Buffer.from([80, 75, 3, 4, 0]) },
        { fileName: '方案.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7\n') },
      ].map(file => ({ fileName: file.fileName, mimeType: file.mimeType, content: file.bytes.toString('base64'), contentEncoding: 'base64', checksum: createHash('sha256').update(file.bytes).digest('hex') }));
      const receipt = await app.inject({ method: 'POST', url: `/api/v1/runtime/devices/${assigned}/calls/${call.id}/receipt`, headers, payload: {
        receiptId: randomUUID(), status: 'completed', result: tool === 'local_code' ? { stored: true } : { qc: { ok: true, blocked: 0 }, renderStatus: 'completed' },
        approval: { approved: true, decidedAt: new Date().toISOString() },
        ...(tool === 'local_code' ? { artifact: { fileName: 'app.py', content, mimeType: 'text/plain', checksum: createHash('sha256').update(content).digest('hex') } } : { artifacts: files }),
      } });
      expect(receipt.statusCode, receipt.body).toBe(200);
      await vi.waitFor(async () => {
        expect((await accounts.listConversationRuns(room.id)).find(item => item.id === run.id)?.status).toBe('completed');
      }, { timeout: 15_000, interval: 100 });
      const artifacts = await accounts.listArtifacts(account.identity.id, room.id);
      expect(artifacts).toHaveLength(tool === 'local_code' ? 1 : 2);
      if (tool === 'local_code') expect(artifacts[0].content).toBe(content);
      const messages = await accounts.listMessages(room.id);
      expect(messages.at(-1)?.text).toContain('代码文件已完成');
      expect(messages.at(-1)?.metadata?.artifactIds).toEqual(expect.arrayContaining(artifacts.map(file => file.id)));
      const completed = (await accounts.listConversationRuns(room.id)).find(item => item.id === run.id)!;
      expect(completed.result.artifactIds).toEqual(expect.arrayContaining(artifacts.map(file => file.id)));
      const receiptEvent = (await pool.query("SELECT payload FROM runtime_events WHERE run_id=$1 AND kind='tool.receipt'", [run.id])).rows[0].payload;
      expect(receiptEvent.artifactIds).toEqual(expect.arrayContaining(artifacts.map(file => file.id)));
      const events = (await pool.query('SELECT kind FROM runtime_events WHERE run_id=$1 ORDER BY sequence', [run.id])).rows.map(row => row.kind);
      expect(events).toContain('tool.queued');
      expect(events).toContain('tool.dispatched');
      expect(events).toContain('tool.receipt');
      expect(events).toContain('run.completed');
      expect(completeChat).toHaveBeenCalledTimes(3);
    } finally {
      await worker?.stop();
      await app.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }, 30_000);
});
