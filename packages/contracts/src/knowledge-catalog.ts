import { z } from 'zod';
export const libraryEntrySchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80), description: z.string().max(500), scope: z.enum(['company', 'project', 'personal']), collection: z.string().trim().max(200), updatedAt: z.string(), projectId: z.string().uuid().nullable().optional(), organizationId: z.string().uuid().nullable().optional(), personalIdentityId: z.string().uuid().nullable().optional(), canWrite: z.boolean().optional() });
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;
export const knowledgeCatalogSchema = z.array(libraryEntrySchema).max(100).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate library ID');
export const initialKnowledgeCatalog: LibraryEntry[] = [];

/**
 * 目录规范化只处理已知的历史别名。
 * collection 是知识服务的真实路由键，创建知识库时允许用户连接已有
 * 集合；按 scope 强行改名会把多个库合并到同一个集合并造成连接错配。
 */
export const CURRENT_COLLECTIONS: Record<string, string> = {
  'company': '金牌知识库',
  'project': '项目知识库',
  'personal': '个人知识库',
};
export function normalizeCatalogCollection(entry: LibraryEntry): LibraryEntry {
  // The only shipped rename is the old company collection. Keep all other
  // names, including user supplied project/personal collections, untouched.
  const expected = entry.scope === 'company' && entry.collection === '年会知识库'
    ? CURRENT_COLLECTIONS.company
    : undefined;
  if (expected) return { ...entry, collection: expected };
  return entry;
}
export function normalizeKnowledgeCatalog(entries: LibraryEntry[]): { entries: LibraryEntry[]; changed: boolean } {
  let changed = false;
  const next = entries.map((entry) => {
    const normalized = normalizeCatalogCollection(entry);
    if (normalized !== entry) changed = true;
    return normalized;
  });
  return { entries: next, changed };
}
