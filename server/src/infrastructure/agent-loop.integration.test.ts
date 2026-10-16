import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { runMigrations } from '../database/migrations.js';
import { PostgresAccountRepository } from '../repositories/postgres-account-repository.js';
import { ShortTermMemoryService } from '../memories/short-term.js';
import { roomRegistry } from '../runtime/registry.js';
import { AgentLoopWorker } from './agent-loop.js';

const config = loadConfig();
const dbCase = config.databaseUrl ? it : it.skip;

describe('persisted multi-agent loop', () => {
  dbCase('resumes immediately after a server tool without a five-second retry delay', async () => {
    const schema = `kla_loop_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema},public`, max: 6, connectionTimeoutMillis: 5000 });
    let worker: AgentLoopWorker | undefined;
    try {
      await runMigrations(pool, schema);
      const accounts = new PostgresAccountRepository(pool);
      const account = await accounts.register({ email: 'server-tool-resume@example.test', nickname: '工具续跑测试', password: 'TestPass2026!' });
      const project = await accounts.createProject(account.identity.id, '服务端工具项目');
      const room = await accounts.createConversation(project.id, '服务端工具群聊');
      const agent = (await roomRegistry(pool, room.id)).find(item => item.name === '本地执行智能体')!;
      await pool.query("UPDATE agents SET execution_location='server' WHERE id=$1", [agent.id]);
      const trigger = await accounts.createMessage(room.id, account.user.id, '保存简短大纲');
      const completeChat = vi.fn(async (_identity, request: { requestId: string }) => ({ payload: { choices: [{ message:
        request.requestId.endsWith(':plan')
          ? { tool_calls: [{ id: 'plan-1', type: 'function', function: { name: 'delegate_tasks', arguments: JSON.stringify({ tasks: [{ title: '保存大纲', instruction: '保存大纲', agentId: agent.id, dependsOn: [] }] }) } }] }
          : request.requestId.endsWith(':turn:0')
            ? { tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'artifact_write', arguments: JSON.stringify({ fileName: 'outline.md', content: '# 大纲', mimeType: 'text/markdown' }) } }] }
            : { content: '大纲已保存。' },
      }] } }));
      worker = new AgentLoopWorker(pool, accounts, { completeChat } as never, new ShortTermMemoryService(pool));
      const run = await accounts.createRun(room.id, trigger.id, 'balanced');
      const tickOnce = async () => { worker!.kick(); await (worker as unknown as { pending: Promise<void> | null }).pending; };
      await tickOnce(); // coordination
      await tickOnce(); // model tool call and server-side execution
      const step = (await pool.query('SELECT status FROM conversation_run_steps WHERE run_id=$1', [run.id])).rows[0];
      const currentRun = (await pool.query('SELECT status,next_attempt_at FROM conversation_runs WHERE id=$1', [run.id])).rows[0];
      expect(step.status).toBe('pending');
      expect(currentRun).toMatchObject({ status: 'running', next_attempt_at: null });
      await tickOnce(); // next model turn
      await tickOnce(); // finish the run
      expect((await pool.query('SELECT status FROM conversation_runs WHERE id=$1', [run.id])).rows[0].status).toBe('completed');
      expect(completeChat).toHaveBeenCalledTimes(3);
    } finally {
      await worker?.stop();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }, 30_000);

  dbCase('resumes a failed execution from completed steps and refuses uncertain local calls', async () => {
    const schema = `kla_loop_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema},public`, max: 6, connectionTimeoutMillis: 5000 });
    try {
      await runMigrations(pool, schema);
      const accounts = new PostgresAccountRepository(pool);
      const registered = await accounts.register({ email: 'resume@example.test', nickname: '断点测试', password: 'TestPass2026!' });
      const project = await accounts.createProject(registered.identity.id, '断点项目');
      const room = await accounts.createConversation(project.id, '断点群聊');
      const agent = (await roomRegistry(pool, room.id)).find(item => item.name === '本地执行智能体')!;
      const trigger = await accounts.createMessage(room.id, registered.user.id, '分段写作');
      const worker = new AgentLoopWorker(pool, accounts, { completeChat: vi.fn() } as never, new ShortTermMemoryService(pool));
      vi.spyOn(worker, 'kick').mockImplementation(() => {});
      const run = await accounts.createRun(room.id, trigger.id, 'balanced');
      await pool.query("UPDATE conversation_runs SET status='failed',phase='execution' WHERE id=$1", [run.id]);
      await pool.query(`INSERT INTO conversation_run_steps(run_id,step_index,title,instruction,assigned_agent_id,status,result,transcript)
        VALUES($1,1,'大纲','写大纲',$2,'completed',$3,'[]'),($1,2,'正文','写正文',$2,'cancelled','{}',$4),
          ($1,3,'终稿','合并终稿',$2,'cancelled','{}','[]')`,
      [run.id, agent.id, JSON.stringify({ text: '大纲完成', artifactIds: [randomUUID()] }), JSON.stringify([{ role: 'user', content: '正文' }])]);
      expect((await worker.resumeRun(room.id, run.id))?.status).toBe('running');
      const steps = (await pool.query('SELECT status,result,turns FROM conversation_run_steps WHERE run_id=$1 ORDER BY step_index', [run.id])).rows;
      expect(steps[0]).toMatchObject({ status: 'completed', result: { text: '大纲完成' }, turns: 0 });
      expect(steps[1]).toMatchObject({ status: 'pending', turns: 1 });
      expect(steps[2]).toMatchObject({ status: 'pending', turns: 0 });
      await pool.query("UPDATE conversation_runs SET status='failed' WHERE id=$1", [run.id]);
      await pool.query("UPDATE conversation_run_steps SET status='cancelled' WHERE run_id=$1 AND step_index=2", [run.id]);
      const secondStep = (await pool.query('SELECT id FROM conversation_run_steps WHERE run_id=$1 AND step_index=2', [run.id])).rows[0].id;
      const session = await accounts.createSession(registered.user.id);
      const device = (await pool.query(`INSERT INTO execution_devices(identity_id,session_id,installation_id,name,platform)
        VALUES($1,$2,$3,'test-device','test') RETURNING id`, [registered.identity.id, session.id, randomUUID()])).rows[0].id;
      await pool.query(`INSERT INTO runtime_tool_calls(step_id,identity_id,device_id,model_call_id,tool_name,arguments,status)
        VALUES($1,$2,$3,'local-1','local_write','{}','unknown')`, [secondStep, registered.identity.id, device]);
      await expect(worker.resumeRun(room.id, run.id)).rejects.toThrow('未确认');
      expect((await accounts.listConversationRuns(room.id))[0].status).toBe('failed');
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }, 25_000);

  dbCase('keeps a newly submitted run on its originating worker while its lease is valid', async () => {
    const schema = `kla_loop_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema},public`, max: 6, connectionTimeoutMillis: 5000 });
    let origin: AgentLoopWorker | undefined;
    let peer: AgentLoopWorker | undefined;
    try {
      await runMigrations(pool, schema);
      const accounts = new PostgresAccountRepository(pool);
      const registered = await accounts.register({ email: 'lease@example.test', nickname: '租约测试', password: 'TestPass2026!' });
      const project = await accounts.createProject(registered.identity.id, '租约项目');
      const room = await accounts.createConversation(project.id, '租约群聊');
      const registry = await roomRegistry(pool, room.id);
      const executor = registry.find(agent => agent.name === '本地执行智能体')!;
      await pool.query("UPDATE agents SET execution_location='server' WHERE id=$1", [executor.id]);
      const trigger = await accounts.createMessage(room.id, registered.user.id, '你好');
      const originChat = vi.fn(async (_identity, request: { requestId: string }) => ({ payload: { choices: [{ message: request.requestId.endsWith(':plan')
        ? { tool_calls: [{ id: 'plan', type: 'function', function: { name: 'delegate_tasks', arguments: JSON.stringify({ tasks: [{ title: '回答', instruction: '回答用户', agentId: executor.id, dependsOn: [] }] }) } }] }
        : { content: '你好' } }] } }));
      const peerChat = vi.fn(async () => ({ payload: { choices: [{ message: { content: '其他实例回答' } }] } }));
      origin = new AgentLoopWorker(pool, accounts, { completeChat: originChat } as never, new ShortTermMemoryService(pool));
      peer = new AgentLoopWorker(pool, accounts, { completeChat: peerChat } as never, new ShortTermMemoryService(pool));
      const originKick = vi.spyOn(origin, 'kick').mockImplementation(() => {});
      const run = await origin.reserveRun(room.id, trigger.id, 'balanced');
      peer.start(50);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect((await accounts.listConversationRuns(room.id)).find(item => item.id === run.id)?.status).toBe('queued');
      expect(peerChat).not.toHaveBeenCalled();
      originKick.mockRestore();
      origin.kick();
      await vi.waitFor(async () => {
        expect((await pool.query('SELECT phase,status,lease_owner FROM conversation_runs WHERE id=$1', [run.id])).rows[0]).toMatchObject({ phase: 'execution', status: 'running' });
      }, { timeout: 10_000, interval: 100 });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(peerChat).not.toHaveBeenCalled();
      origin.start(50);
      await vi.waitFor(async () => {
        expect((await accounts.listConversationRuns(room.id)).find(item => item.id === run.id)?.status).toBe('completed');
      }, { timeout: 10_000, interval: 100 });
      expect(peerChat).not.toHaveBeenCalled();
      expect(originChat).toHaveBeenCalled();
    } finally {
      await origin?.stop();
      await peer?.stop();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }, 25_000);

  dbCase('plans dependent work, executes a real artifact tool, and publishes the summary', async () => {
    const schema = `kla_loop_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema},public`, max: 6, connectionTimeoutMillis: 5000 });
    let worker: AgentLoopWorker | undefined;
    try {
      await runMigrations(pool, schema);
      const accounts = new PostgresAccountRepository(pool);
      const registered = await accounts.register({ email: 'loop@example.test', nickname: '循环测试', password: 'TestPass2026!' });
      const project = await accounts.createProject(registered.identity.id, '循环项目');
      const room = await accounts.createConversation(project.id, '循环群聊');
      const registry = await roomRegistry(pool, room.id);
      const executor = registry.find(agent => agent.name === '本地执行智能体')!;
      await pool.query("UPDATE agents SET execution_location='server' WHERE id=$1", [executor.id]);
      executor.execution_location = 'server';
      const trigger = await accounts.createMessage(room.id, registered.user.id, '先写大纲，再检查内容');
      const calls: string[] = [];
      const modelRequests: Array<{ requestId: string; messages: unknown[] }> = [];
      const completeChat = vi.fn(async (_identity, request: { requestId: string; messages: unknown[]; tags: { taskId?: string; conversationId: string } }) => {
        expect(request.tags.taskId).toBeUndefined();
        expect(request.tags.conversationId).toBe(room.id);
        calls.push(request.requestId);
        modelRequests.push({ requestId: request.requestId, messages: request.messages });
        let message: unknown;
        if (request.requestId.endsWith(':plan')) message = { tool_calls: [{ id: 'plan-1', type: 'function', function: { name: 'delegate_tasks', arguments: JSON.stringify({ tasks: [
          { title: '撰写大纲', instruction: '写入 outline.md', agentId: executor.id, dependsOn: [] },
          { title: '检查大纲', instruction: '检查第一步成果', agentId: executor.id, dependsOn: [1] },
        ] }) } }] };
        else if (request.requestId.includes(':step:') && request.requestId.endsWith(':turn:0') && calls.filter(id => id.includes(':step:')).length === 1)
          message = { tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'artifact_write', arguments: JSON.stringify({ fileName: 'outline.md', content: '# 大纲\n- 目标', mimeType: 'text/markdown' }) } }] };
        else if (request.requestId.includes(':step:') && request.requestId.endsWith(':turn:1')) message = { content: '大纲已写入成果文件。' };
        else if (request.requestId.includes(':step:')) message = { content: '已检查大纲，内容完整。' };
        else message = { content: '大纲已完成并通过检查。' };
        return { payload: { choices: [{ message }] } };
      });
      worker = new AgentLoopWorker(pool, accounts, { completeChat } as never, new ShortTermMemoryService(pool));
      await accounts.createRun(room.id, trigger.id, 'balanced');
      worker.start(50);
      await vi.waitFor(async () => {
        expect((await accounts.listConversationRuns(room.id))[0]?.status).toBe('completed');
      }, { timeout: 15_000, interval: 100 });
      const steps = (await pool.query('SELECT step_index,status,result FROM conversation_run_steps ORDER BY step_index')).rows;
      expect(steps.map(step => step.status)).toEqual(['completed', 'completed']);
      const artifact = await accounts.listArtifacts(registered.identity.id, room.id);
      expect(artifact).toHaveLength(1);
      expect(artifact[0].name).toBe('outline.md');
      expect(artifact[0].content).toContain('目标');
      expect(steps[0].result.artifactIds).toEqual([artifact[0].id]);
      const messages = await accounts.listMessages(room.id);
      expect(messages.at(-1)?.text).toContain('大纲已完成并通过检查');
      expect(messages.at(-1)?.metadata?.artifactIds).toEqual([artifact[0].id]);
      expect(calls.at(-1)).toMatch(/:summary$/);
      const captured = await pool.query("SELECT content FROM memories WHERE metadata->>'conversationId'=$1 AND metadata->>'agentId'=$2", [room.id, executor.id]);
      expect(captured.rows.some(row => String(row.content).includes('大纲已写入成果文件'))).toBe(true);
      const nextTrigger = await accounts.createMessage(room.id, registered.user.id, '继续按上次的大纲处理');
      const nextRun = await accounts.createRun(room.id, nextTrigger.id, 'balanced');
      worker.kick();
      await vi.waitFor(async () => {
        expect((await accounts.listConversationRuns(room.id)).find(item => item.id === nextRun.id)?.status).toBe('completed');
      }, { timeout: 15_000, interval: 100 });
      const followUpContext = modelRequests.find(request => request.requestId === `run:${nextRun.id}:plan`);
      expect(JSON.stringify(followUpContext?.messages)).toContain('大纲已完成并通过检查');
      const memoryEvents = (await pool.query("SELECT kind FROM runtime_events WHERE run_id=$1 AND kind LIKE 'memory.%'", [nextRun.id])).rows.map(row => row.kind);
      expect(memoryEvents).toContain('memory.recalled');
    } finally {
      await worker?.stop();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }, 25_000);
});
