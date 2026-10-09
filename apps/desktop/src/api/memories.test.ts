import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_DAY_MS, type MemoryBrowserEntry, type MemoryBrowserPage } from '@kla-workstation/contracts';
import { klaApi, type ApiResult } from './client';
import { memoryApi } from './memories';
import { MemoryCache } from './memory-cache';

const cache = new MemoryCache();
let accountSequence = 0;
const identity = 'identity-one';
const key = () => `${klaApi.getCacheOrigin()}|${klaApi.getAccount()}|${identity}`;
const query = (days = 7) => ({ term: 'short_term' as const, from: new Date(Date.now() - days * MEMORY_DAY_MS).toISOString(), page: 1, pageSize: 20 });
const entry = (): MemoryBrowserEntry => ({
  id: 'memory:1', content: '当前任务内容', term: 'short_term', kind: 'task_summary', source: 'stored_memory',
  projectId: 'project-one', projectName: '项目', conversationId: 'chat-one', conversationName: '群聊',
  agentKey: 'agent-one', agentName: '本地执行智能体', shared: false, sourceMessageId: null,
  createdAt: new Date(Date.now() - MEMORY_DAY_MS).toISOString(), updatedAt: new Date().toISOString(), expiresAt: null,
});
const page = (): MemoryBrowserPage => ({ items: [entry()], page: { page: 1, pageSize: 100, total: 1 } });
const seed = async () => cache.write({ namespace: key(), items: [entry()], fetchedAt: Date.now() - 120_000, coveredFrom: new Date(Date.now() - 7 * MEMORY_DAY_MS - 1000).toISOString() });

beforeEach(() => {
  sessionStorage.clear(); klaApi.setAccount(`cache-user-${++accountSequence}`);
  klaApi.setIdentity(identity); klaApi.setAccessToken('test-token');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('memory API cache routing', () => {
  it('synchronizes once, filters recent entries locally and requests older ranges from the server', async () => {
    const request = vi.spyOn(klaApi, 'request').mockResolvedValue({ ok: true, data: page() });
    expect((await memoryApi.entries(identity, query())).ok).toBe(true);
    const result = await memoryApi.entries(identity, { ...query(), agentKey: 'other-agent' });
    expect(result.ok && result.data.items).toEqual([]);
    expect(request).toHaveBeenCalledOnce();
    await memoryApi.entries(identity, query(30));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toContain('from=');
    expect(request.mock.calls[1][1]).toMatchObject({ headers: { 'x-identity-id': identity } });
  });
  it('can read an existing recent snapshot offline while still recomputing decay', async () => {
    await seed();
    vi.spyOn(klaApi, 'request').mockRejectedValue(new TypeError('Network unavailable'));
    const result = await memoryApi.entries(identity, query());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.items[0].timeWeight).toBeLessThan(1);
  });
  it('does not fall back to cached private data when the server rejects authorization', async () => {
    await seed();
    vi.spyOn(klaApi, 'request').mockResolvedValue({ ok: false, code: 'PERMISSION_DENIED', message: '权限已撤回' });
    expect(await memoryApi.entries(identity, query())).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(await cache.read(key())).toBeUndefined();
  });
  it('never saves an incomplete oversized snapshot and falls back to authoritative pagination', async () => {
    const request = vi.spyOn(klaApi, 'request').mockResolvedValue({ ok: true, data: { ...page(), page: { page: 1, pageSize: 100, total: 6000 } } });
    expect((await memoryApi.entries(identity, query())).ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await cache.read(key())).toBeUndefined();
  });
  it('discards a late response after logout rather than recreating its cache', async () => {
    const oldKey = key();
    let finish!: (value: ApiResult<unknown>) => void;
    const request = vi.spyOn(klaApi, 'request').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = memoryApi.entries(identity, query());
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    klaApi.clearAccessToken();
    finish({ ok: true, data: page() });
    expect(await pending).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(await cache.read(oldKey)).toBeUndefined();
  });
  it('uses the server when IndexedDB is unavailable without breaking the memory page', async () => {
    vi.stubGlobal('indexedDB', undefined);
    vi.spyOn(klaApi, 'request').mockResolvedValue({ ok: true, data: page() });
    const result = await memoryApi.entries(identity, query());
    expect(result.ok && result.data.items[0].content).toBe('当前任务内容');
  });
});
