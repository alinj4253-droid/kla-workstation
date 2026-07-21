import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['telegram', 'lark', 'dingtalk', 'wecom-webhook'] }).notNull(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  status: text('status', { enum: ['disconnected', 'connecting', 'connected', 'error'] }).notNull().default('disconnected'),
  configJson: text('config_json'),
  secretRef: text('secret_ref'),
  lastConnectedAt: text('last_connected_at'),
  lastError: text('last_error'),
}, (table) => [
  uniqueIndex('idx_channels_type_name').on(table.type, table.name),
]);

export const channelBindings = sqliteTable('channel_bindings', {
  channelId: text('channel_id').notNull().references(() => channels.id),
  externalConversationId: text('external_conversation_id').notNull(),
  projectId: text('project_id').notNull(),
  createdAt: text('created_at').notNull(),
});

export const channelEvents = sqliteTable('channel_events', {
  channelId: text('channel_id').notNull().references(() => channels.id),
  externalEventId: text('external_event_id').notNull(),
  direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
  payloadJson: text('payload_json'),
  status: text('status', { enum: ['received', 'processed', 'failed'] }).notNull().default('received'),
  createdAt: text('created_at').notNull(),
});
