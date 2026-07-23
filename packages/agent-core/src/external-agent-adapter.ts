import type { AgentRuntimeMode } from './index';

// ─── Shared types ───────────────────────────────────────────────────────────

export type ExternalAgentStatus =
  | 'available'
  | 'unavailable'
  | 'checking'
  | 'busy'
  | 'error'
  | 'disabled'
  | 'incompatible';

export type AdapterCapability = 'code-generation' | 'file-read' | 'file-write' | 'terminal' | 'search' | 'reasoning' | 'network-access';

export type SpawnSpec = {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: Uint8Array;
  shell: false;
};

// ─── Detect ─────────────────────────────────────────────────────────────────

export type DetectInput = {
  /** PATH hint or user-specified directory to scan */
  searchPaths?: string[];
};

export type DetectedExecutable = {
  executablePath: string;
  source: 'path' | 'user-specified' | 'wmike';
  versionHint: string | null;
};

// ─── Version evidence ────────────────────────────────────────────────────────

export type ExecutableRef = {
  executablePath: string;
};

export type VersionEvidence = {
  rawVersion: string;
  semver: { major: number; minor: number; patch: number } | null;
  source: 'stdout' | 'stderr' | '--version' | 'registry';
};

// ─── Connection snapshot (for auth / run) ────────────────────────────────────

export type CliConnectionSnapshot = {
  id: string;
  name: string;
  adapterType: string;
  executablePath: string;
  strategyId: string;
  trustTier: 'trusted' | 'sandboxed' | 'restricted';
  capabilities: AdapterCapability[];
  secretRefs: string[];
  detectedVersion: string | null;
};

// ─── Auth ────────────────────────────────────────────────────────────────────

export type AuthProbeResult = {
  source: 'explicit' | 'env' | 'none';
  hints: string[];
  error: string | null;
};

// ─── Run ─────────────────────────────────────────────────────────────────────

export type ExternalRunRequest = {
  connection: CliConnectionSnapshot;
  instruction: string;
  workspaceRoot: string;
};

export type AgentEventSink = {
  onStdout?(data: string): void;
  onStderr?(data: string): void;
  onEvent?(event: ParsedAgentEvent): void;
  onExit?(exit: NormalizedExit): void;
};

export type ExternalRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

// ─── Strategy internals ──────────────────────────────────────────────────────

export type PreparedExternalRun = {
  executablePath: string;
  instruction: string;
  args: string[];
  env: Record<string, string>;
  workspaceRoot: string;
  capabilities: VersionCapabilities;
};

export type ParserState = {
  buffer: string;
  lineMode: boolean;
};

export type ParsedAgentEvent = {
  type: string;
  data: unknown;
  ts: string;
};

export type ProcessExit = {
  code: number | null;
  signal: string | null;
};

export type NormalizedExit = {
  code: number;
  reason: 'success' | 'cancelled' | 'timeout' | 'error' | 'incompatible';
  message: string;
};

// ─── Version capabilities ────────────────────────────────────────────────────

export type VersionCapabilities = {
  nonInteractive: boolean;
  structuredOutput: boolean;
  resumableSession: boolean;
  processScopedMcp: boolean;
  reliableCancellation: boolean;
};

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface ExternalAgentAdapter {
  readonly type: string;
  readonly runtimeMode: AgentRuntimeMode;

  detect(input: DetectInput, signal: AbortSignal): Promise<DetectedExecutable[]>;
  readVersion(executable: ExecutableRef, signal: AbortSignal): Promise<VersionEvidence>;
  selectStrategy(version: VersionEvidence): VersionStrategy | null;
  probeAuth(connection: CliConnectionSnapshot, signal: AbortSignal): Promise<AuthProbeResult>;
  run(input: ExternalRunRequest, sink: AgentEventSink, signal: AbortSignal): Promise<ExternalRunResult>;
}

export interface VersionStrategy {
  readonly id: string;
  readonly versionRange: string;
  readonly capabilities: VersionCapabilities;

  buildVersionProbe(executable: ExecutableRef): SpawnSpec;
  buildAuthProbe(connection: CliConnectionSnapshot): SpawnSpec | null;
  buildRun(input: PreparedExternalRun): SpawnSpec;
  parseStdout(chunk: Uint8Array, state: ParserState): ParsedAgentEvent[];
  classifyExit(result: ProcessExit): NormalizedExit;
}

// ─── Deprecated aliases (backward compat, will be removed) ───────────────────

/** @deprecated Use DetectedExecutable[] + VersionStrategy instead */
export type CliDetectionResult = {
  adapterType: string;
  executablePath: string;
  detectedVersion: string | null;
  status: 'available' | 'not-found' | 'error';
};

/** @deprecated Use CliConnectionSnapshot instead */
export type CliConnectionConfig = CliConnectionSnapshot & {
  name: string;
  args: string[];
  status: string;
};

/** @deprecated Use ExternalRunRequest + AgentEventSink instead */
export type ExecuteCliOptions = {
  connectionId: string;
  instruction: string;
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
};

/** @deprecated Use ExternalRunResult instead */
export type ExecuteCliResult = ExternalRunResult;

/** @deprecated Use VersionStrategy instead */
export interface AdapterStrategy {
  readonly strategyId: string;
  buildArgs(instruction: string, cwd: string): string[];
  shouldDelegate(instruction: string): number;
}
