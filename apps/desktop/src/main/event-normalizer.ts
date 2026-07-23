import { z } from 'zod';

/**
 * 10.11.5 事件归一化 — 结构化 Agent 事件
 *
 * 所有外部 CLI 输出的 stdout/stderr 必须先归一化为 AgentEvent，
 * 经 schema 校验和 256 KB 单事件限制后，才能进入聊天呈现层。
 */

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run.started'),
    runId: z.string().min(1),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('message.delta'),
    text: z.string().max(256 * 1024),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('tool.requested'),
    callId: z.string().min(1),
    tool: z.string().min(1),
    safeSummary: z.string().max(1024),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('tool.completed'),
    callId: z.string().min(1),
    ok: z.boolean(),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('artifact.proposed'),
    sandboxRelativePath: z.string().min(1),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('warning'),
    code: z.string().min(1),
    message: z.string().max(4096),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('run.completed'),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('run.failed'),
    code: z.string().min(1),
    message: z.string().max(4096),
    at: z.string().datetime(),
  }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;

/**
 * 解析失败时降级为受限文本事件，标记 protocol_degraded。
 * 降级事件不进入 schema 校验，由呈现层按受限文本显示。
 */
export interface DegradedEvent {
  type: 'message.delta';
  text: string;
  at: string;
  protocol_degraded: true;
}

/** 归一化后的结果类型 */
export type NormalizedEvent = AgentEvent | DegradedEvent;

const MAX_EVENT_BYTES = 256 * 1024; // 256 KB

/**
 * 尝试将一行 CLI 输出解析为 AgentEvent。
 *
 * 优先尝试 JSON 解析（CLI 原生 JSON 输出模式）；
 * 非 JSON 行按普通文本生成 message.delta。
 */
export function parseLine(line: string, runId: string, now?: string): NormalizedEvent {
  const at = now ?? new Date().toISOString();

  if (line.length > MAX_EVENT_BYTES) {
    return {
      type: 'message.delta',
      text: line.slice(0, MAX_EVENT_BYTES),
      at,
      protocol_degraded: true,
    };
  }

  // 尝试 JSON 行解析
  const trimmed = line.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      // 如果是一个数组，取第一个元素
      const target = Array.isArray(parsed) ? parsed[0] : parsed;
      if (target && typeof target === 'object' && 'type' in target) {
        const result = agentEventSchema.safeParse(target);
        if (result.success) {
          return result.data;
        }
      }
    } catch {
      // JSON 解析失败，降级为文本
    }
  }

  // 非 JSON 或解析失败 → 降级为文本事件
  return {
    type: 'message.delta',
    text: trimmed || line,
    at,
    protocol_degraded: true,
  };
}

/**
 * 将多行 CLI 输出归一化为 AgentEvent 列表。
 */
export function normalizeOutput(output: string, runId: string): NormalizedEvent[] {
  if (!output) return [];
  const lines = output.split(/\r?\n/);
  const events: NormalizedEvent[] = [];
  let buffer = '';

  for (const line of lines) {
    // 空行跳过（不作为独立事件，也不追加到缓冲区）
    if (line.trim() === '') continue;

    // 尝试解析每一行
    const event = parseLine(line, runId);
    if (event.type === 'message.delta' && 'protocol_degraded' in event) {
      // 多个连续文本行合并为一个 delta 事件
      buffer += (buffer ? '\n' : '') + event.text;
      if (buffer.length >= MAX_EVENT_BYTES) {
        events.push({
          type: 'message.delta',
          text: buffer.slice(0, MAX_EVENT_BYTES),
          at: event.at,
          protocol_degraded: true,
        });
        buffer = buffer.slice(MAX_EVENT_BYTES);
      }
    } else {
      // 结构化事件，先 flush 缓冲区
      if (buffer) {
        events.push({
          type: 'message.delta',
          text: buffer,
          at: new Date().toISOString(),
          protocol_degraded: true,
        });
        buffer = '';
      }
      events.push(event);
    }
  }

  // flush 剩余文本
  if (buffer) {
    events.push({
      type: 'message.delta',
      text: buffer,
      at: new Date().toISOString(),
      protocol_degraded: true,
    });
  }

  return events;
}

/**
 * 从 CLI 输出块中提取结构化事件，供 CliExecutor 使用。
 * 返回归一化后的事件列表，不产生副作用。
 */
export function normalizeChunk(chunk: string, runId: string): NormalizedEvent[] {
  return normalizeOutput(chunk, runId);
}

/** 验证事件是否为结构化事件（非降级文本） */
export function isStructuredEvent(event: NormalizedEvent): event is AgentEvent {
  return !('protocol_degraded' in event);
}

/** 验证事件是否为降级文本事件 */
export function isDegradedEvent(event: NormalizedEvent): event is DegradedEvent {
  return 'protocol_degraded' in event;
}