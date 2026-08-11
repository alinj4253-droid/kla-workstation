// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
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
