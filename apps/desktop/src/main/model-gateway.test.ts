// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { generateObject } from 'ai';
import { ModelGateway } from './model-gateway';

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString(), isEncrypted: () => true },
  app: { getPath: () => '/tmp/test', getVersion: () => '0.1.0-test' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

vi.mock('ai', () => {
  const mockStreamResult = {
    textStream: (async function* () { yield 'mock response'; })(),
    text: Promise.resolve('mock response'),
    toTextStreamResponse: () => new Response(),
    warnings: null,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    experimental_providerMetadata: undefined,
    request: {},
    response: { messages: [], body: {} },
  };
  return {
    streamText: vi.fn(() => mockStreamResult),
    generateText: vi.fn(() => Promise.resolve({
      text: 'ok',
      toolCalls: [{ toolName: 'get_weather', args: { city: '北京' } }],
      finishReason: 'stop',
      usage: { promptTokens: 2, completionTokens: 5, totalTokens: 7 },
      steps: [{ toolCalls: [{ toolName: 'get_weather', args: { city: '北京' } }] }],
    })),
    generateObject: vi.fn(() => Promise.resolve({
      object: { result: 'test' },
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      finishReason: 'stop',
    })),
  };
});

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    const modelFn = (_modelId: string) => ({
      specifier: 'openai:gpt-4o-mini',
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      supportsUrl: false,
      doStream: vi.fn().mockResolvedValue({
        stream: (async function* () { yield { type: 'text-delta', textDelta: 'hello', delta: 'hello' }; })(),
        rawResponse: new Response(),
        warnings: null,
      }),
      doGenerate: vi.fn().mockResolvedValue({
        text: 'ok',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        rawResponse: { headers: {} },
        warnings: null,
      }),
    });
    modelFn.chat = modelFn;
    return modelFn;
  }),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => {
    const modelFn = (_modelId: string) => ({
      specifier: 'anthropic:claude-sonnet-4',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
    });
    return modelFn;
  }),
}));

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE model_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT,
      auth_type TEXT,
      secret_ref TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      config_json TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE model_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      parameters_json TEXT,
      declared_capabilities_json TEXT,
      verified_capabilities_json TEXT,
      last_verified_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE model_slot_bindings (
      slot TEXT PRIMARY KEY,
      model_profile_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE secrets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function seedData(db: Database.Database): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO secrets (id, kind, ciphertext, created_at, updated_at) VALUES ('sk-test', 'api_key', 'test-key-123', ?, ?)").run(now, now);
  db.prepare("INSERT INTO model_providers (id, name, type, base_url, secret_ref, status, created_at, updated_at) VALUES ('prov-1', 'TestProvider', 'openai', 'https://api.example.com', 'sk-test', 'available', ?, ?)").run(now, now);
  db.prepare("INSERT INTO model_providers (id, name, type, base_url, status, created_at, updated_at) VALUES ('prov-2', 'NoKeyProvider', 'openai', NULL, 'unknown', ?, ?)").run(now, now);
  db.prepare("INSERT INTO model_profiles (id, name, provider_id, model_id, enabled, created_at, updated_at) VALUES ('prof-1', 'GPT-4o-mini', 'prov-1', 'gpt-4o-mini', 1, ?, ?)").run(now, now);
  db.prepare("INSERT INTO model_profiles (id, name, provider_id, model_id, enabled, created_at, updated_at) VALUES ('prof-2', 'Disabled Profile', 'prov-1', 'gpt-4o', 0, ?, ?)").run(now, now);
  db.prepare("INSERT INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES ('reasoning', 'prof-1', ?)").run(now);
  db.prepare("INSERT INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES ('fast', 'prof-2', ?)").run(now);
}

describe('ModelGateway', () => {
  let db: Database.Database;
  let gateway: ModelGateway;

  beforeEach(() => {
    db = createDb();
    gateway = new ModelGateway(db);
  });

  it('resolves slot to a valid profile', () => {
    seedData(db);
    const profile = (gateway as any).getSlotProfile('reasoning') as { providerType: string; modelId: string; apiKey?: string } | null;
    expect(profile).not.toBeNull();
    expect(profile!.providerType).toBe('openai');
    expect(profile!.modelId).toBe('gpt-4o-mini');
    expect(profile!.apiKey).toBe('test-key-123');
  });

  it('returns null for unbound slot', () => {
    seedData(db);
    const profile = (gateway as any).getSlotProfile('embedding');
    expect(profile).toBeNull();
  });

  it('returns null for slot with disabled profile', () => {
    seedData(db);
    const profile = (gateway as any).getSlotProfile('fast');
    expect(profile).toBeNull();
  });

  it('handles missing API key gracefully', () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO model_providers (id, name, type, status, created_at, updated_at) VALUES ('prov-3', 'Keyless', 'openai', 'unknown', ?, ?)").run(now, now);
    db.prepare("INSERT INTO model_profiles (id, name, provider_id, model_id, enabled, created_at, updated_at) VALUES ('prof-3', 'KeylessModel', 'prov-3', 'gpt-4o-mini', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES ('reasoning', 'prof-3', ?)").run(now);

    const profile = (gateway as any).getSlotProfile('reasoning') as { apiKey?: string } | null;
    expect(profile).not.toBeNull();
    expect(profile!.apiKey).toBeUndefined();
  });

  it('builds provider with correct baseURL', () => {
    seedData(db);
    const profile = (gateway as any).getSlotProfile('reasoning') as { baseUrl?: string } | null;
    expect(profile).not.toBeNull();
    expect(profile!.baseUrl).toBe('https://api.example.com');
  });

  it('uses a mounted profile snapshot before the requested fallback slot', async () => {
    seedData(db);
    const profile = await gateway.runWithModelProfileSnapshot(
      JSON.stringify({ profileId: 'prof-1', parameters: { temperature: 0.2, thinking: false } }),
      async () => (gateway as any).getSlotProfile('embedding') as { modelId: string; parameters: Record<string, unknown> } | null,
    );
    expect(profile).not.toBeNull();
    expect(profile!.modelId).toBe('gpt-4o-mini');
    expect(profile!.parameters).toMatchObject({ temperature: 0.2, thinking: false });
  });

  it('缓存槽位 profile：失效前命中缓存，失效后读到新绑定', () => {
    seedData(db);
    const before = (gateway as any).getSlotProfile('reasoning') as { modelId: string } | null;
    expect(before?.modelId).toBe('gpt-4o-mini');

    const now = new Date().toISOString();
    db.prepare("INSERT INTO model_providers (id, name, type, status, created_at, updated_at) VALUES ('prov-4', 'P4', 'openai', 'unknown', ?, ?)").run(now, now);
    db.prepare("INSERT INTO model_profiles (id, name, provider_id, model_id, enabled, created_at, updated_at) VALUES ('prof-4', 'P4Model', 'prov-4', 'gpt-4.1', 1, ?, ?)").run(now, now);
    db.prepare("UPDATE model_slot_bindings SET model_profile_id = 'prof-4' WHERE slot = 'reasoning'").run();

    const cached = (gateway as any).getSlotProfile('reasoning') as { modelId: string } | null;
    expect(cached?.modelId).toBe('gpt-4o-mini');

    gateway.invalidateSlotProfiles();
    const fresh = (gateway as any).getSlotProfile('reasoning') as { modelId: string } | null;
    expect(fresh?.modelId).toBe('gpt-4.1');
  });

  it('缓存挂载 profile：失效后才反映 profile 被禁用', async () => {
    seedData(db);
    const read = () => gateway.runWithModelProfileSnapshot(
      JSON.stringify({ profileId: 'prof-1' }),
      async () => (gateway as any).getSlotProfile('embedding') as { modelId: string } | null,
    );
    await expect(read()).resolves.toMatchObject({ modelId: 'gpt-4o-mini' });

    db.prepare("UPDATE model_profiles SET enabled = 0 WHERE id = 'prof-1'").run();
    await expect(read()).resolves.toMatchObject({ modelId: 'gpt-4o-mini' });

    gateway.invalidateSlotProfiles();
    await expect(read()).resolves.toBeNull();
  });

  it('recovers structured JSON returned only in a model reasoning field', async () => {
    seedData(db);
    vi.mocked(generateObject).mockRejectedValueOnce({
      response: {
        body: {
          choices: [{ message: { content: '', reasoning_content: '```json\n{"intent":"execute","skillId":"operation-query"}\n```' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      },
    });

    await expect(gateway.generateObject<{ intent: string; skillId: string }>(
      'reasoning',
      [{ role: 'user', content: '返回 JSON' }],
    )).resolves.toEqual({ intent: 'execute', skillId: 'operation-query' });
  });

  it('applies group collaboration thinking without changing expert model settings', async () => {
    seedData(db);
    const snapshot = JSON.stringify({
      profileId: 'prof-1',
      parameters: { temperature: 0.2, thinking: true, thinkingLevel: 'high' },
    });
    const readParameters = async (mode: 'fast' | 'balanced' | 'expert') => gateway.runWithModelProfileSnapshot(
      snapshot,
      () => gateway.runWithCollaborationMode(
        mode,
        async () => ((gateway as any).getSlotProfile('reasoning') as { parameters: Record<string, unknown> }).parameters,
      ),
    );

    await expect(readParameters('fast')).resolves.toMatchObject({ thinking: false, thinkingLevel: 'none' });
    await expect(readParameters('balanced')).resolves.toMatchObject({ thinking: true, thinkingLevel: 'minimal' });
    await expect(readParameters('expert')).resolves.toMatchObject({ thinking: true, thinkingLevel: 'high' });
  });

  it('allows coordination calls to override deep thinking without changing the mounted profile', () => {
    const options = (gateway as any).getGenerationOptions({
      providerType: 'openai',
      modelId: 'gpt-5',
      parameters: { thinking: true, thinkingLevel: 'high' },
    }, {
      thinking: false,
      thinkingLevel: 'none',
    });
    expect(options.providerOptions).toEqual({ openai: { reasoningEffort: 'none' } });
  });

  it('compensates anthropic thinking budget into max_tokens so visible output is not truncated', () => {
    const resolve = (generationOptions: { providerOptions?: Record<string, unknown> }, requested?: number) =>
      (gateway as any).resolveMaxOutputTokens(generationOptions, requested);
    const anthropicThinking = (gateway as any).getGenerationOptions({
      providerType: 'anthropic',
      modelId: 'claude-sonnet-4',
      parameters: { thinking: true, thinkingLevel: 'minimal' },
    }) as { providerOptions?: Record<string, unknown> };
    expect(anthropicThinking.providerOptions).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } },
    });
    // Anthropic 的 max_tokens 同时覆盖思考与正文：2200 的可见输出上限
    // 需叠加 1024 思考预算，否则结构化规划 JSON 会在中途被截断。
    expect(resolve(anthropicThinking, 2200)).toBe(3224);
    // 未请求输出上限时不额外设置 max_tokens
    expect(resolve(anthropicThinking, undefined)).toBeUndefined();
    expect(resolve(anthropicThinking, Number.NaN)).toBeUndefined();
    // 非法请求值有下限保护
    expect(resolve(anthropicThinking, 10)).toBe(1024 + 64);
    // 非 anthropic 或未开启思考时不叠加
    expect(resolve({ providerOptions: { openai: { reasoningEffort: 'high' } } }, 2200)).toBe(2200);
    expect(resolve({}, 2200)).toBe(2200);
    // 非法思考预算不叠加
    expect(resolve({ providerOptions: { anthropic: { thinking: { budgetTokens: 0 } } } }, 2200)).toBe(2200);
    expect(resolve({ providerOptions: { anthropic: { thinking: { budgetTokens: Number.NaN } } } }, 2200)).toBe(2200);
    expect(resolve({ providerOptions: { anthropic: { thinking: { budgetTokens: Number.POSITIVE_INFINITY } } } }, 2200)).toBe(2200);
  });

  it('generateText passes the compensated max_tokens to the model call', async () => {
    seedData(db);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO model_providers (id, name, type, base_url, secret_ref, status, created_at, updated_at) VALUES ('prov-claude', 'ClaudeProvider', 'anthropic', 'https://api.anthropic.com', 'sk-test', 'available', ?, ?)").run(now, now);
    db.prepare("INSERT INTO model_profiles (id, name, provider_id, model_id, enabled, created_at, updated_at) VALUES ('prof-claude', 'Claude Sonnet', 'prov-claude', 'claude-sonnet-4', 1, ?, ?)").run(now, now);
    db.prepare("UPDATE model_slot_bindings SET model_profile_id = 'prof-claude' WHERE slot = 'reasoning'").run();

    const { generateText: aiGenerateText } = await import('ai');
    vi.mocked(aiGenerateText).mockClear();
    await gateway.generateText('reasoning', [{ role: 'user', content: '规划下一步' }], {
      maxOutputTokens: 2200,
      thinking: true,
      thinkingLevel: 'minimal',
    });

    const lastCall = vi.mocked(aiGenerateText).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastCall?.providerOptions).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } } });
    expect(lastCall?.maxOutputTokens).toBe(3224);
  });

  it('testCapabilities throws for nonexistent provider', async () => {
    await expect(gateway.testCapabilities('nonexistent')).rejects.toThrow('Provider 不存在');
  });

  it('testCapabilities returns results for existent provider', async () => {
    seedData(db);
    // Actual HTTP call will fail, but the function should still return results
    const results = await gateway.testCapabilities('prov-1');
    expect(results).toHaveProperty('streaming');
    expect(results).toHaveProperty('toolCalling');
    expect(results).toHaveProperty('structuredOutput');
  }, 10000);

  it('streamText throws for unconfigured slot', async () => {
    await expect(gateway.streamText('reasoning', [{ role: 'user', content: 'hi' }])).rejects.toThrow('模型未配置');
  });

  it('generateText throws for unconfigured slot', async () => {
    await expect(gateway.generateText('fast', [{ role: 'user', content: 'hi' }])).rejects.toThrow('模型未配置');
  });

  it('generateObject throws for unconfigured slot', async () => {
    await expect(gateway.generateObject('embedding', [{ role: 'user', content: 'hi' }])).rejects.toThrow('模型未配置');
  });
});
