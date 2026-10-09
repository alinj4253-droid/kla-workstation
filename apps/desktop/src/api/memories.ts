import { MEMORY_DAY_MS, SHORT_TERM_CACHE_DAYS, type MemoryBrowserPage, type MemoryBrowserQuery, type MemoryBrowserScopes } from '@kla-workstation/contracts';
import { klaApi, type ApiResult } from './client';
import { cachedMemoryPage, MemoryCache, MEMORY_CACHE_TTL_MS, type MemorySnapshot } from './memory-cache';

const cache = new MemoryCache();
let epoch = 0;
const pending = new Map<string, Promise<ApiResult<MemorySnapshot>>>();
const prefix = (accountId: string) => `${klaApi.getCacheOrigin()}|${accountId}|`;
const namespace = (identityId: string) => klaApi.getAccount() ? prefix(klaApi.getAccount()!) + identityId : null;
const current = (key: string, identityId: string, startedEpoch: number) => epoch === startedEpoch && namespace(identityId) === key && klaApi.getIdentity() === identityId && !!sessionStorage.getItem('kla.access-token');
const cancelled = (): ApiResult<never> => ({ ok: false, code: 'CANCELLED', message: '记忆读取已取消' });
const channel = typeof window.BroadcastChannel === 'function' ? new window.BroadcastChannel('kla-memory-cache') : null;
const clearAccount = (accountId: string) => {
  epoch++; pending.clear();
  void cache.clearAccount(prefix(accountId)).catch(() => undefined);
};
if (channel) channel.onmessage = event => { if (typeof event.data?.accountId === 'string') clearAccount(event.data.accountId); };

window.addEventListener('kla:memory-cache-clear', event => {
  const accountId = (event as CustomEvent<string>).detail;
  clearAccount(accountId); channel?.postMessage({ accountId });
});

function serverEntries(identityId: string, query: MemoryBrowserQuery, signal?: AbortSignal) {
  const params = new URLSearchParams({ term: query.term, page: String(query.page), pageSize: String(query.pageSize) });
  for (const name of ['projectId', 'conversationId', 'agentKey', 'from', 'to'] as const) if (query[name]) params.set(name, query[name]);
  return klaApi.request<MemoryBrowserPage>(`/v1/memories/browser?${params}`, { headers: { 'x-identity-id': identityId }, signal });
}

async function synchronize(identityId: string, key: string): Promise<ApiResult<MemorySnapshot>> {
  if (pending.has(key)) return pending.get(key)!;
  const startedEpoch = epoch;
  const job = (async (): Promise<ApiResult<MemorySnapshot>> => {
    const fetchedAt = Date.now();
    const coveredFrom = new Date(fetchedAt - SHORT_TERM_CACHE_DAYS * MEMORY_DAY_MS).toISOString();
    const items: MemorySnapshot['items'] = [];
    let total = 0;
    for (let page = 1; page <= 50; page++) {
      const result = await serverEntries(identityId, { term: 'short_term', from: coveredFrom, to: new Date(fetchedAt).toISOString(), page, pageSize: 100 });
      if (!current(key, identityId, startedEpoch)) return cancelled();
      if (!result.ok) {
        if (['UNAUTHENTICATED', 'SESSION_EXPIRED', 'PERMISSION_DENIED', 'IDENTITY_REQUIRED'].includes(result.code)) await cache.remove(key).catch(() => undefined);
        return result;
      }
      total = result.data.page.total; items.push(...result.data.items);
      if (total > 5000 || JSON.stringify(items).length > 5_000_000) return { ok: false, code: 'CACHE_LIMIT', message: '近期记忆较多，改用服务端分页读取' };
      if (items.length >= total) break;
      if (!result.data.items.length) return { ok: false, code: 'CACHE_INCOMPLETE', message: '近期记忆正在更新，请重新读取' };
    }
    if (new Set(items.map(item => item.id)).size !== total) return { ok: false, code: 'CACHE_INCOMPLETE', message: '近期记忆正在更新，请重新读取' };
    const snapshot = { namespace: key, items, coveredFrom, fetchedAt };
    if (!current(key, identityId, startedEpoch)) return cancelled();
    await cache.write(snapshot).catch(() => undefined);
    // If logout/account change raced an IndexedDB transaction, remove its late write.
    if (!current(key, identityId, startedEpoch)) { await cache.remove(key).catch(() => undefined); return cancelled(); }
    return { ok: true, data: snapshot };
  })();
  pending.set(key, job);
  try { return await job; } finally { if (pending.get(key) === job) pending.delete(key); }
}

/** Viewing memory never invokes a write, extraction or model endpoint. */
export const memoryApi = {
  scopes: (identityId: string, signal?: AbortSignal) => klaApi.request<MemoryBrowserScopes>('/v1/memories/browser/scopes', { headers: { 'x-identity-id': identityId }, signal }),
  entries: async (identityId: string, query: MemoryBrowserQuery, signal?: AbortSignal): Promise<ApiResult<MemoryBrowserPage>> => {
    const key = namespace(identityId);
    const startedEpoch = epoch;
    const recent = query.term === 'short_term' && query.from && Date.parse(query.from) >= Date.now() - SHORT_TERM_CACHE_DAYS * MEMORY_DAY_MS - 1000;
    if (!key || !recent || klaApi.getIdentity() !== identityId) return serverEntries(identityId, query, signal);
    const stored = await cache.read(key).catch(() => undefined);
    if (signal?.aborted || !current(key, identityId, startedEpoch)) return cancelled();
    const cached = stored && cachedMemoryPage(stored, query);
    if (cached && Date.now() - stored.fetchedAt < MEMORY_CACHE_TTL_MS) return { ok: true, data: cached };
    try {
      const synced = await synchronize(identityId, key);
      if (signal?.aborted || !current(key, identityId, startedEpoch)) return cancelled();
      if (synced.ok) {
        const page = cachedMemoryPage(synced.data, query);
        if (page) return { ok: true, data: page };
      } else if (!['CACHE_LIMIT', 'CACHE_INCOMPLETE'].includes(synced.code)) return synced;
    } catch (error) {
      if (cached && !signal?.aborted && current(key, identityId, startedEpoch)) return { ok: true, data: cached };
      throw error;
    }
    return serverEntries(identityId, query, signal);
  },
  warm: async (identityId: string) => {
    await cache.prune().catch(() => undefined);
    const key = namespace(identityId); if (key) await synchronize(identityId, key).catch(() => undefined);
  },
  invalidate: async (identityId: string) => {
    const key = namespace(identityId); epoch++; pending.clear();
    if (key) await cache.remove(key).catch(() => undefined);
  },
};
