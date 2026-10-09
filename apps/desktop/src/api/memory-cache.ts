import { MEMORY_DAY_MS, SHORT_TERM_CACHE_DAYS, shortTermTimeWeight, type MemoryBrowserEntry, type MemoryBrowserPage, type MemoryBrowserQuery } from '@kla-workstation/contracts';

export type MemorySnapshot = { namespace: string; items: MemoryBrowserEntry[]; coveredFrom: string; fetchedAt: number };
const databaseName = 'kla-short-term-memory';
const storeName = 'snapshots';
export const MEMORY_CACHE_TTL_MS = 60_000;

/** A replaceable server snapshot, never a source of authoritative model context. */
export class MemoryCache {
  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'namespace' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Memory cache is blocked'));
    });
  }
  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = action(tx.objectStore(storeName));
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Memory cache transaction failed')); };
    });
  }
  async read(namespace: string): Promise<MemorySnapshot | undefined> {
    return this.transaction<MemorySnapshot | undefined>('readonly', store => store.get(namespace));
  }
  async write(snapshot: MemorySnapshot): Promise<void> {
    await this.transaction('readwrite', store => store.put(snapshot));
  }
  async remove(namespace: string): Promise<void> {
    await this.transaction('readwrite', store => store.delete(namespace));
  }
  async clearAccount(accountPrefix: string): Promise<void> {
    const keys = await this.transaction<IDBValidKey[]>('readonly', store => store.getAllKeys());
    await Promise.all(keys.filter(key => typeof key === 'string' && key.startsWith(accountPrefix)).map(key => this.remove(String(key))));
  }
  async prune(now = Date.now()): Promise<void> {
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const request = tx.objectStore(storeName).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const snapshot = cursor.value as MemorySnapshot;
        const items = snapshot.items.filter(item => Date.parse(item.createdAt) >= now - SHORT_TERM_CACHE_DAYS * MEMORY_DAY_MS);
        if (!items.length && snapshot.fetchedAt < now - SHORT_TERM_CACHE_DAYS * MEMORY_DAY_MS) cursor.delete();
        else if (items.length !== snapshot.items.length) cursor.update({ ...snapshot, items });
        cursor.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }
}

export function cachedMemoryPage(snapshot: MemorySnapshot, query: MemoryBrowserQuery, now = Date.now()): MemoryBrowserPage | null {
  const cutoff = now - SHORT_TERM_CACHE_DAYS * MEMORY_DAY_MS;
  if (query.term !== 'short_term' || !query.from || Date.parse(query.from) < cutoff - 1000
    || Math.max(cutoff, Date.parse(query.from)) < Date.parse(snapshot.coveredFrom) || (query.to && Date.parse(query.to) > now)) return null;
  const items = snapshot.items.filter(item => Date.parse(item.createdAt) >= Math.max(cutoff, Date.parse(query.from!))
    && (!query.to || Date.parse(item.createdAt) <= Date.parse(query.to))
    && (!item.expiresAt || Date.parse(item.expiresAt) > now)
    && (!item.retainedUntil || Date.parse(item.retainedUntil) > now)
    && (!query.projectId || item.projectId === query.projectId)
    && (!query.conversationId || item.conversationId === query.conversationId)
    && (!query.agentKey || item.agentKey === query.agentKey || item.shared))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  return { items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
    .map(item => ({ ...item, timeWeight: shortTermTimeWeight(item.reinforcedAt ?? item.createdAt, now) })),
  page: { page: query.page, pageSize: query.pageSize, total: items.length } };
}
