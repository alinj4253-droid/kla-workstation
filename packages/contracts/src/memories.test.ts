import { describe, expect, it } from 'vitest';
import { memoryBrowserQuerySchema } from './memories.js';

describe('memory browser query', () => {
  it('defaults to bounded long-term pagination and parses URL parameters', () => {
    expect(memoryBrowserQuerySchema.parse({})).toEqual({ term: 'long_term', page: 1, pageSize: 20 });
    expect(memoryBrowserQuerySchema.parse({ term: 'short_term', page: '2', pageSize: '50' })).toEqual({ term: 'short_term', page: 2, pageSize: 50 });
  });
  it.each([{ term: 'all' }, { projectId: 'invalid' }, { conversationId: 'invalid' }, { page: '0' }, { pageSize: '101' }])('rejects invalid scope or pagination: %j', query => {
    expect(memoryBrowserQuerySchema.safeParse(query).success).toBe(false);
  });
  it('accepts a bounded time range and rejects reversed or invalid timestamps', () => {
    const from = '2026-10-01T00:00:00.000Z';
    const to = '2026-10-09T00:00:00.000Z';
    expect(memoryBrowserQuerySchema.parse({ from, to })).toMatchObject({ from, to });
    expect(memoryBrowserQuerySchema.safeParse({ from: to, to: from }).success).toBe(false);
    expect(memoryBrowserQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
  });
});
