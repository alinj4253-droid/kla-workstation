// 算力模块路由（B 侧 §8）：Model Gateway 公共入口
// 智能体与前端都通过此入口调用模型；所有路由来自服务端模型目录，前端传入的 URL/Key 一律忽略。
// 权限：model.use（§10）。

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AccountRepository } from '../repositories/types.js';
import type { ComputeRepository } from './compute-repository.js';
import { GatewayError, type ComputeGateway, type GatewayChatInput } from './gateway.js';
import { COMPUTE_PERMISSION, errorBody, requireIdentity, requirePermission } from './permissions.js';

export type ComputeGatewayRouteDeps = {
  accounts: AccountRepository;
  computeRepo: ComputeRepository;
  gateway: ComputeGateway;
};

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function sendGatewayError(reply: FastifyReply, error: unknown, requestId?: string) {
  if (error instanceof GatewayError) return reply.code(error.httpStatus).send(errorBody(error.code, error.message, requestId));
  return reply.code(500).send(errorBody('INTERNAL', error instanceof Error ? error.message : '模型调用失败', requestId));
}

export async function registerComputeGatewayRoutes(app: FastifyInstance, deps: ComputeGatewayRouteDeps): Promise<void> {
  const pool = deps.computeRepo.pool;

  /** §8：统一入口 —— 鉴权 → model.use → 目录校验/预扣/选 Key → 透传（普通或 SSE）→ 用量结算。 */
  app.post('/api/v1/compute/gateway/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    if (!(await requirePermission(pool, ctx.identity, COMPUTE_PERMISSION.modelUse, request, reply, '无权调用模型'))) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const model = asOptionalString(body.model);
    if (!model) return reply.code(400).send(errorBody('INVALID_ARGUMENT', 'model 为必填项', request.id));
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send(errorBody('INVALID_ARGUMENT', 'messages 不能为空', request.id));
    }
    const maxTokens = typeof body.maxTokens === 'number' ? body.maxTokens : typeof body.max_tokens === 'number' ? body.max_tokens : undefined;
    const input: GatewayChatInput = {
      model,
      messages: body.messages,
      stream: body.stream === true,
      tools: body.tools,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      maxTokens,
      tags: {
        projectId: asOptionalString(body.projectId),
        conversationId: asOptionalString(body.conversationId),
        taskId: asOptionalString(body.taskId),
        agentId: asOptionalString(body.agentId),
      },
      requestId: asOptionalString(body.requestId) ?? request.id ?? randomUUID(),
    };

    if (!input.stream) {
      try {
        const { payload } = await deps.gateway.completeChat(ctx.identity, input);
        // 普通响应与 usage 原样透传
        return reply.send({ ok: true, data: payload });
      } catch (error) {
        return sendGatewayError(reply, error, request.id);
      }
    }

    // SSE 透传：进入流式后无法再改状态码，错误以事件帧下发
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    try {
      const { usage, amountUsd } = await deps.gateway.streamChat(ctx.identity, input, (chunk) => {
        reply.raw.write(Buffer.from(chunk));
      });
      reply.raw.write(`data: ${JSON.stringify({ kla: { usage, amountUsd } })}\n\n`);
      reply.raw.end();
    } catch (error) {
      const payload = error instanceof GatewayError ? { code: error.code, message: error.message } : { code: 'INTERNAL', message: '模型流式调用失败' };
      reply.raw.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      reply.raw.end();
    }
  });
}