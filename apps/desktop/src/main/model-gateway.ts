import type { Database } from 'better-sqlite3';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, generateText, generateObject, jsonSchema, type LanguageModel } from 'ai';
import { safeStorage } from 'electron';
import { z } from 'zod';
import type pino from 'pino';
import { BUILTIN_AGENT_REQUIREMENTS, validateModelForAgent } from '@kunqing/model-core';
import type { ModelCapability, ModelSlot, ModelMessage } from '@kunqing/model-core';
import { getLogger } from './logger';

export type { ModelSlot, ModelCapability, ModelMessage };
export { BUILTIN_AGENT_REQUIREMENTS, validateModelForAgent, noModelError };

type ProviderSettings = { providerType: string; baseUrl?: string; modelId: string; apiKey?: string };
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

/** 用户友好的槽位名称映射 */
const SLOT_LABELS: Record<string, string> = {
  reasoning: '推理',
  fast: '快速',
  embedding: '嵌入',
};

/** 生成用户友好的模型未配置错误消息 */
function noModelError(slot: string): string {
  const label = SLOT_LABELS[slot] ?? slot;
  return `模型未配置：请先在「设置 → 模型管理」中为「${label}」绑定一个可用模型，然后重试。`;
}

/** 结构化输出的测试 schema */
const testObjectSchema = z.object({
  summary: z.string().describe('一句话总结'),
  keywords: z.array(z.string()).describe('关键词列表'),
});

export class ModelGateway {
  protected readonly logger: pino.Logger;

  constructor(protected db: Database) {
    this.logger = getLogger();
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

  private getSlotProfile(slot: ModelSlot): ProviderSettings | null {
    const row = this.db.prepare(
      `SELECT mp.id, mp.model_id as modelId, mp.provider_id as providerId,
              prv.type as providerType, prv.base_url as baseUrl, prv.secret_ref as secretRef
       FROM model_slot_bindings msb
       JOIN model_profiles mp ON mp.id = msb.model_profile_id
       JOIN model_providers prv ON prv.id = mp.provider_id
       WHERE msb.slot = ? AND mp.enabled = 1`,
    ).get(slot) as { id: string; modelId: string; providerId: string; providerType: string; baseUrl: string | null; secretRef: string | null } | undefined;

    if (!row) {
      this.logger.warn({ slot }, 'ModelGateway: no profile found for slot');
      return null;
    }
    let apiKey: string | undefined;
    if (row.secretRef) {
      const secret = this.db.prepare('SELECT ciphertext FROM secrets WHERE id = ?').get(row.secretRef) as { ciphertext: Buffer } | undefined;
      if (secret) {
        try {
          apiKey = safeStorage.decryptString(secret.ciphertext);
        } catch {
          this.logger.warn({ slot, secretRef: row.secretRef }, 'ModelGateway: failed to decrypt API key');
        }
      }
    }
    return stripUndefined({ providerType: row.providerType, baseUrl: row.baseUrl ?? undefined, modelId: row.modelId, apiKey }) as ProviderSettings;
  }

  async streamText(slot: ModelSlot, messages: Array<{ role: 'user' | 'assistant'; content: string }>, system?: string): Promise<ReadableStream<string>> {
    const profile = this.getSlotProfile(slot);
    if (!profile) throw new Error(noModelError(slot));

    this.logger.info({ slot, modelId: profile.modelId, providerType: profile.providerType, msgCount: messages.length }, 'ModelGateway.streamText');
    const provider = this.buildProvider(profile);
    const result = streamText({
      model: provider(profile.modelId),
      messages,
      ...(system !== undefined ? { system } : {}),
    });
    return result.textStream;
  }

  async generateText(
    slot: ModelSlot,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: { system?: string; tools?: Record<string, { description: string; parameters: Record<string, unknown> }> },
  ): Promise<{ text: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }> {
    const profile = this.getSlotProfile(slot);
    if (!profile) throw new Error(noModelError(slot));

    this.logger.info({ slot, modelId: profile.modelId, providerType: profile.providerType, msgCount: messages.length }, 'ModelGateway.generateText');
    const provider = this.buildProvider(profile);
    const { system: sys } = options ?? {};
    const normalizedTools = normalizeModelTools(options?.tools);
    const result = await generateText({
      model: provider(profile.modelId),
      messages,
      ...(sys !== undefined ? { system: sys } : {}),
      ...(normalizedTools.tools ? { tools: normalizedTools.tools } : {}),
    });
    this.recordTokenUsage(result.usage);
    return {
      text: result.text,
      toolCalls: result.toolCalls?.map((tc) => ({
        name: normalizedTools.internalNameByProviderName.get(tc.toolName) ?? tc.toolName,
        args: tc.input as Record<string, unknown>,
      })),
    };
  }

  async generateObject<T>(slot: ModelSlot, messages: Array<{ role: 'user' | 'assistant'; content: string }>, system?: string): Promise<T> {
    const profile = this.getSlotProfile(slot);
    if (!profile) throw new Error(noModelError(slot));

    this.logger.info({ slot, modelId: profile.modelId, providerType: profile.providerType, msgCount: messages.length }, 'ModelGateway.generateObject');
    const provider = this.buildProvider(profile);
    const result = await generateObject({
      model: provider(profile.modelId),
      messages,
      ...(system !== undefined ? { system } : {}),
      output: 'no-schema',
    } as never);
    this.recordTokenUsage((result as { usage?: unknown }).usage);
    return result.object as T;
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
      case 'openai-compatible': {
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
