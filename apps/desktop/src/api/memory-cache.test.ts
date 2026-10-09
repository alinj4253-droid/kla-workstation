import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { MEMORY_DAY_MS, type MemoryBrowserEntry } from '@kla-workstation/contracts';
import { cachedMemoryPage, MemoryCache, type MemorySnapshot } from './memory-cache';

const now = Date.now();
const entry = (id: string, days: number, agentKey = 'agent-a'): MemoryBrowserEntry => ({
  id, content: id, term: 'short_term', kind: 'task_summary', source: 'stored_memory',
  projectId: 'project', projectName: '项目', conversationId: 'chat', conversationName: '群聊', agentKey,
  agentName: agentKey, shared: agentKey === 'shared', sourceMessageId: null, expiresAt: null,
  createdAt: new Date(now - days * MEMORY_DAY_MS).toISOString(), updatedAt: new Date(now - days * MEMORY_DAY_MS).toISOString(),
});
const snapshot = (namespace: string): MemorySnapshot => ({ namespace, coveredFrom: new Date(now - 7 * MEMORY_DAY_MS).toISOString(), fetchedAt: now,
  items: [entry('own', 1), entry('shared', 2, 'shared'), entry('other-agent', 1, 'agent-b'), entry('old', 8)] });

describe('client short-term cache', () => {
  it('isolates account/identity snapshots and only clears the signed-out account', async () => {
    const cache = new MemoryCache();
    await cache.write(snapshot('server|user-a|identity-a'));
    await cache.write(snapshot('server|user-a|identity-b'));
    await cache.write(snapshot('server|user-b|identity-a'));
    expect((await cache.read('server|user-a|identity-b'))?.namespace).toBe('server|user-a|identity-b');
    await cache.clearAccount('server|user-a|');
    expect(await cache.read('server|user-a|identity-a')).toBeUndefined();
    expect(await cache.read('server|user-a|identity-b')).toBeUndefined();
    expect(await cache.read('server|user-b|identity-a')).toBeDefined();
  });
  it('filters recent memory locally, preserves shared input, recalculates weight and refuses older ranges', () => {
    const query = { term: 'short_term' as const, from: new Date(now - 7 * MEMORY_DAY_MS).toISOString(), agentKey: 'agent-a', page: 1, pageSize: 1 };
    const result = cachedMemoryPage(snapshot('namespace'), query, now)!;
    expect(result.page.total).toBe(2);
    expect(result.items[0].id).toBe('own');
    expect(result.items[0].timeWeight).toBeLessThan(1);
    expect(cachedMemoryPage(snapshot('namespace'), { ...query, page: 2 }, now)?.items[0].id).toBe('shared');
    expect(cachedMemoryPage(snapshot('namespace'), { ...query, from: new Date(now - 8 * MEMORY_DAY_MS).toISOString() }, now)).toBeNull();
    expect(cachedMemoryPage(snapshot('namespace'), { ...query, term: 'long_term' }, now)).toBeNull();
  });
  it('physically removes entries older than seven days without altering server data', async () => {
    const cache = new MemoryCache();
    await cache.write(snapshot('prune|user|identity'));
    await cache.prune(now);
    expect((await cache.read('prune|user|identity'))?.items.map(item => item.id)).not.toContain('old');
  });
});
