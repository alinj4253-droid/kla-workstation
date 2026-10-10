// Model Gateway（§8）：智能体与前端统一入口，不直接调用 Sub2API 上游配置。
//
// 流程：Session→当前 identity → 校验 model.use 与模型目录 → 锁定并预扣算力点
//      → 按身份选 Key → 注入业务标签 → 透传普通响应 / SSE / tool calling / usage
//      → 释放预扣；实际费用只由 Sub2API 用量明细同步入账。
//
// 约束：所有路由来自服务端模型目录，前端传入的 URL/Key 一律忽略（§8、§12）。

import { createHash } from 'node:crypto';
import type { Identity } from '../repositories/types.js';
import type { ComputeRepository } from './compute-repository.js';
import type { QuotaService } from './quota-service.js';
import type { Sub2ApiClient } from './sub2api-client.js';
import { resolveManagedPassword } from './encryption.js';
import { COMPUTE_READY_STATES } from './types.js';
import { createPointsConverter, type PointsConverter } from './points.js';

export type GatewayUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** 上游直接给出金额时优先采用（Sub2API 是实际计量的权威，§1） */
  costUsd: number | null;
};

export type GatewayBusinessTags = {
  projectId?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
};

export type GatewayChatInput = {
  model: string;
  /** Server-side agent binding only; never forwarded to Sub2API. */
  keyId?: string | null;
  messages: unknown[];
  stream?: boolean;
  tools?: unknown;
  temperature?: number;
  maxTokens?: number;
  tags?: GatewayBusinessTags;
  /** 幂等键来源：同一 requestId 的 usage 只落一次（§11.2） */
  requestId: string;
};

export type ComputeGatewayDeps = {
  computeRepo: ComputeRepository;
  quota: QuotaService;
  sub2api: Sub2ApiClient;
  encryptionKey: string;
  /** 预扣下限（美元） */
  minReserveUsd: number;
  timeoutMs: number;
  points?: PointsConverter;
};

/** 网关错误：携带可直接映射到 HTTP 的语义码。 */
export class GatewayError extends Error {
  constructor(
    public readonly code: 'FORBIDDEN' | 'CONFLICT' | 'NOT_FOUND' | 'UNAVAILABLE' | 'RATE_LIMITED' | 'INVALID_ARGUMENT',
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** §11.2 去重：Gateway 与 Usage Sync 共用一个 UNIQUE 列，同请求只落一次。 */
export function gatewayDedupeHash(identityId: string, requestId: string): string {
  return createHash('sha256').update(`gateway:${identityId}:${requestId}`).digest('hex');
}

const EMPTY_USAGE: GatewayUsage = { promptTokens: null, completionTokens: null, totalTokens: null, costUsd: null };

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

/** 兼容 OpenAI 风格 usage 字段命名。 */
export function parseUsage(payload: Record<string, unknown>): GatewayUsage {
  const usage = (payload.usage && typeof payload.usage === 'object' ? payload.usage : {}) as Record<string, unknown>;
  return {
    promptTokens: toNumberOrNull(usage.prompt_tokens ?? usage.input_tokens),
    completionTokens: toNumberOrNull(usage.completion_tokens ?? usage.output_tokens),
    totalTokens: toNumberOrNull(usage.total_tokens),
    costUsd: toNumberOrNull(payload.cost ?? payload.amount ?? payload.total_cost ?? usage.cost),
  };
}

/** 从 SSE 文本中提取 usage（取最后一个含 usage 的数据帧）。 */
export function parseUsageFromSse(text: string): GatewayUsage {
  let found = EMPTY_USAGE;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (data === '' || data === '[DONE]') continue;
    try {
      const frame = JSON.parse(data) as Record<string, unknown>;
      const usage = parseUsage(frame);
      if (usage.promptTokens !== null || usage.completionTokens !== null || usage.totalTokens !== null || usage.costUsd !== null) {
        found = usage;
      }
    } catch {
      // 非 JSON 片段（心跳等）忽略
    }
  }
  return found;
}

/** 只挑白名单字段上传，前端传入的 url/key 之类一律丢弃。 */
export function buildUpstreamBody(input: GatewayChatInput): Record<string, unknown> {
  return {
    model: input.model,
    messages: input.messages,
    stream: input.stream === true,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
  };
}

type Prepared = {
  identity: Identity;
  ledgerId: string;
  /** 代理面凭据：API Key 明文（不是 JWT），见 Sub2ApiClient.chatCompletions */
  credential: string;
  keyId: string | null;
  modelId: string;
  startedAt: number;
};

export class ComputeGateway {
  constructor(private readonly deps: ComputeGatewayDeps) {}
  private get points(): PointsConverter { return this.deps.points ?? createPointsConverter(); }

  /** §8.1–§8.4：模型目录校验、凭据、预扣额度、选 Key。 */
  private async prepare(identity: Identity, input: GatewayChatInput): Promise<Prepared> {
    const catalogModel = await this.deps.computeRepo.getCatalogModel(input.model);
    if (!catalogModel) throw new GatewayError('NOT_FOUND', `模型不在服务端目录中：${input.model}`, 404);
    if (!catalogModel.enabled) throw new GatewayError('NOT_FOUND', `模型已停用：${input.model}`, 404);

    const binding = await this.deps.computeRepo.getBinding(identity.id);
    if (!binding) throw new GatewayError('CONFLICT', '算力账号尚未初始化，请先重试初始化', 409);
    if (!COMPUTE_READY_STATES.has(binding.status)) throw new GatewayError('CONFLICT', `算力账号未就绪（${binding.status}）`, 409);
    if (await this.deps.computeRepo.countBindingsForSub2apiUser(binding.sub2apiUserId) > 1) {
      throw new GatewayError('CONFLICT', '多个身份共用同一上游算力账号，无法保证独立计费；请为当前身份重新绑定独立账号', 409);
    }
    const password = resolveManagedPassword(binding.managedPassword, this.deps.encryptionKey);
    if (!password) throw new GatewayError('CONFLICT', '托管凭据不可用，无法调用模型', 409);

    // §8.3 锁定并预扣额度；并发下由 SELECT FOR UPDATE 行锁保证不超发
    let ledgerId: string;
    try {
      ({ ledgerId } = await this.deps.quota.reserve(identity.id, this.points.fromUsd(this.deps.minReserveUsd), input.requestId));
    } catch (error) {
      if (error instanceof Error && error.name === 'QuotaInsufficientError') throw new GatewayError('FORBIDDEN', error.message, 403);
      throw error;
    }

    let jwt: string;
    try {
      jwt = await this.deps.sub2api.getUserJwt(binding.sub2apiUserId, binding.sub2apiUsername, password);
    } catch (error) {
      await this.settle({ identity, ledgerId, credential: '', keyId: null, modelId: catalogModel.id, startedAt: Date.now() }, input, EMPTY_USAGE, 'failure');
      throw new GatewayError('UNAVAILABLE', error instanceof Error ? error.message : 'Sub2API 不可用', 503);
    }

    // §8.4 按身份选 Key（默认优先、状态 active）
    const key = input.keyId
      ? await this.deps.computeRepo.getKey(input.keyId, identity.id)
      : await this.deps.computeRepo.getActiveKey(identity.id);
    if (!key?.sub2apiKeyId || (input.keyId && key.status !== 'active')) {
      await this.settle({ identity, ledgerId, credential: '', keyId: null, modelId: catalogModel.id, startedAt: Date.now() }, input, EMPTY_USAGE, 'failure');
      throw new GatewayError('CONFLICT', input.keyId ? '智能体挂载的 API Key 已不可用，请重新挂载' : '当前身份没有可用的 API Key，请先在「API 密钥」页创建', 409);
    }

    // 代理面只认 API Key：用托管账号 JWT 现取该 Key 明文（仅内存短缓存，不落库）
    let credential: string;
    try {
      const secret = await this.deps.sub2api.resolveApiKeySecret(jwt, key.sub2apiKeyId);
      if (!secret) throw new Error('上游未返回该 Key 的明文，请在 Sub2API 侧确认');
      credential = secret;
    } catch (error) {
      await this.settle({ identity, ledgerId, credential: '', keyId: key.id, modelId: catalogModel.id, startedAt: Date.now() }, input, EMPTY_USAGE, 'failure');
      throw new GatewayError('UNAVAILABLE', error instanceof Error ? error.message : '获取上游 Key 失败', 503);
    }
    return { identity, ledgerId, credential, keyId: key.id, modelId: catalogModel.id, startedAt: Date.now() };
  }

  /** The upstream usage ledger is authoritative; a response only releases the hold. */
  private async settle(prepared: Prepared, input: GatewayChatInput, usage: GatewayUsage, status: 'success' | 'failure'): Promise<number> {
    const amountUsd = 0;
    try {
      if (status === 'failure') await this.deps.computeRepo.upsertUsage({
        identityId: prepared.identity.id,
        organizationId: prepared.identity.organizationId,
        ledgerId: prepared.ledgerId,
        sub2apiUsageId: null,
        model: prepared.modelId,
        amountUsd,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        metadata: { requestId: input.requestId, agentId: input.tags?.agentId ?? null, status },
        dedupeHash: gatewayDedupeHash(prepared.identity.id, input.requestId),
        recordedAt: new Date().toISOString(),
        keyId: prepared.keyId,
        projectId: input.tags?.projectId ?? null,
        conversationId: input.tags?.conversationId ?? null,
        taskId: input.tags?.taskId ?? null,
        latencyMs: Date.now() - prepared.startedAt,
        status: 'failure',
      });
    } catch {
      // 用量写入失败不阻断响应；交由对账与 Usage Sync 补偿（§11.2）
    }
    try {
      await this.deps.quota.release(prepared.ledgerId);
    } catch {
      // 结算失败由对账补偿；不覆盖已成功的模型响应
    }
    return amountUsd;
  }

  /** 普通（非流式）请求：透传响应体与 usage。 */
  async completeChat(identity: Identity, input: GatewayChatInput): Promise<{ payload: unknown; usage: GatewayUsage; amountUsd: number }> {
    const prepared = await this.prepare(identity, input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.tools ? Math.max(this.deps.timeoutMs, 60_000) : this.deps.timeoutMs);
    try {
      const response = await this.deps.sub2api.chatCompletions(prepared.credential, buildUpstreamBody(input), controller.signal);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        await this.settle(prepared, input, EMPTY_USAGE, 'failure');
        const rateLimited = response.status === 429;
        throw new GatewayError(
          rateLimited ? 'RATE_LIMITED' : 'UNAVAILABLE',
          `Sub2API 返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`,
          rateLimited ? 429 : 502,
        );
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const usage = parseUsage(payload);
      const amountUsd = await this.settle(prepared, input, usage, 'success');
      return { payload, usage, amountUsd };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      await this.settle(prepared, input, EMPTY_USAGE, 'failure');
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new GatewayError('UNAVAILABLE', aborted ? 'Sub2API 请求超时' : error instanceof Error ? error.message : 'Sub2API 调用失败', aborted ? 504 : 503);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 流式请求：逐块透传 SSE，结束时按累计 usage 结算。 */
  async streamChat(
    identity: Identity,
    input: GatewayChatInput,
    onChunk: (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<{ usage: GatewayUsage; amountUsd: number }> {
    const prepared = await this.prepare(identity, input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.tools ? Math.max(this.deps.timeoutMs, 60_000) : this.deps.timeoutMs);
    let buffer = '';
    try {
      const response = await this.deps.sub2api.chatCompletions(prepared.credential, buildUpstreamBody(input), controller.signal);
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        await this.settle(prepared, input, EMPTY_USAGE, 'failure');
        const rateLimited = response.status === 429;
        throw new GatewayError(
          rateLimited ? 'RATE_LIMITED' : 'UNAVAILABLE',
          `Sub2API 返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`,
          rateLimited ? 429 : 502,
        );
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += Buffer.from(value).toString('utf8');
        await onChunk(value);
      }
      const usage = parseUsageFromSse(buffer);
      const amountUsd = await this.settle(prepared, input, usage, 'success');
      return { usage, amountUsd };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      await this.settle(prepared, input, EMPTY_USAGE, 'failure');
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new GatewayError('UNAVAILABLE', aborted ? 'Sub2API 流式请求超时' : error instanceof Error ? error.message : 'Sub2API 流式调用失败', aborted ? 504 : 503);
    } finally {
      clearTimeout(timeout);
    }
  }
}
