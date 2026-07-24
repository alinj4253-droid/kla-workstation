import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { DingTalkAdapter } from './dingtalk.js';

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: vi.fn().mockResolvedValue(response),
  });
}

describe('DingTalkAdapter', () => {
  let adapter: DingTalkAdapter;

  beforeEach(() => {
    adapter = new DingTalkAdapter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('test', () => {
    it('returns success when token endpoint works', async () => {
      vi.stubGlobal('fetch', mockFetch({ errcode: 0, errmsg: 'ok' }));
      const result = await adapter.test(
        { type: 'dingtalk', config: { clientId: 'cid', clientSecret: 'cs' }, secrets: {} },
        new AbortController().signal,
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('成功');
    });

    it('returns failure when auth fails', async () => {
      vi.stubGlobal('fetch', mockFetch({ errcode: 400, errmsg: 'invalid' }));
      const result = await adapter.test(
        { type: 'dingtalk', config: { clientId: 'cid', clientSecret: 'bad' }, secrets: {} },
        new AbortController().signal,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('失败');
    });

    it('returns failure when no credentials', async () => {
      const result = await adapter.test(
        { type: 'dingtalk', config: {}, secrets: {} },
        new AbortController().signal,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('缺少');
    });

    it('returns failure on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
      const result = await adapter.test(
        { type: 'dingtalk', config: { clientId: 'cid', clientSecret: 'cs' }, secrets: {} },
        new AbortController().signal,
      );
      expect(result.success).toBe(false);
    });
  });

  describe('send', () => {
    it('sends message and returns ok receipt', async () => {
      // First call = token refresh, second = send
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: vi.fn().mockResolvedValue({ errcode: 0, access_token: 'tok', expires_in: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: vi.fn().mockResolvedValue({ ok: true, processQueryKey: 'pkey_1' }),
        }),
      );
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start({ type: 'dingtalk', config: { clientId: 'cid', clientSecret: 'cs' }, secrets: {} }, sink);

      const receipt = await adapter.send({ conversationId: 'cid_123' }, { conversationId: 'cid_123', text: 'hello' });
      expect(receipt.ok).toBe(true);
      expect(receipt.externalEventId).toBe('pkey_1');
    });

    it('returns failure when send fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 500,
        json: vi.fn().mockResolvedValue({}),
      }));
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start({ type: 'dingtalk', config: { clientId: 'cid', clientSecret: 'cs' }, secrets: {} }, sink);

      const receipt = await adapter.send({ conversationId: 'cid_123' }, { conversationId: 'cid_123', text: 'hello' });
      expect(receipt.ok).toBe(false);
    });
  });

  describe('health', () => {
    it('returns connected after start', async () => {
      vi.stubGlobal('fetch', mockFetch({ errcode: 0, access_token: 'tok', expires_in: 7200 }));
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start({ type: 'dingtalk', config: { clientId: 'cid', clientSecret: 'cs' }, secrets: {} }, sink);
      expect(adapter.health().connected).toBe(true);
    });

    it('returns not connected after stop', async () => {
      vi.stubGlobal('fetch', mockFetch({ errcode: 0, access_token: 'tok', expires_in: 7200 }));
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start({ type: 'dingtalk', config: { clientId: 'cid', clientSecret: 'cs' }, secrets: {} }, sink);
      await adapter.stop();
      expect(adapter.health().connected).toBe(false);
    });
  });
});
