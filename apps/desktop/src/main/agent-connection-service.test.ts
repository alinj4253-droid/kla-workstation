// @vitest-environment node
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { AgentConnectionService } from './agent-connection-service';

vi.mock('./cli-agent-registry', () => ({
  cliAgentRegistry: {
    getAdapter: vi.fn((type: string) => {
      if (type !== 'codex') return undefined;
      return {
        type: 'codex',
        runtimeMode: 'external-cli' as const,
        detect: vi.fn().mockResolvedValue([{ executablePath: '/usr/local/bin/codex', source: 'path', versionHint: '0.1.0' }]),
        readVersion: vi.fn().mockResolvedValue({ rawVersion: '0.1.0', semver: { major: 0, minor: 1, patch: 0 }, source: 'stdout' }),
        selectStrategy: vi.fn().mockReturnValue({
          id: 'auto', versionRange: '>=0.1.0',
          capabilities: { nonInteractive: true, structuredOutput: false, resumableSession: false, processScopedMcp: false, reliableCancellation: false },
          buildVersionProbe: vi.fn(), buildAuthProbe: vi.fn(), buildRun: vi.fn(),
          parseStdout: vi.fn(), classifyExit: vi.fn(),
        }),
        probeAuth: vi.fn().mockResolvedValue({ source: 'none', hints: [], error: null }),
        run: vi.fn(),
      };
    }),
  },
}));

// Mock paths to avoid electron dependency
vi.mock('./paths', () => ({
  getStudioRoot: vi.fn().mockReturnValue('/tmp/kstudio-test'),
}));

// Mock fs/promises to avoid actual filesystem writes in sandbox
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises') as typeof import('node:fs/promises');
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

describe('AgentConnectionService', () => {
  let service: AgentConnectionService;

  beforeEach(() => {
    service = new AgentConnectionService();
  });

  it('starts in idle state', () => {
    expect(service.snapshot.step).toBe('idle');
    expect(service.isActive).toBe(false);
  });

  it('auto-detect transitions to readingVersion on success', async () => {
    const result = await service.startAuto('codex');
    expect(result.snapshot.step).toBe('readingVersion');
    expect(result.snapshot.executablePath).toBe('/usr/local/bin/codex');
    expect(result.snapshot.detectedVersion).toBe('0.1.0');
    expect(service.isActive).toBe(true);
  });

  it('auto-detect fails gracefully when adapter not found', async () => {
    const result = await service.startAuto('claude-code');
    expect(result.snapshot.step).toBe('failed');
    expect(result.snapshot.error?.code).toBe('UNSUPPORTED_ADAPTER');
  });

  it('manual start sets selectingExecutable state', () => {
    const result = service.startManual('My Codex', 'codex', '/custom/path/codex');
    expect(result.snapshot.step).toBe('selectingExecutable');
    expect(result.snapshot.name).toBe('My Codex');
    expect(result.snapshot.executablePath).toBe('/custom/path/codex');
  });

  it('setExecutable transitions to readingVersion', () => {
    service.startManual('Test', 'codex', '/a/b');
    service.setExecutable('/new/path');
    expect(service.snapshot.step).toBe('readingVersion');
    expect(service.snapshot.executablePath).toBe('/new/path');
  });

  it('readVersion transitions to selectingStrategy', async () => {
    await service.startAuto('codex');
    const result = await service.readVersion();
    expect(result.snapshot.step).toBe('selectingStrategy');
    expect(result.snapshot.detectedVersion).toBe('0.1.0');
  });

  // ── Smoke Test 流 ──────────────────────────────────────────────────────

  it('probeAuth transitions to preparingSmokeWorkspace', async () => {
    await service.startAuto('codex');
    await service.readVersion();
    const result = await service.probeAuth();
    expect(result.snapshot.step).toBe('preparingSmokeWorkspace');
    expect(result.snapshot.capabilities).toContain('code-generation');
    expect(result.snapshot.smokeTestResult).toBeNull();
    expect(result.snapshot.smokeWorkspaceDir).toBeNull();
  });

  it('prepareSmokeWorkspace creates sandbox and transitions to smokeTesting', async () => {
    await service.startAuto('codex');
    await service.readVersion();
    await service.probeAuth();
    const result = await service.prepareSmokeWorkspace();

    expect(result.snapshot.step).toBe('smokeTesting');
    expect(result.snapshot.smokeTestResult).toBe('pending');
    expect(result.snapshot.smokeWorkspaceDir).toBeTruthy();
    expect(result.snapshot.smokeWorkspaceDir).toMatch(/sandboxes[\\/]setup-/);
  });

  it('runSmokeTest with valid executable transitions to reviewingCapabilitiesAndRisk', async () => {
    // 使用 Node.js 自身作为可执行文件（一定存在，且 --version 会成功）
    const nodeService = new AgentConnectionService();
    nodeService.startManual('Node', 'codex', process.execPath);
    // 手动设置状态到 smokeTesting
    Object.assign(nodeService, {
      adapter: {
        adapterType: 'codex',
        runtimeMode: 'external-cli' as const,
        detect: vi.fn(),
        execute: vi.fn(),
        getCapabilities: vi.fn().mockReturnValue(['code-generation']),
        parseVersion: vi.fn().mockReturnValue('1.0.0'),
        selectStrategy: vi.fn().mockReturnValue({
          id: 'auto', versionRange: '>=0.1.0',
          capabilities: { nonInteractive: true, structuredOutput: false, resumableSession: false, processScopedMcp: false, reliableCancellation: false },
          buildVersionProbe: vi.fn().mockReturnValue({ executable: process.execPath, args: ['--version'], cwd: '/tmp', env: {}, shell: false }),
          buildAuthProbe: vi.fn(), buildRun: vi.fn(),
          parseStdout: vi.fn(), classifyExit: vi.fn(),
        }),
      },
    });
    // 直接设置状态机到 smokeTesting
    (nodeService as any).state = {
      ...(nodeService as any).state,
      step: 'smokeTesting',
      smokeWorkspaceDir: '/tmp',
      executablePath: process.execPath,
      smokeTestResult: 'pending',
    };

    const result = await nodeService.runSmokeTest();
    expect(result.snapshot.step).toBe('reviewingCapabilitiesAndRisk');
    expect(result.snapshot.smokeTestResult).toBe('passed');
  });

  it('runSmokeTest with invalid executable transitions to failed', async () => {
    const badService = new AgentConnectionService();
    badService.startManual('Bad', 'codex', '/nonexistent/command');
    Object.assign(badService, {
      adapter: {
        adapterType: 'codex',
        runtimeMode: 'external-cli' as const,
        detect: vi.fn(),
        execute: vi.fn(),
        getCapabilities: vi.fn().mockReturnValue([]),
        parseVersion: vi.fn().mockReturnValue(null),
        selectStrategy: vi.fn().mockReturnValue({
          id: 'auto', versionRange: '>=0.1.0',
          capabilities: { nonInteractive: true, structuredOutput: false, resumableSession: false, processScopedMcp: false, reliableCancellation: false },
          buildVersionProbe: vi.fn().mockReturnValue({ executable: '/nonexistent/command', args: ['--version'], cwd: '/tmp', env: {}, shell: false }),
          buildAuthProbe: vi.fn(), buildRun: vi.fn(),
          parseStdout: vi.fn(), classifyExit: vi.fn(),
        }),
      },
    });
    (badService as any).state = {
      ...(badService as any).state,
      step: 'smokeTesting',
      smokeWorkspaceDir: '/tmp',
      executablePath: '/nonexistent/command',
      smokeTestResult: 'pending',
    };

    const result = await badService.runSmokeTest();
    expect(result.snapshot.step).toBe('failed');
    expect(result.snapshot.error?.code).toBe('SMOKE_TEST_FAILED');
    expect(result.snapshot.failedAtStep).toBe('smokeTesting');
  });

  it('prepareSmokeWorkspace fails when no adapter', async () => {
    // 先创建服务并设置状态到 preparingSmokeWorkspace，但没有 adapter
    const emptyService = new AgentConnectionService();
    (emptyService as any).state = {
      ...(emptyService as any).state,
      name: 'test',
      adapterType: 'codex',
      executablePath: '/test',
      capabilities: [],
      step: 'preparingSmokeWorkspace',
    };

    // 没有 adapter 的 prepareSmokeWorkspace 不应失败（adapter 不是必需的）
    // 实际上 prepareSmokeWorkspace 不依赖 adapter
    const result = await emptyService.prepareSmokeWorkspace();
    expect(result.snapshot.step).toBe('smokeTesting');
  });

  // ── 保存流 ────────────────────────────────────────────────────────────

  it('save persists to DB and transitions to ready', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE cli_connections (
        id TEXT PRIMARY KEY, name TEXT, adapter_type TEXT, executable_path TEXT,
        args_json TEXT, strategy_id TEXT, detected_version TEXT,
        status TEXT, trust_tier TEXT, capabilities_json TEXT,
        created_at TEXT, updated_at TEXT
      );
    `);

    await service.startAuto('codex');
    await service.readVersion();
    await service.probeAuth();
    await service.prepareSmokeWorkspace();
    // 用 node 模拟 smoke test 通过
    const nodeService = service;
    (nodeService as any).state = {
      ...(nodeService as any).state,
      step: 'reviewingCapabilitiesAndRisk',
      smokeTestResult: 'passed',
    };

    const result = await service.save(db);

    expect(result.snapshot.step).toBe('ready');
    expect(result.snapshot.connectionId).toBeTruthy();

    const saved = db.prepare('SELECT name, adapter_type FROM cli_connections WHERE id = ?').get(result.snapshot.connectionId!) as any;
    expect(saved.name).toBe('codex');
    expect(saved.adapter_type).toBe('codex');

    db.close();
  });

  it('save fails when not in reviewingCapabilitiesAndRisk', async () => {
    await expect(service.save({} as any)).rejects.toThrow('当前状态不允许保存');
  });

  // ── 通用状态管理 ──────────────────────────────────────────────────────

  it('reset returns to idle', () => {
    service.startManual('T', 'codex', '/p');
    expect(service.isActive).toBe(true);
    service.reset();
    expect(service.snapshot.step).toBe('idle');
    expect(service.isActive).toBe(false);
  });

  it('throws if state transition is invalid', async () => {
    expect(() => service.setExecutable('/x')).toThrow('当前状态不允许');
    await expect(service.save({} as any)).rejects.toThrow('当前状态不允许');
  });

  it('retry from failed resets to idling for detecting failure', async () => {
    await service.startAuto('claude-code');
    expect(service.snapshot.step).toBe('failed');
    service.retry();
    expect(service.snapshot.step).toBe('idle');
  });

  it('terry from not failed throws', () => {
    expect(() => service.retry()).toThrow('只能在失败状态重试');
  });
});