import { useQuery, useQueryClient } from '@tanstack/react-query';
import { libraryEntrySchema, type LibraryEntry } from '@kla-workstation/contracts/knowledge';
import { knowledgeCatalogApi } from '../../api/knowledge';
import { klaApi } from '../../api/client';
import { unwrap } from './api';
export type { LibraryEntry };
export function normalizeKnowledgeServiceUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
const configuredKnowledgeServiceUrl = normalizeKnowledgeServiceUrl(window.klaPlatform?.knowledgeServiceUrl || import.meta.env.VITE_KNOWLEDGE_BASE_URL || '');
export const KNOWLEDGE_SERVICE_URL = configuredKnowledgeServiceUrl || 'http://192.168.10.206:8120';
export function defaultCollection(entry: Pick<LibraryEntry, 'id' | 'name'>): string {
  if (entry.id === 'company') return '金牌知识库';
  if (entry.id === 'project') return '项目知识库';
  if (entry.id === 'personal') return '个人知识库';
  return 'kb_' + entry.id;
}
export function useLibraryCatalog() {
  const client = useQueryClient();
  const key = ['knowledgeCatalog', klaApi.getAccount(), klaApi.getIdentity()] as const;
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(knowledgeCatalogApi.get()), retry: false });
  async function save(entry: LibraryEntry) {
    const valid = libraryEntrySchema.parse({ ...entry, collection: entry.collection.trim() || defaultCollection(entry) });
    const existing = client.getQueryData<LibraryEntry[]>(key)?.some(item => item.id === valid.id);
    await unwrap(existing ? knowledgeCatalogApi.update(valid) : knowledgeCatalogApi.create(valid));
    await client.invalidateQueries({ queryKey: key });
  }
  async function remove(id: string) { await unwrap(knowledgeCatalogApi.remove(id)); await client.invalidateQueries({ queryKey: key }); }
  return { entries: query.data ?? [], save, remove, error: query.error?.message ?? '', loading: query.isPending, refresh: query.refetch };
}
