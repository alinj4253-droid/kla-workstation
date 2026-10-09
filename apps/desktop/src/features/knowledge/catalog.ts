import { useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { libraryEntrySchema, type LibraryEntry } from '@kla-workstation/contracts/knowledge';
import { knowledgeCatalogApi } from '../../api/knowledge';
import { unwrap } from './api';
export type { LibraryEntry };
export const KNOWLEDGE_SERVICE_URL = import.meta.env.VITE_KNOWLEDGE_BASE_URL || 'http://192.168.10.206:8120';
export function defaultCollection(entry: Pick<LibraryEntry, 'id' | 'name'>): string {
  if (entry.id === 'company') return '金牌知识库';
  if (entry.id === 'project') return '项目知识库';
  if (entry.id === 'personal') return '个人知识库';
  return 'kb_' + entry.id;
}
const key = ['knowledgeCatalog'] as const;
export function useLibraryCatalog() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: key, queryFn: () => unwrap(knowledgeCatalogApi.get()), retry: false });
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  function persist(change: (entries: LibraryEntry[]) => LibraryEntry[]): Promise<void> {
    const work = writes.current.catch(() => undefined).then(async () => {
      const current = client.getQueryData<LibraryEntry[]>(key);
      if (!current) throw new Error('请先读取服务端知识库目录。');
      const next = await unwrap(knowledgeCatalogApi.save(change(current)));
      client.setQueryData(key, next);
    });
    writes.current = work;
    return work;
  }
  async function save(entry: LibraryEntry) {
    const valid = libraryEntrySchema.parse({ ...entry, collection: entry.collection.trim() || defaultCollection(entry) });
    await persist(current => current.some(item => item.id === valid.id) ? current.map(item => item.id === valid.id ? valid : item) : [...current, valid]);
  }
  async function remove(id: string) { await persist(current => current.filter(entry => entry.id !== id)); }
  return { entries: query.data ?? [], save, remove, error: query.error?.message ?? '', loading: query.isPending, refresh: query.refetch };
}
