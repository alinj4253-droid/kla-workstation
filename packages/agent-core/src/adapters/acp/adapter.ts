import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAcpTransport, type AcpTransportOptions } from './transport.js';
import { runAcpSession, acpSmokeHandshake, allowAcpToolOnce } from './session.js';
import { getAcpRegistryEntry, buildAcpSpawnSpec, type AcpCliRegistryEntry } from './registry.js';
import { detectExecutables } from '../detect-shared.js';
import { buildSpawnInvocation } from '../spawn.js';
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
    // Some CLIs install outside PATH. Keep the generic ACP registry while
    // adding each vendor's documented per-user bin directory.
    const home = os.homedir();
    const knownDirs = this.type === 'kimi'
      ? [path.join(home, '.kimi-code', 'bin'), path.join(home, '.kimi', 'bin')]
      : [];
    return detectExecutables(input, signal, [this.entry.command], knownDirs, this.entry.versionArgs);
  }

  async readVersion(executable: ExecutableRef, signal: AbortSignal): Promise<VersionEvidence> {
    let rawVersion = '';
    let source: VersionEvidence['source'] = 'stdout';
    try {
      if (process.platform === 'win32' && !/\.(?:exe|com)$/i.test(executable.executablePath)) {
        const mergedEnv: Record<string, string> = { ...process.env, ...this.entry.env } as Record<string, string>;
        const spec: SpawnSpec = {
          executable: executable.executablePath,
          args: this.entry.versionArgs,
          cwd: process.cwd(),
          env: mergedEnv,
          shell: true,
        };
        const invocation = buildSpawnInvocation(spec);
        const { stdout, stderr } = await runAndCapture(invocation.executable, invocation.args, {
          env: spec.env,
          ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments } : {}),
          timeout: 5000,
          signal,
        });
        rawVersion = stdout.trim() || stderr.trim() || '';
        source = stdout.trim() ? 'stdout' : 'stderr';
      } else {
        const result = await execFileAsync(executable.executablePath, this.entry.versionArgs, {
          env: { ...process.env, ...this.entry.env },
          shell: false,
          timeout: 5000,
          windowsHide: true,
          signal,
        });
        rawVersion = result.stdout.trim() || result.stderr.trim() || '';
        source = result.stdout.trim() ? 'stdout' : 'stderr';
      }
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
      // trusted and sandboxed connections execute in a per-run isolated
      // workspace. ACP still asks the client for each Read/Write/Bash action;
      // without this callback the protocol default cancels every tool call.
      ...(input.connection.trustTier === 'restricted'
        ? {}
        : { onPermissionRequest: async (context) => allowAcpToolOnce(context.params.options) }),
    });

    return {
      // ACP agents are terminated after session/close. On Windows that cleanup
      // commonly reports process exit code 1 even though the prompt ended
      // normally, so protocol stopReason is the authoritative outcome.
      exitCode: result.stopReason === 'end_turn'
        ? 0
        : result.stopReason === 'cancelled'
          ? null
          : result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    };
  }

  getCapabilities(): AdapterCapability[] {
    // 能力来自注册表（经契约测试验证后逐个 CLI 启用）
    return this.entry.capabilities as AdapterCapability[];
  }

  /** smoke test 握手（agent-connection-service 调用）：仅 initialize+session/new，不触发真实调用 */
  async smokeAcp(
    ref: { executablePath: string },
    signal: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    const spec = buildAcpSpawnSpec(this.entry, ref.executablePath, process.cwd());
    const transport = createAcpTransport({ spec, envOverrides: this.entry.env });
    try {
      return await acpSmokeHandshake(transport, signal);
    } finally {
      const pid = transport.child.pid;
      if (pid && !transport.child.killed) transport.child.kill();
    }
  }
}

/** 经 cmd shim 执行并收集 stdout/stderr（带超时与 abort） */
function runAndCapture(
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean; timeout: number; signal: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    const onAbort = (): void => { child.kill(); reject(new Error('aborted')); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, options.timeout);
    child.once('error', (err) => { clearTimeout(timer); options.signal.removeEventListener('abort', onAbort); reject(err); });
    child.once('close', () => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr });
    });
  });
}
