import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { WeComWebhookAdapter } from './wecom-webhook.js';

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: vi.fn().mockResolvedValue(response),
  });
}

describe('WeComWebhookAdapter', () => {
  let adapter: WeComWebhookAdapter;

  beforeEach(() => {
    adapter = new WeComWebhookAdapter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('test', () => {
    it('returns success when webhook responds ok', async () => {
      vi.stubGlobal('fetch', mockFetch({ errcode: 0, errmsg: 'ok' }));
      const result = await adapter.test(
        { type: 'wecom-webhook', config: {}, secrets: { webhookUrl: 'https://qyapi.weixin.qq.com/webhook/send?key=xxx' } },
        new AbortController().signal,
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('成功');
    });

    it('returns failure when webhook returns error', async () => {
      vi.stubGlobal('fetch', mockFetch({ errcode: 400, errmsg: 'invalid key' }));
      const result = await adapter.test(
        { type: 'wecom-webhook', config: {}, secrets: { webhookUrl: 'https://qyapi.weixin.qq.com/webhook/send?key=bad' } },
        new AbortController().signal,
      );
      expect(result.success).toBe(false);
    });

    it('returns failure when no webhook URL', async () => {
      const result = await adapter.test(
        { type: 'wecom-webhook', config: {}, secrets: {} },
        new AbortController().signal,
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('缺少');
    });
  });

  describe('send', () => {
    it('sends message and returns ok receipt', async () => {
      vi.stubGlobal('fetch', mockFetch({ errcode: 0, errmsg: 'ok' }));
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start(
        { type: 'wecom-webhook', config: {}, secrets: { webhookUrl: 'https://qyapi.weixin.qq.com/webhook/send?key=xxx' } },
        sink,
      );
      const receipt = await adapter.send({ conversationId: 'https://qyapi.weixin.qq.com/webhook/send?key=xxx' }, { conversationId: 'https://qyapi.weixin.qq.com/webhook/send?key=xxx', text: 'hello' });
      expect(receipt.ok).toBe(true);
    });

    it('returns failure when API returns error', async () => {
      vi.stubGlobal('fetch', mockFetch({ errcode: 400, errmsg: 'invalid' }));
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start(
        { type: 'wecom-webhook', config: {}, secrets: { webhookUrl: 'https://qyapi.weixin.qq.com/webhook/send?key=bad' } },
        sink,
      );
      const receipt = await adapter.send({ conversationId: 'url' }, { conversationId: 'url', text: 'hello' });
      expect(receipt.ok).toBe(false);
    });
  });

  describe('health', () => {
    it('returns connected after start', async () => {
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start(
        { type: 'wecom-webhook', config: {}, secrets: { webhookUrl: 'https://qyapi.weixin.qq.com/webhook/send?key=xxx' } },
        sink,
      );
      expect(adapter.health().connected).toBe(true);
    });

    it('returns not connected after stop', async () => {
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start(
        { type: 'wecom-webhook', config: {}, secrets: { webhookUrl: 'https://qyapi.weixin.qq.com/webhook/send?key=xxx' } },
        sink,
      );
      await adapter.stop();
      expect(adapter.health().connected).toBe(false);
    });
  });
});
