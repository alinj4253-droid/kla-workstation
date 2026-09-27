import type { BrowserWindow } from 'electron';
import { broadcastEvent } from './event-broadcast';

/** 流式分片的最长等待时间；超时视为模型响应中断，由调用方回退或失败。 */
const STREAM_CHUNK_TIMEOUT_MS = 120_000;

export async function streamAgentMessage(
  window: BrowserWindow,
  input: { projectId: string; messageId: string; senderId: string; text: string },
  signal?: AbortSignal,
): Promise<void> {
  if (window.isDestroyed() || !input.text) return;
  // 文本在调用前已生成完毕，这里只负责按块分发 message.delta 事件；
  // 不附加人为延迟，避免伪流式拖慢交付。
  const chunkSize = Math.max(3, Math.ceil(input.text.length / 56));
  let seq = 0;
  for (let index = 0; index < input.text.length; index += chunkSize) {
    if (signal?.aborted || window.isDestroyed()) return;
    broadcastEvent(window, {
      type: 'message.delta',
      projectId: input.projectId,
      messageId: input.messageId,
      senderId: input.senderId,
      seq,
      delta: input.text.slice(index, index + chunkSize),
    });
    seq += 1;
  }
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<string>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<string>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('用户取消', 'AbortError'));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('模型流式响应超时'));
    }, STREAM_CHUNK_TIMEOUT_MS);
    const onAbort = () => {
      cleanup();
      reject(new DOMException('用户取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => { cleanup(); resolve(result); },
      (err) => { cleanup(); reject(err); },
    );
  });
}

/**
 * 真流式消费：边接收模型分片边向渲染端分发 message.delta，返回拼接后的完整文本。
 * 两阶段提交协议的第一阶段——渲染端以 sending 占位消息实时渲染分片；
 * 第二阶段由调用方在完整文本确定后落库并广播 message.committed（同 ID 时整体替换）。
 * 分片等待超时或外部取消时抛错；已分发内容保留在渲染端占位消息中，
 * 由调用方通过 discardStreamingPlaceholder 或最终 committed 决定去留。
 */
export async function collectStreamedAgentText(
  window: BrowserWindow,
  input: { projectId: string; messageId: string; senderId: string; stream: ReadableStream<string> },
  signal?: AbortSignal,
): Promise<string> {
  const reader = input.stream.getReader();
  let text = '';
  let seq = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('用户取消', 'AbortError');
      const { done, value } = await readWithTimeout(reader, signal);
      if (done) break;
      if (!value) continue;
      text += value;
      if (window.isDestroyed()) continue;
      broadcastEvent(window, {
        type: 'message.delta',
        projectId: input.projectId,
        messageId: input.messageId,
        senderId: input.senderId,
        seq,
        delta: value,
      });
      seq += 1;
    }
  } finally {
    // fire-and-forget：pull 挂起时 cancel 的 promise 可能不立即 settle，
    // 不让取消动作阻塞错误向上传播（超时/中断时底层请求仍会被取消）。
    void reader.cancel().catch(() => { /* 流可能已关闭或出错 */ });
  }
  return text;
}

/**
 * 通知渲染端丢弃流式占位消息（仅当其仍处于 sending 状态时移除）。
 * 用于去重命中复用已有消息、运行取消或失败时清理半成品占位。
 */
export function discardStreamingPlaceholder(
  window: BrowserWindow,
  input: { projectId: string; messageId: string; reason: string },
): void {
  if (window.isDestroyed()) return;
  broadcastEvent(window, {
    type: 'message.discarded',
    projectId: input.projectId,
    messageId: input.messageId,
    reason: input.reason,
  });
}
