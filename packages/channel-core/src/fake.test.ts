import { describe, expect, it } from 'vitest';
import { FakeChannelAdapter } from './fake.js';

describe('FakeChannelAdapter', () => {
  it('test returns success', async () => {
    const adapter = new FakeChannelAdapter();
    const result = await adapter.test({ type: 'telegram', config: {}, secrets: {} }, new AbortController().signal);
    expect(result.success).toBe(true);
    expect(result.message).toContain('passed');
  });

  it('start and stop transitions health', async () => {
    const adapter = new FakeChannelAdapter();
    expect(adapter.health().connected).toBe(false);

    const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
    await adapter.start({ type: 'telegram', config: {}, secrets: {} }, sink);
    expect(adapter.health().connected).toBe(true);

    await adapter.stop();
    expect(adapter.health().connected).toBe(false);
  });

  it('send returns ok receipt', async () => {
    const adapter = new FakeChannelAdapter();
    const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
    await adapter.start({ type: 'telegram', config: {}, secrets: {} }, sink);

    const receipt = await adapter.send({ conversationId: '123' }, { conversationId: '123', text: 'hello' });
    expect(receipt.ok).toBe(true);
    expect(receipt.externalEventId).toContain('fake-');

    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]!.message.text).toBe('hello');
  });

  it('simulateInbound triggers sink.onEvent', () => {
    const adapter = new FakeChannelAdapter();
    const events: Array<{ text: string }> = [];
    const sink = { onEvent: (e: any) => events.push(e), onError: () => {}, onStatusChange: () => {} };
    adapter.simulateInbound(sink, {
      externalEventId: 'evt-1',
      externalConversationId: 'conv-1',
      externalUserId: 'user-1',
      text: 'test',
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe('test');
  });

  it('health returns connected and non-null fields after start', async () => {
    const adapter = new FakeChannelAdapter();
    const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
    await adapter.start({ type: 'telegram', config: {}, secrets: {} }, sink);
    const health = adapter.health();
    expect(health.connected).toBe(true);
    expect(typeof health.uptimeMs).toBe('number');
    expect(health.lastPingAt).not.toBeNull();
  });
});
