import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type', { enum: ['project', 'shared'] }).notNull(),
  scopeId: text('scope_id').notNull(),
  parentId: text('parent_id'),
  type: text('type', { enum: ['file', 'directory'] }).notNull(),
  name: text('name').notNull(),
  normalizedPath: text('normalized_path').notNull(),
  mimeType: text('mime_type'),
  currentVersionId: text('current_version_id'),
  origin: text('origin', { enum: ['upload', 'artifact', 'imported'] }).notNull().default('upload'),
  status: text('status', { enum: ['staging', 'ready', 'deleted', 'error'] }).notNull().default('ready'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [
  uniqueIndex('idx_files_scope_path').on(table.scopeType, table.scopeId, table.normalizedPath),
]);

export const fileVersions = sqliteTable('file_versions', {
  id: text('id').primaryKey(),
  fileId: text('file_id').notNull().references(() => files.id),
  versionNo: integer('version_no').notNull(),
  storageRelPath: text('storage_rel_path').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  createdByType: text('created_by_type', { enum: ['user', 'agent', 'system'] }).notNull(),
  createdById: text('created_by_id').notNull(),
  runId: text('run_id'),
  changeNote: text('change_note'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  unq: uniqueIndex('unq_file_versions_file_version').on(table.fileId, table.versionNo),
  shaIdx: index('idx_file_versions_sha').on(table.sha256),
}));
