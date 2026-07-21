import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BaseRepository } from './base';
import { notFound } from '../errors';

export type RunStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelling' | 'cancelled' | 'interrupted';

export interface AgentRunRow {
  id: string;
  projectId: string;
  triggerMessageId: string | null;
  parentRunId: string | null;
  agentInstanceId: string;
  requestedByType: string;
  requestedById: string;
  instruction: string | null;
  status: RunStatus;
  attempt: number;
  modelProfileSnapshotJson: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  resultMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface AgentRunEventRow {
  id: string;
  runId: string;
  seq: number;
  type: string;
  payloadJson: string | null;
  createdAt: string;
}

const RUN_COLS = 'id, project_id as projectId, trigger_message_id as triggerMessageId, parent_run_id as parentRunId, agent_instance_id as agentInstanceId, requested_by_type as requestedByType, requested_by_id as requestedById, instruction, status, attempt, model_profile_snapshot_json as modelProfileSnapshotJson, started_at as startedAt, finished_at as finishedAt, result_message_id as resultMessageId, error_code as errorCode, error_message as errorMessage, created_at as createdAt';

export class AgentRunRepository extends BaseRepository {
  constructor(db: Database.Database) { super(db); }

  getById(id: string): AgentRunRow {
    const row = this.db.prepare(`SELECT ${RUN_COLS} FROM agent_runs WHERE id = ?`).get(id) as AgentRunRow | undefined;
    if (!row) throw notFound('AgentRun', id);
    return row;
  }

  listByProject(projectId: string, limit = 20): AgentRunRow[] {
    return this.db.prepare(
      `SELECT ${RUN_COLS} FROM agent_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(projectId, limit) as AgentRunRow[];
  }

  listQueuedByInstance(agentInstanceId: string, limit = 5): AgentRunRow[] {
    return this.db.prepare(
      `SELECT ${RUN_COLS} FROM agent_runs WHERE agent_instance_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT ?`,
    ).all(agentInstanceId, limit) as AgentRunRow[];
  }

  create(input: {
    projectId: string; agentInstanceId: string; requestedByType: string; requestedById: string;
    instruction?: string; parentRunId?: string; triggerMessageId?: string; status?: RunStatus;
  }): AgentRunRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    this.db.prepare(
      `INSERT INTO agent_runs (id, project_id, agent_instance_id, requested_by_type, requested_by_id, instruction, parent_run_id, trigger_message_id, status, attempt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, input.projectId, input.agentInstanceId, input.requestedByType, input.requestedById,
      input.instruction ?? null, input.parentRunId ?? null, input.triggerMessageId ?? null,
      input.status ?? 'queued', now);
    return this.getById(id);
  }

  setStatus(id: string, status: RunStatus, extra?: { errorCode?: string; errorMessage?: string }): void {
    const sets = ['status = ?', ...(status === 'running' ? ['started_at = ?'] : []), ...(['completed', 'failed', 'cancelled', 'interrupted'].includes(status) ? ['finished_at = ?'] : [])];
    const params: unknown[] = [status];
    if (status === 'running') params.push(this.now());
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) params.push(this.now());
    if (extra?.errorCode) { sets.push('error_code = ?'); params.push(extra.errorCode); }
    if (extra?.errorMessage) { sets.push('error_message = ?'); params.push(extra.errorMessage); }
    params.push(id);
    this.db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  setResultMessage(id: string, messageId: string): void {
    this.db.prepare('UPDATE agent_runs SET result_message_id = ? WHERE id = ?').run(messageId, id);
  }

  interruptByAgent(agentInstanceId: string): void {
    this.db.prepare(
      "UPDATE agent_runs SET status = 'interrupted', finished_at = ? WHERE agent_instance_id = ? AND status IN ('queued', 'starting', 'running')",
    ).run(this.now(), agentInstanceId);
  }

  listEvents(runId: string): AgentRunEventRow[] {
    return this.db.prepare(
      'SELECT id, run_id as runId, seq, type, payload_json as payloadJson, created_at as createdAt FROM agent_run_events WHERE run_id = ? ORDER BY seq',
    ).all(runId) as AgentRunEventRow[];
  }

  addEvent(runId: string, type: string, payload?: unknown): AgentRunEventRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 as next FROM agent_run_events WHERE run_id = ?').get(runId) as { next: number }).next;
    const now = this.now();
    this.db.prepare(
      'INSERT INTO agent_run_events (id, run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, runId, seq, type, payload ? JSON.stringify(payload) : null, now);
    return { id, runId, seq, type, payloadJson: payload ? JSON.stringify(payload) : null, createdAt: now };
  }
}
