import type { Database } from 'better-sqlite3';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, generateText, generateObject, jsonSchema, type LanguageModel } from 'ai';
import { safeStorage } from 'electron';
import { z } from 'zod';
import type pino from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BUILTIN_AGENT_REQUIREMENTS, validateModelForAgent } from '@kunqing/model-core';
import type { GenerateOptions, ModelCapability, ModelSlot, ModelMessage } from '@kunqing/model-core';
import { getLogger } from './logger';
import type { CollaborationMode } from './collaboration-mode';

export type { ModelSlot, ModelCapability, ModelMessage };
export { BUILTIN_AGENT_REQUIREMENTS, validateModelForAgent, noModelError };

type ProviderSettings = {
  providerType: string;
  baseUrl?: string;
  modelId: string;
  apiKey?: string;
  parameters?: Record<string, unknown>;
};
/** 槽位 profile 的库内解析结果：不含运行期合并参数（挂载覆盖 / 协作模式），可跨调用缓存。 */
type SlotProfileRow = {
  providerType: string;
  baseUrl?: string | undefined;
  modelId: string;
  apiKey?: string | undefined;
  storedParameters: Record<string, unknown>;
};
type ModelExecutionContext = {
  profileId?: string;
  parameters?: Record<string, unknown>;
  collaborationMode?: CollaborationMode;
};
type GatewayToolDefinition = { description: string; parameters: Record<string, unknown> };

export function normalizeModelTools(
  definitions: Record<string, GatewayToolDefinition> | undefined,
): {
  tools: Record<string, { description: string; inputSchema: ReturnType<typeof jsonSchema> }> | undefined;
  internalNameByProviderName: Map<string, string>;
} {
  if (!definitions || Object.keys(definitions).length === 0) {
    return { tools: undefined, internalNameByProviderName: new Map() };
  }

  const tools: Record<string, { description: string; inputSchema: ReturnType<typeof jsonSchema> }> = {};
  const internalNameByProviderName = new Map<string, string>();

  for (const [internalName, definition] of Object.entries(definitions)) {
    const normalizedBase = internalName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool';
    let providerName = normalizedBase.slice(0, 64);
    let suffix = 2;
    while (internalNameByProviderName.has(providerName)) {
      const suffixText = `_${suffix++}`;
      providerName = `${normalizedBase.slice(0, 64 - suffixText.length)}${suffixText}`;
    }
    internalNameByProviderName.set(providerName, internalName);
    tools[providerName] = {
      description: definition.description,
      inputSchema: jsonSchema(definition.parameters),
    };
  }

  return { tools, internalNameByProviderName };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): { [K in keyof T as T[K] extends undefined ? never : K]: T[K] } {
  const result = { ...obj } as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }
  return result as ReturnType<typeof stripUndefined<T>>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function parseJsonPayload(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [trimmed, unfenced];
  const objectStart = unfenced.indexOf('{');
  const objectEnd = unfenced.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(unfenced.slice(objectStart, objectEnd + 1));
  const arrayStart = unfenced.indexOf('[');
  const arrayEnd = unfenced.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(unfenced.slice(arrayStart, arrayEnd + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next representation */ }
  }
  return undefined;
}

function recoverStructuredObjectFromModelError<T>(error: unknown): { object: T; usage?: unknown } | null {
  const errorRow = asRecord(error);
  const response = asRecord(errorRow?.response);
  let body: unknown = response?.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* retain raw body */ }
  }
  const bodyRow = asRecord(body);
  const choices = Array.isArray(bodyRow?.choices) ? bodyRow.choices : [];
  const message = asRecord(asRecord(choices[0])?.message);
  const payloads = [message?.content, message?.reasoning_content, errorRow?.text, errorRow?.reasoningText];
  for (const payload of payloads) {
    const object = parseJsonPayload(payload);
    if (object !== undefined) return { object: object as T, usage: response?.usage ?? bodyRow?.usage ?? errorRow?.usage };
  }
  return null;
}

/** 用户友好的槽位名称映射 */
const SLOT_LABELS: Record<string, string> = {
  reasoning: '推理',
  fast: '快速',
  embedding: '嵌入',
};

/** 生成用户友好的模型未配置错误消息 */
function noModelError(slot: string): string {
  const label = SLOT_LABELS[slot] ?? slot;
  return `模型未配置：请先在「设置 → 模型管理」中添加可用模型，并在「智能体管理」中为当前智能体挂载模型（未挂载时将使用${label}默认模型）。`;
}

/** 结构化输出的测试 schema */
const testObjectSchema = z.object({
  summary: z.string().describe('一句话总结'),
  keywords: z.array(z.string()).describe('关键词列表'),
});

/** 生产 LLM 调用的默认超时：避免网络挂起长期占用调度并发槽。 */
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

/** 判断模型调用错误是否值得幂等重试一次（网络中断、超时、429/5xx 等）。 */
function isRetryableModelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const row = error as Record<string, unknown>;
  if (row.isRetryable === true) return true; // ai-sdk APICallError：连接失败 / 429 / 5xx
  const name = typeof row.name === 'string' ? row.name : '';
  if (name === 'TimeoutError' || name === 'APIConnectionError') return true;
  if (name === 'TypeError' && typeof row.message === 'string' && /fetch|network|econn|etimedout/i.test(row.message)) return true;
  return false;
}

export class ModelGateway {
  protected readonly logger: pino.Logger;
  private readonly modelExecutionContext = new AsyncLocalStorage<ModelExecutionContext>();

  constructor(protected db: Database) {
    this.logger = getLogger();
  }

  runWithModelProfileSnapshot<T>(snapshotJson: string | null | undefined, task: () => Promise<T>): Promise<T> {
    // Establish an explicit empty context as well. Background work may be
    // scheduled from another run's AsyncLocalStorage scope and must not inherit
    // that run's mounted model accidentally.
    if (!snapshotJson) return this.modelExecutionContext.run({}, task);
    try {
      const snapshot = JSON.parse(snapshotJson) as { profileId?: unknown; parameters?: unknown };
      if (typeof snapshot.profileId !== 'string' || !snapshot.profileId) return this.modelExecutionContext.run({}, task);
      const parameters = snapshot.parameters && typeof snapshot.parameters === 'object'
        ? snapshot.parameters as Record<string, unknown>
        : undefined;
      return this.modelExecutionContext.run({ profileId: snapshot.profileId, ...(parameters ? { parameters } : {}) }, task);
    } catch {
      return this.modelExecutionContext.run({}, task);
    }
  }

  runWithCollaborationMode<T>(mode: CollaborationMode, task: () => Promise<T>): Promise<T> {
    return this.modelExecutionContext.run({ ...this.modelExecutionContext.getStore(), collaborationMode: mode }, task);
  }

  private recordTokenUsage(usage: unknown): void {
    if (!usage || typeof usage !== 'object') return;
    const row = usage as Record<string, unknown>;
    const numeric = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const total = numeric(row.totalTokens)
      || numeric(row.totalTokenCount)
      || numeric(row.inputTokens) + numeric(row.outputTokens)
      || numeric(row.promptTokens) + numeric(row.completionTokens);
    if (total <= 0) return;
    try {
      const current = this.db.prepare('SELECT value_json as valueJson FROM settings WHERE key = ?').get('tokenUsageTotal') as { valueJson: string } | undefined;
      let previous = 0;
      try {
        const parsed = JSON.parse(current?.valueJson ?? '{}') as { value?: unknown };
        previous = numeric(parsed.value);
      } catch { /* start from zero */ }
      const now = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES ('tokenUsageTotal', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(JSON.stringify({ value: previous + total }), now);
    } catch {
      // Lightweight test databases may not include the settings table.
    }
  }

  /**
   * 为一次生产模型调用提供默认超时与单次幂等重试。
   * - 生成类调用本身无副作用（副作用发生在工具执行侧），失败重试安全；
   * - 超时或网络类错误重试一次，其余错误直接抛出，不放大延迟。
   */
  private async callWithTimeoutRetry<T>(slot: ModelSlot, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_LLM_TIMEOUT_MS);
      try {
        return await invoke(controller.signal);
      } catch (error) {
        lastError = error;
        const timedOut = controller.signal.aborted;
        if (attempt === 0 && (timedOut || isRetryableModelError(error))) {
          this.logger.warn(
            { slot, attempt, timedOut, error: error instanceof Error ? error.message : String(error) },
            'ModelGateway: 模型调用失败，将重试一次',
          );
          continue;
        }
        if (timedOut && attempt === 1) {
          throw new Error(`模型请求超时（${DEFAULT_LLM_TIMEOUT_MS / 1_000}s），已重试一次仍失败`, { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  /** 槽位/挂载 profile 的库内行缓存：同一 run 的多轮 LLM 调用复用解析与解密结果。 */
  private slotProfileRows = new Map<string, SlotProfileRow | null>();

  /** 模型设置（provider/profile/槽位绑定/API Key）变更后调用，确保后续调用读到新配置。 */
  invalidateSlotProfiles(): void {
    this.slotProfileRows.clear();
  }

  private loadSlotProfileRow(slot: ModelSlot, mountedProfileId?: string): SlotProfileRow | null {
    const row = mountedProfileId
      ? this.db.prepare(
        `SELECT mp.id, mp.model_id as modelId, mp.provider_id as providerId,
                prv.type as providerType, prv.base_url as baseUrl, prv.secret_ref as secretRef,
                mp.parameters_json as parametersJson
         FROM model_profiles mp
         JOIN model_providers prv ON prv.id = mp.provider_id
         WHERE mp.id = ? AND mp.enabled = 1`,
      ).get(mountedProfileId)
      : this.db.prepare(
      `SELECT mp.id, mp.model_id as modelId, mp.provider_id as providerId,
              prv.type as providerType, prv.base_url as baseUrl, prv.secret_ref as secretRef,
              mp.parameters_json as parametersJson
       FROM model_slot_bindings msb
       JOIN model_profiles mp ON mp.id = msb.model_profile_id
       JOIN model_providers prv ON prv.id = mp.provider_id
       WHERE msb.slot = ? AND mp.enabled = 1`,
    ).get(slot);
    const typedRow = row as { id: string; modelId: string; providerId: string; providerType: string; baseUrl: string | null; secretRef: string | null; parametersJson: string | null } | undefined;

    if (!typedRow) {
      this.logger.warn({ slot, mountedProfileId }, 'ModelGateway: no profile found');
      return null;
    }
    let apiKey: string | undefined;
    if (typedRow.secretRef) {
      const secret = this.db.prepare('SELECT ciphertext FROM secrets WHERE id = ?').get(typedRow.secretRef) as { ciphertext: Buffer } | undefined;
      if (secret) {
        try {
          apiKey = safeStorage.decryptString(secret.ciphertext);
        } catch {
          this.logger.warn({ slot, secretRef: typedRow.secretRef }, 'ModelGateway: failed to decrypt API key');
        }
      }
    }
    let storedParameters: Record<string, unknown> = {};
    try { storedParameters = typedRow.parametersJson ? JSON.parse(typedRow.parametersJson) as Record<string, unknown> : {}; } catch { /* ignore malformed parameters */ }
    return {
      providerType: typedRow.providerType,
      baseUrl: typedRow.baseUrl ?? undefined,
      modelId: typedRow.modelId,
      apiKey,
      storedParameters,
    };
  }

  private getSlotProfile(slot: ModelSlot): ProviderSettings | null {
    const mounted = this.modelExecutionContext.getStore();
    const cacheKey = mounted?.profileId ? `profile:${mounted.profileId}` : `slot:${slot}`;
    let row = this.slotProfileRows.get(cacheKey);
    if (row === undefined) {
      row = this.loadSlotProfileRow(slot, mounted?.profileId);
      this.slotProfileRows.set(cacheKey, row);
    }
    if (!row) return null;
    const collaborationParameters = mounted?.collaborationMode === 'fast'
      ? { thinking: false, thinkingLevel: 'none' }
      : mounted?.collaborationMode === 'balanced'
        ? { thinking: true, thinkingLevel: 'minimal' }
        : {};
    const parameters = { ...row.storedParameters, ...(mounted?.parameters ?? {}), ...collaborationParameters };
    return stripUndefined({ providerType: row.providerType, baseUrl: row.baseUrl, modelId: row.modelId, apiKey: row.apiKey, parameters }) as ProviderSettings;
  }

  private getGenerationOptions(
    profile: ProviderSettings,
    overrides?: Pick<GenerateOptions, 'thinking' | 'thinkingLevel'>,
  ): { temperature?: number; providerOptions?: Record<string, unknown> } {
    const parameters: Record<string, unknown> = {
      ...(profile.parameters ?? {}),
      ...(typeof overrides?.thinking === 'boolean' ? { thinking: overrides.thinking } : {}),
      ...(overrides?.thinkingLevel ? { thinkingLevel: overrides.thinkingLevel } : {}),
    };
    const thinking = parameters.thinking === true;
    const thinkingLevel = typeof parameters.thinkingLevel === 'string' ? parameters.thinkingLevel : 'medium';
    const isOpenAiReasoningModel = /(?:^|[-_.])(o1|o3|o4)(?:[-_.]|$)|gpt-5/i.test(profile.modelId);
    const temperature = typeof parameters.temperature === 'number' && Number.isFinite(parameters.temperature)
      && !(thinking && (isOpenAiReasoningModel || profile.providerType === 'anthropic'))
      ? Math.max(0, Math.min(2, parameters.temperature))
      : undefined;
    const temperatureOptions = temperature === undefined ? {} : { temperature };
    if (!thinking || thinkingLevel === 'none') {
      if (thinkingLevel === 'none' && profile.providerType === 'openai' && isOpenAiReasoningModel) {
        return {
          ...temperatureOptions,
          providerOptions: { openai: { reasoningEffort: 'none' } },
        };
      }
      return temperatureOptions;
    }
    if (profile.providerType === 'openai' && isOpenAiReasoningModel) {
      return {
        ...temperatureOptions,
        providerOptions: { openai: { reasoningEffort: thinkingLevel } },
      };
    }
    if (profile.providerType === 'anthropic') {
      const budgetByLevel: Record<string, number> = { minimal: 1_024, low: 2_048, medium: 4_096, high: 8_192, xhigh: 16_384 };
      return {
        ...temperatureOptions,
        providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: budgetByLevel[thinkingLevel] ?? 4_096 } } },
      };
    }
    return temperatureOptions;
  }

  private resolveMaxOutputTokens(
    generationOptions: { providerOptions?: Record<string, unknown> },
    requested: number | undefined,
  ): number | undefined {
    const base = typeof requested === 'number' && Number.isFinite(requested)
      ? Math.max(64, Math.floor(requested))
      : undefined;
    if (base === undefined) return undefined;
    const anthropic = generationOptions.providerOptions?.anthropic as { thinking?: { budgetTokens?: unknown } } | undefined;
    const budget = anthropic?.thinking?.budgetTokens;
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return base;
    // Anthropic 的 max_tokens 同时覆盖思考与正文，而调用方传入的
    // maxOutputTokens 语义是可见输出上限。这里把思考预算补到 max_tokens
    // 上，避免正文配额被思考挤占后在结构化输出中途截断。
    return base + budget;
  }

  async streamText(
    slot: ModelSlot,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: { system?: string; maxOutputTokens?: number; signal?: AbortSignal },
  ): Promise<ReadableStream<string>> {
    const profile = this.getSlotProfile(slot);
    if (!profile) throw new Error(noModelError(slot));

    this.logger.info({ slot, modelId: profile.modelId, providerType: profile.providerType, msgCount: messages.length }, 'ModelGateway.streamText');
    const provider = this.buildProvider(profile);
    const generationOptions = this.getGenerationOptions(profile);
    const maxOutputTokens = this.resolveMaxOutputTokens(generationOptions, options?.maxOutputTokens);
    const result = streamText({
      model: provider(profile.modelId),
      messages,
      ...(options?.system !== undefined ? { system: options.system } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(options?.signal ? { abortSignal: options.signal } : {}),
      ...generationOptions,
    } as never);
    return result.textStream;
  }

  async generateText(
    slot: ModelSlot,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: GenerateOptions & { system?: string },
  ): Promise<{ text: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }> {
    const profile = this.getSlotProfile(slot);
    if (!profile) throw new Error(noModelError(slot));

    this.logger.info({ slot, modelId: profile.modelId, providerType: profile.providerType, msgCount: messages.length }, 'ModelGateway.generateText');
    const provider = this.buildProvider(profile);
    const { system: sys } = options ?? {};
    const normalizedTools = normalizeModelTools(options?.tools);
    const generationOptions = this.getGenerationOptions(profile, options);
    const maxOutputTokens = this.resolveMaxOutputTokens(generationOptions, options?.maxOutputTokens);
    return await this.callWithTimeoutRetry(slot, (signal) => generateText({
      model: provider(profile.modelId),
      messages,
      ...(sys !== undefined ? { system: sys } : {}),
      ...(normalizedTools.tools ? { tools: normalizedTools.tools } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      abortSignal: signal,
      ...generationOptions,
    } as never).then((res) => {
      this.recordTokenUsage(res.usage);
      return {
        text: res.text,
        toolCalls: res.toolCalls?.map((tc) => ({
          name: normalizedTools.internalNameByProviderName.get(tc.toolName) ?? tc.toolName,
          args: tc.input as Record<string, unknown>,
        })),
      };
    }));
  }

  async generateObject<T>(slot: ModelSlot, messages: Array<{ role: 'user' | 'assistant'; content: string }>, system?: string): Promise<T> {
    const profile = this.getSlotProfile(slot);
    if (!profile) throw new Error(noModelError(slot));

    this.logger.info({ slot, modelId: profile.modelId, providerType: profile.providerType, msgCount: messages.length }, 'ModelGateway.generateObject');
    const provider = this.buildProvider(profile);
    const generationOptions = this.getGenerationOptions(profile);
    return this.callWithTimeoutRetry(slot, async (signal) => {
      try {
        const result = await generateObject({
          model: provider(profile.modelId),
          messages,
          ...(system !== undefined ? { system } : {}),
          abortSignal: signal,
          ...generationOptions,
          output: 'no-schema',
        } as never);
        this.recordTokenUsage((result as { usage?: unknown }).usage);
        return result.object as T;
      } catch (error) {
        const recovered = recoverStructuredObjectFromModelError<T>(error);
        if (!recovered) throw error;
        this.recordTokenUsage(recovered.usage);
        this.logger.warn({ slot, modelId: profile.modelId }, 'ModelGateway: 从模型思考字段恢复结构化结果');
        return recovered.object;
      }
    });
  }

  async generateObjectWithImages<T>(slot: ModelSlot, text: string, images: Uint8Array[], system?: string): Promise<T> {
    const profile = this.getSlotProfile(slot);
    if (!profile) throw new Error(noModelError(slot));
    const provider = this.buildProvider(profile);
    const generationOptions = this.getGenerationOptions(profile);
    return this.callWithTimeoutRetry(slot, async (signal) => {
      try {
        const result = await generateObject({
          model: provider(profile.modelId),
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text },
              ...images.slice(0, 4).map((image) => ({
                type: 'file' as const,
                mediaType: 'image/png',
                data: { type: 'data' as const, data: image },
              })),
            ],
          }],
          ...(system !== undefined ? { system } : {}),
          abortSignal: signal,
          ...generationOptions,
          output: 'no-schema',
        } as never);
        this.recordTokenUsage((result as { usage?: unknown }).usage);
        return result.object as T;
      } catch (error) {
        const recovered = recoverStructuredObjectFromModelError<T>(error);
        if (!recovered) throw error;
        this.recordTokenUsage(recovered.usage);
        this.logger.warn({ slot, modelId: profile.modelId }, 'ModelGateway: 从模型思考字段恢复结构化结果');
        return recovered.object;
      }
    });
  }

  /**
   * 对指定 Provider 执行真实能力测试
   * - streaming: 发送简单消息，验证能否收到流式 chunk
   * - toolCalling: 提供工具定义，验证模型是否调用工具
   * - structuredOutput: 使用 schema 验证模型能否输出结构化结果
   */
  async testCapabilities(providerId: string, modelId?: string): Promise<{ streaming: boolean; toolCalling: boolean; structuredOutput: boolean; error?: string }> {
    this.logger.info({ providerId, modelId }, 'ModelGateway.testCapabilities');
    const providerRow = this.db.prepare(
      'SELECT type, base_url, secret_ref FROM model_providers WHERE id = ?',
    ).get(providerId) as { type: string; base_url: string | null; secret_ref: string | null } | undefined;
    if (!providerRow) throw new Error('Provider 不存在');

    const secret = providerRow.secret_ref
      ? this.db.prepare('SELECT ciphertext FROM secrets WHERE id = ?').get(providerRow.secret_ref) as { ciphertext: Buffer } | undefined
      : undefined;
    let apiKey: string | undefined;
    if (!providerRow.secret_ref) {
      return { streaming: false, toolCalling: false, structuredOutput: false, error: '未配置 API Key，请在编辑中设置' };
    }
    if (secret) {
      try {
        apiKey = safeStorage.decryptString(secret.ciphertext);
      } catch {
        return { streaming: false, toolCalling: false, structuredOutput: false, error: 'API Key 解密失败，请重新设置' };
      }
    }
    if (!apiKey) {
      return { streaming: false, toolCalling: false, structuredOutput: false, error: 'API Key 为空或解密后为空，请在编辑中重新设置' };
    }

    let testModelId = modelId;
    if (!testModelId) {
      const profile = this.db.prepare('SELECT model_id FROM model_profiles WHERE provider_id = ? AND enabled = 1 LIMIT 1').get(providerId) as { model_id: string } | undefined;
      testModelId = profile?.model_id;
    }
    if (!testModelId) throw new Error('未提供 modelId 且该 Provider 无有效 Model Profile，无法测试');
    const profile = stripUndefined({ providerType: providerRow.type, baseUrl: providerRow.base_url ?? undefined, modelId: testModelId, apiKey }) as ProviderSettings;
    const provider = this.buildProvider(profile);

    const results: { streaming: boolean; toolCalling: boolean; structuredOutput: boolean; error?: string } = { streaming: false, toolCalling: false, structuredOutput: false };
    const testSignal = AbortSignal.timeout(30000);

    // 1. 测试基本连通性（用 generateText 获取明确错误）
    try {
      const textResult = await generateText({
        model: provider(profile.modelId),
        messages: [{ role: 'user', content: 'Hi' }],
        abortSignal: testSignal,
      });
      results.streaming = true;

      // 2. 测试工具调用
      try {
        const toolResult = await generateText({
          model: provider(profile.modelId),
          messages: [{ role: 'user', content: '北京天气怎么样？请调用 get_weather 工具查询。' }],
          tools: {
            get_weather: {
              description: '查询城市天气',
              parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
            } as any,
          },
          abortSignal: testSignal,
        } as any);
        results.toolCalling = (toolResult.toolCalls?.length ?? 0) > 0
          || (toolResult.steps?.some((s) => (s.toolCalls?.length ?? 0) > 0) ?? false);
      } catch { /* tool calling not supported */ }

      // 3. 测试结构化输出
      try {
        const objResult = await generateObject({
          model: provider(profile.modelId),
          schema: testObjectSchema,
          messages: [{ role: 'user', content: '请用一句话总结 AI 的发展趋势，并列出 3 个关键词。' }],
          abortSignal: testSignal,
        } as never);
        results.structuredOutput = typeof objResult.object === 'object'
          && objResult.object !== null
          && 'summary' in objResult.object;
      } catch { /* structured output not supported */ }
    } catch (err) {
      results.error = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err: results.error, providerId, modelId: testModelId }, 'ModelGateway.testCapabilities: connectivity failed');
    }

    this.logger.info({ providerId, ...results }, 'ModelGateway.testCapabilities result');
    return results;
  }

  private buildProvider(profile: { providerType?: string; baseUrl?: string; apiKey?: string }): (modelId: string) => LanguageModel {
    const type = profile.providerType ?? 'openai';
    this.logger.debug({ providerType: type, hasBaseUrl: !!profile.baseUrl, hasApiKey: !!profile.apiKey }, 'ModelGateway.buildProvider');

    switch (type) {
      case 'openai':
      case 'openai-compatible':
      case 'deepseek':
      case 'glm':
      case 'kimi':
      case 'qwen': {
        const opts: Record<string, string> = {};
        if (profile.apiKey) opts.apiKey = profile.apiKey;
        if (profile.baseUrl) opts.baseURL = profile.baseUrl;
        const provider = createOpenAI(opts as never);
        return (modelId: string) => (provider as any).chat(modelId);
      }

      case 'anthropic': {
        const { createAnthropic } = require('@ai-sdk/anthropic') as typeof import('@ai-sdk/anthropic');
        const opts: Record<string, string> = {};
        if (profile.apiKey) opts.apiKey = profile.apiKey;
        if (profile.baseUrl) opts.baseURL = profile.baseUrl;
        return createAnthropic(opts as never) as unknown as (modelId: string) => LanguageModel;
      }

      case 'google': {
        const { createGoogleGenerativeAI } = require('@ai-sdk/google') as typeof import('@ai-sdk/google');
        const opts: Record<string, string> = {};
        if (profile.apiKey) opts.apiKey = profile.apiKey;
        if (profile.baseUrl) opts.baseURL = profile.baseUrl;
        return createGoogleGenerativeAI(opts as never) as unknown as (modelId: string) => LanguageModel;
      }

      default:
        this.logger.error({ providerType: type }, 'ModelGateway.buildProvider: unsupported provider type');
        throw new Error(`不支持的 Provider 类型: ${type}。支持的: openai, openai-compatible, anthropic, google`);
    }
  }
}
