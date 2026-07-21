import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const secrets = sqliteTable('secrets', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  ciphertext: text('ciphertext').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  projectId: text('project_id'),
  readAt: text('read_at'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  readIdx: index('idx_notifications_read').on(table.readAt, table.createdAt),
}));

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  actorType: text('actor_type', { enum: ['user', 'agent', 'system'] }).notNull(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  createdIdx: index('idx_audit_logs_created').on(table.createdAt),
  targetIdx: index('idx_audit_logs_target').on(table.targetType, table.targetId),
}));

export const idempotencyRequests = sqliteTable('idempotency_requests', {
  key: text('key').primaryKey(),
  operation: text('operation').notNull(),
  requestHash: text('request_hash').notNull(),
  resultJson: text('result_json').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
});

export const drafts = sqliteTable('drafts', {
  scope: text('scope').notNull(),
  scopeId: text('scope_id').notNull(),
  contentJson: text('content_json'),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.scope, table.scopeId] }),
}));
