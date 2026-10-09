import { describe, expect, it } from 'vitest';
import { buildLoggerOptions, createRequestIdGenerator, shouldQuietRequestLogging } from './logger.js';

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

  it('降噪只压设备心跳 poll，不误伤其他业务路由', () => {
    // Fastify v5 已删 autoLogging；该函数经 logController 选项的 disableRequestLogging 生效
    const ignore = shouldQuietRequestLogging;
    // 本地运行时每 2 秒一次，属高频心跳，压掉
    expect(ignore({ url: '/api/v1/runtime/devices/2f1c9a30-1111-4222-8333-444455556666/poll' })).toBe(true);
    // 同前缀但不同操作，必须保留日志
    expect(ignore({ url: '/api/v1/runtime/devices/2f1c9a30-1111-4222-8333-444455556666' })).toBe(false);
    expect(ignore({ url: '/api/v1/runtime/devices/2f1c9a30-1111-4222-8333-444455556666/receipt' })).toBe(false);
    expect(ignore({ url: '/api/v1/knowledge-library/contentRequest' })).toBe(false);
    expect(ignore({ url: '/api/v1/knowledge-library/health' })).toBe(false);
    expect(ignore({ url: undefined })).toBe(false);
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
