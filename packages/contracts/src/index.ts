export type Identifier = string;
export type ProjectStatus = 'active' | 'reviewing' | 'archived';
export type AgentRunStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelling' | 'cancelled' | 'interrupted';

export type { ErrorCode, RpcSuccess, RpcFailure, RpcResult } from './error-codes';
export * from './ipc-schemas';
export * from './agent-events';
