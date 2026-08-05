import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

export const memoryRecords = sqliteTable('memory_records', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  agentInstanceId: text('agent_instance_id').notNull(),
  scope: text('scope', { enum: ['short-term', 'long-term'] }).notNull(),
  type: text('type').notNull(),
  content: text('content').notNull(),
  confidence: real('confidence').notNull().default(1),
  importance: real('importance').notNull().default(0.5),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  topicKey: text('topic_key'),
  sourceRefsJson: text('source_refs_json'),
  metadataJson: text('metadata_json'),
  status: text('status', { enum: ['active', 'expired', 'deleted', 'consolidated', 'superseded'] }).notNull().default('active'),
  expiresAt: text('expires_at'),
  lastReinforcedAt: text('last_reinforced_at').notNull(),
  lastAccessedAt: text('last_accessed_at'),
  accessCount: integer('access_count').notNull().default(0),
  consolidatedIntoId: text('consolidated_into_id'),
  supersedesId: text('supersedes_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_memory_records_lookup').on(table.agentInstanceId, table.scope, table.status),
]);

export const memoryTombstones = sqliteTable('memory_tombstones', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  agentInstanceId: text('agent_instance_id').notNull(),
  normalizedKey: text('normalized_key').notNull(),
  sourceMessageId: text('source_message_id'),
  reason: text('reason').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_memory_tombstones_lookup').on(table.projectId, table.agentInstanceId, table.normalizedKey),
]);
