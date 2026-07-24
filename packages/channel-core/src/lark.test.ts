import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { LarkAdapter } from './lark.js';

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: vi.fn().mockResolvedValue(response),
  });
}

// Mock the Lark SDK — we don't want actual WS connections in unit tests
vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockWSClient {
    start() { return Promise.resolve(); }
    close() {}
    getConnectionStatus() { return { state: 'connected' }; }
  }
  return {
    default: {},
    WSClient: MockWSClient,
    Domain: { Feishu: 'feishu' },
    LoggerLevel: { debug: 0 },
    EventDispatcher: class {
      register() { return this; }
    },
  };
});

describe('LarkAdapter', () => {
  let adapter: LarkAdapter;

  beforeEach(() => {
    adapter = new LarkAdapter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('test', () => {
    it('returns success when token endpoint works', async () => {
      vi.stubGlobal('fetch', mockFetch({ code: 0, msg: 'ok' }));
      const result = await adapter.test(
        { type: 'lark', config: { app_id: 'cli_xxx' }, secrets: { token: 'secret' } },
        new AbortController().signal,
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('成功');
    });

    it('returns failure when auth fails', async () => {
      vi.stubGlobal('fetch', mockFetch({ code: 1, msg: 'invalid app' }));
      const result = await adapter.test(
        { type: 'lark', config: { app_id: 'cli_xxx' }, secrets: { token: 'bad' } },
        new AbortController().signal,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('失败');
    });

    it('returns failure when no credentials', async () => {
      const result = await adapter.test(
        { type: 'lark', config: {}, secrets: {} },
        new AbortController().signal,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('缺少');
    });

    it('returns failure on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
      const result = await adapter.test(
        { type: 'lark', config: { app_id: 'cli_xxx' }, secrets: { token: 'secret' } },
        new AbortController().signal,
      );
      expect(result.success).toBe(false);
    });
  });

  describe('send', () => {
    it('sends message and returns ok receipt', async () => {
      // First fetch = token refresh, second = send message
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: vi.fn().mockResolvedValue({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { message_id: 'msg_123' } }),
        }),
      );
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start({ type: 'lark', config: { app_id: 'cli_xxx' }, secrets: { token: 'secret' } }, sink);

      const receipt = await adapter.send({ conversationId: 'oc_xxx' }, { conversationId: 'oc_xxx', text: 'hello' });
      expect(receipt.ok).toBe(true);
      expect(receipt.externalEventId).toBe('msg_123');
    });

    it('returns failure when API returns error', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: vi.fn().mockResolvedValue({ code: 0, tenant_access_token: 'tok', expire: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: vi.fn().mockResolvedValue({ code: 999, msg: 'permission denied' }),
        }),
      );
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start({ type: 'lark', config: { app_id: 'cli_xxx' }, secrets: { token: 'secret' } }, sink);

      const receipt = await adapter.send({ conversationId: 'oc_xxx' }, { conversationId: 'oc_xxx', text: 'hello' });
      expect(receipt.ok).toBe(false);
      expect(receipt.error).toContain('permission');
    });
  });

  describe('health', () => {
    it('returns health status after start', async () => {
      vi.stubGlobal('fetch', mockFetch({ code: 0, tenant_access_token: 'tok', expire: 7200 }));
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start({ type: 'lark', config: { app_id: 'cli_xxx' }, secrets: { token: 'secret' } }, sink);
      const h = adapter.health();
      expect(h.connected).toBe(true);
    });
  });

  describe('start', () => {
    it('succeeds with valid credentials', async () => {
      vi.stubGlobal('fetch', mockFetch({ code: 0, tenant_access_token: 'tok', expire: 7200 }));
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await expect(adapter.start(
        { type: 'lark', config: { app_id: 'cli_xxx' }, secrets: { token: 'secret' } },
        sink,
      )).resolves.toBeUndefined();
    });
  });
});
