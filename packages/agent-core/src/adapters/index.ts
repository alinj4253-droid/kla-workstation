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

export { CodexCliAdapter } from './codex/adapter';
export { CodexAutoStrategy } from './codex/strategies/auto';
export { ClaudeCodeCliAdapter } from './claude-code/adapter';
export { ClaudeCodeAutoStrategy } from './claude-code/strategies/auto';