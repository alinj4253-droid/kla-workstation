import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

loadDotenv({
  path: process.env.DOTENV_CONFIG_PATH || resolve(dirname(fileURLToPath(import.meta.url)), '../.env'),
  // The local preview launcher explicitly opts into its server/.env
  // so an inherited shell value such as SUB2API_BASE_URL=/api cannot shadow the
  // absolute upstream URL required by the compute gateway.
  override: process.env.DOTENV_CONFIG_OVERRIDE === 'true' || process.env.NODE_ENV !== 'production',
  quiet: true,
});

const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
function positiveInterval(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : fallback;
}

export type Sub2ApiConfig = {
  baseUrl: string;
  adminApiKey: string;
  timeoutMs: number;
  defaultGroupId: string;
  personalGroupId: string;
  fastGroupId: string;
  /** 托管账号内部邮箱域名（设计文档 §3.2）：Sub2API 的登录/建号标识是 email，
   * KLA 侧保存确定性用户名（kla-personal-{identityId}），由此域名拼出内部邮箱。
   */
  accountEmailDomain: string;
};

export type ComputeConfig = {
  usageSyncIntervalMs: number;
  outboxIntervalMs: number;
  reconciliationEnabled: boolean;
  secretEncryptionKey: string;
  modelTimeoutMs: number;
  toolModelTimeoutMs: number;
  /** Model Gateway 预扣下限（美元）：调用前的软额度闸门金额（§4.2、§8.3） */
  minReserveUsd: number;
  /** 预扣超时自动释放（毫秒）：进程异常终止后兜底回收，防止可用余额被残留占位永久虚减 */
  reserveTimeoutMs: number;
  /** 上游 → KLA 余额对账周期（毫秒）：追认直接在 Sub2API 管理面发生的充值，补记为充值流水 */
  balanceReconcileIntervalMs: number;
  /**
   * 算力点汇率：1 USD = pointsPerUsd 点（DESIGN_POINTS_BASED_BILLING.md §3）。
   * 当前 1 元 = 1 美元 = 1000 积分；调整必须与存量重估迁移及兼容触发器同时发布。
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

/** Independent server-only WeKnora configuration; never sent to models or clients. */
export type WeKnoraConfig = {
  baseUrl: string;
  apiKey: string;
  knowledgeBaseIds: string[];
  timeoutMs: number;
  maxConcurrent: number;
  queueLimit: number;
  cacheTtlMs: number;
  cacheVersion: string;
};

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

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
  weknora?: WeKnoraConfig;
  objectStoragePath: string;
  objectStorageMaxFileBytes: number;
  agentStepMaxTurns: number;
  pointsAdmin: {
    username: string;
    password: string;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 8787);
  const requestedLevel = env.LOG_LEVEL ?? 'info';
  const sub2apiBaseUrl = env.SUB2API_BASE_URL?.trim() ?? '';
  if (sub2apiBaseUrl && !/^https?:\/\/[^/]+/i.test(sub2apiBaseUrl)) {
    throw new Error('SUB2API_BASE_URL 必须是完整的 http(s) 地址');
  }
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    host: env.HOST ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 8787,
    logLevel: LOG_LEVELS.has(requestedLevel) ? requestedLevel : 'info',
    databaseUrl: env.DATABASE_URL ?? '',
    redisUrl: env.REDIS_URL ?? '',
    databaseSchema: /^[a-z_][a-z0-9_]*$/i.test(env.DATABASE_SCHEMA ?? 'kla') ? (env.DATABASE_SCHEMA ?? 'kla') : 'kla',
    sub2api: {
      baseUrl: sub2apiBaseUrl,
      adminApiKey: env.SUB2API_ADMIN_API_KEY ?? env.SUB2API_API_KEY ?? '',
      timeoutMs: Number(env.SUB2API_TIMEOUT_MS ?? 15000),
      defaultGroupId: env.SUB2API_DEFAULT_GROUP_ID ?? '',
      personalGroupId: env.SUB2API_PERSONAL_GROUP_ID ?? '',
      fastGroupId: env.SUB2API_FAST_GROUP_ID ?? '',
      accountEmailDomain: env.SUB2API_ACCOUNT_EMAIL_DOMAIN ?? 'kla.internal',
    },
    compute: {
      usageSyncIntervalMs: Number(env.COMPUTE_USAGE_SYNC_INTERVAL_MS ?? 5000),
      outboxIntervalMs: Number(env.COMPUTE_OUTBOX_INTERVAL_MS ?? 5000),
      reconciliationEnabled: env.COMPUTE_RECONCILIATION_ENABLED === 'true',
      secretEncryptionKey: env.COMPUTE_SECRET_ENCRYPTION_KEY ?? '',
      modelTimeoutMs: positiveInterval(env.SUB2API_MODEL_TIMEOUT_MS, 60000),
      toolModelTimeoutMs: positiveInterval(env.SUB2API_TOOL_MODEL_TIMEOUT_MS, 300000),
      minReserveUsd: Number(env.COMPUTE_MIN_RESERVE_USD ?? 0.01),
      reserveTimeoutMs: positiveInterval(env.COMPUTE_RESERVE_TIMEOUT_MS, 600000),
      balanceReconcileIntervalMs: positiveInterval(env.COMPUTE_BALANCE_RECONCILE_INTERVAL_MS, 60_000),
      pointsPerUsd: Number(env.POINTS_PER_USD ?? 1000),
    },
    tools: {
      bochaApiKey: env.BOCHA_API_KEY ?? '',
    },
    weknora: {
      baseUrl: env.WEKNORA_BASE_URL?.trim() ?? '',
      apiKey: env.WEKNORA_API_KEY?.trim() ?? '',
      knowledgeBaseIds: [...new Set((env.WEKNORA_KNOWLEDGE_BASE_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean))],
      timeoutMs: boundedInteger(env.WEKNORA_TIMEOUT_MS, 15000, 100, 120000),
      maxConcurrent: boundedInteger(env.WEKNORA_MAX_CONCURRENT, 2, 1, 32),
      queueLimit: boundedInteger(env.WEKNORA_QUEUE_LIMIT, 16, 0, 256),
      cacheTtlMs: boundedInteger(env.WEKNORA_CACHE_TTL_MS, 60000, 0, 3600000),
      cacheVersion: env.WEKNORA_CACHE_VERSION?.trim() || '1',
    },
    objectStoragePath: resolve(env.OBJECT_STORAGE_PATH ?? resolve(process.cwd(), '.runtime/object-storage')),
    objectStorageMaxFileBytes: Math.max(1, Number(env.OBJECT_STORAGE_MAX_FILE_BYTES ?? 100 * 1024 * 1024)),
    agentStepMaxTurns: Math.max(1, Math.min(1000, Math.floor(Number(env.AGENT_STEP_MAX_TURNS ?? 64) || 64))),
    pointsAdmin: {
      username: env.POINTS_ADMIN_USERNAME ?? 'admin',
      password: env.POINTS_ADMIN_PASSWORD ?? 'admin123456',
    },
  };
}
