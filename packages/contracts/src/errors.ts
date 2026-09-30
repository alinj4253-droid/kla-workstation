export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'INVALID_ARGUMENT',
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'NOT_IMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'UNAVAILABLE',
  'INTERNAL',
]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export type ApiErrorBody = {
  ok: false;
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta?: { requestId: string };
};

export function apiError(
  code: ErrorCode,
  message: string,
  options?: { requestId?: string; retryable?: boolean },
): ApiErrorBody {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: options?.retryable ?? isRetryable(code),
    },
    ...(options?.requestId ? { meta: { requestId: options.requestId } } : {}),
  };
}
