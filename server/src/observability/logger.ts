import type { IncomingHttpHeaders } from 'node:http';

/** 规范见 docs/OBSERVABILITY_SPEC.md §1–§2。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.set-cookie',
  'req.headers.x-api-key',
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
];

export type LoggerConfig = { nodeEnv: string; logLevel: string };

export type FastifyLoggerOptions = { level: string; base: { service: string; env: string }; redact: { paths: string[]; censor: string } };

/** Fastify/pino 日志选项：结构化 JSON、注入服务上下文、脱敏敏感字段；test 环境关闭。 */
export function buildLoggerOptions(config: LoggerConfig): false | FastifyLoggerOptions {
  if (config.nodeEnv === 'test') return false;
  return {
    level: config.logLevel,
    base: { service: 'kla-backend', env: config.nodeEnv },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
}

export type RequestIdGenerator = (req: { headers: IncomingHttpHeaders }) => string;

/**
 * 请求 ID 生成器：复用合法的客户端 x-request-id，否则生成 UUID（规范 §2）。
 * 注意：重复头不作部分采纳——HTTP/1.1 下 Node 将重复头合并为逗号串（天然过不了校验），
 * HTTP/2 下可能表现为数组；两种情况都说明客户端提供了多个互相矛盾的 ID，
 * 此时取任意一个都是不确定行为，整体回退 UUID（与 W3C Trace Context 对重复 traceparent 的处理一致）。
 */
export function createRequestIdGenerator(): RequestIdGenerator {
  return (req) => {
    const incoming = req.headers['x-request-id'];
    return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : globalThis.crypto.randomUUID();
  };
}
