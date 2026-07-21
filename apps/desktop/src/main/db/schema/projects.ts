import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', { enum: ['active', 'reviewing', 'archived'] }).notNull().default('active'),
  summary: text('summary'),
  leaderInstanceId: text('leader_instance_id'),
  workspaceRelPath: text('workspace_rel_path'),
  sharedKnowledgeEnabled: integer('shared_knowledge_enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastActiveAt: text('last_active_at').notNull(),
  archivedAt: text('archived_at'),
}, (table) => [
  uniqueIndex('idx_projects_last_active').on(table.lastActiveAt),
]);

export const projectViewState = sqliteTable('project_view_state', {
  projectId: text('project_id').primaryKey().references(() => projects.id),
  scrollAnchor: text('scroll_anchor'),
  draftJson: text('draft_json'),
  activeFileId: text('active_file_id'),
  updatedAt: text('updated_at').notNull(),
});
