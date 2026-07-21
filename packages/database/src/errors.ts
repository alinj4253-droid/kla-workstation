import type { ErrorCode, RpcResult } from '@kunqing/contracts';

export class DatabaseError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function notFound(entity: string, id?: string): DatabaseError {
  const msg = id ? `${entity} not found: ${id}` : `${entity} not found`;
  return new DatabaseError('NOT_FOUND', msg);
}

export function conflict(entity: string, detail?: string): DatabaseError {
  return new DatabaseError('CONFLICT', `${entity} conflict${detail ? `: ${detail}` : ''}`);
}

export function validationFailed(reason: string): DatabaseError {
  return new DatabaseError('VALIDATION_FAILED', reason);
}

export function databaseUnavailable(cause?: string): DatabaseError {
  return new DatabaseError('DATABASE_UNAVAILABLE', `Database unavailable${cause ? `: ${cause}` : ''}`);
}

export function toRpcResult<T>(result: T, requestId: string): RpcResult<T> {
  return { ok: true as const, requestId, data: result };
}

export function toRpcError(error: unknown, requestId: string): RpcResult<never> {
  if (error instanceof DatabaseError) {
    const err: { code: ErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> } = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
    if (error.details !== undefined) err.details = error.details;
    return { ok: false as const, requestId, error: err };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false as const,
    requestId,
    error: { code: 'INTERNAL_ERROR' as ErrorCode, message, retryable: false },
  };
}

export function wrapHandler<T>(
  handler: () => T,
  requestId: string,
): RpcResult<T> {
  try {
    const result = handler();
    return toRpcResult(result, requestId);
  } catch (error) {
    return toRpcError(error, requestId);
  }
}
