import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const workspaceRegistry = sqliteTable('workspace_registry', {
  workspaceId: text('workspace_id').primaryKey(),
  rootPathHash: text('root_path_hash').notNull(),
  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  lastOpenedAt: text('last_opened_at').notNull(),
});
