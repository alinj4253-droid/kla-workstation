// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { selectTaskContextMessages } from './task-context';

describe('task context selection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sender_type TEXT NOT NULL,
        sender_id TEXT NOT NULL, kind TEXT NOT NULL, content_json TEXT NOT NULL,
        status TEXT NOT NULL, reply_to_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, trigger_message_id TEXT,
        parent_run_id TEXT, agent_instance_id TEXT NOT NULL, requested_by_type TEXT NOT NULL,
        requested_by_id TEXT NOT NULL, instruction TEXT, status TEXT NOT NULL,
        result_message_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE agent_run_events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
        type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL
      );
    `);
  });

  afterEach(() => db.close());

  const message = (id: string, text: string, createdAt: string, senderType = 'user', replyToId: string | null = null) => {
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'group-1', senderType, senderType === 'user' ? 'local-user' : 'agent-1', 'text', JSON.stringify({ text }), 'sent', replyToId, createdAt, createdAt);
  };

  it('adds only a minimal recent background for an ordinary new request', () => {
    message('old-user-1', '第一份旧需求', '2026-09-02T00:40:00.000Z');
    message('old-result-1', '第一份旧结果', '2026-09-02T00:41:00.000Z', 'agent');
    message('old-user-2', '第二份旧需求', '2026-09-02T00:50:00.000Z');
    message('old-result-2', '第二份旧结果', '2026-09-02T00:51:00.000Z', 'agent');
    message('old-user-3', '第三份旧需求', '2026-09-02T00:55:00.000Z');
    message('old-result-3', '第三份旧结果', '2026-09-02T00:56:00.000Z', 'agent');
    message('new-user', '头脑风暴十个产品名称，只回复文本', '2026-09-02T02:00:00.000Z');

    const selected = selectTaskContextMessages(db, 'group-1', 'new-user');
    expect(selected.map((row) => [row.id, row.taskRelation])).toEqual([
      ['old-user-2', 'history'],
      ['old-result-2', 'history'],
      ['old-user-3', 'history'],
      ['old-result-3', 'history'],
      ['new-user', 'current'],
    ]);
  });

  it('lets an implicit format follow-up see the previous round through the fallback window', () => {
    message('stock-user', '帮我梳理一份完整的今日A股评估报告', '2026-09-09T07:52:02.000Z');
    message('stock-result', '已产出 outputs/今日A股评估报告_2026-09-09.md', '2026-09-09T07:55:02.000Z', 'agent');
    message('new-user', '我要html的报告', '2026-09-09T07:55:28.000Z');

    const selected = selectTaskContextMessages(db, 'group-1', 'new-user');
    expect(selected.map((row) => [row.id, row.taskRelation])).toEqual([
      ['stock-user', 'history'],
      ['stock-result', 'history'],
      ['new-user', 'current'],
    ]);
  });

  it('adds bounded marked history only for an explicit follow-up', () => {
    message('old-user', '分析新品发布策略', '2026-09-02T01:00:00.000Z');
    message('old-result', '策略分析如下', '2026-09-02T01:01:00.000Z', 'agent');
    message('new-user', '把上面的内容整理成文件', '2026-09-02T02:00:00.000Z');

    const selected = selectTaskContextMessages(db, 'group-1', 'new-user');
    expect(selected.map((row) => [row.id, row.taskRelation])).toEqual([
      ['old-user', 'history'],
      ['old-result', 'history'],
      ['new-user', 'current'],
    ]);
  });

  it('keeps delegation, result and quoted user reply in the same root chain', () => {
    message('root-user', '查询今天的天气', '2026-09-02T01:00:00.000Z');
    message('delegation', '@调研智能体 查询厦门天气', '2026-09-02T01:01:00.000Z', 'agent');
    message('question', '@用户 请确认城市', '2026-09-02T01:02:00.000Z', 'agent');
    message('reply', '厦门', '2026-09-02T01:03:00.000Z', 'user', 'question');
    db.prepare('INSERT INTO agent_runs VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)')
      .run('run-1', 'group-1', 'root-user', 'agent-1', 'user', 'local-user', '查询天气', 'awaiting_user', 'question', '2026-09-02T01:00:01.000Z');
    db.prepare('INSERT INTO agent_run_events VALUES (?, ?, ?, ?, ?, ?)')
      .run('event-1', 'run-1', 1, 'run.anchor', JSON.stringify({ messageId: 'delegation' }), '2026-09-02T01:01:00.000Z');

    expect(selectTaskContextMessages(db, 'group-1', 'root-user').map((row) => row.id))
      .toEqual(['root-user', 'delegation', 'question', 'reply']);
  });
});
