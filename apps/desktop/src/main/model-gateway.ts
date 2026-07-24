import type { Database } from 'better-sqlite3';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, generateText, generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';

export type ModelSlot = 'reasoning' | 'fast' | 'embedding';

/** 智能体定义对模型的能力要求 */
export type AgentCapabilityRequirements = {
  definitionId: string;
  requiredCapabilities: string[];
};

/** 内置智能体的模型能力要求映射 */
export const BUILTIN_AGENT_REQUIREMENTS: AgentCapabilityRequirements[] = [
  {
    definitionId: 'builtin.orchestrator',
    requiredCapabilities: ['streaming', 'toolCalling', 'structuredOutput'],
  },
  {
    definitionId: 'builtin.knowledge-manager',
    requiredCapabilities: ['streaming', 'structuredOutput'],
  },
  {
    definitionId: 'builtin.researcher',
    requiredCapabilities: ['streaming', 'structuredOutput'],
  },
];

/** 验证模型能力是否满足智能体要求 */
export function validateModelForAgent(
  definitionId: string,
  verifiedCapabilities: string[],
): { allowed: boolean; reason?: string } {
  const req = BUILTIN_AGENT_REQUIREMENTS.find((r) => r.definitionId === definitionId);
  if (!req) {
    return { allowed: true };
  }

  const missing = req.requiredCapabilities.filter((cap) => !verifiedCapabilities.includes(cap));
  if (missing.length > 0) {
    return {
      allowed: false,
      reason: `模型缺少必要能力: ${missing.join(', ')}。智能体 ${definitionId} 需要: ${req.requiredCapabilities.join(', ')}`,
    };
  }

  return { allowed: true };
}

type ProviderSettings = { providerType: string; baseUrl?: string; modelId: string; apiKey?: string };

function stripUndefined<T extends Record<string, unknown>>(obj: T): { [K in keyof T as T[K] extends undefined ? never : K]: T[K] } {
  const result = { ...obj } as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }
  return result as ReturnType<typeof stripUndefined<T>>;
}

/** 结构化输出的测试 schema */
const testObjectSchema = z.object({
  summary: z.string().describe('一句话总结'),
  keywords: z.array(z.string()).describe('关键词列表'),
});

export class ModelGateway {
  constructor(private db: Database) {}

  private getSlotProfile(slot: ModelSlot): ProviderSettings | null {
    const row = this.db.prepare(
      `SELECT mp.id, mp.model_id as modelId, mp.provider_id as providerId,
              prv.type as providerType, prv.base_url as baseUrl, prv.secret_ref as secretRef
       FROM model_slot_bindings msb
       JOIN model_profiles mp ON mp.id = msb.model_profile_id
       JOIN model_providers prv ON prv.id = mp.provider_id
       WHERE msb.slot = ? AND mp.enabled = 1`,
    ).get(slot) as { id: string; modelId: string; providerId: string; providerType: string; baseUrl: string | null; secretRef: string | null } | undefined;

    if (!row) return null;
    let apiKey: string | undefined;
    if (row.secretRef) {
      const secret = this.db.prepare('SELECT value FROM secrets WHERE ref = ?').get(row.secretRef) as { value: string } | undefined;
      apiKey = secret?.value;
    }
    return stripUndefined({ providerType: row.providerType, baseUrl: row.baseUrl ?? undefined, modelId: row.modelId, apiKey }) as ProviderSettings;
  }

  async streamText(slot: ModelSlot, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<ReadableStream<string>> {
    const profile = this.getSlotProfile(slot);
    if (!profile) throw new Error(`没有为槽位 "${slot}" 配置可用的模型`);

    const provider = this.buildProvider(profile);
    const result = streamText({
      model: provider(profile.modelId),
      messages,
    });
    return result.textStream;
  }

  async generateText(slot: ModelSlot, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string> {
    const profile = this.getSlotProfile(slot);
    if (!profile) throw new Error(`没有为槽位 "${slot}" 配置可用的模型`);

    const provider = this.buildProvider(profile);
    const result = await generateText({
      model: provider(profile.modelId),
      messages,
    });
    return result.text;
  }

  async generateObject<T>(slot: ModelSlot, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<T> {
    const profile = this.getSlotProfile(slot);
    if (!profile) throw new Error(`没有为槽位 "${slot}" 配置可用的模型`);

    const provider = this.buildProvider(profile);
    const result = await generateObject({
      model: provider(profile.modelId),
      messages,
      output: 'no-schema',
    } as never);
    return result.object as T;
  }

  /**
   * 对指定 Provider 执行真实能力测试
   * - streaming: 发送简单消息，验证能否收到流式 chunk
   * - toolCalling: 提供工具定义，验证模型是否调用工具
   * - structuredOutput: 使用 schema 验证模型能否输出结构化结果
   */
  async testCapabilities(providerId: string, modelId?: string): Promise<{ streaming: boolean; toolCalling: boolean; structuredOutput: boolean }> {
    const providerRow = this.db.prepare(
      'SELECT type, base_url, secret_ref FROM model_providers WHERE id = ?',
    ).get(providerId) as { type: string; base_url: string | null; secret_ref: string | null } | undefined;
    if (!providerRow) throw new Error('Provider 不存在');

    const secret = providerRow.secret_ref
      ? this.db.prepare('SELECT value FROM secrets WHERE ref = ?').get(providerRow.secret_ref) as { value: string } | undefined
      : undefined;
    const apiKey = secret?.value;

    let testModelId = modelId;
    if (!testModelId) {
      const profile = this.db.prepare('SELECT model_id FROM model_profiles WHERE provider_id = ? AND enabled = 1 LIMIT 1').get(providerId) as { model_id: string } | undefined;
      testModelId = profile?.model_id;
    }
    if (!testModelId) throw new Error('未提供 modelId 且该 Provider 无有效 Model Profile，无法测试');
    const profile = stripUndefined({ providerType: providerRow.type, baseUrl: providerRow.base_url ?? undefined, modelId: testModelId, apiKey }) as ProviderSettings;
    const provider = this.buildProvider(profile);

    const results = { streaming: false, toolCalling: false, structuredOutput: false };
    const testSignal = AbortSignal.timeout(15000);

    // 1. 测试流式文本
    try {
      const streamResult = streamText({
        model: provider(profile.modelId),
        messages: [{ role: 'user', content: 'Hi' }],
        abortSignal: testSignal,
      });
      for await (const _chunk of streamResult.textStream) {
        results.streaming = true;
        break;
      }
    } catch { /* streaming not supported */ }

    // 2. 测试工具调用
    if (results.streaming) {
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
        // 检查是否有 tool call
        results.toolCalling = (toolResult.toolCalls?.length ?? 0) > 0
          || (toolResult.steps?.some((s) => (s.toolCalls?.length ?? 0) > 0) ?? false);
      } catch { /* tool calling not supported */ }
    }

    // 3. 测试结构化输出
    if (results.streaming) {
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
    }

    return results;
  }

  private buildProvider(profile: { providerType?: string; baseUrl?: string; apiKey?: string }): (modelId: string) => LanguageModel {
    const type = profile.providerType ?? 'openai';

    switch (type) {
      case 'openai':
      case 'openai-compatible': {
        const opts: Record<string, string> = {};
        if (profile.apiKey) opts.apiKey = profile.apiKey;
        if (profile.baseUrl) opts.baseURL = profile.baseUrl;
        return createOpenAI(opts as never) as unknown as (modelId: string) => LanguageModel;
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
        throw new Error(`不支持的 Provider 类型: ${type}。支持的: openai, openai-compatible, anthropic, google`);
    }
  }
}
