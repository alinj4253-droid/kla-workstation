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