// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildAgentCollaborationInstructions,
  findDuplicateAwaitingUserMessage,
  isAllowedAgentHandoff,
  messageRequestsUserResponse,
  normalizeAgentMessageContent,
  resolveAgentMentions,
  sanitizeAgentDisplayText,
} from './agent-collaboration';
import { processMessageMentions } from './message-router';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/app/path') },
}));

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, definition_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, model_profile_id TEXT, overrides_json TEXT
    );
    CREATE TABLE project_agent_instances (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_profile_id TEXT NOT NULL,
      role TEXT NOT NULL, runtime_mode TEXT NOT NULL, ordinal INTEGER NOT NULL,
      model_profile_id TEXT
    );
    CREATE TABLE model_slot_bindings (slot TEXT PRIMARY KEY, model_profile_id TEXT);
    CREATE TABLE model_profiles (
      id TEXT PRIMARY KEY, name TEXT, model_id TEXT,
      parameters_json TEXT, verified_capabilities_json TEXT, provider_id TEXT, enabled INTEGER
    );
    CREATE TABLE model_providers (
      id TEXT PRIMARY KEY, name TEXT, type TEXT, base_url TEXT
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_instance_id TEXT NOT NULL,
      trigger_message_id TEXT, parent_run_id TEXT,
      requested_by_type TEXT NOT NULL DEFAULT 'user', requested_by_id TEXT NOT NULL DEFAULT '',
      instruction TEXT, status TEXT NOT NULL DEFAULT 'queued',
      result_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sender_type TEXT NOT NULL,
      sender_id TEXT NOT NULL, kind TEXT NOT NULL, content_json TEXT NOT NULL,
      status TEXT NOT NULL, reply_to_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO agent_profiles VALUES ('p-leader', '统筹管理智能体', 'builtin.orchestrator', 1, NULL, NULL)").run();
  db.prepare("INSERT INTO agent_profiles VALUES ('p-knowledge', '知识管理智能体', 'builtin.knowledge-manager', 1, NULL, NULL)").run();
  db.prepare("INSERT INTO agent_profiles VALUES ('p-research', '资料调研智能体', 'builtin.researcher', 1, NULL, NULL)").run();
  db.prepare("INSERT INTO agent_profiles VALUES ('p-review', '验收智能体', 'builtin.acceptance-reviewer', 1, NULL, NULL)").run();
  db.prepare("INSERT INTO agent_profiles VALUES ('p-review-2', '验收智能体副本', 'builtin.acceptance-reviewer', 1, NULL, NULL)").run();
  db.prepare("INSERT INTO agent_profiles VALUES ('p-disabled', '已禁用智能体', 'custom.disabled', 0, NULL, NULL)").run();
  db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-orch', 'group-1', 'p-leader', 'leader', 'native-model', 0, NULL)").run();
  db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-know', 'group-1', 'p-knowledge', 'teammate', 'native-model', 1, NULL)").run();
  db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-research', 'group-1', 'p-research', 'teammate', 'native-model', 2, NULL)").run();
  db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-review', 'group-1', 'p-review', 'teammate', 'native-model', 4, NULL)").run();
  db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-review-2', 'group-1', 'p-review-2', 'teammate', 'native-model', 5, NULL)").run();
  db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-off', 'group-1', 'p-disabled', 'teammate', 'external-cli', 3, NULL)").run();
  return db;
}

describe('agent collaboration mentions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it('enforces fast zero-review and balanced one-review budget at the root task router', () => {
    const runRepo = {
      countRunsByTrigger: vi.fn(() => 0),
      getAncestorChain: vi.fn(() => []),
      create: vi.fn(() => ({ id: 'review-run-created' })),
      addEvent: vi.fn(),
    };
    const scheduler = { enqueue: vi.fn() };

    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'root-fast', 'group-1', 'user', 'local-user', 'text',
      JSON.stringify({ text: '请完成任务', collaborationMode: 'fast' }), 'sent', null,
      new Date().toISOString(), new Date().toISOString(),
    );
    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({ text: '@验收智能体 请验收', messageType: 'delegation', mentions: [{ target: { scope: 'instance', id: 'group-1-review' } }] }),
      'root-fast', 'group-1-orch', 'parent-fast', 'agent',
    );
    expect(runRepo.create).not.toHaveBeenCalled();

    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'root-balanced', 'group-1', 'user', 'local-user', 'text',
      JSON.stringify({ text: '请完成任务', collaborationMode: 'balanced' }), 'sent', null,
      new Date().toISOString(), new Date().toISOString(),
    );
    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({ text: '@验收智能体 请执行唯一一次验收', messageType: 'delegation', mentions: [{ target: { scope: 'instance', id: 'group-1-review' } }] }),
      'root-balanced', 'group-1-orch', 'parent-balanced', 'agent',
    );
    expect(runRepo.create).toHaveBeenCalledTimes(1);
    runRepo.create.mockClear();
    scheduler.enqueue.mockClear();

    db.prepare(
      `INSERT INTO agent_runs
       (id, project_id, agent_instance_id, trigger_message_id, requested_by_type, requested_by_id, instruction, status)
       VALUES ('already-reviewed', 'group-1', 'group-1-review', 'root-balanced', 'agent', 'group-1-orch', '已验收', 'completed')`,
    ).run();
    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({ text: '@验收智能体副本 请再次验收', messageType: 'delegation', mentions: [{ target: { scope: 'instance', id: 'group-1-review-2' } }] }),
      'root-balanced', 'group-1-orch', 'parent-balanced', 'agent',
    );
    expect(runRepo.create).not.toHaveBeenCalled();
  });

  it('resolves an agent-authored @name to the group-scoped instance id', () => {
    const mentions = resolveAgentMentions(db, 'group-1', '@知识管理智能体 请整理资料');
    expect(mentions).toEqual([
      expect.objectContaining({
        target: { scope: 'instance', id: 'group-1-know' },
        label: '知识管理智能体',
      }),
    ]);
  });

  it('normalizes text mentions and preserves an existing parent mention without duplicates', () => {
    const normalized = normalizeAgentMessageContent(
      db,
      'group-1',
      JSON.stringify({
        schemaVersion: 1,
        text: '@统筹管理智能体 已完成，请继续汇总',
        mentions: [{ target: { scope: 'instance', id: 'group-1-orch' }, label: '统筹管理智能体', start: 0, end: 0 }],
      }),
    );
    const parsed = JSON.parse(normalized) as { mentions: Array<{ target: { id: string } }> };
    expect(parsed.mentions.map((item) => item.target.id)).toEqual(['group-1-orch']);
  });

  it('does not expose planner JSON from agent-authored chat messages', () => {
    const normalized = JSON.parse(normalizeAgentMessageContent(
      db,
      'group-1',
      JSON.stringify({
        text: JSON.stringify({ status: 'delegate', assignments: [{ agentInstanceId: 'group-1-know', objective: '检索' }] }),
      }),
      [],
      'group-1-orch',
    )) as { text: string };
    expect(normalized.text).toBe('');
  });

  it('keeps only the exact instance selected by message audience metadata', () => {
    const rows = db.prepare(
      `SELECT pai.id, ap.name
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id IN ('group-1-orch', 'group-1-know')`,
    ).all() as Array<{ id: string; name: string }>;
    const names = new Map(rows.map((row) => [row.id, row.name]));
    const normalized = JSON.parse(normalizeAgentMessageContent(
      db,
      'group-1',
      JSON.stringify({
        text: `@${names.get('group-1-orch')} @${names.get('group-1-know')} please continue`,
        audience: { scope: 'instance', id: 'group-1-know' },
      }),
    )) as { text: string; mentions: Array<{ target: { id: string } }> };

    expect(normalized.mentions.map((mention) => mention.target.id)).toEqual(['group-1-know']);
    expect(normalized.text).not.toContain(`@${names.get('group-1-orch')}`);
  });

  it('does not activate an agent mentioned inside a user-directed final reply', () => {
    const knowledgeName = db.prepare(
      `SELECT ap.name
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = 'group-1-know'`,
    ).pluck().get() as string;
    const normalized = JSON.parse(normalizeAgentMessageContent(
      db,
      'group-1',
      JSON.stringify({
        text: `@user ${knowledgeName} has completed the work`,
        audience: { scope: 'user' },
      }),
    )) as { mentions: Array<{ target: { scope: string; id: string } }> };

    expect(normalized.mentions).toEqual([
      expect.objectContaining({ target: { scope: 'user', id: 'local-user' } }),
    ]);
  });

  it('keeps the exact parent and user while dropping a third agent', () => {
    const rows = db.prepare(
      `SELECT pai.id, ap.name
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id IN ('group-1-orch', 'group-1-know')`,
    ).all() as Array<{ id: string; name: string }>;
    const names = new Map(rows.map((row) => [row.id, row.name]));
    const normalized = JSON.parse(normalizeAgentMessageContent(
      db,
      'group-1',
      JSON.stringify({
        text: `@${names.get('group-1-orch')} @user @${names.get('group-1-know')} input required`,
        audience: { scope: 'parent', id: 'group-1-orch', includeUser: true },
      }),
    )) as { mentions: Array<{ target: { id: string } }> };

    expect(normalized.mentions.map((mention) => mention.target.id)).toHaveLength(2);
    expect(normalized.mentions.map((mention) => mention.target.id)).toEqual(
      expect.arrayContaining(['group-1-orch', 'local-user']),
    );
  });

  it('does not create rich mention semantics for an unknown audience target', () => {
    const knowledgeName = db.prepare(
      `SELECT ap.name
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = 'group-1-know'`,
    ).pluck().get() as string;
    const normalized = JSON.parse(normalizeAgentMessageContent(
      db,
      'group-1',
      JSON.stringify({
        text: `@${knowledgeName} please continue`,
        audience: { scope: 'instance', id: 'missing-agent' },
      }),
    )) as { text: string; mentions: unknown[] };

    expect(normalized.mentions).toEqual([]);
    expect(normalized.text).not.toContain(`@${knowledgeName}`);
  });

  it('recognizes @用户 as a non-routing conversation mention', () => {
    const mentions = resolveAgentMentions(db, 'group-1', '@用户 请补充验收标准。');
    expect(mentions).toEqual([expect.objectContaining({ target: { scope: 'user', id: 'local-user' }, label: '用户' })]);
  });

  it('only waits for a user mention when the message requires a critical response', () => {
    const required = normalizeAgentMessageContent(db, 'group-1', JSON.stringify({
      text: '@用户 请提供项目地点，否则无法继续查询。',
      requiresUserResponse: true,
    }), [], 'group-1-orch');
    const completed = normalizeAgentMessageContent(db, 'group-1', JSON.stringify({
      text: '@用户 已经处理好了，需要我继续时直接说就行。',
      requiresUserResponse: false,
    }), [], 'group-1-orch');

    expect(messageRequestsUserResponse(required)).toBe(true);
    expect(messageRequestsUserResponse(completed)).toBe(false);
  });

  it('uses a conservative semantic fallback for external agent user mentions', () => {
    const blocking = normalizeAgentMessageContent(db, 'group-1', JSON.stringify({
      text: '@用户 麻烦补充项目地点，否则没法继续查询。',
    }), [], 'group-1-research');
    const greeting = normalizeAgentMessageContent(db, 'group-1', JSON.stringify({
      text: '@用户 在的，已收到你的 @。需要我继续处理时直接说就行。',
    }), [], 'group-1-research');

    expect(messageRequestsUserResponse(blocking)).toBe(true);
    expect(messageRequestsUserResponse(greeting)).toBe(false);
  });

  it('shares one equivalent user question across agents in the same task chain', () => {
    const question = normalizeAgentMessageContent(db, 'group-1', JSON.stringify({ text: '@用户 请提供项目地点。' }), [], 'group-1-orch');
    expect(messageRequestsUserResponse(question)).toBe(true);
    db.prepare(
      `INSERT INTO messages VALUES ('question-1', 'group-1', 'agent', 'group-1-orch', 'text', ?, 'sent', NULL, ?, ?)`,
    ).run(question, new Date().toISOString(), new Date().toISOString());
    db.prepare(
      `INSERT INTO agent_runs
       (id, project_id, agent_instance_id, trigger_message_id, requested_by_type, requested_by_id, instruction, status, result_message_id)
       VALUES ('waiting-1', 'group-1', 'group-1-orch', 'root-task', 'user', 'local-user', '查询天气', 'awaiting_user', 'question-1')`,
    ).run();
    const equivalent = normalizeAgentMessageContent(db, 'group-1', JSON.stringify({ text: '@用户 麻烦补充项目地点' }), [], 'group-1-know');
    expect(findDuplicateAwaitingUserMessage(db, 'group-1', 'root-task', equivalent, 'waiting-2')).toBe('question-1');
  });

  it('keeps unknown or longer names as plain text instead of confirming a partial mention', () => {
    expect(resolveAgentMentions(db, 'group-1', '@知识管理智能体助手 请处理')).toEqual([]);
    const normalized = JSON.parse(normalizeAgentMessageContent(
      db,
      'group-1',
      JSON.stringify({ text: '@不存在智能体 请处理', mentions: [{ target: { scope: 'instance', id: 'group-1-know' }, label: '不存在智能体', start: 0, end: 7 }] }),
    )) as { mentions: unknown[] };
    expect(normalized.mentions).toEqual([]);
  });

  it('only resolves actionable mentions outside Markdown code', () => {
    const text = [
      '代码示例：`@知识管理智能体 请处理`',
      '```text',
      '@资料调研智能体 这也是示例',
      '```',
      '@知识管理智能体 请检索公司地址并返回准确出处。',
    ].join('\n');
    const mentions = resolveAgentMentions(db, 'group-1', text);
    expect(mentions).toEqual([expect.objectContaining({
      target: { scope: 'instance', id: 'group-1-know' },
      label: '知识管理智能体',
      start: text.lastIndexOf('@知识管理智能体'),
    })]);
  });

  it('does not route a mention that exists only inside Markdown code', () => {
    const normalized = JSON.parse(normalizeAgentMessageContent(
      db,
      'group-1',
      JSON.stringify({ text: '示例：`@知识管理智能体 请处理`' }),
      [],
      'group-1-orch',
    )) as { mentions: unknown[] };
    expect(normalized.mentions).toEqual([]);
  });

  it('removes self mention semantics and the @ marker from an agent message', () => {
    const normalized = JSON.parse(normalizeAgentMessageContent(
      db,
      'group-1',
      JSON.stringify({ text: '@统筹管理智能体 我继续处理这项工作' }),
      [],
      'group-1-orch',
    )) as { text: string; mentions: unknown[] };
    expect(normalized.text).toBe('统筹管理智能体 我继续处理这项工作');
    expect(normalized.mentions).toEqual([]);
  });

  it('keeps agent results but removes internal framework labels from visible messages', () => {
    const normalized = JSON.parse(normalizeAgentMessageContent(
      db,
      'group-1',
      JSON.stringify({ text: '目标：完成页面\n当前输入：用户上传的文件\n\n已经生成 outputs/report.html。' }),
      [],
      'group-1-know',
    )) as { text: string };
    expect(normalized.text).toBe('完成页面\n用户上传的文件\n\n已经生成 outputs/report.html。');
    expect(normalized.text).not.toMatch(/目标|当前输入/);
  });

  it('exposes every enabled group member by display name without leaking instance ids', () => {
    const prompt = buildAgentCollaborationInstructions(db, 'group-1', 'group-1-orch');
    expect(prompt).toContain('统筹管理智能体（你自己，leader');
    expect(prompt).not.toContain('@统筹管理智能体（');
    expect(prompt).toContain('@知识管理智能体（teammate');
    expect(prompt).not.toContain('group-1-orch');
    expect(prompt).not.toContain('group-1-know');
    expect(prompt).not.toContain('已禁用智能体');
    expect(prompt).toContain(':::artifact{path="outputs/文件名.html"}');
    expect(prompt).toContain('<html lang="zh-CN">');
    expect(prompt).not.toContain('...完整 HTML...');
  });

  it('sanitizes known instance ids in user-visible text and normalized messages', () => {
    expect(sanitizeAgentDisplayText(db, 'group-1', '等待 group-1-know 回复')).toBe('等待 知识管理智能体 回复');
    const normalized = normalizeAgentMessageContent(
      db,
      'group-1',
      JSON.stringify({ text: '@group-1-know 请处理知识文档并输出验收结果' }),
    );
    const parsed = JSON.parse(normalized) as { text: string; mentions: Array<{ target: { id: string } }> };
    expect(parsed.text).toBe('@知识管理智能体 请处理知识文档并输出验收结果');
    expect(parsed.mentions[0]?.target.id).toBe('group-1-know');
  });

  it('routes each enabled teammate once and skips self or disabled targets', () => {
    const runRepo = {
      countRunsByTrigger: vi.fn(() => 0),
      getAncestorChain: vi.fn(() => []),
      create: vi.fn(() => ({ id: 'sub-run-1' })),
      addEvent: vi.fn(),
    };
    const scheduler = { enqueue: vi.fn() };
    const contentJson = JSON.stringify({
      text: '请处理知识文档并输出可验收的摘要结果',
      mentions: [
        { target: { scope: 'instance', id: 'group-1-know' } },
        { target: { scope: 'instance', id: 'group-1-know' } },
        { target: { scope: 'instance', id: 'group-1-orch' } },
        { target: { scope: 'instance', id: 'group-1-off' } },
      ],
    });

    processMessageMentions(
      db,
      runRepo as never,
      scheduler as never,
      'group-1',
      contentJson,
      'message-1',
      'group-1-orch',
      'parent-run',
      'agent',
    );

    expect(runRepo.create).toHaveBeenCalledTimes(1);
    expect(runRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'group-1',
      agentInstanceId: 'group-1-know',
      requestedByType: 'agent',
      requestedById: 'group-1-orch',
      parentRunId: 'parent-run',
      triggerMessageId: 'message-1',
    }));
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
    expect(runRepo.addEvent).toHaveBeenCalledWith('sub-run-1', 'run.anchor', { messageId: 'message-1' });
  });

  it('passes the complete message to a mentioned agent regardless of mention position', () => {
    const runRepo = {
      countRunsByTrigger: vi.fn(() => 0),
      getAncestorChain: vi.fn(() => []),
      create: vi.fn(() => ({ id: 'sub-run-full-message' })),
      addEvent: vi.fn(),
    };
    const scheduler = { enqueue: vi.fn() };
    const fullText = '请读取前面的全部要求并输出结果，完成后回复 @知识管理智能体';
    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({ text: fullText, mentions: [{ target: { scope: 'instance', id: 'group-1-know' } }] }),
      'message-full', 'local-user', undefined, 'user', 'message-full',
    );
    expect(runRepo.create).toHaveBeenCalledWith(expect.objectContaining({ instruction: fullText }));
    expect(scheduler.enqueue).toHaveBeenCalledWith(expect.objectContaining({ instruction: fullText }));
  });

  it('does not create more runs after the root message reaches the collaboration limit', () => {
    const runRepo = {
      countRunsByTrigger: vi.fn(() => 64),
      getAncestorChain: vi.fn(() => []),
      create: vi.fn(),
      addEvent: vi.fn(),
    };
    const scheduler = { enqueue: vi.fn() };

    processMessageMentions(
      db,
      runRepo as never,
      scheduler as never,
      'group-1',
      JSON.stringify({
        text: '@知识管理智能体 请继续检查文档并输出验收结果',
        mentions: [{ target: { scope: 'instance', id: 'group-1-know' } }],
      }),
      'root-message',
      'group-1-orch',
      'parent-run',
      'agent',
    );

    expect(runRepo.create).not.toHaveBeenCalled();
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('does not route acknowledgement-only agent messages', () => {
    const runRepo = { countRunsByTrigger: vi.fn(() => 0), getAncestorChain: vi.fn(() => []), create: vi.fn(), addEvent: vi.fn() };
    const scheduler = { enqueue: vi.fn() };
    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({ text: '@知识管理智能体 收到，谢谢。', mentions: [{ target: { scope: 'instance', id: 'group-1-know' } }] }),
      'root-message', 'group-1-orch', 'parent-run', 'agent',
    );
    expect(runRepo.create).not.toHaveBeenCalled();
  });

  it('does not turn an optional completion report into a new agent task', () => {
    const runRepo = { countRunsByTrigger: vi.fn(() => 0), getAncestorChain: vi.fn(() => []), create: vi.fn(), addEvent: vi.fn() };
    const scheduler = { enqueue: vi.fn() };
    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({
        text: '@统筹管理智能体 图片链接已经整理完成，需要我把首选页面再做成清单吗？',
        mentions: [{ target: { scope: 'instance', id: 'group-1-orch' } }],
      }),
      'root-message', 'group-1-research', 'research-run', 'agent',
    );
    expect(runRepo.create).not.toHaveBeenCalled();
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('routes an explicit structured delegation even when its visible wording is concise', () => {
    const runRepo = {
      countRunsByTrigger: vi.fn(() => 0),
      getAncestorChain: vi.fn(() => []),
      create: vi.fn(() => ({ id: 'delegated-run' })),
      addEvent: vi.fn(),
    };
    const scheduler = { enqueue: vi.fn() };
    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({
        text: '@知识管理智能体 查接待制度',
        mentions: [{ target: { scope: 'instance', id: 'group-1-know' } }],
        messageType: 'delegation',
      }),
      'root-message', 'group-1-orch', 'orchestrator-run', 'agent',
    );
    expect(runRepo.create).toHaveBeenCalledTimes(1);
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('blocks sending the same root task back to an ancestor agent', () => {
    const runRepo = {
      countRunsByTrigger: vi.fn(() => 1),
      getAncestorChain: vi.fn(() => [{ agentInstanceId: 'group-1-orch' }]),
      create: vi.fn(),
      addEvent: vi.fn(),
    };
    const scheduler = { enqueue: vi.fn() };
    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({ text: '@统筹管理智能体 请继续汇总当前结果并提交用户', mentions: [{ target: { scope: 'instance', id: 'group-1-orch' } }] }),
      'root-message', 'group-1-know', 'child-run', 'agent',
    );
    expect(runRepo.create).not.toHaveBeenCalled();
  });

  it('blocks a research agent from handing research findings to knowledge curation', () => {
    expect(isAllowedAgentHandoff(db, 'group-1', 'group-1-research', 'group-1-know', '@知识管理智能体 请把调研结果归集到知识库')).toBe(false);
  });

  it('blocks an equivalent duplicate instruction to the same target within the same root task', () => {
    db.prepare(
      `INSERT INTO agent_runs
       (id, project_id, agent_instance_id, trigger_message_id, requested_by_type, requested_by_id, instruction, status)
       VALUES ('run-orch-know', 'group-1', 'group-1-know', 'root-message', 'agent', 'group-1-orch', ?, 'running')`,
    ).run('@知识管理智能体 请检查公司制度并输出相关证据');
    const runRepo = {
      countRunsByTrigger: vi.fn(() => 2),
      getAncestorChain: vi.fn(() => []),
      create: vi.fn(),
      addEvent: vi.fn(),
    };
    const scheduler = { enqueue: vi.fn() };

    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({
        text: '@知识管理智能体，请检查公司制度并输出相关证据。',
        mentions: [{ target: { scope: 'instance', id: 'group-1-know' } }],
      }),
      'root-message', 'group-1-orch', 'orchestrator-run', 'agent', 'orchestrator-message-2',
    );

    expect(runRepo.create).not.toHaveBeenCalled();
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('blocks an equivalent instruction that already completed', () => {
    db.prepare(
      `INSERT INTO agent_runs
       (id, project_id, agent_instance_id, trigger_message_id, requested_by_type, requested_by_id, instruction, status)
       VALUES ('run-orch-know-complete', 'group-1', 'group-1-know', 'root-message', 'agent', 'group-1-orch', ?, 'completed')`,
    ).run('@知识管理智能体 请检查公司制度并输出相关证据');
    const runRepo = {
      countRunsByTrigger: vi.fn(() => 2),
      getAncestorChain: vi.fn(() => []),
      create: vi.fn(),
      addEvent: vi.fn(),
    };
    const scheduler = { enqueue: vi.fn() };

    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({
        text: '@知识管理智能体 请检查公司制度并输出相关证据',
        mentions: [{ target: { scope: 'instance', id: 'group-1-know' } }],
      }),
      'root-message', 'group-1-orch', 'orchestrator-run', 'agent', 'orchestrator-message-3',
    );

    expect(runRepo.create).not.toHaveBeenCalled();
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('allows a materially different follow-up instruction to the same target', () => {
    db.prepare(
      `INSERT INTO agent_runs
       (id, project_id, agent_instance_id, trigger_message_id, requested_by_type, requested_by_id, instruction, status)
       VALUES ('run-orch-review', 'group-1', 'group-1-know', 'root-message', 'agent', 'group-1-orch', ?, 'completed')`,
    ).run('@知识管理智能体 请审阅报告草稿并给出结论');
    const runRepo = {
      countRunsByTrigger: vi.fn(() => 2),
      getAncestorChain: vi.fn(() => []),
      create: vi.fn(() => ({ id: 'follow-up-run' })),
      addEvent: vi.fn(),
    };
    const scheduler = { enqueue: vi.fn() };
    const followUp = '@知识管理智能体 你上次只给出了不通过结论，请重新审阅并列出具体返修项';

    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({
        text: followUp,
        mentions: [{ target: { scope: 'instance', id: 'group-1-know' } }],
      }),
      'root-message', 'group-1-orch', 'orchestrator-run', 'agent', 'orchestrator-message-3',
    );

    expect(runRepo.create).toHaveBeenCalledTimes(1);
    expect(runRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      agentInstanceId: 'group-1-know',
      requestedById: 'group-1-orch',
      instruction: followUp,
    }));
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('prefers the longest agent name when group member names overlap', () => {
    db.prepare("INSERT INTO agent_profiles VALUES ('p-short', '知识', 'custom.short', 1, NULL, NULL)").run();
    db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-short', 'group-1', 'p-short', 'teammate', 'native-model', 2, NULL)").run();

    const mentions = resolveAgentMentions(db, 'group-1', '@知识管理智能体 请处理');
    expect(mentions.map((mention) => mention.target.id)).toEqual(['group-1-know']);
  });
});
