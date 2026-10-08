import 'dotenv/config';

const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export type Sub2ApiConfig = {
  baseUrl: string;
  adminApiKey: string;
  timeoutMs: number;
  defaultGroupId: string;
  personalGroupId: string;
  fastGroupId: string;
  /**
   * 托管账号内部邮箱域名（设计文档 §3.2）：Sub2API 的登录/建号标识是 email，
   * KLA 侧保存确定性用户名（kla-personal-{identityId}），由此域名拼出内部邮箱。
   */
  accountEmailDomain: string;
  /**
   * 共享上游账号模式：两者都非空时，所有 KLA 身份复用该 Sub2API 账号（不再逐个建号）。
   * 用于上游只提供一个账号/一份额度的部署场景。
   */
  sharedAccountEmail: string;
  sharedAccountPassword: string;
};

export type ComputeConfig = {
  usageSyncIntervalMs: number;
  outboxIntervalMs: number;
  reconciliationEnabled: boolean;
  secretEncryptionKey: string;
  /** Model Gateway 预扣下限（美元）：调用前的软额度闸门金额（§4.2、§8.3） */
  minReserveUsd: number;
};

export type ServerConfig = {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  databaseSchema: string;
  sub2api: Sub2ApiConfig;
  compute: ComputeConfig;
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
    sub2api: {
      baseUrl: env.SUB2API_BASE_URL ?? '',
      adminApiKey: env.SUB2API_ADMIN_API_KEY ?? env.SUB2API_API_KEY ?? '',
      timeoutMs: Number(env.SUB2API_TIMEOUT_MS ?? 15000),
      defaultGroupId: env.SUB2API_DEFAULT_GROUP_ID ?? '',
      personalGroupId: env.SUB2API_PERSONAL_GROUP_ID ?? '',
      fastGroupId: env.SUB2API_FAST_GROUP_ID ?? '',
      accountEmailDomain: env.SUB2API_ACCOUNT_EMAIL_DOMAIN ?? 'kla.internal',
      sharedAccountEmail: env.SUB2API_SHARED_ACCOUNT_EMAIL ?? '',
      sharedAccountPassword: env.SUB2API_SHARED_ACCOUNT_PASSWORD ?? '',
    },
    compute: {
      usageSyncIntervalMs: Number(env.COMPUTE_USAGE_SYNC_INTERVAL_MS ?? 60000),
      outboxIntervalMs: Number(env.COMPUTE_OUTBOX_INTERVAL_MS ?? 5000),
      reconciliationEnabled: env.COMPUTE_RECONCILIATION_ENABLED === 'true',
      secretEncryptionKey: env.COMPUTE_SECRET_ENCRYPTION_KEY ?? '',
      minReserveUsd: Number(env.COMPUTE_MIN_RESERVE_USD ?? 0.01),
    },
  };
}
