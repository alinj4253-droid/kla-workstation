// @vitest-environment node
import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AgentDefinitionRepository } from '@kunqing/database';
import { validateEffectivePermissions, type PermissionDefinition } from './permission-validator';
import { checkVersionCompatibility } from './version-compatibility';
import { CodexCliAdapter, ClaudeCodeCliAdapter } from '@kunqing/agent-core';

const ADAPTER_SRC = resolve(process.cwd(), '../../packages/agent-core/src/adapters');

describe('AC-AGENT-01: 内置 Agent Profile 的权限只能收紧', () => {
  let db: Database.Database;
  let defRepo: AgentDefinitionRepository;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_definitions (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL DEFAULT '1.0.0',
        kind TEXT NOT NULL DEFAULT 'builtin',
        manifest_rel_path TEXT NOT NULL DEFAULT '',
        checksum TEXT NOT NULL DEFAULT '',
        framework_entry TEXT,
        max_permissions_json TEXT,
        model_requirements_json TEXT,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        installed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    defRepo = new AgentDefinitionRepository(db);

    // 创建内置定义，包含 maxPermissionsJson
    defRepo.create({
      id: 'builtin.orchestrator',
      kind: 'builtin',
      isBuiltin: true,
      manifestRelPath: 'agents/builtin-orchestrator/manifest.json',
      maxPermissionsJson: JSON.stringify({
        read: ['group.original-files', 'group.knowledge', 'shared.knowledge', 'group.messages'],
        write: ['self.memory', 'group.outputs'],
        network: 'model-gateway-only',
        shell: 'deny',
      }),
      modelRequirementsJson: JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']),
    });

    defRepo.create({
      id: 'builtin.knowledge-manager',
      kind: 'builtin',
      isBuiltin: true,
      manifestRelPath: 'agents/builtin-knowledge-manager/manifest.json',
      maxPermissionsJson: JSON.stringify({
        read: ['group.original-files', 'group.knowledge', 'shared.knowledge', 'group.messages'],
        write: ['self.memory', 'group.outputs', 'group.knowledge'],
        network: 'model-gateway-only',
        shell: 'deny',
      }),
      modelRequirementsJson: JSON.stringify(['streaming']),
    });
  });

  // ─── orchestrator 权限校验 ───────────────────────────────────────────────
  const orchMax: PermissionDefinition = {
    read: ['group.original-files', 'group.knowledge', 'shared.knowledge', 'group.messages'],
    write: ['self.memory', 'group.outputs'],
    network: 'model-gateway-only',
    shell: 'deny',
  };

  describe('orchestrator 权限收紧', () => {
    it('允许收紧 read 权限（子集）', () => {
      const result = validateEffectivePermissions(
        { read: ['group.messages'], write: ['self.memory'], network: 'model-gateway-only', shell: 'deny' },
        orchMax,
      );
      expect(result.allowed).toBe(true);
    });

    it('拒绝超出 read 范围', () => {
      const result = validateEffectivePermissions(
        { read: ['group.messages', 'group.secrets'], write: ['self.memory'], network: 'model-gateway-only', shell: 'deny' },
        orchMax,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('group.secrets');
    });

    it('拒绝超出 write 范围', () => {
      const result = validateEffectivePermissions(
        { read: ['group.messages'], write: ['self.memory', 'group.knowledge'], network: 'model-gateway-only', shell: 'deny' },
        orchMax,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('group.knowledge');
    });

    it('拒绝修改 network 权限', () => {
      const result = validateEffectivePermissions(
        { read: ['group.messages'], write: ['self.memory'], network: 'full', shell: 'deny' },
        orchMax,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('network');
    });

    it('拒绝修改 shell 权限', () => {
      const result = validateEffectivePermissions(
        { read: ['group.messages'], write: ['self.memory'], network: 'model-gateway-only', shell: 'allow' },
        orchMax,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('shell');
    });

    it('允许完全相同的权限（不收紧）', () => {
      const result = validateEffectivePermissions(orchMax, orchMax);
      expect(result.allowed).toBe(true);
    });

    it('允许空权限（完全收紧）', () => {
      const result = validateEffectivePermissions(
        { read: [], write: [], network: 'model-gateway-only', shell: 'deny' },
        orchMax,
      );
      expect(result.allowed).toBe(true);
    });
  });

  // ─── knowledge-manager 权限校验 ──────────────────────────────────────────
  const kmMax: PermissionDefinition = {
    read: ['group.original-files', 'group.knowledge', 'shared.knowledge', 'group.messages'],
    write: ['self.memory', 'group.outputs', 'group.knowledge'],
    network: 'model-gateway-only',
    shell: 'deny',
  };

  describe('knowledge-manager 权限收紧', () => {
    it('允许收紧 write 权限（子集）', () => {
      const result = validateEffectivePermissions(
        { read: ['group.knowledge'], write: ['self.memory'], network: 'model-gateway-only', shell: 'deny' },
        kmMax,
      );
      expect(result.allowed).toBe(true);
    });

    it('拒绝超出 write 范围（KM 允许 write:knowledge）', () => {
      const result = validateEffectivePermissions(
        { read: ['group.knowledge'], write: ['self.memory', 'delete:file'], network: 'model-gateway-only', shell: 'deny' },
        kmMax,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('delete:file');
    });
  });

  // ─── maxPermissionsJson 持久化 ───────────────────────────────────────────
  describe('maxPermissionsJson 持久化', () => {
    it('orchestrator 定义记录了 maxPermissionsJson', () => {
      const def = defRepo.getById('builtin.orchestrator');
      expect(def.maxPermissionsJson).not.toBeNull();
      const parsed = JSON.parse(def.maxPermissionsJson!);
      expect(parsed.read).toContain('group.messages');
      expect(parsed.shell).toBe('deny');
    });

    it('knowledge-manager 定义记录了 maxPermissionsJson', () => {
      const def = defRepo.getById('builtin.knowledge-manager');
      expect(def.maxPermissionsJson).not.toBeNull();
      const parsed = JSON.parse(def.maxPermissionsJson!);
      expect(parsed.write).toContain('group.knowledge');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-AGENT-02: 版本不在已测试范围时标记 incompatible/experimental
// ---------------------------------------------------------------------------
describe('AC-AGENT-02: CLI 版本兼容性检测', () => {
  it('version-compatibility module exists and exports checkVersionCompatibility', () => {
    expect(checkVersionCompatibility).toBeDefined();
    expect(typeof checkVersionCompatibility).toBe('function');
  });

  describe('checkVersionCompatibility — codex', () => {
    it('已知范围内版本返回 compatible', () => {
      expect(checkVersionCompatibility('codex', '1.0.0')).toBe('compatible');
      expect(checkVersionCompatibility('codex', '0.1.0')).toBe('compatible');
      expect(checkVersionCompatibility('codex', '0.5.3')).toBe('compatible');
      expect(checkVersionCompatibility('codex', '1.99.99')).toBe('compatible');
    });

    it('低于最低版本返回 incompatible', () => {
      expect(checkVersionCompatibility('codex', '0.0.9')).toBe('incompatible');
      expect(checkVersionCompatibility('codex', '0.0.1')).toBe('incompatible');
    });

    it('超出最大版本返回 experimental', () => {
      expect(checkVersionCompatibility('codex', '2.0.0')).toBe('experimental');
      expect(checkVersionCompatibility('codex', '3.0.0')).toBe('experimental');
    });

    it('null 或空版本返回 unknown', () => {
      expect(checkVersionCompatibility('codex', null)).toBe('unknown');
      expect(checkVersionCompatibility('codex', '')).toBe('unknown');
    });

    it('无法解析的版本字符串返回 unknown', () => {
      expect(checkVersionCompatibility('codex', 'dev')).toBe('unknown');
      expect(checkVersionCompatibility('codex', 'latest')).toBe('unknown');
    });

    it('不支持的适配器类型返回 unknown', () => {
      expect(checkVersionCompatibility('nonexistent', '1.0.0')).toBe('unknown');
    });
  });

  describe('checkVersionCompatibility — claude-code', () => {
    it('已知范围内版本返回 compatible', () => {
      expect(checkVersionCompatibility('claude-code', '0.1.0')).toBe('compatible');
      expect(checkVersionCompatibility('claude-code', '1.0.0')).toBe('compatible');
      expect(checkVersionCompatibility('claude-code', '5.0.0')).toBe('compatible');
      expect(checkVersionCompatibility('claude-code', '9.99.99')).toBe('compatible');
    });

    it('低于最低版本返回 incompatible', () => {
      expect(checkVersionCompatibility('claude-code', '0.0.1')).toBe('incompatible');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-AGENT-03: CLI 认证信息不被应用读取或复制，detect 只读 PATH 和 --version
// ---------------------------------------------------------------------------
// 第一组：静态源码分析（验证 adapter 实现不包含认证文件路径）
// 第二组：运行时验证（env 消毒、logger 脱敏）
describe('AC-AGENT-03: CLI 认证信息不被应用读取或复制', () => {
  const codexDetectSource = readFileSync(resolve(ADAPTER_SRC, 'codex/detect.ts'), 'utf-8');
  const claudeDetectSource = readFileSync(resolve(ADAPTER_SRC, 'claude-code/detect.ts'), 'utf-8');
  const codexAdapterSource = readFileSync(resolve(ADAPTER_SRC, 'codex/adapter.ts'), 'utf-8');
  const claudeAdapterSource = readFileSync(resolve(ADAPTER_SRC, 'claude-code/adapter.ts'), 'utf-8');

  it('CodexCliAdapter.detect 源码不包含认证文件路径', () => {
    expect(codexDetectSource).not.toMatch(/~(\/|\\)\.codex/);
    expect(codexDetectSource).not.toMatch(/~(\/|\\)\.config\/codex/);
    expect(codexDetectSource).not.toMatch(/codex\/config/);
    expect(codexDetectSource).not.toMatch(/read(File|Sync).*\.env/);
    expect(codexDetectSource).not.toMatch(/credentials/);
    expect(codexDetectSource).not.toMatch(/auth\.json/);
    expect(codexDetectSource).not.toMatch(/tokens?\.json/);
  });

  it('ClaudeCodeCliAdapter.detect 源码不包含认证文件路径', () => {
    expect(claudeDetectSource).not.toMatch(/~(\/|\\)\.claude/);
    expect(claudeDetectSource).not.toMatch(/claude\/config/);
    expect(claudeDetectSource).not.toMatch(/read(File|Sync).*\.env/);
    expect(claudeDetectSource).not.toMatch(/credentials/);
    expect(claudeDetectSource).not.toMatch(/auth\.json/);
    expect(claudeDetectSource).not.toMatch(/tokens?\.json/);
  });

  it('detect 只使用 --version 参数，不使用 --auth/--config', () => {
    // Both detectors only run `--version` on the detected executable
    expect(codexDetectSource).toContain('--version');
    expect(claudeDetectSource).toContain('--version');
    // Should NOT run auth-related subcommands in detect
    expect(codexDetectSource).not.toContain('--auth');
    expect(codexDetectSource).not.toContain('--config');
    expect(codexDetectSource).not.toContain('login');
    expect(claudeDetectSource).not.toContain('--auth');
    expect(claudeDetectSource).not.toContain('--config');
    expect(claudeDetectSource).not.toContain('login');
  });

  it('execute 只传递进程 env 不含 CLI 全局配置路径', () => {
    // execute passes through process.env but does NOT add explicit auth vars
    expect(codexAdapterSource).toContain('...process.env');
    expect(claudeAdapterSource).toContain('...process.env');
    // No hardcoded auth/config paths
    expect(codexAdapterSource).not.toMatch(/CODEX_(API_KEY|TOKEN|AUTH|CONFIG)/);
    expect(claudeAdapterSource).not.toMatch(/CLAUDE_(API_KEY|TOKEN|AUTH|CONFIG)/);
  });

  it('detect 只会从 --version 输出解析版本号，不过度读取配置', () => {
    // Both detectors' detect() calls --version, not config-reading commands
    expect(codexDetectSource).toContain('--version');
    expect(claudeDetectSource).toContain('--version');
    // No shell commands that read configuration files
    expect(codexDetectSource).not.toMatch(/\bcat\s/);
    expect(codexDetectSource).not.toMatch(/\bmore\s/);
    expect(claudeDetectSource).not.toMatch(/\bcat\s/);
    expect(claudeDetectSource).not.toMatch(/\bmore\s/);
  });

  // ─── 第二组：运行时 env 消毒 ──────────────────────────────────────────────
  describe('运行时 env 消毒', () => {
    it('sanitizeEnv 过滤 OPENAI_API_KEY', async () => {
      const { sanitizeEnv } = await import('./env-sanitizer');
      const env = { OPENAI_API_KEY: 'sk-test-123', PATH: '/usr/bin' };
      const result = sanitizeEnv(env);
      expect(result).not.toHaveProperty('OPENAI_API_KEY');
      expect(result).toHaveProperty('PATH');
    });

    it('sanitizeEnv 过滤 ANTHROPIC_API_KEY', async () => {
      const { sanitizeEnv } = await import('./env-sanitizer');
      const env = { ANTHROPIC_API_KEY: 'sk-ant-test', PATH: '/usr/bin' };
      const result = sanitizeEnv(env);
      expect(result).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(result).toHaveProperty('PATH');
    });

    it('sanitizeEnv 过滤 CODEX_API_KEY', async () => {
      const { sanitizeEnv } = await import('./env-sanitizer');
      const env = { CODEX_API_KEY: 'sk-codex-test', HOME: '/home/user' };
      const result = sanitizeEnv(env);
      expect(result).not.toHaveProperty('CODEX_API_KEY');
      expect(result).toHaveProperty('HOME');
    });

    it('sanitizeEnv 保留非认证变量', async () => {
      const { sanitizeEnv } = await import('./env-sanitizer');
      const env = { PATH: '/usr/bin', HOME: '/home/user', EDITOR: 'vim', LANG: 'en_US.UTF-8' };
      const result = sanitizeEnv(env);
      expect(result).toHaveProperty('PATH');
      expect(result).toHaveProperty('HOME');
      expect(result).toHaveProperty('EDITOR');
      expect(result).toHaveProperty('LANG');
    });

    it('sanitizeEnv 返回新对象，不修改原始对象', async () => {
      const { sanitizeEnv } = await import('./env-sanitizer');
      const env = { OPENAI_API_KEY: 'sk-test-123', PATH: '/usr/bin' };
      const original = { ...env };
      sanitizeEnv(env);
      expect(env).toEqual(original);
    });

    it('isCliAuthEnvVar 正确识别认证变量名', async () => {
      const { isCliAuthEnvVar } = await import('./env-sanitizer');
      expect(isCliAuthEnvVar('OPENAI_API_KEY')).toBe(true);
      expect(isCliAuthEnvVar('ANTHROPIC_API_KEY')).toBe(true);
      expect(isCliAuthEnvVar('CODEX_API_KEY')).toBe(true);
      expect(isCliAuthEnvVar('CLAUDE_API_KEY')).toBe(true);
      expect(isCliAuthEnvVar('GEMINI_API_KEY')).toBe(true);
      expect(isCliAuthEnvVar('PATH')).toBe(false);
      expect(isCliAuthEnvVar('HOME')).toBe(false);
      expect(isCliAuthEnvVar('EDITOR')).toBe(false);
    });
  });

  // ─── 第三组：CliExecutor 使用 sanitizeEnv ────────────────────────────────
  describe('CliExecutor env 安全', () => {
    it('cli-executor.ts 导入 sanitizeEnv', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const source = readFileSync(resolve(__dirname, 'cli-executor.ts'), 'utf-8');
      expect(source).toContain("from './env-sanitizer'");
      expect(source).toContain('sanitizeEnv(process.env');
    });
  });
});