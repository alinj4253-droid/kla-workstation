// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildAgentCollaborationInstructions,
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
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE project_agent_instances (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_profile_id TEXT NOT NULL,
      role TEXT NOT NULL, runtime_mode TEXT NOT NULL, ordinal INTEGER NOT NULL
    );
    CREATE TABLE model_slot_bindings (slot TEXT PRIMARY KEY, model_profile_id TEXT);
    CREATE TABLE model_profiles (
      id TEXT PRIMARY KEY, name TEXT, model_id TEXT, model_slot TEXT,
      parameters_json TEXT, verified_capabilities_json TEXT, provider_id TEXT, enabled INTEGER
    );
    CREATE TABLE model_providers (
      id TEXT PRIMARY KEY, name TEXT, type TEXT, base_url TEXT
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_instance_id TEXT NOT NULL,
      trigger_message_id TEXT, parent_run_id TEXT,
      requested_by_type TEXT NOT NULL DEFAULT 'user', requested_by_id TEXT NOT NULL DEFAULT ''
    );
  `);
  db.prepare("INSERT INTO agent_profiles VALUES ('p-leader', '统筹管理智能体', 'builtin.orchestrator', 1)").run();
  db.prepare("INSERT INTO agent_profiles VALUES ('p-knowledge', '知识管理智能体', 'builtin.knowledge-manager', 1)").run();
  db.prepare("INSERT INTO agent_profiles VALUES ('p-research', '资料调研智能体', 'builtin.researcher', 1)").run();
  db.prepare("INSERT INTO agent_profiles VALUES ('p-disabled', '已禁用智能体', 'custom.disabled', 0)").run();
  db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-orch', 'group-1', 'p-leader', 'leader', 'native-model', 0)").run();
  db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-know', 'group-1', 'p-knowledge', 'teammate', 'native-model', 1)").run();
  db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-research', 'group-1', 'p-research', 'teammate', 'native-model', 2)").run();
  db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-off', 'group-1', 'p-disabled', 'teammate', 'external-cli', 3)").run();
  return db;
}

describe('agent collaboration mentions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
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

  it('recognizes @用户 as a non-routing conversation mention', () => {
    const mentions = resolveAgentMentions(db, 'group-1', '@用户 请补充验收标准。');
    expect(mentions).toEqual([expect.objectContaining({ target: { scope: 'user', id: 'local-user' }, label: '用户' })]);
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
      countRunsByTrigger: vi.fn(() => 20),
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

  it('allows a research agent to hand new findings to knowledge after another sender already used knowledge', () => {
    db.prepare(
      `INSERT INTO agent_runs
       (id, project_id, agent_instance_id, trigger_message_id, requested_by_type, requested_by_id)
       VALUES ('run-orch-know', 'group-1', 'group-1-know', 'root-message', 'agent', 'group-1-orch')`,
    ).run();
    const runRepo = {
      countRunsByTrigger: vi.fn(() => 2),
      getAncestorChain: vi.fn(() => []),
      create: vi.fn(() => ({ id: 'run-research-know' })),
      addEvent: vi.fn(),
    };
    const scheduler = { enqueue: vi.fn() };

    processMessageMentions(
      db, runRepo as never, scheduler as never, 'group-1',
      JSON.stringify({
        text: '@知识管理智能体 请把我补充的资料纳入知识库并更新结论',
        mentions: [{ target: { scope: 'instance', id: 'group-1-know' } }],
      }),
      'root-message', 'group-1-research', 'research-run', 'agent', 'research-message',
    );

    expect(runRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      agentInstanceId: 'group-1-know',
      requestedById: 'group-1-research',
      instruction: '@知识管理智能体 请把我补充的资料纳入知识库并更新结论',
    }));
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('blocks a duplicate sender-to-target edge within the same root task', () => {
    db.prepare(
      `INSERT INTO agent_runs
       (id, project_id, agent_instance_id, trigger_message_id, requested_by_type, requested_by_id)
       VALUES ('run-research-know', 'group-1', 'group-1-know', 'root-message', 'agent', 'group-1-research')`,
    ).run();
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
        text: '@知识管理智能体 请再次整理同一批调研资料并更新结论',
        mentions: [{ target: { scope: 'instance', id: 'group-1-know' } }],
      }),
      'root-message', 'group-1-research', 'research-run-2', 'agent', 'research-message-2',
    );

    expect(runRepo.create).not.toHaveBeenCalled();
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('prefers the longest agent name when group member names overlap', () => {
    db.prepare("INSERT INTO agent_profiles VALUES ('p-short', '知识', 'custom.short', 1)").run();
    db.prepare("INSERT INTO project_agent_instances VALUES ('group-1-short', 'group-1', 'p-short', 'teammate', 'native-model', 2)").run();

    const mentions = resolveAgentMentions(db, 'group-1', '@知识管理智能体 请处理');
    expect(mentions.map((mention) => mention.target.id)).toEqual(['group-1-know']);
  });
});
