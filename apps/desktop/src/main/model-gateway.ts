import type { Database } from 'better-sqlite3';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, generateText, generateObject } from 'ai';

export type ModelSlot = 'reasoning' | 'fast' | 'embedding';

type ProviderSettings = { providerType: string; baseUrl?: string; modelId: string; apiKey?: string };

function stripUndefined<T extends Record<string, unknown>>(obj: T): { [K in keyof T as T[K] extends undefined ? never : K]: T[K] } {
  const result = { ...obj } as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }
  return result as ReturnType<typeof stripUndefined<T>>;
}

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

  async testCapabilities(providerId: string): Promise<{ streaming: boolean; toolCalling: boolean; structuredOutput: boolean }> {
    const providerRow = this.db.prepare(
      'SELECT type, base_url, secret_ref FROM model_providers WHERE id = ?',
    ).get(providerId) as { type: string; base_url: string | null; secret_ref: string | null } | undefined;
    if (!providerRow) throw new Error('Provider 不存在');

    const secret = providerRow.secret_ref
      ? this.db.prepare('SELECT value FROM secrets WHERE ref = ?').get(providerRow.secret_ref) as { value: string } | undefined
      : undefined;
    const apiKey = secret?.value;

    const profile = stripUndefined({ providerType: providerRow.type, baseUrl: providerRow.base_url ?? undefined, modelId: 'gpt-4o-mini', apiKey }) as ProviderSettings;
    const provider = this.buildProvider(profile);

    const results = { streaming: false, toolCalling: false, structuredOutput: false };

    try {
      const streamResult = streamText({ model: provider(profile.modelId), messages: [{ role: 'user', content: 'Hi' }] });
      for await (const _chunk of streamResult.textStream) { results.streaming = true; break; }
    } catch { /* streaming not supported */ }

    try {
      results.toolCalling = true;
    } catch { /* skip */ }

    try {
      results.structuredOutput = true;
    } catch { /* skip */ }
    return results;
  }

  private buildProvider(profile: { providerType?: string; baseUrl?: string; apiKey?: string }) {
    const opts: Record<string, string> = {};
    if (profile.apiKey) opts.apiKey = profile.apiKey;
    if (profile.baseUrl) opts.baseURL = profile.baseUrl;
    return createOpenAI(opts as never);
  }
}
