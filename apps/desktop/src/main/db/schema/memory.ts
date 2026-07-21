import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const memoryRecords = sqliteTable('memory_records', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  agentInstanceId: text('agent_instance_id').notNull(),
  scope: text('scope', { enum: ['short-term', 'long-term'] }).notNull(),
  type: text('type').notNull(),
  content: text('content').notNull(),
  confidence: integer('confidence').notNull().default(1),
  sourceRefsJson: text('source_refs_json'),
  status: text('status', { enum: ['active', 'expired', 'deleted'] }).notNull().default('active'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_memory_records_lookup').on(table.agentInstanceId, table.scope, table.status),
]);
