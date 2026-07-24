export type Identifier = string;
export type ProjectStatus = 'active' | 'reviewing' | 'archived';
export type AgentRunStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelling' | 'cancelled' | 'interrupted';

export type { ErrorCode, RpcSuccess, RpcFailure, RpcResult } from './error-codes.js';
export * from './ipc-schemas.js';
export * from './agent-events.js';
