import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { projects } from './projects';

export const agentRuns = sqliteTable('agent_runs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  triggerMessageId: text('trigger_message_id'),
  parentRunId: text('parent_run_id'),
  agentInstanceId: text('agent_instance_id').notNull(),
  requestedByType: text('requested_by_type', { enum: ['user', 'agent', 'system'] }).notNull(),
  requestedById: text('requested_by_id').notNull(),
  instruction: text('instruction'),
  status: text('status', {
    enum: ['queued', 'starting', 'running', 'completed', 'failed', 'cancelling', 'cancelled', 'interrupted'],
  }).notNull().default('queued'),
  attempt: integer('attempt').notNull().default(1),
  modelProfileSnapshotJson: text('model_profile_snapshot_json'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  resultMessageId: text('result_message_id'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_agent_runs_instance').on(table.agentInstanceId, table.status),
  index('idx_agent_runs_created').on(table.createdAt),
]);

export const agentRunEvents = sqliteTable('agent_run_events', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
  type: text('type').notNull(),
  payloadJson: text('payload_json'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  unq: uniqueIndex('unq_agent_run_events_seq').on(table.runId, table.seq),
}));
