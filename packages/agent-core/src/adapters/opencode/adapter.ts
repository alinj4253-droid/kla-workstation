import { spawn } from 'node:child_process';
import type {
  ExternalAgentAdapter, VersionStrategy, DetectInput, DetectedExecutable,
  ExecutableRef, VersionEvidence, CliConnectionSnapshot, AuthProbeResult,
  ExternalRunRequest, AgentEventSink, ExternalRunResult, AdapterCapability,
} from '../../external-agent-adapter';
import { OpencodeDetector } from './detect.js';
import { OpencodeAutoStrategy } from './strategies/auto.js';

export { OpencodeAutoStrategy } from './strategies/auto.js';

export class OpencodeCliAdapter implements ExternalAgentAdapter {
  readonly type = 'opencode';
  readonly runtimeMode = 'external-cli' as const;
  private detector = new OpencodeDetector();
  private strategies = new Map<string, VersionStrategy>();

  constructor() {
    const auto = new OpencodeAutoStrategy();
    this.strategies.set(auto.id, auto);
  }

  async detect(input: DetectInput, signal: AbortSignal): Promise<DetectedExecutable[]> {
    return this.detector.detect(input, signal);
  }

  async readVersion(executable: ExecutableRef, signal: AbortSignal): Promise<VersionEvidence> {
    const strategy = this.getDefaultStrategy();
    const spec = strategy.buildVersionProbe(executable);
    const result = await this.spawnAndCollect(spec, signal);
    const rawVersion = result.stdout.trim() || result.stderr.trim() || '';
    const match = rawVersion.match(/(\d+\.\d+(?:\.\d+)?)/);
    const semver = match
      ? (() => { const p = match[1]!.split('.').map(Number); return { major: p[0]!, minor: p[1]!, patch: p[2] ?? 0 }; })()
      : null;
    return { rawVersion, semver, source: result.stdout.trim() ? 'stdout' : 'stderr' };
  }

  selectStrategy(_version: VersionEvidence): VersionStrategy | null {
    return this.getDefaultStrategy();
  }

  async probeAuth(_connection: CliConnectionSnapshot, _signal: AbortSignal): Promise<AuthProbeResult> {
    return { source: 'none', hints: [], error: null };
  }

  async run(input: ExternalRunRequest, sink: AgentEventSink, signal: AbortSignal): Promise<ExternalRunResult> {
    const strategy = this.getDefaultStrategy();
    const spec = strategy.buildRun({
      executablePath: input.connection.executablePath,
      instruction: input.instruction,
      args: [],
      env: input.connection.secretRefs.length > 0 ? { KUN_SECRETS: input.connection.secretRefs.join(',') } : {},
      workspaceRoot: input.workspaceRoot,
      capabilities: strategy.capabilities,
    });
    return this.spawnAndCollect(spec, signal, sink);
  }

  getCapabilities(): AdapterCapability[] {
    return ['code-generation', 'file-read', 'file-write', 'search', 'network-access'];
  }

  parseVersion(versionOutput: string): string | null {
    const match = versionOutput.match(/(\d+\.\d+(?:\.\d+)?)/);
    return match?.[1] ?? null;
  }

  private getDefaultStrategy(): VersionStrategy {
    return this.strategies.get('auto') ?? new OpencodeAutoStrategy();
  }

  private spawnAndCollect(
    spec: { executable: string; args: string[]; cwd: string; env: Record<string, string>; shell: boolean; stdin?: Uint8Array },
    signal: AbortSignal,
    sink?: AgentEventSink,
  ): Promise<ExternalRunResult> {
    const start = Date.now();
    console.log('[OpencodeCliAdapter.spawnAndCollect]', {
      executable: spec.executable,
      args: spec.args,
      cwd: spec.cwd,
      shell: spec.shell,
      env: spec.env,
      processPlatform: process.platform
    });
    return new Promise((resolve) => {
      const child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: spec.shell, stdio: ['pipe', 'pipe', 'pipe'], signal,
      });
      let stdout = ''; let stderr = ''; let exitCode: number | null = null;
      if (spec.stdin) { child.stdin?.write(spec.stdin); child.stdin?.end(); }
      child.stdout?.on('data', (chunk: Buffer) => { const text = chunk.toString(); stdout += text; sink?.onStdout?.(text); });
      child.stderr?.on('data', (chunk: Buffer) => { const text = chunk.toString(); stderr += text; sink?.onStderr?.(text); });
      child.on('exit', (code) => {
        console.log('[OpencodeCliAdapter.spawnAndCollect] exit', { code, stdout, stderr, duration: Date.now() - start });
        exitCode = code; resolve({ stdout, stderr, exitCode, durationMs: Date.now() - start });
      });
      child.on('error', (err) => {
        console.log('[OpencodeCliAdapter.spawnAndCollect] error', err);
        resolve({ stdout, stderr, exitCode, durationMs: Date.now() - start });
      });
    });
  }
}
