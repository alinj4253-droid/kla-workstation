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
