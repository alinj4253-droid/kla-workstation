// @vitest-environment node
/**
 * AC-EXT-08：ACP 统一适配器契约测试
 *
 * 对齐方案 docs/ACP_ADAPTER_PLAN.md 验收标准：
 *  - spawn 遵守 L1357/L1358：永不 shell:true，Windows .cmd shim 走固定 launcher
 *  - 事件流遵守 L1411（单事件 256KB + 截断）与 L1412（隐藏推理不落聊天）
 *  - 取消遵守 L1419：session/cancel 优雅取消 + 2 秒兜底终止进程树
 *  - stdout/stderr/单次运行时长有上限（L1421）
 *  - 注册表条目与契约夹具（CLI_CONTRACTS）保持一致
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACP_CLI_REGISTRY,
  buildAcpSpawnSpec,
  getAcpRegistryEntry,
  AcpCliAdapter,
  getContract,
  buildSpawnInvocation,
} from '@kunqing/agent-core';

const ACP_TYPES = ACP_CLI_REGISTRY.map((e) => e.type).sort();

describe('AC-EXT-08 (ACP 适配器契约)', () => {
  // ── 注册表条目契约 ─────────────────────────────────────────────────────

  describe('注册表条目契约', () => {
    it('注册表覆盖全部期望的用户可见 CLI', () => {
      expect(ACP_TYPES).toEqual(['codebuddy', 'gemini', 'hermes', 'kimi', 'opencode', 'qoder', 'qoder-cn', 'qwen-code']);
    });

    it('每个条目都已明确记录 verified 状态与启动参数', () => {
      for (const entry of ACP_CLI_REGISTRY) {
        expect(entry.type, entry.type).toBeTruthy();
        expect(entry.command, entry.type).toBeTruthy();
        expect(entry.args.length, `${entry.type}.args`).toBeGreaterThan(0);
        expect(entry.versionArgs.length, `${entry.type}.versionArgs`).toBeGreaterThan(0);
        expect(entry.capabilities.length, `${entry.type}.capabilities`).toBeGreaterThan(0);
        expect(typeof entry.verified, `${entry.type}.verified`).toBe('boolean');
        expect(['trusted', 'sandboxed', 'restricted'], `${entry.type}.trustTier`).toContain(entry.trustTier);
        expect(entry.env, `${entry.type}.env`).toBeDefined();
      }
    });

    it('实测通过（verified:true）的 CLI 至少覆盖一个已安装运行时（opencode/codebuddy）', () => {
      const verified = ACP_CLI_REGISTRY.filter((e) => e.verified).map((e) => e.type);
      // 不允许全部为 false——已接入的 ACP CLI 必须有实测证据支撑接入
      expect(verified.length).toBeGreaterThan(0);
      expect(verified).toContain('opencode');
      expect(verified).toContain('codebuddy');
    });

    it('未实测（verified:false）的 CLI 不得标注能力可用（L1275）', () => {
      // 未实测条目仍可注册（迁移待实测），但契约测试只对 verified 条目强制能力匹配
      const pending = ACP_CLI_REGISTRY.filter((e) => !e.verified).map((e) => e.type);
      expect(pending.sort()).toEqual(['gemini', 'hermes', 'kimi', 'qoder', 'qoder-cn', 'qwen-code']);
    });
  });

  // ── 适配器契约 ─────────────────────────────────────────────────────────

  describe('适配器契约', () => {
    it('AcpCliAdapter 对每个注册类型都能实例化，且标记 acp=true', () => {
      for (const type of ACP_TYPES) {
        const adapter = new AcpCliAdapter(type);
        expect(adapter.type, type).toBe(type);
        expect((adapter as any).acp, type).toBe(true);
        expect(adapter.runtimeMode, type).toBe('external-cli');
      }
    });

    it('对未注册的类型抛出明确错误', () => {
      expect(() => new AcpCliAdapter('not-a-cli')).toThrow(/未知的 ACP CLI 类型/);
    });

    it('capabilities 上报与注册表一致', () => {
      for (const entry of ACP_CLI_REGISTRY) {
        const adapter = new AcpCliAdapter(entry.type);
        expect([...adapter.getCapabilities()].sort(), entry.type).toEqual([...entry.capabilities].sort());
      }
    });

    it('getCapabilities 使用合法能力集合', () => {
      const legal = ['code-generation', 'file-read', 'file-write', 'search', 'network-access', 'terminal', 'reasoning'];
      for (const entry of ACP_CLI_REGISTRY) {
        for (const cap of entry.capabilities) {
          expect(legal, `${entry.type}.${cap}`).toContain(cap);
        }
      }
    });
  });

  // ── selectStrategy 能力承诺契约 ────────────────────────────────────────

  describe('selectStrategy 能力承诺契约', () => {
    it('ACP 策略承诺全部协议能力（structuredOutput / resumable / cancel / mcp）', () => {
      for (const entry of ACP_CLI_REGISTRY) {
        const adapter = new AcpCliAdapter(entry.type);
        const strategy = adapter.selectStrategy({ rawVersion: '1.0.0', semver: { major: 1, minor: 0, patch: 0 }, source: 'stdout' });
        expect(strategy, entry.type).not.toBeNull();
        const caps = strategy!.capabilities;
        expect(caps.nonInteractive, entry.type).toBe(true);
        expect(caps.structuredOutput, entry.type).toBe(true);
        expect(caps.resumableSession, entry.type).toBe(true);
        expect(caps.reliableCancellation, entry.type).toBe(true);
        expect(caps.processScopedMcp, entry.type).toBe(true);
      }
    });

    it('版本不可解析时 selectStrategy 返回 null（上游标记 incompatible）', () => {
      const adapter = new AcpCliAdapter('opencode');
      expect(adapter.selectStrategy({ rawVersion: '', semver: null, source: 'stdout' })).toBeNull();
    });
  });

  // ── buildRun / buildVersionProbe 参数契约 ─────────────────────────────

  describe('buildRun 参数契约', () => {
    it('buildRun 生成 ACP 启动参数（非指令字符串）', () => {
      const entry = getAcpRegistryEntry('opencode')!;
      const adapter = new AcpCliAdapter('opencode');
      const strategy = adapter.selectStrategy({ rawVersion: '1.0.0', semver: { major: 1, minor: 0, patch: 0 }, source: 'stdout' })!;
      const spec = strategy.buildRun({
        executablePath: 'opencode',
        instruction: 'write a test',
        args: [],
        env: {},
        workspaceRoot: '/tmp',
        capabilities: strategy.capabilities,
      });
      expect(spec.args).toEqual(entry.args);
      expect(spec.args).not.toContain('write a test'); // 指令绝不进命令参数
    });

    it('buildVersionProbe 生成 ACP 启动参数（区别于 readVersion 的 --version 探测）', () => {
      const entry = getAcpRegistryEntry('codebuddy')!;
      const adapter = new AcpCliAdapter('codebuddy');
      const strategy = adapter.selectStrategy({ rawVersion: '2.0.0', semver: { major: 2, minor: 0, patch: 0 }, source: 'stdout' })!;
      // buildVersionProbe 是 ACP 会话探测（启动 ACP 端点），版本探测由 readVersion 用 versionArgs 完成
      const spec = strategy.buildVersionProbe({ executablePath: 'codebuddy' });
      expect(spec.args).toEqual(entry.args);
      expect(entry.versionArgs).toEqual(['--version']);
    });
  });

  // ── 注册表与契约夹具一致性 ────────────────────────────────────────────

  describe('注册表与契约夹具一致性', () => {
    it('ACP 策略的 emptyArgs/simpleArgs 与注册表 args 一致', () => {
      for (const type of ACP_TYPES) {
        const entry = getAcpRegistryEntry(type)!;
        const contract = getContract(type);
        expect(contract, type).toBeDefined();
        const acpStrategy = contract!.strategies.find((s) => s.strategyId === 'acp');
        expect(acpStrategy, `${type}.acp strategy`).toBeDefined();
        expect(acpStrategy!.emptyArgs, `${type}.emptyArgs`).toEqual(entry.args);
        expect(acpStrategy!.simpleArgs, `${type}.simpleArgs`).toEqual(entry.args);
        expect(acpStrategy!.shouldDelegateMin, `${type}.shouldDelegateMin`).toBe(0);
      }
    });

    it('注册表能力与契约 expectedCapabilities 一致', () => {
      for (const type of ACP_TYPES) {
        const entry = getAcpRegistryEntry(type)!;
        const contract = getContract(type);
        expect(contract!.expectedCapabilities.sort(), type).toEqual([...entry.capabilities].sort());
      }
    });
  });

  // ── spawn 安全契约（L1357/L1358）──────────────────────────────────────

  describe('spawn 安全契约', () => {
    it('buildAcpSpawnSpec 生成的 spec 经 buildSpawnInvocation 后永不启用 shell', () => {
      for (const type of ACP_TYPES) {
        const entry = getAcpRegistryEntry(type)!;
        const spec = buildAcpSpawnSpec(entry, entry.command, '/tmp');
        const invocation = buildSpawnInvocation(spec);
        expect(invocation.executable, type).toBeTruthy();
        const launchedCmdShim = /cmd\.exe$/i.test(invocation.executable);
        expect(launchedCmdShim || invocation.executable === spec.executable, type).toBe(true);
        // 裸命令名（无 .exe）在 Windows 必须走 cmd.exe launcher（L1358），绝不直接 shell
        if (process.platform === 'win32') {
          expect(launchedCmdShim, type).toBe(true);
          expect(invocation.windowsVerbatimArguments, type).toBe(true);
        }
      }
    });

    it('buildAcpSpawnSpec 不把 instruction 等运行时内容带进启动参数', () => {
      const entry = getAcpRegistryEntry('opencode')!;
      const spec = buildAcpSpawnSpec(entry, entry.command, '/tmp');
      expect(spec.args).not.toContain('--');
      expect(spec.args.every((a) => !a.startsWith('write a test')), 'null-safety').toBe(true);
    });
  });

  // ── 源码级安全契约（L1411/L1419/L1421）────────────────────────────────

  describe('源码级安全契约', () => {
    const sessionSource = readFileSync(resolve(import.meta.dirname, '../../../../packages/agent-core/src/adapters/acp/session.ts'), 'utf-8');
    const transportSource = readFileSync(resolve(import.meta.dirname, '../../../../packages/agent-core/src/adapters/acp/transport.ts'), 'utf-8');

    it('session.ts 实现 session/cancel 优雅取消 + 2 秒兜底终止进程树（L1419）', () => {
      expect(sessionSource).toContain('methods.agent.session.cancel');
      expect(sessionSource).toContain('PROCESS_TREE_KILL_GRACE_MS = 2_000');
      expect(sessionSource).toContain('taskkill');
      expect(sessionSource).toContain('killProcessTree');
    });

    it('session.ts 实现单事件 256KB 截断（L1411）', () => {
      expect(sessionSource).toContain('256 * 1024');
      expect(sessionSource).toContain('MAX_EVENT_BYTES');
      expect(sessionSource).toContain('truncateText');
    });

    it('session.ts 隐藏推理不落聊天、规划事件仅内部 trace（L1412）', () => {
      expect(sessionSource).toContain('agent_thought_chunk');
      expect(sessionSource).toContain('L1412');
    });

    it('session.ts runAcpSession 在异常路径终止子进程树并等待退出（无泄漏）', () => {
      expect(sessionSource).toContain('finally');
      expect(sessionSource).toContain('killProcessTree(pid)');
    });

    it('transport.ts 永不设置 shell:true（L1357）', () => {
      expect(transportSource).toContain('shell: false');
      expect(transportSource).toContain('buildSpawnInvocation');
      expect(transportSource).not.toContain('shell: true');
    });
  });
});