import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { MEMORY_DAY_MS, memoryBrowserPageSchema } from '@kla-workstation/contracts';
import { loadConfig } from '../config.js';
import { PostgresDatabase } from '../database/postgres.js';
import { PostgresAccountRepository } from '../repositories/index.js';
import { registerRoutes } from '../routes.js';
import { AgentLoopWorker } from '../infrastructure/agent-loop.js';
import { rankShortTerm, ShortTermMemoryService } from './short-term.js';

const config = loadConfig();
const testCase = config.databaseUrl ? it : it.skip;

describe('short-term recall and retention', () => {
  it('uses the old ranking and never revives zero-weight high-confidence memories', () => {
    const now = Date.now();
    const candidate = { id: 'fresh', content: 'bluewhale', last_reinforced_at: new Date(now), confidence: 0.5, importance: 0.5, access_count: 0 };
    expect(rankShortTerm([candidate, { ...candidate, id: 'old', last_reinforced_at: new Date(now - 30 * MEMORY_DAY_MS), confidence: 1, importance: 1, access_count: 100 }], 'bluewhale', now).map(row => row.id)).toEqual(['fresh']);
    expect(rankShortTerm([{ ...candidate, content: 'unrelated', last_reinforced_at: new Date(now - 10 * MEMORY_DAY_MS) }], 'bluewhale', now)).toEqual([]);
  });

  testCase('recalls per-agent context, captures once, excludes long-term and retains viewable old history', async () => {
    const schema = `kla_recall_test_${randomUUID().replaceAll('-', '')}`;
    const database = new PostgresDatabase(config.databaseUrl, schema);
    const pool = database.rawPool!;
    const app = Fastify({ logger: false });
    let loopWorker: AgentLoopWorker | undefined;
    try {
      await database.migrate(schema);
      const accounts = new PostgresAccountRepository(pool);
      const memory = new ShortTermMemoryService(pool);
      const owner = await accounts.register({ email: 'recall-owner@example.test', nickname: '测试', password: 'TestPass2026!' });
      const other = await accounts.register({ email: 'recall-other@example.test', nickname: '他人', password: 'TestPass2026!' });
      const project = await accounts.createProject(owner.identity.id, '记忆项目');
      const chat = await accounts.createConversation(project.id, '群组一');
      const chatTwo = await accounts.createConversation(project.id, '群组二');
      const agents = await accounts.listAgents(owner.identity.id);
      const coordinator = agents.find(agent => agent.name === '统筹智能体')!;
      expect(coordinator).toBeDefined();
      const executor = (await pool.query("INSERT INTO agents(identity_id,name) VALUES($1,'独立执行智能体') RETURNING id", [owner.identity.id])).rows[0];
      const foreignAgent = (await pool.query("INSERT INTO agents(identity_id,name) VALUES($1,'私有智能体') RETURNING id", [other.identity.id])).rows[0];
      const workspace = (await pool.query("SELECT id FROM workspaces WHERE identity_id=$1 AND type='personal' LIMIT 1", [owner.identity.id])).rows[0];
      const add = async (content: string, kind: string, days: number, agentId = coordinator.id, conversationId = chat.id) => {
        return (await pool.query(`INSERT INTO memories(workspace_id,content,kind,metadata,created_at)
          VALUES($1,$2,$3,$4,$5) RETURNING id,last_reinforced_at`, [workspace.id, content, kind,
        JSON.stringify({ conversationId, agentId }), new Date(Date.now() - days * MEMORY_DAY_MS)])).rows[0];
      };
      const active = await add('bluewhale 当前项目负责人小林', 'short_term', 10);
      const fixed = await add('bluewhale 长期秘密不应被注入', 'long_term', 400);
      const zero = await add('bluewhale 已归零历史', 'short_term', 40);
      const expired = await add('bluewhale 超过一年', 'short_term', 366);
      await add('bluewhale 另一个智能体私密内容', 'short_term', 0, executor.id);
      await add('bluewhale 另一个群组私密内容', 'short_term', 0, coordinator.id, chatTwo.id);
      const scope = { identityId: owner.identity.id, conversationId: chat.id, agentId: coordinator.id };
      expect(await memory.recall(scope, 'bluewhale')).toEqual(['bluewhale 当前项目负责人小林']);
      expect(await memory.recall({ ...scope, conversationId: chatTwo.id }, 'bluewhale')).toEqual(['bluewhale 另一个群组私密内容']);
      const afterRead = (await pool.query('SELECT last_reinforced_at,access_count FROM memories WHERE id=$1', [active.id])).rows[0];
      expect(afterRead.last_reinforced_at.toISOString()).toBe(active.last_reinforced_at.toISOString());
      expect(afterRead.access_count).toBe(1);
      expect(await memory.recall({ ...scope, identityId: other.identity.id }, 'bluewhale')).toEqual([]);
      expect(await memory.recall({ ...scope, agentId: foreignAgent.id }, 'bluewhale')).toEqual([]);

      await accounts.createMessage(chatTwo.id, owner.user.id, '二群专属用户输入，代号 redfox');
      const otherRoomMessage = await accounts.createAgentMessage(chatTwo.id, coordinator.name, '二群专属智能体历史，代号 redfox', { agentId: coordinator.id });
      await accounts.createAgentMessage(chat.id, '独立执行智能体', '其他执行智能体的私密结果', { agentId: executor.id });
      const trigger = await accounts.createMessage(chat.id, owner.user.id, 'bluewhale 请接续回答');
      const history = await memory.history(scope, trigger.id);
      expect(history.map(message => message.content)).toEqual(['bluewhale 请接续回答']);
      expect(await memory.history(scope, otherRoomMessage.id)).toEqual([]);
      expect((await accounts.listMessages(chat.id)).every(message => message.conversationId === chat.id)).toBe(true);
      const capture = { runId: randomUUID(), agentName: coordinator.name, request: 'bluewhale', answer: '完成', sourceMessageId: trigger.id };
      await memory.capture(scope, capture); await memory.capture(scope, capture);
      expect((await pool.query("SELECT count(*)::int AS count FROM memories WHERE metadata->>'runId'=$1", [capture.runId])).rows[0].count).toBe(1);

      const completeChat = vi.fn().mockResolvedValue({ payload: { choices: [{ message: { content: '依据短期记忆，小林是负责人。' } }] } });
      loopWorker = new AgentLoopWorker(pool, accounts, { completeChat }, memory);
      await registerRoutes(app, { accounts, database, shortTermMemory: memory, gateway: { completeChat }, loopWorker });
      loopWorker.start(100);
      const session = await accounts.createSession(owner.user.id);
      const headers = { authorization: `Bearer ${session.accessToken}`, 'x-identity-id': owner.identity.id };
      const response = await app.inject({ method: 'POST', url: `/api/v1/conversations/${chat.id}/messages`, headers, payload: { text: 'bluewhale 谁负责？', submitObject: [{ type: 'command', id: 'task_execution' }] } });
      expect(response.statusCode).toBe(200);
      await vi.waitFor(async () => expect((await accounts.listConversationRuns(chat.id))[0].status).toBe('completed'), { timeout: 10_000, interval: 100 });
      const context = JSON.stringify(completeChat.mock.calls[0][1].messages);
      expect(context).toContain('当前项目负责人小林');
      expect(context).not.toContain('长期秘密');
      expect(context).not.toContain('已归零历史');
      expect(context).not.toContain('另一个智能体私密');
      expect(context).not.toContain('另一个群组私密');
      const saved = (await pool.query("SELECT metadata FROM memories WHERE metadata->>'runId'=$1", [response.json().data.run.id])).rows;
      expect(saved).toHaveLength(1);
      expect(saved[0].metadata.agentId).toBe(coordinator.id);
      expect(saved[0].metadata.conversationId).toBe(chat.id);

      // Reuse the very same definition in another room in the same project.
      // Its model context, generated messages and captured memory stay separate.
      const second = await app.inject({ method: 'POST', url: `/api/v1/conversations/${chatTwo.id}/messages`, headers, payload: { text: 'redfox 只接续二群任务', submitObject: [{ type: 'command', id: 'task_execution' }] } });
      expect(second.statusCode).toBe(200);
      await vi.waitFor(async () => expect((await accounts.listConversationRuns(chatTwo.id))[0].status).toBe('completed'), { timeout: 10_000, interval: 100 });
      const secondCalls = completeChat.mock.calls.filter(call => call[1].tags.conversationId === chatTwo.id);
      expect(secondCalls.length).toBeGreaterThan(0);
      const secondContext = JSON.stringify(secondCalls.map(call => call[1].messages));
      expect(secondContext).toContain('二群专属用户输入');
      expect(secondContext).toContain('二群专属智能体历史');
      expect(secondContext).not.toContain('当前项目负责人小林');
      expect(secondContext).not.toContain('bluewhale 请接续回答');
      expect((await accounts.listMessages(chat.id)).some(message => message.text.includes('二群专属'))).toBe(false);
      expect((await accounts.listConversationRuns(chat.id)).some(run => run.id === second.json().data.run.id)).toBe(false);
      const secondSaved = (await pool.query("SELECT metadata FROM memories WHERE metadata->>'runId'=$1", [second.json().data.run.id])).rows;
      expect(secondSaved).toHaveLength(1);
      expect(secondSaved[0].metadata).toMatchObject({ agentId: coordinator.id, conversationId: chatTwo.id });

      const browser = await app.inject({ method: 'GET', url: `/api/v1/memories/browser?term=short_term&conversationId=${chat.id}&from=${new Date(Date.now() - 365 * MEMORY_DAY_MS).toISOString()}`, headers });
      expect(browser.statusCode).toBe(200);
      const page = memoryBrowserPageSchema.parse(browser.json().data);
      expect(page.items.find(item => item.id === `memory:${zero.id}`)?.timeWeight).toBe(0);
      expect(page.items.some(item => item.id === `memory:${expired.id}`)).toBe(false);
      const long = await app.inject({ method: 'GET', url: '/api/v1/memories/browser?term=long_term', headers });
      expect(long.json().data.items.find((item: { id: string }) => item.id === `memory:${fixed.id}`).timeWeight).toBeNull();
      const search = await app.inject({ method: 'POST', url: '/api/v1/memories/search', headers, payload: { query: 'bluewhale' } });
      expect(search.statusCode).toBe(200);
      expect(search.json().data.some((item: { kind: string }) => item.kind === 'long_term')).toBe(false);
      const messagesBefore = (await accounts.listMessages(chat.id)).length;
      expect(await memory.prune()).toBe(1);
      expect((await pool.query('SELECT id FROM memories WHERE id=ANY($1::uuid[])', [[fixed.id, zero.id]])).rows).toHaveLength(2);
      expect((await accounts.listMessages(chat.id)).length).toBe(messagesBefore);
    } finally {
      await loopWorker?.stop();
      await app.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await database.close();
    }
  }, 30_000);
});
