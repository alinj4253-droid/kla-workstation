import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sub2ApiClient } from './sub2api-client.js';

afterEach(() => vi.unstubAllGlobals());

describe('Sub2API actual usage', () => {
  it('retries one transient login rejection before failing an agent continuation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 401, message: 'invalid email or password' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { access_token: 'recovered-jwt' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new Sub2ApiClient({ baseUrl: 'http://sub2api.test', adminApiKey: '', timeoutMs: 5000, defaultGroupId: '', personalGroupId: '', fastGroupId: '', accountEmailDomain: 'kla.internal' });
    expect(await client.getUserJwt('user-1', 'person@kla.internal', 'managed-password')).toBe('recovered-jwt');
    expect(await client.getUserJwt('user-1', 'person@kla.internal', 'managed-password')).toBe('recovered-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('reports missing upstream URL before fetch receives a relative path', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new Sub2ApiClient({ baseUrl: '', adminApiKey: '', timeoutMs: 5000, defaultGroupId: '', personalGroupId: '', fastGroupId: '', accountEmailDomain: 'kla.internal' });
    await expect(client.loginUser('test@kla.internal', 'test-password')).rejects.toThrow('SUB2API_BASE_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('lists only models exposed to the selected API Key without exposing its secret', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ authorization: 'Bearer selected-key' });
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-flash' }, { id: 'zhipu/glm-5.3-flash' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new Sub2ApiClient({ baseUrl: 'http://sub2api.test', adminApiKey: '', timeoutMs: 5000, defaultGroupId: '', personalGroupId: '', fastGroupId: '', accountEmailDomain: 'kla.internal' });
    expect(await client.listModels('selected-key')).toEqual(['deepseek-v4-flash', 'zhipu/glm-5.3-flash']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://sub2api.test/v1/models');
  });
  it('reads paged admin usage details and maps the billed cost', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      paths.push(url);
      const page = new URL(url).searchParams.get('page');
      const items = page === '1'
        ? [{ id: 39, user_id: 52, api_key_id: 65, request_id: 'r-39', model: 'glm-4', total_cost: 0.00036205, input_tokens: 120, output_tokens: 40, created_at: '2026-10-09T19:40:10+08:00' }]
        : [{ id: 38, user_id: 52, api_key_id: 65, request_id: 'r-38', model: 'glm-4', total_cost: 0.0001676, input_tokens: 70, output_tokens: 20, created_at: '2026-10-09T19:38:56+08:00' }];
      return new Response(JSON.stringify({ code: 0, data: { items, pages: 2 } }), { status: 200 });
    }));
    const client = new Sub2ApiClient({
      baseUrl: 'http://sub2api.test', adminApiKey: 'test-admin-key', timeoutMs: 5000,
      defaultGroupId: '', personalGroupId: '', fastGroupId: '', accountEmailDomain: 'kla.internal',
    });

    const rows = await client.listUsage('52', '2026-10-09T11:00:00Z');
    expect(paths).toHaveLength(2);
    expect(paths.every(path => path.includes('/api/v1/admin/usage?user_id=52'))).toBe(true);
    expect(rows).toEqual([
      { id: '39', userId: '52', apiKeyId: '65', requestId: 'r-39', model: 'glm-4', amountUsd: 0.00036205, promptTokens: 120, completionTokens: 40, cacheCreationTokens: 0, cacheReadTokens: 0, durationMs: null, firstTokenMs: null, timestamp: '2026-10-09T19:40:10+08:00' },
      { id: '38', userId: '52', apiKeyId: '65', requestId: 'r-38', model: 'glm-4', amountUsd: 0.0001676, promptTokens: 70, completionTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, durationMs: null, firstTokenMs: null, timestamp: '2026-10-09T19:38:56+08:00' },
    ]);
  });
});
