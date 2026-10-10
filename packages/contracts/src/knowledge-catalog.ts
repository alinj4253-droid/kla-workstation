import { z } from 'zod';
export const libraryEntrySchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80), description: z.string().max(500), scope: z.enum(['company', 'project', 'personal']), collection: z.string().trim().max(200), updatedAt: z.string(), projectId: z.string().uuid().nullable().optional(), organizationId: z.string().uuid().nullable().optional(), personalIdentityId: z.string().uuid().nullable().optional(), canWrite: z.boolean().optional() });
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;
export const knowledgeCatalogSchema = z.array(libraryEntrySchema).max(100).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate library ID');
export const initialKnowledgeCatalog: LibraryEntry[] = [];

/**
 * 目录规范化：把历史集合名自动升级为当前约定名。
 * 服务端读到存量catalog 后调用一次并回写，**任何人拉代码重启即生效**，
 * 不需要手动改数据库或跑迁移脚本。
 */
export const CURRENT_COLLECTIONS: Record<string, string> = {
  'company': '金牌知识库',
  'project': '项目知识库',
  'personal': '个人知识库',
};
export function normalizeCatalogCollection(entry: LibraryEntry): LibraryEntry {
  const expected = CURRENT_COLLECTIONS[entry.scope] ?? CURRENT_COLLECTIONS[entry.id];
  if (expected && entry.collection !== expected) return { ...entry, collection: expected };
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
