export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE_REQUEST'
  | 'DATABASE_UNAVAILABLE'
  | 'MIGRATION_FAILED'
  | 'STUDIO_WORKSPACE_INVALID'
  | 'STUDIO_WORKSPACE_LOCKED'
  | 'WORKSPACE_NOT_READY'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'FILE_TOO_LARGE'
  | 'FILE_TYPE_UNSUPPORTED'
  | 'FILE_OPERATION_FAILED'
  | 'PREVIEW_FAILED'
  | 'AGENT_UNAVAILABLE'
  | 'AGENT_PROTOCOL_ERROR'
  | 'AGENT_VERSION_INCOMPATIBLE'
  | 'AGENT_TIMEOUT'
  | 'RUN_CANCELLED'
  | 'RUNTIME_UNAVAILABLE'
  | 'MODEL_PROVIDER_UNAVAILABLE'
  | 'MODEL_CAPABILITY_MISMATCH'
  | 'PERMISSION_DENIED'
  | 'MEMORY_VALIDATION_FAILED'
  | 'KNOWLEDGE_INGEST_FAILED'
  | 'SECRET_STORAGE_UNAVAILABLE'
  | 'CHANNEL_AUTH_FAILED'
  | 'CHANNEL_CONNECTION_FAILED'
  | 'CHANNEL_RATE_LIMITED'
  | 'INTERNAL_ERROR';

export type RpcSuccess<T> = {
  ok: true;
  requestId: string;
  data: T;
};

export type RpcFailure = {
  ok: false;
  requestId: string;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
};

export type RpcResult<T> = RpcSuccess<T> | RpcFailure;
