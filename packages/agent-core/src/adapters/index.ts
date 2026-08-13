/**
 * 适配器分层目录结构
 *
 * 每种 CLI 使用独立目录：
 *   adapters/<adapter-type>/
 *   ├─ detect.ts          — CLI 检测逻辑
 *   ├─ adapter.ts         — 适配器类 + 策略导出
 *   ├─ strategies/        — 版本策略
 *   └─ contract-tests/    — 契约测试夹具
 */

export { CodexCliAdapter } from './codex/adapter.js';
export { CodexAutoStrategy } from './codex/strategies/auto.js';
export { ClaudeCodeCliAdapter } from './claude-code/adapter.js';
export { ClaudeCodeAutoStrategy } from './claude-code/strategies/auto.js';
export { AionCliAdapter } from './aion/adapter.js';
export { AionAutoStrategy } from './aion/strategies/auto.js';
export { GeminiCliAdapter } from './gemini/adapter.js';
export { GeminiAutoStrategy } from './gemini/strategies/auto.js';
export { QwenCodeCliAdapter } from './qwen-code/adapter.js';
export { QwenCodeAutoStrategy } from './qwen-code/strategies/auto.js';
export { OpencodeCliAdapter } from './opencode/adapter.js';
export { OpencodeAutoStrategy } from './opencode/strategies/auto.js';
export { KimiCliAdapter } from './kimi/adapter.js';
export { KimiAutoStrategy } from './kimi/strategies/auto.js';
export { CodeBuddyCliAdapter } from './codebuddy/adapter.js';
export { CodeBuddyAutoStrategy } from './codebuddy/strategies/auto.js';
export { CodeBuddyDetector, buildCodeBuddySearchPaths, CODEBUDDY_BINARY_NAMES } from './codebuddy/detect.js';
export { AcpCliAdapter } from './acp/adapter.js';
export { ACP_CLI_REGISTRY, getAcpRegistryEntry, buildAcpSpawnSpec } from './acp/registry.js';
export type { AcpCliRegistryEntry } from './acp/registry.js';
export { buildSpawnInvocation } from './spawn.js';
export type { SpawnInvocation } from './spawn.js';
export { runAcpSession } from './acp/session.js';
export { createAcpTransport } from './acp/transport.js';
export type { AcpSessionRunOptions, AcpSessionResult } from './acp/session.js';
export type { AcpTransportOptions, AcpTransport } from './acp/transport.js';
