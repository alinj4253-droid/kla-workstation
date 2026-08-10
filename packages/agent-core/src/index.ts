export type AgentRuntimeMode = 'native-model' | 'external-cli';

// ─── New spec-compliant types ────────────────────────────────────────────────
export type {
  ExternalAgentStatus,
  SpawnSpec,
  DetectInput,
  DetectedExecutable,
  ExecutableRef,
  VersionEvidence,
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
} from './external-agent-adapter.js';

export type { ExternalAgentAdapter, VersionStrategy, CliConnectionSnapshot } from './external-agent-adapter.js';
export type { AdapterCapability } from './external-agent-adapter.js';

// ─── Deprecated aliases (backward compat) ────────────────────────────────────
export type {
  CliDetectionResult,
  CliConnectionConfig,
  ExecuteCliOptions,
  ExecuteCliResult,
  AdapterStrategy,
} from './external-agent-adapter.js';

// 分层目录结构导出（推荐）
export {
  CodexCliAdapter,
  CodexAutoStrategy,
  ClaudeCodeCliAdapter,
  ClaudeCodeAutoStrategy,
  AionCliAdapter,
  AionAutoStrategy,
  GeminiCliAdapter,
  GeminiAutoStrategy,
  QwenCodeCliAdapter,
  QwenCodeAutoStrategy,
  OpencodeCliAdapter,
  OpencodeAutoStrategy,
  KimiCliAdapter,
  KimiAutoStrategy,
  CodeBuddyCliAdapter,
  CodeBuddyAutoStrategy,
  CodeBuddyDetector,
  buildCodeBuddySearchPaths,
  CODEBUDDY_BINARY_NAMES,
  AcpCliAdapter,
} from './adapters/index.js';

// 向后兼容别名（通过旧路径重导出）
export { CodexCliAdapter as CodexCliAdapterLegacy, CodexAutoStrategy as CodexAutoStrategyLegacy } from './codex-adapter.js';
export { ClaudeCodeCliAdapter as ClaudeCodeCliAdapterLegacy, ClaudeCodeAutoStrategy as ClaudeCodeAutoStrategyLegacy } from './claude-code-adapter.js';

export { getContract, validateCapabilities, validateStrategy } from './contract-validator.js';
export type { AdapterContract, StrategyContract } from './contract-validator.js';
