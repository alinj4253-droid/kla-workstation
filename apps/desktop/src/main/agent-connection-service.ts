import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pino from 'pino';
import type Database from 'better-sqlite3';
import { buildSpawnInvocation } from './process-supervisor';
import { cliAgentRegistry } from './cli-agent-registry';
import { checkVersionCompatibility } from './version-compatibility';
import { getStudioRoot } from './paths';
import { getLogger } from './logger';
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
  private readonly logger: pino.Logger;

  constructor() {
    this.logger = getLogger();
  }

  get snapshot(): Readonly<WizardSnapshot> { return this.state; }
  get isActive(): boolean {
    return this.state.step !== 'idle' && this.state.step !== 'ready' && this.state.step !== 'failed';
  }

  reset(): void {
    this.logger.info({ prevStep: this.state.step, name: this.state.name }, 'AgentConnectionService.reset');
    this.state = createSnapshot({});
    this.adapter = null;
  }

  startManual(name: string, adapterType: string, executablePath: string): { snapshot: WizardSnapshot } {
    if (this.isActive) throw new Error('向导已在运行中');
    const adapter = cliAgentRegistry.getAdapter(adapterType);
    if (!adapter) throw new Error(`不支持的适配器类型: ${adapterType}`);
    this.adapter = adapter;
    this.state = createSnapshot({ step: 'selectingExecutable', name, adapterType, executablePath });
    this.logger.info({ name, adapterType, executablePath }, 'AgentConnectionService.startManual');
    return { snapshot: this.state };
  }

  async startAuto(adapterType: string): Promise<{ snapshot: WizardSnapshot; detection?: DetectedExecutable[] }> {
    if (this.isActive) throw new Error('向导已在运行中');
    const adapter = cliAgentRegistry.getAdapter(adapterType);
    if (!adapter) {
      this.logger.warn({ adapterType }, 'AgentConnectionService.startAuto: unsupported adapter');
      this.state = createSnapshot({ step: 'failed', name: adapterType, adapterType, error: { code: 'UNSUPPORTED_ADAPTER', message: `不支持的适配器类型: ${adapterType}`, retryable: false }, failedAtStep: 'selectingExecutable' });
      return { snapshot: this.state };
    }
    this.adapter = adapter;
    const controller = new AbortController();
    const executables = await adapter.detect({}, controller.signal);
    if (executables.length === 0) {
      this.logger.warn({ adapterType }, 'AgentConnectionService.startAuto: no executables found');
      this.state = createSnapshot({ step: 'failed', name: adapterType, adapterType, error: { code: 'NOT_FOUND', message: `未在 PATH 中找到 ${adapterType}`, retryable: true }, failedAtStep: 'selectingExecutable' });
      return { snapshot: this.state, detection: executables };
    }
    const exe = executables[0]!;
    this.logger.info({ adapterType, executablePath: exe.executablePath, versionHint: exe.versionHint }, 'AgentConnectionService.startAuto');
    this.state = createSnapshot({ step: 'readingVersion', name: adapterType, adapterType, executablePath: exe.executablePath, detectedVersion: exe.versionHint });
    return { snapshot: this.state, detection: executables };
  }

  async readVersion(): Promise<{ snapshot: WizardSnapshot; compatibility?: ReturnType<typeof checkVersionCompatibility> }> {
    if (this.state.step !== 'readingVersion' || !this.adapter) {
      throw new Error(`当前状态不允许读取版本: ${this.state.step}`);
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('读取版本超时')), 10000);
      const evidence = await this.adapter.readVersion({ executablePath: this.state.executablePath }, controller.signal);
      clearTimeout(timeout);
      const parsedVersion = evidence.semver ? `${evidence.semver.major}.${evidence.semver.minor}.${evidence.semver.patch}` : null;
      const compatibility = checkVersionCompatibility(this.state.adapterType, parsedVersion);
      this.logger.info({ adapterType: this.state.adapterType, parsedVersion, compatibility }, 'AgentConnectionService.readVersion');
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
      this.logger.error({ err, adapterType: this.state.adapterType }, 'AgentConnectionService.readVersion failed');
      this.state = { ...this.state, step: 'failed', error: { code: 'VERSION_ERROR', message: String(err), retryable: true }, failedAtStep: 'readingVersion' };
      return { snapshot: this.state };
    }
  }

  async probeAuth(): Promise<{ snapshot: WizardSnapshot }> {
    if (this.state.step !== 'selectingStrategy') throw new Error(`当前状态不允许探测认证: ${this.state.step}`);
    this.state = { ...this.state, step: 'probingAuth' };
    this.logger.info({ name: this.state.name, adapterType: this.state.adapterType }, 'AgentConnectionService.probeAuth');
    const controller = new AbortController();
    const conn: CliConnectionSnapshot = {
      id: '', name: this.state.name, adapterType: this.state.adapterType,
      executablePath: this.state.executablePath, strategyId: 'auto',
      trustTier: this.state.trustTier, capabilities: this.state.capabilities,
      secretRefs: [], detectedVersion: this.state.detectedVersion,
    };
    const result = await this.adapter?.probeAuth(conn, controller.signal) ?? { source: 'none' as const, hints: [], error: null };
    this.logger.info({ authMethod: result.source }, 'AgentConnectionService.probeAuth result');
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
    this.logger.info({ sandboxDir }, 'AgentConnectionService.prepareSmokeWorkspace');
    try {
      await mkdir(sandboxDir, { recursive: true });
      await writeFile(join(sandboxDir, 'input.txt'), 'smoke test: verify CLI can run in sandbox\n', 'utf-8');
      this.state = { ...this.state, step: 'smokeTesting', smokeWorkspaceDir: sandboxDir, smokeTestResult: 'pending' };
    } catch (err) {
      this.logger.error({ err, sandboxDir }, 'AgentConnectionService.prepareSmokeWorkspace failed');
      this.state = { ...this.state, step: 'failed', error: { code: 'SMOKE_WORKSPACE_ERROR', message: `无法创建 Smoke 工作区: ${String(err)}`, retryable: true }, failedAtStep: 'preparingSmokeWorkspace' };
    }
    return { snapshot: this.state };
  }

  async runSmokeTest(): Promise<{ snapshot: WizardSnapshot }> {
    if (this.state.step !== 'smokeTesting' || !this.state.smokeWorkspaceDir) throw new Error(`当前状态不允许运行 Smoke 测试: ${this.state.step}`);
    if (!this.adapter) {
      this.logger.warn({}, 'AgentConnectionService.runSmokeTest: no adapter loaded');
      this.state = { ...this.state, step: 'failed', error: { code: 'NO_ADAPTER', message: '适配器未加载', retryable: false }, failedAtStep: 'smokeTesting' };
      return { snapshot: this.state };
    }
    this.logger.info({ executablePath: this.state.executablePath }, 'AgentConnectionService.runSmokeTest');
    try {
      const isAcp = 'acp' in this.adapter && (this.adapter as any).acp === true;
      let passed: boolean;
      let detail: string;
      if (isAcp && 'smokeAcp' in this.adapter) {
        // ACP CLI：通过真实 initialize 握手验证协议端点可用（无需认证即可握手）
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const smoke = await (this.adapter as any).smokeAcp({ executablePath: this.state.executablePath }, controller.signal);
          passed = !!smoke?.ok;
          detail = smoke?.error ?? 'ACP initialize 握手成功';
        } finally {
          clearTimeout(timeout);
        }
      } else {
        // 使用适配器策略的 buildVersionProbe 获取正确的探测参数
        const evidence: import('@kunqing/agent-core').VersionEvidence = {
          rawVersion: this.state.detectedVersion ?? '',
          semver: null,
          source: 'stdout',
        };
        const strategy = this.adapter.selectStrategy(evidence);
        const probeArgs = strategy?.buildVersionProbe({ executablePath: this.state.executablePath }).args ?? ['--version'];
        const result = await this.runCliCommand(probeArgs, 5000);
        passed = result.exitCode === 0 && result.stdout.trim().length > 0;
        detail = `exit code ${result.exitCode}，输出: ${result.stderr.slice(0, 200) || result.stdout.slice(0, 200)}`;
      }
      this.logger.info({ passed }, 'AgentConnectionService.runSmokeTest result');
      if (!passed) {
        this.state = { ...this.state, step: 'failed', smokeTestResult: 'failed', error: { code: 'SMOKE_TEST_FAILED', message: `Smoke 测试未通过：${detail}`, retryable: true }, failedAtStep: 'smokeTesting' };
      } else {
        this.state = { ...this.state, step: 'reviewingCapabilitiesAndRisk', smokeTestResult: 'passed' };
      }
    } catch (err) {
      this.logger.error({ err }, 'AgentConnectionService.runSmokeTest exception');
      this.state = { ...this.state, step: 'failed', error: { code: 'SMOKE_TEST_ERROR', message: `Smoke 测试异常: ${String(err)}`, retryable: true }, failedAtStep: 'smokeTesting' };
    }
    return { snapshot: this.state };
  }

  private runCliCommand(args: string[], timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    this.logger.debug({ executablePath: this.state.executablePath, args, timeoutMs }, 'AgentConnectionService.runCliCommand');
    return new Promise((resolve) => {
      const invocation = buildSpawnInvocation({
        executable: this.state.executablePath, args, shell: process.platform === 'win32',
      });
      const child = spawn(invocation.executable, invocation.args, {
        cwd: this.state.smokeWorkspaceDir ?? undefined,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      let stdout = ''; let stderr = '';
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!child.killed) child.kill('SIGTERM');
        resolve({ exitCode, stdout, stderr });
      };

      // spawn 不支持 timeout 选项，手动实现超时
      const timer = setTimeout(() => {
        stderr += '\n[TIMEOUT] 子进程未在 ' + (timeoutMs / 1000) + ' 秒内退出';
        if (!child.killed) child.kill('SIGKILL');
        finish();
      }, timeoutMs);

      let exitCode: number | null = null;
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code) => { exitCode = code; finish(); });
      child.on('error', (err) => { stderr += err.message; finish(); });
    });
  }

  async save(db: Database.Database): Promise<{ snapshot: WizardSnapshot }> {
    if (this.state.step !== 'reviewingCapabilitiesAndRisk') throw new Error(`当前状态不允许保存: ${this.state.step}`);
    this.state = { ...this.state, step: 'saving' };
    this.logger.info({ name: this.state.name, adapterType: this.state.adapterType }, 'AgentConnectionService.save');
    try {
      const now = new Date().toISOString();
      const compatibility = checkVersionCompatibility(this.state.adapterType, this.state.detectedVersion);
      const status = compatibility === 'compatible' ? 'compatible' : compatibility === 'experimental' ? 'experimental' : 'unknown';
      
      // 检查是否已存在同类型的连接，如果存在则更新，否则插入
      const existing = db.prepare('SELECT id FROM cli_connections WHERE adapter_type = ?').get(this.state.adapterType) as { id: string } | undefined;
      if (existing) {
        // 更新现有记录
        db.prepare(`UPDATE cli_connections SET name = ?, executable_path = ?, strategy_id = ?, detected_version = ?, status = ?, trust_tier = ?, capabilities_json = ?, updated_at = ? WHERE id = ?`)
          .run(this.state.name, this.state.executablePath, this.state.strategyId, this.state.detectedVersion, status, this.state.trustTier, this.state.capabilities.length > 0 ? JSON.stringify(this.state.capabilities) : null, now, existing.id);
        this.state = { ...this.state, step: 'ready', connectionId: existing.id };
        this.logger.info({ connectionId: existing.id }, 'AgentConnectionService.save updated existing connection');
        // 同步更新 agent_profiles 中对应的记录
        const existingProfile = db.prepare('SELECT id FROM agent_profiles WHERE cli_connection_id = ?').get(existing.id) as { id: string } | undefined;
        if (existingProfile) {
          db.prepare('UPDATE agent_profiles SET name = ?, updated_at = ? WHERE id = ?').run(this.state.name, now, existingProfile.id);
        } else {
          const profileId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
          db.prepare(`INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, cli_connection_id, enabled, delegatable, is_system_default, created_at, updated_at) VALUES (?, ?, ?, '1.0.0', 'external-cli', ?, 1, 1, 0, ?, ?)`)
            .run(profileId, this.state.name, `custom.${this.state.adapterType}`, existing.id, now, now);
          this.logger.info({ profileId, connectionId: existing.id }, 'AgentConnectionService.save created profile for existing connection');
        }
      } else {
        // 插入新记录
        const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
        db.prepare(`INSERT INTO cli_connections (id, name, adapter_type, executable_path, args_json, strategy_id, detected_version, status, trust_tier, capabilities_json, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, this.state.name, this.state.adapterType, this.state.executablePath, this.state.strategyId, this.state.detectedVersion, status, this.state.trustTier, this.state.capabilities.length > 0 ? JSON.stringify(this.state.capabilities) : null, now, now);
        this.state = { ...this.state, step: 'ready', connectionId: id };
        this.logger.info({ connectionId: id }, 'AgentConnectionService.save created new connection');
        // 同时创建对应的 agent_profiles 记录，使 CLI 智能体出现在 @ 列表和创建群聊对话框中
        const profileId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
        db.prepare(`INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, cli_connection_id, enabled, delegatable, is_system_default, created_at, updated_at) VALUES (?, ?, ?, '1.0.0', 'external-cli', ?, 1, 1, 0, ?, ?)`)
          .run(profileId, this.state.name, `custom.${this.state.adapterType}`, id, now, now);
        this.logger.info({ profileId, connectionId: id }, 'AgentConnectionService.save created profile for new connection');
      }
      
      return { snapshot: this.state };
    } catch (err) {
      this.logger.error({ err }, 'AgentConnectionService.save failed');
      this.state = { ...this.state, step: 'failed', error: { code: 'SAVE_ERROR', message: String(err), retryable: true }, failedAtStep: 'saving' };
      return { snapshot: this.state };
    }
  }

  setExecutable(executablePath: string): void {
    if (this.state.step !== 'selectingExecutable') throw new Error(`当前状态不允许设置可执行文件路径: ${this.state.step}`);
    this.logger.info({ executablePath }, 'AgentConnectionService.setExecutable');
    this.state = { ...this.state, step: 'readingVersion', executablePath };
  }

  setTrustTier(tier: 'trusted' | 'sandboxed' | 'restricted'): void {
    this.logger.info({ tier }, 'AgentConnectionService.setTrustTier');
    this.state = { ...this.state, trustTier: tier };
  }

  retry(): void {
    if (this.state.step !== 'failed') throw new Error('只能在失败状态重试');
    this.logger.info({ failedAtStep: this.state.failedAtStep }, 'AgentConnectionService.retry');
    if (this.state.failedAtStep === 'selectingExecutable') {
      // 自动检测失败回到 idle，让用户看到初始表单重新操作
      // （selectingExecutable 在 UI 中没有渲染分支，直接设回会导致空白对话框）
      this.state = createSnapshot({ ...this.state, step: 'idle' as WizardStep });
    } else if (this.state.failedAtStep === 'readingVersion') {
      this.state = { ...createSnapshot({ ...this.state, step: 'readingVersion' as WizardStep }), executablePath: this.state.executablePath, adapterType: this.state.adapterType, name: this.state.name };
    } else {
      this.state = { ...createSnapshot({ ...this.state, step: 'idle' as WizardStep }) };
    }
  }
}

export const agentConnectionService = new AgentConnectionService();
