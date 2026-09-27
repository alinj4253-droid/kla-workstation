// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AgentRunRepository, MessageRepository } from '@kunqing/database';

describe('message idempotency', () => {
  it('creates only one user message for a stable id', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_json TEXT NOT NULL,
        status TEXT NOT NULL,
        reply_to_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const repository = new MessageRepository(db);
    const first = repository.createUserMessage('project-1', '{"text":"第一次"}', 'stable-message-id');
    const duplicate = repository.createUserMessage('project-1', '{"text":"重复请求"}', 'stable-message-id');

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.createdAt).toBe(first.createdAt);
    expect((db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT content_json as content FROM messages WHERE id = ?').get('stable-message-id') as { content: string }).content)
      .toBe('{"text":"第一次"}');
    db.close();
  });

  it('persists a quoted reply and finds every run waiting on that message', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sender_type TEXT NOT NULL,
        sender_id TEXT NOT NULL, kind TEXT NOT NULL, content_json TEXT NOT NULL,
        status TEXT NOT NULL, reply_to_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, trigger_message_id TEXT, parent_run_id TEXT,
        agent_instance_id TEXT NOT NULL, requested_by_type TEXT NOT NULL, requested_by_id TEXT NOT NULL,
        instruction TEXT, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
        model_profile_snapshot_json TEXT, started_at TEXT, finished_at TEXT, result_message_id TEXT,
        error_code TEXT, error_message TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE agent_run_events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
        payload_json TEXT, created_at TEXT NOT NULL
      );
    `);
    const messages = new MessageRepository(db);
    const question = messages.createUserMessage('project-1', '{"text":"问题"}', 'question-message');
    const reply = messages.createUserMessage('project-1', '{"text":"关键结果"}', 'reply-message', question.id);
    expect(reply.replyToId).toBe(question.id);

    const runs = new AgentRunRepository(db);
    const first = runs.create({ projectId: 'project-1', agentInstanceId: 'agent-1', requestedByType: 'agent', requestedById: 'leader', status: 'awaiting_user' });
    const second = runs.create({ projectId: 'project-1', agentInstanceId: 'agent-2', requestedByType: 'agent', requestedById: 'leader', status: 'awaiting_user' });
    runs.setResultMessage(first.id, question.id);
    runs.setResultMessage(second.id, question.id);
    expect(runs.listAwaitingUserByMessage('project-1', question.id).map((run) => run.id)).toEqual([first.id, second.id]);
    db.close();
  });
});
