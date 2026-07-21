import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { projects } from './projects';

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  senderType: text('sender_type', { enum: ['user', 'agent', 'system'] }).notNull(),
  senderId: text('sender_id').notNull(),
  kind: text('kind', { enum: ['text', 'artifact', 'system'] }).notNull().default('text'),
  contentJson: text('content_json').notNull(),
  routingJson: text('routing_json'),
  status: text('status', { enum: ['sending', 'sent', 'failed'] }).notNull().default('sent'),
  replyToId: text('reply_to_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_messages_project').on(table.projectId, table.createdAt, table.id),
]);

export const messageAttachments = sqliteTable('message_attachments', {
  messageId: text('message_id').notNull().references(() => messages.id),
  fileId: text('file_id').notNull(),
  versionId: text('version_id').notNull(),
  ordinal: integer('ordinal').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.messageId, table.fileId, table.versionId] }),
}));
