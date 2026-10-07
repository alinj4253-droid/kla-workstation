import 'dotenv/config';

const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export type ServerConfig = {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  databaseSchema: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 8787);
  const requestedLevel = env.LOG_LEVEL ?? 'info';
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    host: env.HOST ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 8787,
    logLevel: LOG_LEVELS.has(requestedLevel) ? requestedLevel : 'info',
    databaseUrl: env.DATABASE_URL ?? '',
    redisUrl: env.REDIS_URL ?? '',
    databaseSchema: /^[a-z_][a-z0-9_]*$/i.test(env.DATABASE_SCHEMA ?? 'kla') ? (env.DATABASE_SCHEMA ?? 'kla') : 'kla',
  };
}
