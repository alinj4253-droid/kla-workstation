import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TelegramAdapter } from './telegram.js';

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: vi.fn().mockResolvedValue(response),
  });
}

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    adapter = new TelegramAdapter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('test', () => {
    it('returns success when token is valid', async () => {
      vi.stubGlobal('fetch', mockFetch({ ok: true }));
      const result = await adapter.test(
        { type: 'telegram', config: {}, secrets: { token: 'valid:token' } },
        new AbortController().signal,
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('成功');
    });

    it('returns failure when token is invalid', async () => {
      vi.stubGlobal('fetch', mockFetch({ ok: false }));
      const result = await adapter.test(
        { type: 'telegram', config: {}, secrets: { token: 'bad:token' } },
        new AbortController().signal,
      );
      expect(result.success).toBe(false);
    });

    it('returns failure when no token provided', async () => {
      const result = await adapter.test(
        { type: 'telegram', config: {}, secrets: {} },
        new AbortController().signal,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('缺少');
    });

    it('returns failure on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
      const result = await adapter.test(
        { type: 'telegram', config: {}, secrets: { token: 'tok' } },
        new AbortController().signal,
      );
      expect(result.success).toBe(false);
    });
  });

  describe('send', () => {
    it('sends message and returns ok receipt', async () => {
      vi.stubGlobal('fetch', mockFetch({ ok: true, result: { message_id: 42 } }));
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start({ type: 'telegram', config: {}, secrets: { token: 'tok' } }, sink);

      const receipt = await adapter.send({ conversationId: '123' }, { conversationId: '123', text: 'hello' });
      expect(receipt.ok).toBe(true);
      expect(receipt.externalEventId).toBe('42');
    });

    it('returns failure when API returns not ok', async () => {
      vi.stubGlobal('fetch', mockFetch({ ok: false }));
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start({ type: 'telegram', config: {}, secrets: { token: 'tok' } }, sink);

      const receipt = await adapter.send({ conversationId: '123' }, { conversationId: '123', text: 'hello' });
      expect(receipt.ok).toBe(false);
    });
  });

  describe('health', () => {
    it('returns not connected before start', () => {
      const h = adapter.health();
      expect(h.connected).toBe(false);
    });

    it('returns connected after start', async () => {
      vi.stubGlobal('fetch', mockFetch({ ok: true, result: [] }));
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start({ type: 'telegram', config: {}, secrets: { token: 'tok' } }, sink);
      expect(adapter.health().connected).toBe(true);
    });

    it('returns not connected after stop', async () => {
      vi.stubGlobal('fetch', mockFetch({ ok: true, result: [] }));
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start({ type: 'telegram', config: {}, secrets: { token: 'tok' } }, sink);
      await adapter.stop();
      expect(adapter.health().connected).toBe(false);
    });
  });

  describe('start', () => {
    it('throws when no token', async () => {
      await expect(adapter.start(
        { type: 'telegram', config: {}, secrets: {} },
        { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} },
      )).rejects.toThrow('缺少');
    });
  });
});
