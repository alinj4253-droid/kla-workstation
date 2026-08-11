// @vitest-environment node
/**
 * AC-MODEL-01 & AC-MODEL-02 验收测试
 *
 * AC-MODEL-01: 只通过文本生成测试、未通过工具调用测试的模型不能绑定统筹管理智能体。
 * AC-MODEL-02: 把内置智能体从 Provider A 的模型切换到兼容的 Provider B 后，无需修改智能体定义即可运行。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ModelGateway, validateModelForAgent, BUILTIN_AGENT_REQUIREMENTS } from './model-gateway';
import type { ModelCapability } from './model-gateway';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test', getVersion: () => '0.1.0-test' },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
      ref TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      definition_version TEXT NOT NULL,
      runtime_mode TEXT NOT NULL DEFAULT 'native-model',
      model_profile_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      delegatable INTEGER NOT NULL DEFAULT 1,
      is_system_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE project_agent_instances (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_profile_id TEXT NOT NULL,
      definition_id TEXT,
      definition_version TEXT,
      role TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      model_profile_id TEXT,
      ordinal INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function seedProviders(db: Database.Database): { providerA: string; providerB: string; profileA: string; profileB: string } {
  const now = new Date().toISOString();
  const providerA = 'prov-a';
  const providerB = 'prov-b';
  const profileA = 'prof-a-gpt4';
  const profileB = 'prof-b-claude';

  // Provider A: OpenAI-compatible
  db.prepare(
    "INSERT INTO model_providers (id, name, type, base_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'available', ?, ?)",
  ).run(providerA, 'Provider A (OpenAI)', 'openai', 'https://api.openai.com', now, now);

  // Provider B: Anthropic-compatible (but same OpenAI-compatible interface for testing)
  db.prepare(
    "INSERT INTO model_providers (id, name, type, base_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'available', ?, ?)",
  ).run(providerB, 'Provider B (Anthropic)', 'openai', 'https://api.anthropic.com', now, now);

  // Profile A: GPT-4o-mini, verified with streaming + toolCalling + structuredOutput
  db.prepare(
    "INSERT INTO model_profiles (id, name, provider_id, model_id, verified_capabilities_json, last_verified_at, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
  ).run(profileA, 'GPT-4o-mini', providerA, 'gpt-4o-mini', JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']), now, now, now);

  // Profile B: Claude 3.5 Sonnet, verified with streaming + toolCalling + structuredOutput
  db.prepare(
    "INSERT INTO model_profiles (id, name, provider_id, model_id, verified_capabilities_json, last_verified_at, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
  ).run(profileB, 'Claude 3.5 Sonnet', providerB, 'claude-3-5-sonnet', JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']), now, now, now);

  return { providerA, providerB, profileA, profileB };
}

// ─── AC-MODEL-01 ─────────────────────────────────────────────────────────────

describe('AC-MODEL-01: 模型能力校验', () => {
  describe('validateModelForAgent', () => {
    it('拒绝将缺少 structuredOutput 的模型绑定到 orchestrator', () => {
      const result = validateModelForAgent('builtin.orchestrator', ['streaming']);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('toolCalling');
      expect(result.reason).toContain('structuredOutput');
    });

    it('允许通过完整能力校验的模型绑定到 orchestrator', () => {
      const result = validateModelForAgent('builtin.orchestrator', ['streaming', 'toolCalling', 'structuredOutput']);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('拒绝将完全无能力的模型绑定到 orchestrator', () => {
      const result = validateModelForAgent('builtin.orchestrator', []);
      expect(result.allowed).toBe(false);
    });

    it('允许将 streaming + structuredOutput 的模型绑定到 knowledge-manager', () => {
      const result = validateModelForAgent('builtin.knowledge-manager', ['streaming', 'structuredOutput']);
      expect(result.allowed).toBe(true);
    });

    it('非内置智能体不做能力校验', () => {
      const result = validateModelForAgent('custom.agent', []);
      expect(result.allowed).toBe(true);
    });
  });

  describe('与 ModelGateway 集成', () => {
    it('orchestrator 的 slot 配置应引用已验证 toolCalling 的模型', () => {
      const db = createDb();
      const { profileA } = seedProviders(db);

      // 将 reasoning slot 绑定到 Profile A（已验证 streaming + toolCalling）
      const now = new Date().toISOString();
      db.prepare("INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)").run('reasoning', profileA, now);

      const gateway = new ModelGateway(db);
      const profile = (gateway as any).getSlotProfile('reasoning') as { modelId: string } | null;
      expect(profile).not.toBeNull();
      expect(profile!.modelId).toBe('gpt-4o-mini');

      // 验证该 profile 满足 orchestrator 的能力要求
      const profileRow = db.prepare('SELECT verified_capabilities_json FROM model_profiles WHERE id = ?').get(profileA) as { verified_capabilities_json: string };
      const caps = JSON.parse(profileRow.verified_capabilities_json) as string[];
      const validation = validateModelForAgent('builtin.orchestrator', caps as ModelCapability[]);
      expect(validation.allowed).toBe(true);
    });

    it('orchestrator 不应绑定到仅文本生成的模型', () => {
      const db = createDb();
      const now = new Date().toISOString();

      db.prepare("INSERT INTO model_providers (id, name, type, status, created_at, updated_at) VALUES ('prov-text', 'TextOnly', 'openai', 'available', ?, ?)").run(now, now);
      db.prepare(
        "INSERT INTO model_profiles (id, name, provider_id, model_id, verified_capabilities_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
      ).run('prof-text', 'Text-Only Model', 'prov-text', 'gpt-3.5-turbo', JSON.stringify(['streaming']), now, now);

      const profileRow = db.prepare('SELECT verified_capabilities_json FROM model_profiles WHERE id = ?').get('prof-text') as { verified_capabilities_json: string };
      const caps = JSON.parse(profileRow.verified_capabilities_json) as string[];

      const validation = validateModelForAgent('builtin.orchestrator', caps as ModelCapability[]);
      expect(validation.allowed).toBe(false);
    });
  });
});

// ─── AC-MODEL-02 ─────────────────────────────────────────────────────────────

describe('AC-MODEL-02: Provider 切换兼容性', () => {
  it('切换 slot 绑定从 Provider A 到 Provider B 后，通过 slot 解析仍能获取到新模型', () => {
    const db = createDb();
    const { profileA, profileB } = seedProviders(db);
    const now = new Date().toISOString();

    // 1. 初始绑定：reasoning slot → Profile A (Provider A)
    db.prepare("INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)").run('reasoning', profileA, now);

    const gateway = new ModelGateway(db);

    // 验证 slot 解析到 Provider A 的模型
    const slotProfileA = (gateway as any).getSlotProfile('reasoning') as { providerType: string; modelId: string; baseUrl: string } | null;
    expect(slotProfileA).not.toBeNull();
    expect(slotProfileA!.modelId).toBe('gpt-4o-mini');
    expect(slotProfileA!.baseUrl).toBe('https://api.openai.com');

    // 2. 切换绑定：reasoning slot → Profile B (Provider B)，不修改任何智能体定义
    db.prepare("INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)").run('reasoning', profileB, now);

    // 验证 slot 解析到 Provider B 的模型，无需修改智能体定义
    const slotProfileB = (gateway as any).getSlotProfile('reasoning') as { providerType: string; modelId: string; baseUrl: string } | null;
    expect(slotProfileB).not.toBeNull();
    expect(slotProfileB!.modelId).toBe('claude-3-5-sonnet');
    expect(slotProfileB!.baseUrl).toBe('https://api.anthropic.com');

    // 验证 Provider A 和 Provider B 的 profile 都满足 orchestrator 的能力要求
    const profileARow = db.prepare('SELECT verified_capabilities_json FROM model_profiles WHERE id = ?').get(profileA) as { verified_capabilities_json: string };
    const profileBRow = db.prepare('SELECT verified_capabilities_json FROM model_profiles WHERE id = ?').get(profileB) as { verified_capabilities_json: string };
    expect(validateModelForAgent('builtin.orchestrator', JSON.parse(profileARow.verified_capabilities_json)).allowed).toBe(true);
    expect(validateModelForAgent('builtin.orchestrator', JSON.parse(profileBRow.verified_capabilities_json)).allowed).toBe(true);
  });

  it('多个 slot 各自独立切换，不影响其他 slot', () => {
    const db = createDb();
    const now = new Date().toISOString();
    const { providerA, providerB, profileA, profileB } = seedProviders(db);

    // 创建额外的 profile 用于 fast slot
    const profileAFast = 'prof-a-fast';
    const profileBFast = 'prof-b-fast';
    db.prepare(
      "INSERT INTO model_profiles (id, name, provider_id, model_id, verified_capabilities_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    ).run(profileAFast, 'GPT-4o-fast', providerA, 'gpt-4o', JSON.stringify(['streaming', 'toolCalling']), now, now);
    db.prepare(
      "INSERT INTO model_profiles (id, name, provider_id, model_id, verified_capabilities_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    ).run(profileBFast, 'Claude-Haiku', providerB, 'claude-3-haiku', JSON.stringify(['streaming', 'toolCalling']), now, now);

    // 初始绑定：reasoning → Profile A, fast → profileAFast
    db.prepare("INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)").run('reasoning', profileA, now);
    db.prepare("INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)").run('fast', profileAFast, now);

    const gateway = new ModelGateway(db);

    // 验证初始状态
    const reasoningProfile = (gateway as any).getSlotProfile('reasoning') as { modelId: string } | null;
    expect(reasoningProfile!.modelId).toBe('gpt-4o-mini');
    const fastProfile = (gateway as any).getSlotProfile('fast') as { modelId: string } | null;
    expect(fastProfile!.modelId).toBe('gpt-4o');

    // 只切换 reasoning slot 到 Provider B，fast slot 保持不变
    db.prepare("INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)").run('reasoning', profileB, now);

    // reasoning slot 已切换到 Provider B 的模型
    const reasoningProfileB = (gateway as any).getSlotProfile('reasoning') as { modelId: string; baseUrl: string } | null;
    expect(reasoningProfileB!.modelId).toBe('claude-3-5-sonnet');
    expect(reasoningProfileB!.baseUrl).toBe('https://api.anthropic.com');

    // fast slot 仍为 Provider A 的模型
    const fastProfileUnchanged = (gateway as any).getSlotProfile('fast') as { modelId: string; baseUrl: string } | null;
    expect(fastProfileUnchanged!.modelId).toBe('gpt-4o');
    expect(fastProfileUnchanged!.baseUrl).toBe('https://api.openai.com');
  });

  it('禁用 profile 后 slot 解析返回 null，不影响其他 slot', () => {
    const db = createDb();
    const { profileA } = seedProviders(db);
    const now = new Date().toISOString();

    // 绑定 reasoning → Profile A
    db.prepare("INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)").run('reasoning', profileA, now);

    const gateway = new ModelGateway(db);
    expect((gateway as any).getSlotProfile('reasoning')).not.toBeNull();

    // 禁用 Profile A
    db.prepare("UPDATE model_profiles SET enabled = 0 WHERE id = ?").run(profileA);

    // 禁用后 slot 解析应返回 null
    expect((gateway as any).getSlotProfile('reasoning')).toBeNull();
  });

  describe('BUILTIN_AGENT_REQUIREMENTS 常量', () => {
    it('orchestrator 需要 streaming、toolCalling 和 structuredOutput', () => {
      const req = BUILTIN_AGENT_REQUIREMENTS.find((r) => r.definitionId === 'builtin.orchestrator');
      expect(req).toBeDefined();
      expect(req!.requiredCapabilities).toContain('streaming');
      expect(req!.requiredCapabilities).toContain('toolCalling');
      expect(req!.requiredCapabilities).toContain('structuredOutput');
    });

    it('knowledge-manager 需要 streaming 和 structuredOutput', () => {
      const req = BUILTIN_AGENT_REQUIREMENTS.find((r) => r.definitionId === 'builtin.knowledge-manager');
      expect(req).toBeDefined();
      expect(req!.requiredCapabilities).toContain('streaming');
      expect(req!.requiredCapabilities).toContain('structuredOutput');
      expect(req!.requiredCapabilities).not.toContain('toolCalling');
    });
  });
});