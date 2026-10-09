import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV !== 'production') {
  loadDotenv({
    path: process.env.DOTENV_CONFIG_PATH || resolve(dirname(fileURLToPath(import.meta.url)), '../.env'),
    override: true,
    quiet: true,
  });
}

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
  /**
   * 算力点汇率：1 USD = pointsPerUsd 点（DESIGN_POINTS_BASED_BILLING.md §3）。
   * MVP 恒定；调整视同重大变更（发版 + 存量重估迁移），不是运行时可改参数。
   */
  pointsPerUsd: number;
};

export type ToolsConfig = {
  /**
   * 博查 Web Search API Key：平台统一持有，仅服务端使用，绝不下发客户端。
   * 见 docs/DESIGN_BOCHA_SEARCH_INTEGRATION.md §4。
   */
  bochaApiKey: string;
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
  tools: ToolsConfig;
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
      pointsPerUsd: Number(env.POINTS_PER_USD ?? 1000),
    },
    tools: {
      bochaApiKey: env.BOCHA_API_KEY ?? '',
    },
  };
}
