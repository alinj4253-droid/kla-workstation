// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();

class MockBrowserWindow {
  webContents = { send: mockSend };
  isDestroyed = () => false;
}

vi.mock('electron', () => ({ BrowserWindow: MockBrowserWindow }));

const { collectStreamedAgentText, discardStreamingPlaceholder, streamAgentMessage } = await import('./message-stream');

function makeStream(chunks: string[], delayMs = 0): ReadableStream<string> {
  let index = 0;
  return new ReadableStream<string>({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const chunk = chunks[index++];
      if (chunk !== undefined) controller.enqueue(chunk);
    },
  });
}

function sentEvents(): Array<Record<string, unknown>> {
  return mockSend.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

describe('message-stream', () => {
  it('collectStreamedAgentText 逐片分发 message.delta 并返回完整文本', async () => {
    mockSend.mockClear();
    const window = new MockBrowserWindow();
    const text = await collectStreamedAgentText(window as never, {
      projectId: 'p1',
      messageId: 'm1',
      senderId: 'a1',
      stream: makeStream(['你好', '，', '世界']),
    });
    expect(text).toBe('你好，世界');
    const events = sentEvents();
    expect(events.map((event) => event.type)).toEqual(['message.delta', 'message.delta', 'message.delta']);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(events.map((event) => event.delta)).toEqual(['你好', '，', '世界']);
    expect(events.every((event) => event.projectId === 'p1' && event.messageId === 'm1' && event.senderId === 'a1')).toBe(true);
  });

  it('collectStreamedAgentText 在信号已取消时抛出 AbortError', async () => {
    mockSend.mockClear();
    const window = new MockBrowserWindow();
    const controller = new AbortController();
    controller.abort();
    await expect(collectStreamedAgentText(window as never, {
      projectId: 'p1',
      messageId: 'm1',
      senderId: 'a1',
      stream: makeStream(['a']),
    }, controller.signal)).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('collectStreamedAgentText 中途取消时停止消费并抛出 AbortError', async () => {
    mockSend.mockClear();
    const window = new MockBrowserWindow();
    const abortController = new AbortController();
    const stream = new ReadableStream<string>({
      async pull(controller) {
        controller.enqueue('first');
        await new Promise((resolve) => setTimeout(resolve, 5));
        abortController.abort();
        controller.enqueue('second');
      },
    });
    await expect(collectStreamedAgentText(window as never, {
      projectId: 'p1',
      messageId: 'm1',
      senderId: 'a1',
      stream,
    }, abortController.signal)).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }));
    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.delta).toBe('first');
  });

  it('collectStreamedAgentText 分片等待超时时抛出超时错误', async () => {
    vi.useFakeTimers();
    try {
      mockSend.mockClear();
      const window = new MockBrowserWindow();
      const stream = new ReadableStream<string>({
        pull() {
          return new Promise<void>(() => { /* 模拟模型长时间不产出分片 */ });
        },
      });
      const pending = collectStreamedAgentText(window as never, {
        projectId: 'p1',
        messageId: 'm1',
        senderId: 'a1',
        stream,
      });
      const expectation = expect(pending).rejects.toThrow('模型流式响应超时');
      await vi.advanceTimersByTimeAsync(120_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('discardStreamingPlaceholder 广播 message.discarded 事件', () => {
    mockSend.mockClear();
    const window = new MockBrowserWindow();
    discardStreamingPlaceholder(window as never, { projectId: 'p1', messageId: 'm1', reason: 'run-cancelled' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(sentEvents()[0]).toMatchObject({
      type: 'message.discarded',
      projectId: 'p1',
      messageId: 'm1',
      reason: 'run-cancelled',
    });
  });

  it('streamAgentMessage 将已生成文本按块分发且内容完整', async () => {
    mockSend.mockClear();
    const window = new MockBrowserWindow();
    const text = 'a'.repeat(120);
    await streamAgentMessage(window as never, { projectId: 'p1', messageId: 'm1', senderId: 'a1', text });
    const events = sentEvents();
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((event) => event.type === 'message.delta')).toBe(true);
    expect(events.map((event) => event.delta).join('')).toBe(text);
  });
});
