import { describe, expect, it } from 'vitest';
import { failureStatus } from './routes.js';

describe('知识库错误码 → HTTP 状态码', () => {
  it('权限与参数类错误给出可纠正的 4xx，而不是 502', () => {
    expect(failureStatus('UNAUTHENTICATED')).toBe(401);
    expect(failureStatus('PERMISSION_DENIED')).toBe(403);
    expect(failureStatus('NOT_FOUND')).toBe(404);
    expect(failureStatus('VALIDATION_FAILED')).toBe(400);
    expect(failureStatus('CONFLICT')).toBe(409);
    expect(failureStatus('DUPLICATE_REQUEST')).toBe(409);
    expect(failureStatus('RUN_CANCELLED')).toBe(409);
    expect(failureStatus('FILE_TOO_LARGE')).toBe(413);
    expect(failureStatus('FILE_TYPE_UNSUPPORTED')).toBe(415);
  });

  it('只有上游/内部失败留在 5xx，连接失败给 503', () => {
    expect(failureStatus('CHANNEL_CONNECTION_FAILED')).toBe(503);
    expect(failureStatus('KNOWLEDGE_INGEST_FAILED')).toBe(502);
    expect(failureStatus('INTERNAL_ERROR')).toBe(502);
    expect(failureStatus('SOMETHING_UNKNOWN')).toBe(502);
  });
});
