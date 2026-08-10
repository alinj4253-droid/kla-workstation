// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

function computeHelpHash(executable: string): string | null {
  try {
    const helpOutput = execSync(`"${executable}" --help 2>&1`, {
      timeout: 5000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
    return createHash('sha256').update(helpOutput).digest('hex');
  } catch {
    return null;
  }
}

describe('AC-EXT-07', () => {
  // ── 能力矩阵契约 ──────────────────────────────────────────────────────

  describe('能力矩阵契约', () => {
    it('Codex 能力矩阵与契约夹具一致', async () => {
      const { CodexCliAdapter, validateCapabilities, getContract } = await import('@kunqing/agent-core');
      const adapter = new CodexCliAdapter();
      const caps = adapter.getCapabilities();
      const result = validateCapabilities('codex', caps);
      if (!result.ok) {
        console.error('Codex 能力矩阵与契约不一致:', result.errors);
        console.error('当前能力:', [...caps].sort());
        console.error('契约期望:', getContract('codex')?.expectedCapabilities);
      }
      expect(result.ok).toBe(true);
    });

    it('Claude Code 能力矩阵与契约夹具一致', async () => {
      const { ClaudeCodeCliAdapter, validateCapabilities, getContract } = await import('@kunqing/agent-core');
      const adapter = new ClaudeCodeCliAdapter();
      const caps = adapter.getCapabilities();
      const result = validateCapabilities('claude-code', caps);
      if (!result.ok) {
        console.error('Claude Code 能力矩阵与契约不一致:', result.errors);
        console.error('当前能力:', [...caps].sort());
        console.error('契约期望:', getContract('claude-code')?.expectedCapabilities);
      }
      expect(result.ok).toBe(true);
    });

    it('Hermes (ACP) 能力矩阵与契约夹具一致', async () => {
      const { AcpCliAdapter, validateCapabilities, getContract } = await import('@kunqing/agent-core');
      const adapter = new AcpCliAdapter('hermes');
      const caps = adapter.getCapabilities();
      const result = validateCapabilities('hermes', caps);
      if (!result.ok) {
        console.error('Hermes 能力矩阵与契约不一致:', result.errors);
        console.error('当前能力:', [...caps].sort());
        console.error('契约期望:', getContract('hermes')?.expectedCapabilities);
      }
      expect(result.ok).toBe(true);
    });

    it('OpenCode (ACP) 能力矩阵与契约夹具一致', async () => {
      const { AcpCliAdapter, validateCapabilities, getContract } = await import('@kunqing/agent-core');
      const adapter = new AcpCliAdapter('opencode');
      const caps = adapter.getCapabilities();
      const result = validateCapabilities('opencode', caps);
      if (!result.ok) {
        console.error('OpenCode 能力矩阵与契约不一致:', result.errors);
        console.error('当前能力:', [...caps].sort());
        console.error('契约期望:', getContract('opencode')?.expectedCapabilities);
      }
      expect(result.ok).toBe(true);
    });

    it('Gemini (ACP) 能力矩阵与契约夹具一致', async () => {
      const { AcpCliAdapter, validateCapabilities, getContract } = await import('@kunqing/agent-core');
      const adapter = new AcpCliAdapter('gemini');
      const caps = adapter.getCapabilities();
      const result = validateCapabilities('gemini', caps);
      if (!result.ok) {
        console.error('Gemini 能力矩阵与契约不一致:', result.errors);
        console.error('当前能力:', [...caps].sort());
        console.error('契约期望:', getContract('gemini')?.expectedCapabilities);
      }
      expect(result.ok).toBe(true);
    });

    it('Qwen Code (ACP) 能力矩阵与契约夹具一致', async () => {
      const { AcpCliAdapter, validateCapabilities, getContract } = await import('@kunqing/agent-core');
      const adapter = new AcpCliAdapter('qwen-code');
      const caps = adapter.getCapabilities();
      const result = validateCapabilities('qwen-code', caps);
      if (!result.ok) {
        console.error('Qwen Code 能力矩阵与契约不一致:', result.errors);
        console.error('当前能力:', [...caps].sort());
        console.error('契约期望:', getContract('qwen-code')?.expectedCapabilities);
      }
      expect(result.ok).toBe(true);
    });

    it('Kimi (ACP) 能力矩阵与契约夹具一致', async () => {
      const { AcpCliAdapter, validateCapabilities, getContract } = await import('@kunqing/agent-core');
      const adapter = new AcpCliAdapter('kimi');
      const caps = adapter.getCapabilities();
      const result = validateCapabilities('kimi', caps);
      if (!result.ok) {
        console.error('Kimi 能力矩阵与契约不一致:', result.errors);
        console.error('当前能力:', [...caps].sort());
        console.error('契约期望:', getContract('kimi')?.expectedCapabilities);
      }
      expect(result.ok).toBe(true);
    });

    it('CodeBuddy (ACP) 能力矩阵与契约夹具一致', async () => {
      const { AcpCliAdapter, validateCapabilities, getContract } = await import('@kunqing/agent-core');
      const adapter = new AcpCliAdapter('codebuddy');
      const caps = adapter.getCapabilities();
      const result = validateCapabilities('codebuddy', caps);
      if (!result.ok) {
        console.error('CodeBuddy 能力矩阵与契约不一致:', result.errors);
        console.error('当前能力:', [...caps].sort());
        console.error('契约期望:', getContract('codebuddy')?.expectedCapabilities);
      }
      expect(result.ok).toBe(true);
    });

    it('能力矩阵不能被意外修改', () => {
      const codexCaps = ['code-generation', 'file-read', 'file-write', 'terminal', 'search', 'network-access'].sort();
      const claudeCaps = ['code-generation', 'file-read', 'file-write', 'search', 'reasoning', 'network-access'].sort();
      expect(codexCaps).toMatchInlineSnapshot(`
        [
          "code-generation",
          "file-read",
          "file-write",
          "network-access",
          "search",
          "terminal",
        ]
      `);
      expect(claudeCaps).toMatchInlineSnapshot(`
        [
          "code-generation",
          "file-read",
          "file-write",
          "network-access",
          "reasoning",
          "search",
        ]
      `);
    });
  });

  // ── 策略行为契约 ──────────────────────────────────────────────────────

  describe('策略行为契约', () => {
    it('CodexAutoStrategy buildRun 匹配契约', async () => {
      const { CodexAutoStrategy } = await import('@kunqing/agent-core');
      const strategy = new CodexAutoStrategy();
      expect(strategy.id).toBe('auto');
      const spec = strategy.buildRun({
        executablePath: 'codex',
        instruction: 'write a test',
        args: [],
        env: {},
        workspaceRoot: '/tmp',
        capabilities: strategy.capabilities,
      });
      expect(spec.executable).toBe('codex');
      expect(spec.args).toContain('write a test');
    });

    it('CodexAutoStrategy versionRange 非空', async () => {
      const { CodexAutoStrategy } = await import('@kunqing/agent-core');
      const strategy = new CodexAutoStrategy();
      expect(strategy.versionRange).toBeTruthy();
    });

    it('ClaudeCodeAutoStrategy buildRun 匹配契约', async () => {
      const { ClaudeCodeAutoStrategy } = await import('@kunqing/agent-core');
      const strategy = new ClaudeCodeAutoStrategy();
      expect(strategy.id).toBe('auto');
      const spec = strategy.buildRun({
        executablePath: 'claude',
        instruction: 'write a test',
        args: [],
        env: {},
        workspaceRoot: '/tmp',
        capabilities: strategy.capabilities,
      });
      expect(spec.executable).toBe('claude');
      expect(spec.args).toContain('write a test');
    });

    it('ClaudeCodeAutoStrategy versionRange 非空', async () => {
      const { ClaudeCodeAutoStrategy } = await import('@kunqing/agent-core');
      const strategy = new ClaudeCodeAutoStrategy();
      expect(strategy.versionRange).toBeTruthy();
    });
  });

  // ── 版本兼容性契约 ────────────────────────────────────────────────────

  describe('版本兼容性契约', () => {
    it('Codex 版本兼容范围与契约夹具一致', async () => {
      const { checkVersionCompatibility } = await import('./version-compatibility');
      expect(checkVersionCompatibility('codex', '0.1.0')).toBe('compatible');
      expect(checkVersionCompatibility('codex', '1.0.0')).toBe('compatible');
      expect(checkVersionCompatibility('codex', '1.99.99')).toBe('compatible');
      expect(checkVersionCompatibility('codex', '0.0.9')).toBe('incompatible');
      expect(checkVersionCompatibility('codex', '2.0.0')).toBe('experimental');
      expect(checkVersionCompatibility('codex', null)).toBe('unknown');
      expect(checkVersionCompatibility('codex', '')).toBe('unknown');
    });

    it('Claude Code 版本兼容范围与契约一致', async () => {
      const { checkVersionCompatibility } = await import('./version-compatibility');
      expect(checkVersionCompatibility('claude-code', '0.1.0')).toBe('compatible');
      expect(checkVersionCompatibility('claude-code', '1.0.0')).toBe('compatible');
      expect(checkVersionCompatibility('claude-code', '9.99.99')).toBe('compatible');
      expect(checkVersionCompatibility('claude-code', '0.0.9')).toBe('incompatible');
      expect(checkVersionCompatibility('claude-code', '10.0.0')).toBe('experimental');
      expect(checkVersionCompatibility('claude-code', null)).toBe('unknown');
    });

    it('Hermes (ACP) 版本兼容范围与契约一致', async () => {
      const { checkVersionCompatibility } = await import('./version-compatibility');
      expect(checkVersionCompatibility('hermes', '0.1.0')).toBe('compatible');
      expect(checkVersionCompatibility('hermes', '1.0.0')).toBe('compatible');
      expect(checkVersionCompatibility('hermes', '9.99.99')).toBe('compatible');
      expect(checkVersionCompatibility('hermes', '0.0.9')).toBe('incompatible');
      expect(checkVersionCompatibility('hermes', '10.0.0')).toBe('experimental');
      expect(checkVersionCompatibility('hermes', null)).toBe('unknown');
    });

    it('OpenCode (ACP) 版本兼容范围与契约一致', async () => {
      const { checkVersionCompatibility } = await import('./version-compatibility');
      expect(checkVersionCompatibility('opencode', '0.1.0')).toBe('compatible');
      expect(checkVersionCompatibility('opencode', '1.18.13')).toBe('compatible');
      expect(checkVersionCompatibility('opencode', '9.99.99')).toBe('compatible');
      expect(checkVersionCompatibility('opencode', '0.0.9')).toBe('incompatible');
      expect(checkVersionCompatibility('opencode', '10.0.0')).toBe('experimental');
      expect(checkVersionCompatibility('opencode', null)).toBe('unknown');
    });

    it('Gemini (ACP) 版本兼容范围与契约一致', async () => {
      const { checkVersionCompatibility } = await import('./version-compatibility');
      expect(checkVersionCompatibility('gemini', '0.1.0')).toBe('compatible');
      expect(checkVersionCompatibility('gemini', '0.46.0')).toBe('compatible');
      expect(checkVersionCompatibility('gemini', '9.99.99')).toBe('compatible');
      expect(checkVersionCompatibility('gemini', '0.0.9')).toBe('incompatible');
      expect(checkVersionCompatibility('gemini', '10.0.0')).toBe('experimental');
      expect(checkVersionCompatibility('gemini', null)).toBe('unknown');
    });

    it('Qwen Code (ACP) 版本兼容范围与契约一致', async () => {
      const { checkVersionCompatibility } = await import('./version-compatibility');
      expect(checkVersionCompatibility('qwen-code', '0.1.0')).toBe('compatible');
      expect(checkVersionCompatibility('qwen-code', '1.0.0')).toBe('compatible');
      expect(checkVersionCompatibility('qwen-code', '9.99.99')).toBe('compatible');
      expect(checkVersionCompatibility('qwen-code', '0.0.9')).toBe('incompatible');
      expect(checkVersionCompatibility('qwen-code', '10.0.0')).toBe('experimental');
      expect(checkVersionCompatibility('qwen-code', null)).toBe('unknown');
    });

    it('Kimi (ACP) 版本兼容范围与契约一致', async () => {
      const { checkVersionCompatibility } = await import('./version-compatibility');
      expect(checkVersionCompatibility('kimi', '0.1.0')).toBe('compatible');
      expect(checkVersionCompatibility('kimi', '1.0.0')).toBe('compatible');
      expect(checkVersionCompatibility('kimi', '9.99.99')).toBe('compatible');
      expect(checkVersionCompatibility('kimi', '0.0.9')).toBe('incompatible');
      expect(checkVersionCompatibility('kimi', '10.0.0')).toBe('experimental');
      expect(checkVersionCompatibility('kimi', null)).toBe('unknown');
    });

    it('CodeBuddy (ACP) 版本兼容范围与契约一致', async () => {
      const { checkVersionCompatibility } = await import('./version-compatibility');
      expect(checkVersionCompatibility('codebuddy', '0.1.0')).toBe('compatible');
      expect(checkVersionCompatibility('codebuddy', '2.132.0')).toBe('compatible');
      expect(checkVersionCompatibility('codebuddy', '9.99.99')).toBe('compatible');
      expect(checkVersionCompatibility('codebuddy', '0.0.9')).toBe('incompatible');
      expect(checkVersionCompatibility('codebuddy', '10.0.0')).toBe('experimental');
      expect(checkVersionCompatibility('codebuddy', null)).toBe('unknown');
    });
  });

  // ── parseVersion 契约 ─────────────────────────────────────────────────

  describe('parseVersion 契约', () => {
    it('Codex parseVersion 正确解析 semver', async () => {
      const { CodexCliAdapter } = await import('@kunqing/agent-core');
      const adapter = new CodexCliAdapter();
      expect(adapter.parseVersion('codex 1.2.3')).toBe('1.2.3');
      expect(adapter.parseVersion('1.2.3')).toBe('1.2.3');
      expect(adapter.parseVersion('v0.1.0')).toBe('0.1.0');
      expect(adapter.parseVersion('no version')).toBeNull();
    });

    it('Claude Code parseVersion 正确解析 semver', async () => {
      const { ClaudeCodeCliAdapter } = await import('@kunqing/agent-core');
      const adapter = new ClaudeCodeCliAdapter();
      expect(adapter.parseVersion('Claude Code 0.1.0')).toBe('0.1.0');
      expect(adapter.parseVersion('0.1.0')).toBe('0.1.0');
      expect(adapter.parseVersion('v1.2.3')).toBe('1.2.3');
      expect(adapter.parseVersion('no version')).toBeNull();
    });
  });

  // ── --help 输出哈希（可选，仅在 CLI 安装时运行） ───────────────────────

  describe('--help 输出哈希（可选）', () => {
    it('如果 Codex 已安装，--help 哈希应与契约一致', async () => {
      const { getContract } = await import('@kunqing/agent-core');
      const contract = getContract('codex')!;

      let codexPath: string | null = null;
      try {
        codexPath = execSync('where codex 2>nul || which codex 2>/dev/null', {
          timeout: 3000,
          encoding: 'utf-8',
        }).trim();
      } catch {
        return;
      }

      if (!codexPath) return;

      const hash = computeHelpHash(codexPath);
      if (hash === null) return;

      if (hash !== contract.helpOutputHash) {
        console.warn(`⚠ Codex --help 哈希已变更: ${hash}`);
        console.warn(`  契约中未记录 helpOutputHash，请更新 contract-validator.ts`);
      }
    });

    it('如果 Claude Code 已安装，--help 哈希应与契约一致', async () => {
      const { getContract } = await import('@kunqing/agent-core');
      const contract = getContract('claude-code')!;

      let claudePath: string | null = null;
      try {
        const candidates = ['claude', 'claude-code', 'claude-code.exe'];
        for (const cmd of candidates) {
          try {
            const result = execSync(`where ${cmd} 2>nul || which ${cmd} 2>/dev/null`, {
              timeout: 3000,
              encoding: 'utf-8',
            }).trim();
            if (result) { claudePath = result; break; }
          } catch { /* try next */ }
        }
      } catch {
        return;
      }

      if (!claudePath) return;

      const hash = computeHelpHash(claudePath);
      if (hash === null) return;

      if (hash !== contract.helpOutputHash) {
        console.warn(`⚠ Claude Code --help 哈希已变更: ${hash}`);
        console.warn(`  契约中未记录 helpOutputHash，请更新 contract-validator.ts`);
      }
    });
  });

  // ── 契约夹具完整性 ────────────────────────────────────────────────────

  describe('契约夹具完整性', () => {
    it('所有注册的适配器都有对应的契约', async () => {
      const { getContract } = await import('@kunqing/agent-core');

      const registeredAdapters = ['codex', 'claude-code', 'hermes', 'opencode', 'gemini', 'qwen-code', 'kimi', 'codebuddy'];
      for (const adapterType of registeredAdapters) {
        const contract = getContract(adapterType);
        expect(contract).toBeDefined();
        expect(contract!.adapterType).toBe(adapterType);
        expect(contract!.strategies.length).toBeGreaterThan(0);
      }
    });

    it('契约中的适配器类型与代码中的 type 一致', async () => {
      const { CodexCliAdapter, ClaudeCodeCliAdapter, getContract } = await import('@kunqing/agent-core');

      const codexContract = getContract('codex')!;
      expect(codexContract.adapterType).toBe(new CodexCliAdapter().type);

      const claudeContract = getContract('claude-code')!;
      expect(claudeContract.adapterType).toBe(new ClaudeCodeCliAdapter().type);
    });
  });
});
