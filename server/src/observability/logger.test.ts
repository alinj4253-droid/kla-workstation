import { describe, expect, it } from 'vitest';
import { buildLoggerOptions, createRequestIdGenerator } from './logger.js';

describe('buildLoggerOptions', () => {
  it('test 环境关闭日志', () => {
    expect(buildLoggerOptions({ nodeEnv: 'test', logLevel: 'info' })).toBe(false);
  });

  it('注入服务上下文、级别与脱敏规则', () => {
    const options = buildLoggerOptions({ nodeEnv: 'production', logLevel: 'warn' });
    expect(options).toMatchObject({
      level: 'warn',
      base: { service: 'kla-backend', env: 'production' },
      redact: { censor: '[REDACTED]' },
    });
    const redact = (options as { redact: { paths: string[] } }).redact;
    expect(redact.paths).toContain('req.headers.authorization');
    expect(redact.paths).toContain('*.password');
    expect(redact.paths).toContain('*.accessToken');
  });
});

describe('createRequestIdGenerator', () => {
  const generate = createRequestIdGenerator();

  it('复用合法的客户端 x-request-id', () => {
    expect(generate({ headers: { 'x-request-id': 'abc-123_XYZ' } })).toBe('abc-123_XYZ');
  });

  it('非法格式回退为 UUID（不含客户端原值）', () => {
    for (const invalid of ['带 空格', 'x'.repeat(65), '', '符号!@#']) {
      const id = generate({ headers: { 'x-request-id': invalid } });
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('头部缺失或非字符串时回退为 UUID', () => {
    expect(generate({ headers: {} })).toMatch(/^[0-9a-f-]{36}$/);
    expect(generate({ headers: { 'x-request-id': ['not-a-single-value'] } })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('重复头（HTTP/1.1 合并串与 HTTP/2 数组）整体回退 UUID，不部分采纳', () => {
    expect(generate({ headers: { 'x-request-id': 'smoke-001, smoke-002' } })).toMatch(/^[0-9a-f-]{36}$/);
    expect(generate({ headers: { 'x-request-id': ['smoke-001', 'smoke-002'] } })).toMatch(/^[0-9a-f-]{36}$/);
  });
});
