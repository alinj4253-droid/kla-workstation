import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { cliAgentRegistry } from './cli-agent-registry';
import { checkVersionCompatibility } from './version-compatibility';
import { getStudioRoot } from './paths';
import type {
  ExternalAgentAdapter, DetectedExecutable, VersionEvidence,
  CliConnectionSnapshot, AuthProbeResult, AdapterCapability,
} from '@kunqing/agent-core';

export type WizardStep =
  | 'idle'
  | 'selectingExecutable'
  | 'readingVersion'
  | 'selectingStrategy'
  | 'probingAuth'
  | 'preparingSmokeWorkspace'
  | 'smokeTesting'
  | 'reviewingCapabilitiesAndRisk'
  | 'saving'
  | 'ready'
  | 'failed';

export interface WizardSnapshot {
  step: WizardStep;
  name: string;
  adapterType: string;
  executablePath: string;
  detectedVersion: string | null;
  strategyId: string;
  capabilities: AdapterCapability[];
  authMethod: string;
  authRequired: boolean;
  trustTier: 'trusted' | 'sandboxed' | 'restricted';
  connectionId: string | null;
  smokeWorkspaceDir: string | null;
  smokeTestResult: 'pending' | 'passed' | 'failed' | null;
  error?: { code: string; message: string; retryable: boolean };
  failedAtStep?: string;
}

function createSnapshot(partial: Partial<WizardSnapshot>): WizardSnapshot {
  return {
    step: 'idle', name: '', adapterType: '', executablePath: '',
    detectedVersion: null, strategyId: 'auto', capabilities: [],
    authMethod: 'none', authRequired: false, trustTier: 'trusted',
    connectionId: null, smokeWorkspaceDir: null, smokeTestResult: null,
    ...partial,
  };
}

export class AgentConnectionService {
  private state: WizardSnapshot = createSnapshot({});
  private adapter: ExternalAgentAdapter | null = null;

  get snapshot(): Readonly<WizardSnapshot> { return this.state; }
  get isActive(): boolean {
    return this.state.step !== 'idle' && this.state.step !== 'ready' && this.state.step !== 'failed';
  }

  reset(): void { this.state = createSnapshot({}); this.adapter = null; }

  startManual(name: string, adapterType: string, executablePath: string): { snapshot: WizardSnapshot } {
    if (this.isActive) throw new Error('向导已在运行中');
    const adapter = cliAgentRegistry.getAdapter(adapterType);
    if (!adapter) throw new Error(`不支持的适配器类型: ${adapterType}`);
    this.adapter = adapter;
    this.state = createSnapshot({ step: 'selectingExecutable', name, adapterType, executablePath });
    return { snapshot: this.state };
  }

  async startAuto(adapterType: string): Promise<{ snapshot: WizardSnapshot; detection?: DetectedExecutable[] }> {
    if (this.isActive) throw new Error('向导已在运行中');
    const adapter = cliAgentRegistry.getAdapter(adapterType);
    if (!adapter) {
      this.state = createSnapshot({ step: 'failed', name: adapterType, adapterType, error: { code: 'UNSUPPORTED_ADAPTER', message: `不支持的适配器类型: ${adapterType}`, retryable: false }, failedAtStep: 'selectingExecutable' });
      return { snapshot: this.state };
    }
    this.adapter = adapter;
    const controller = new AbortController();
    const executables = await adapter.detect({}, controller.signal);
    if (executables.length === 0) {
      this.state = createSnapshot({ step: 'failed', name: adapterType, adapterType, error: { code: 'NOT_FOUND', message: `未在 PATH 中找到 ${adapterType}`, retryable: true }, failedAtStep: 'selectingExecutable' });
      return { snapshot: this.state, detection: executables };
    }
    const exe = executables[0]!;
    this.state = createSnapshot({ step: 'readingVersion', name: adapterType, adapterType, executablePath: exe.executablePath, detectedVersion: exe.versionHint });
    return { snapshot: this.state, detection: executables };
  }

  async readVersion(): Promise<{ snapshot: WizardSnapshot; compatibility?: ReturnType<typeof checkVersionCompatibility> }> {
    if (this.state.step !== 'readingVersion' || !this.adapter) {
      throw new Error(`当前状态不允许读取版本: ${this.state.step}`);
    }
    try {
      const controller = new AbortController();
      const evidence = await this.adapter.readVersion({ executablePath: this.state.executablePath }, controller.signal);
      const parsedVersion = evidence.semver ? `${evidence.semver.major}.${evidence.semver.minor}.${evidence.semver.patch}` : null;
      const compatibility = checkVersionCompatibility(this.state.adapterType, parsedVersion);
      if (compatibility === 'incompatible') {
        this.state = { ...this.state, step: 'failed', detectedVersion: parsedVersion, error: { code: 'VERSION_INCOMPATIBLE', message: `版本 ${parsedVersion} 低于最低支持版本，请升级 CLI`, retryable: false }, failedAtStep: 'readingVersion' };
        return { snapshot: this.state, compatibility };
      }
      const strategy = this.adapter.selectStrategy(evidence);
      this.state = {
        ...this.state, step: 'selectingStrategy', detectedVersion: parsedVersion,
        capabilities: strategy ? Object.values(strategy.capabilities).filter(Boolean).length > 0 ? ['code-generation'] as AdapterCapability[] : [] : [],
      };
      if (compatibility === 'experimental') this.state.trustTier = 'restricted';
      return { snapshot: this.state, compatibility };
    } catch (err) {
      this.state = { ...this.state, step: 'failed', error: { code: 'VERSION_ERROR', message: String(err), retryable: true }, failedAtStep: 'readingVersion' };
      return { snapshot: this.state };
    }
  }

  async probeAuth(): Promise<{ snapshot: WizardSnapshot }> {
    if (this.state.step !== 'selectingStrategy') throw new Error(`当前状态不允许探测认证: ${this.state.step}`);
    this.state = { ...this.state, step: 'probingAuth' };
    const controller = new AbortController();
    const conn: CliConnectionSnapshot = {
      id: '', name: this.state.name, adapterType: this.state.adapterType,
      executablePath: this.state.executablePath, strategyId: 'auto',
      trustTier: this.state.trustTier, capabilities: this.state.capabilities,
      secretRefs: [], detectedVersion: this.state.detectedVersion,
    };
    const result = await this.adapter?.probeAuth(conn, controller.signal) ?? { source: 'none' as const, hints: [], error: null };
    this.state = {
      ...this.state, step: 'preparingSmokeWorkspace',
      capabilities: this.state.capabilities,
      authMethod: result.source === 'none' ? 'none' : 'cli-auth',
      authRequired: result.source !== 'none',
      smokeTestResult: null, smokeWorkspaceDir: null,
    };
    return { snapshot: this.state };
  }

  async prepareSmokeWorkspace(): Promise<{ snapshot: WizardSnapshot }> {
    if (this.state.step !== 'preparingSmokeWorkspace') throw new Error(`当前状态不允许准备 Smoke 工作区: ${this.state.step}`);
    const tempId = `setup-${randomUUID().toLowerCase().replace(/-/g, '').slice(0, 16)}`;
    const sandboxDir = join(getStudioRoot(), '.runtime', 'sandboxes', tempId);
    try {
      await mkdir(sandboxDir, { recursive: true });
      await writeFile(join(sandboxDir, 'input.txt'), 'smoke test: verify CLI can run in sandbox\n', 'utf-8');
      this.state = { ...this.state, step: 'smokeTesting', smokeWorkspaceDir: sandboxDir, smokeTestResult: 'pending' };
    } catch (err) {
      this.state = { ...this.state, step: 'failed', error: { code: 'SMOKE_WORKSPACE_ERROR', message: `无法创建 Smoke 工作区: ${String(err)}`, retryable: true }, failedAtStep: 'preparingSmokeWorkspace' };
    }
    return { snapshot: this.state };
  }

  async runSmokeTest(): Promise<{ snapshot: WizardSnapshot }> {
    if (this.state.step !== 'smokeTesting' || !this.state.smokeWorkspaceDir) throw new Error(`当前状态不允许运行 Smoke 测试: ${this.state.step}`);
    if (!this.adapter) {
      this.state = { ...this.state, step: 'failed', error: { code: 'NO_ADAPTER', message: '适配器未加载', retryable: false }, failedAtStep: 'smokeTesting' };
      return { snapshot: this.state };
    }
    try {
      const result = await this.runCliCommand(['--version'], 5000);
      const passed = result.exitCode === 0 && result.stdout.trim().length > 0;
      if (!passed) {
        this.state = { ...this.state, step: 'failed', smokeTestResult: 'failed', error: { code: 'SMOKE_TEST_FAILED', message: `Smoke 测试未通过：exit code ${result.exitCode}，输出: ${result.stderr.slice(0, 200)}`, retryable: true }, failedAtStep: 'smokeTesting' };
      } else {
        this.state = { ...this.state, step: 'reviewingCapabilitiesAndRisk', smokeTestResult: 'passed' };
      }
    } catch (err) {
      this.state = { ...this.state, step: 'failed', error: { code: 'SMOKE_TEST_ERROR', message: `Smoke 测试异常: ${String(err)}`, retryable: true }, failedAtStep: 'smokeTesting' };
    }
    return { snapshot: this.state };
  }

  private runCliCommand(args: string[], timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.state.executablePath, args, { cwd: this.state.smokeWorkspaceDir ?? undefined, shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
      child.on('error', (err) => resolve({ exitCode: null, stdout, stderr: err.message }));
    });
  }

  async save(db: Database.Database): Promise<{ snapshot: WizardSnapshot }> {
    if (this.state.step !== 'reviewingCapabilitiesAndRisk') throw new Error(`当前状态不允许保存: ${this.state.step}`);
    this.state = { ...this.state, step: 'saving' };
    try {
      const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
      const now = new Date().toISOString();
      const compatibility = checkVersionCompatibility(this.state.adapterType, this.state.detectedVersion);
      const status = compatibility === 'compatible' ? 'compatible' : compatibility === 'experimental' ? 'experimental' : 'unknown';
      db.prepare(`INSERT INTO cli_connections (id, name, adapter_type, executable_path, args_json, strategy_id, detected_version, status, trust_tier, capabilities_json, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, this.state.name, this.state.adapterType, this.state.executablePath, this.state.strategyId, this.state.detectedVersion, status, this.state.trustTier, this.state.capabilities.length > 0 ? JSON.stringify(this.state.capabilities) : null, now, now);
      this.state = { ...this.state, step: 'ready', connectionId: id };
      return { snapshot: this.state };
    } catch (err) {
      this.state = { ...this.state, step: 'failed', error: { code: 'SAVE_ERROR', message: String(err), retryable: true }, failedAtStep: 'saving' };
      return { snapshot: this.state };
    }
  }

  setExecutable(executablePath: string): void {
    if (this.state.step !== 'selectingExecutable') throw new Error(`当前状态不允许设置可执行文件路径: ${this.state.step}`);
    this.state = { ...this.state, step: 'readingVersion', executablePath };
  }

  setTrustTier(tier: 'trusted' | 'sandboxed' | 'restricted'): void { this.state = { ...this.state, trustTier: tier }; }

  retry(): void {
    if (this.state.step !== 'failed') throw new Error('只能在失败状态重试');
    if (this.state.failedAtStep === 'selectingExecutable') {
      this.state = createSnapshot({ ...this.state, step: 'selectingExecutable' as WizardStep });
    } else if (this.state.failedAtStep === 'readingVersion') {
      this.state = { ...createSnapshot({ ...this.state, step: 'readingVersion' as WizardStep }), executablePath: this.state.executablePath, adapterType: this.state.adapterType, name: this.state.name };
    } else {
      this.state = { ...createSnapshot({ ...this.state, step: 'idle' as WizardStep }) };
    }
  }
}

export const agentConnectionService = new AgentConnectionService();
