export type AgentRuntimeMode = 'native-model' | 'external-cli';

// ─── New spec-compliant types ────────────────────────────────────────────────
export type {
  ExternalAgentStatus,
  SpawnSpec,
  DetectInput,
  DetectedExecutable,
  ExecutableRef,
  VersionEvidence,
  CliConnectionSnapshot,
  AuthProbeResult,
  ExternalRunRequest,
  AgentEventSink,
  ExternalRunResult,
  PreparedExternalRun,
  ParserState,
  ParsedAgentEvent,
  ProcessExit,
  NormalizedExit,
  VersionCapabilities,
} from './external-agent-adapter';

export type { ExternalAgentAdapter, VersionStrategy } from './external-agent-adapter';
export type { AdapterCapability } from './external-agent-adapter';

// ─── Deprecated aliases (backward compat) ────────────────────────────────────
export type {
  CliDetectionResult,
  CliConnectionConfig,
  ExecuteCliOptions,
  ExecuteCliResult,
  AdapterStrategy,
} from './external-agent-adapter';

// 分层目录结构导出（推荐）
export {
  CodexCliAdapter,
  CodexAutoStrategy,
  ClaudeCodeCliAdapter,
  ClaudeCodeAutoStrategy,
} from './adapters';

// 向后兼容别名（通过旧路径重导出）
export { CodexCliAdapter as CodexCliAdapterLegacy, CodexAutoStrategy as CodexAutoStrategyLegacy } from './codex-adapter';
export { ClaudeCodeCliAdapter as ClaudeCodeCliAdapterLegacy, ClaudeCodeAutoStrategy as ClaudeCodeAutoStrategyLegacy } from './claude-code-adapter';

export { getContract, validateCapabilities, validateStrategy } from './contract-validator';
export type { AdapterContract, StrategyContract } from './contract-validator';
