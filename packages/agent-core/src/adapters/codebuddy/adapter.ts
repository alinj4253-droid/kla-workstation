import { spawn } from 'node:child_process';
import type {
  ExternalAgentAdapter, VersionStrategy, DetectInput, DetectedExecutable,
  ExecutableRef, VersionEvidence, CliConnectionSnapshot, AuthProbeResult,
  ExternalRunRequest, AgentEventSink, ExternalRunResult, AdapterCapability,
} from '../../external-agent-adapter';
import { CodeBuddyDetector } from './detect.js';
import { CodeBuddyAutoStrategy } from './strategies/auto.js';

export { CodeBuddyAutoStrategy } from './strategies/auto.js';

const CODEBUDDY_AUTH_ENV_VARS = ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN'] as const;

export class CodeBuddyCliAdapter implements ExternalAgentAdapter {
  readonly type = 'codebuddy';
  readonly runtimeMode = 'external-cli' as const;
  private detector = new CodeBuddyDetector();
  private strategies = new Map<string, VersionStrategy>();

  constructor() {
    const auto = new CodeBuddyAutoStrategy();
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

  async probeAuth(connection: CliConnectionSnapshot, _signal: AbortSignal): Promise<AuthProbeResult> {
    const found: string[] = [];
    for (const key of CODEBUDDY_AUTH_ENV_VARS) {
      if (connection.secretRefs.some((r) => r.includes(key))) {
        found.push(key);
      } else if (process.env[key]) {
        found.push(key);
      }
    }
    if (found.length > 0) {
      return {
        source: found.includes('CODEBUDDY_AUTH_TOKEN') ? 'explicit' : 'env',
        hints: [`已检测到认证信息: ${found.join(', ')}`],
        error: null,
      };
    }
    return {
      source: 'none',
      hints: ['需要登录 CodeBuddy: 运行 `codebuddy login` 或设置 `CODEBUDDY_API_KEY` 环境变量'],
      error: 'Authentication required',
    };
  }

  async run(input: ExternalRunRequest, sink: AgentEventSink, signal: AbortSignal): Promise<ExternalRunResult> {
    const strategy = this.getDefaultStrategy();
    const env: Record<string, string> = {};
    for (const key of CODEBUDDY_AUTH_ENV_VARS) {
      const ref = input.connection.secretRefs.find((r) => r.startsWith(key));
      if (ref) {
        const val = ref.split('=', 2)[1];
        if (val) env[key] = val;
      } else if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }
    const spec = strategy.buildRun({
      executablePath: input.connection.executablePath,
      instruction: input.instruction,
      args: [],
      env,
      workspaceRoot: input.workspaceRoot,
      capabilities: strategy.capabilities,
    });
    const result = await this.spawnAndCollect(spec, signal, sink);
    if (result.exitCode !== 0 && (result.stderr.includes('Authentication required') || result.stdout.includes('Authentication required'))) {
      sink?.onStderr?.('\n请先登录 CodeBuddy: 在终端运行 `codebuddy login` 或设置 CODEBUDDY_API_KEY');
    }
    return result;
  }

  getCapabilities(): AdapterCapability[] {
    return ['code-generation', 'file-read', 'file-write', 'search', 'network-access'];
  }

  parseVersion(versionOutput: string): string | null {
    const match = versionOutput.match(/(\d+\.\d+(?:\.\d+)?)/);
    return match?.[1] ?? null;
  }

  private getDefaultStrategy(): VersionStrategy {
    return this.strategies.get('auto') ?? new CodeBuddyAutoStrategy();
  }

  private spawnAndCollect(
    spec: { executable: string; args: string[]; cwd: string; env: Record<string, string>; shell: boolean; stdin?: Uint8Array },
    signal: AbortSignal,
    sink?: AgentEventSink,
  ): Promise<ExternalRunResult> {
    const start = Date.now();
    return new Promise((resolve) => {
      const child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: spec.shell, stdio: ['pipe', 'pipe', 'pipe'], signal,
      });
      let stdout = ''; let stderr = ''; let exitCode: number | null = null;
      if (spec.stdin) { child.stdin?.write(spec.stdin); child.stdin?.end(); }
      child.stdout?.on('data', (chunk: Buffer) => { const text = chunk.toString(); stdout += text; sink?.onStdout?.(text); });
      child.stderr?.on('data', (chunk: Buffer) => { const text = chunk.toString(); stderr += text; sink?.onStderr?.(text); });
      child.on('exit', (code) => {
        exitCode = code; resolve({ stdout, stderr, exitCode, durationMs: Date.now() - start });
      });
      child.on('error', () => {
        resolve({ stdout, stderr, exitCode, durationMs: Date.now() - start });
      });
    });
  }
}
