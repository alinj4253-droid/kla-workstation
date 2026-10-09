import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { runMigrations } from '../database/migrations.js';
import { PostgresAccountRepository } from '../repositories/postgres-account-repository.js';
import { ShortTermMemoryService } from '../memories/short-term.js';
import { roomRegistry } from './registry.js';
import { ToolGateway } from './tool-gateway.js';
import { RuntimeTools } from './tools.js';

const config = loadConfig();
const dbCase = config.databaseUrl ? it : it.skip;

describe('unified runtime tool gateway', () => {
  it('allows a write-authorized chat without granting local execution', async () => {
    const pool = {
      hasPermission: (_id: string, action: string) => action === 'write',
      query: async () => ({ rowCount: 1, rows: [{ ok: true }] }),
    } as unknown as Pool;
    const completeChat = vi.fn(async () => ({ payload: { choices: [{ message: { content: '完成' } }] } }));
    const gateway = new ToolGateway(pool, {} as RuntimeTools, { completeChat } as never);
    await gateway.completeModel({ id: randomUUID() } as never, { model: 'test', messages: [], requestId: randomUUID() });
    expect(completeChat).toHaveBeenCalledOnce();
  });

  it('rejects a model call when model.use has been revoked', async () => {
    const pool = {
      hasPermission: () => true,
      query: async () => ({ rowCount: 0, rows: [] }),
    } as unknown as Pool;
    const completeChat = vi.fn();
    const gateway = new ToolGateway(pool, {} as RuntimeTools, { completeChat } as never);
    await expect(gateway.completeModel({ id: randomUUID() } as never,
      { model: 'test', messages: [], requestId: randomUUID() })).rejects.toThrow('model.use');
    expect(completeChat).not.toHaveBeenCalled();
  });

  dbCase('discovers enabled skills, routes a server tool and audits its result', async () => {
    const schema = `kla_gateway_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema},public`, max: 5, connectionTimeoutMillis: 5000 });
    try {
      await runMigrations(pool, schema);
      const accounts = new PostgresAccountRepository(pool);
      const account = await accounts.register({ email: 'gateway@example.test', nickname: '工具测试', password: 'TestPass2026!' });
      const project = await accounts.createProject(account.identity.id, '工具项目');
      const room = await accounts.createConversation(project.id, '工具群聊');
      const agent = (await roomRegistry(pool, room.id)).find(item => item.name === '本地执行智能体')!;
      const trigger = await accounts.createMessage(room.id, account.user.id, '保存成果');
      const run = await accounts.createRun(room.id, trigger.id, 'balanced');
      const step = (await pool.query('INSERT INTO conversation_run_steps(run_id,step_index,title,instruction,assigned_agent_id) VALUES($1,1,$2,$3,$4) RETURNING id', [run.id, '保存成果', '写文件', agent.id])).rows[0];
      const gateway = new ToolGateway(pool, new RuntimeTools(pool, accounts, new ShortTermMemoryService(pool), ''));
      const scope = { identityId: account.identity.id, conversationId: room.id, runId: run.id, stepId: step.id, agent, deviceId: null };
      expect(gateway.discover(agent).some(tool => tool.function.name === 'artifact_write')).toBe(true);
      expect(gateway.discover(agent).some(tool => tool.function.name === 'local_read')).toBe(false);
      const prepared = await gateway.prepare(scope, { id: 'write-1', function: { name: 'artifact_write', arguments: JSON.stringify({ fileName: 'result.md', content: '# 完成' }) } });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await gateway.enqueue(client, scope, prepared);
        await client.query('COMMIT');
      } finally { client.release(); }
      await gateway.executeServerCalls(scope, async () => undefined);
      const call = (await pool.query('SELECT status,result FROM runtime_tool_calls WHERE step_id=$1', [step.id])).rows[0];
      expect(call.status).toBe('completed');
      expect(call.result.artifactId).toBeTruthy();
      expect((await pool.query('SELECT kind FROM runtime_events WHERE run_id=$1 ORDER BY sequence', [run.id])).rows.map(row => row.kind)).toEqual(['tool.queued', 'tool.completed']);
      await pool.query("UPDATE skills SET enabled=false WHERE agent_id=$1 AND definition->>'code'='artifact_write'", [agent.id]);
      await expect(gateway.prepare(scope, { id: 'write-2', function: { name: 'artifact_write', arguments: '{}' } })).rejects.toThrow(/已停用/);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }, 25_000);
});
