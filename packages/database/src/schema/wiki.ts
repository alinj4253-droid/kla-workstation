import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const wikiPages = sqliteTable('wiki_pages', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type', { enum: ['project', 'shared'] }).notNull(),
  scopeId: text('scope_id').notNull(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  bodyMd: text('body_md'),
  sourceRefsJson: text('source_refs_json'),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  unq: uniqueIndex('unq_wiki_pages_scope_slug').on(table.scopeType, table.scopeId, table.slug),
}));
