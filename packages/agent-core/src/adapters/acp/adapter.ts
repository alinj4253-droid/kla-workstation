import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAcpTransport, type AcpTransportOptions } from './transport.js';
import { runAcpSession } from './session.js';
import { getAcpRegistryEntry, buildAcpSpawnSpec, type AcpCliRegistryEntry } from './registry.js';
import { detectExecutables } from '../detect-shared.js';
import type {
  ExternalAgentAdapter, VersionStrategy, DetectInput, DetectedExecutable,
  ExecutableRef, VersionEvidence, CliConnectionSnapshot, AuthProbeResult,
  ExternalRunRequest, AgentEventSink, ExternalRunResult, AdapterCapability, SpawnSpec,
} from '../../external-agent-adapter.js';

const execFileAsync = promisify(execFile);

/** ACP 统一适配器（registry 驱动，单一类覆盖全部 ACP CLI） */
export class AcpCliAdapter implements ExternalAgentAdapter {
  readonly runtimeMode = 'external-cli' as const;
  /** ACP 长连接标记：desktop 端 cli-executor / agent-connection-service 据此分流 */
  readonly acp = true as const;
  readonly type: string;

  private entry: AcpCliRegistryEntry;

  constructor(type: string) {
    const entry = getAcpRegistryEntry(type);
    if (!entry) {
      throw new Error(`未知的 ACP CLI 类型: ${type}`);
    }
    this.entry = entry;
    this.type = entry.type;
  }

  async detect(input: DetectInput, signal: AbortSignal): Promise<DetectedExecutable[]> {
    // 版本探测兼作存在性探测
    return detectExecutables(input, signal, [this.entry.command], [], this.entry.versionArgs);
  }

  async readVersion(executable: ExecutableRef, signal: AbortSignal): Promise<VersionEvidence> {
    let rawVersion = '';
    let source: VersionEvidence['source'] = 'stdout';
    try {
      const result = await execFileAsync(executable.executablePath, this.entry.versionArgs, {
        env: { ...process.env, ...this.entry.env },
        shell: false,
        timeout: 5000,
        windowsHide: true,
        signal,
      });
      rawVersion = result.stdout.trim() || result.stderr.trim() || '';
      source = result.stdout.trim() ? 'stdout' : 'stderr';
    } catch {
      return { rawVersion: '', semver: null, source: 'registry' };
    }

    const match = rawVersion.match(/(\d+\.\d+(?:\.\d+)?)/);
    const semver = match
      ? (() => { const p = match[1]!.split('.').map(Number); return { major: p[0]!, minor: p[1]!, patch: p[2] ?? 0 }; })()
      : null;
    return { rawVersion, semver, source };
  }

  selectStrategy(version: VersionEvidence): VersionStrategy | null {
    // ACP 路径无需 per-version 策略；版本兼容判定交给 desktop 的 version-compatibility.ts。
    // 版本不可解析时返回 null → 上游标记 incompatible。
    if (!version.semver) return null;
    const entry = this.entry;
    return {
      id: 'acp',
      versionRange: '*',
      capabilities: {
        nonInteractive: true,
        structuredOutput: true,
        resumableSession: true,
        processScopedMcp: true,
        reliableCancellation: true,
      },
      buildVersionProbe(executable: ExecutableRef): SpawnSpec {
        return buildAcpSpawnSpec(entry, executable.executablePath, process.cwd());
      },
      buildAuthProbe(): SpawnSpec | null {
        return null;
      },
      buildRun(input: { executablePath: string; instruction: string; args: string[]; env: Record<string, string>; workspaceRoot: string; capabilities: unknown }): SpawnSpec {
        return buildAcpSpawnSpec(entry, input.executablePath, input.workspaceRoot, input.env);
      },
      parseStdout(): never[] {
        return [];
      },
      classifyExit(result: { code: number | null; signal: string | null }) {
        return result.code === 0
          ? { code: 0, reason: 'success' as const, message: 'ok' }
          : result.code === null
            ? { code: 1, reason: 'cancelled' as const, message: 'acp run cancelled' }
            : { code: result.code, reason: 'error' as const, message: 'acp run failed' };
      },
    };
  }

  async probeAuth(_connection: CliConnectionSnapshot, _signal: AbortSignal): Promise<AuthProbeResult> {
    return { source: 'none', hints: [], error: null };
  }

  async run(input: ExternalRunRequest, sink: AgentEventSink, signal: AbortSignal): Promise<ExternalRunResult> {
    const spec = buildAcpSpawnSpec(this.entry, input.connection.executablePath, input.workspaceRoot);
    const transportOptions: AcpTransportOptions = {
      spec,
      envOverrides: this.entry.env,
      onProtocolStderr: (text) => sink.onStderr?.(text),
    };
    const transport = createAcpTransport(transportOptions);

    const result = await runAcpSession({
      transport,
      instruction: input.instruction,
      workspaceRoot: input.workspaceRoot,
      sink,
      signal,
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    };
  }

  getCapabilities(): AdapterCapability[] {
    // 能力来自注册表（经契约测试验证后逐个 CLI 启用）
    return this.entry.capabilities as AdapterCapability[];
  }

  /** smoke test 握手（agent-connection-service 调用） */
  async smokeAcp(
    ref: { executablePath: string },
    signal: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    const spec = buildAcpSpawnSpec(this.entry, ref.executablePath, process.cwd());
    const transport = createAcpTransport({ spec, envOverrides: this.entry.env });
    try {
      await runAcpSession({
        transport,
        instruction: '',
        workspaceRoot: process.cwd(),
        sink: {},
        signal,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      const pid = transport.child.pid;
      if (pid && !transport.child.killed) transport.child.kill();
    }
  }
}
