// Sub2API 适配层：Admin API（建号/停用/调额/查用量）+ User API（登录/JWT/Key/分组）
// 超时与重试：SUB2API_TIMEOUT_MS 默认 15s，可重试错误最多 3 次，指数退避。
// JWT 缓存：内存 Map（RedisDatabase 暂未暴露 get/set，后续可切换）。

import { createHash } from 'node:crypto';
import type { RedisDatabase } from '../infrastructure/redis.js';

export type Sub2ApiConfig = {
  baseUrl: string;
  adminApiKey: string;
  timeoutMs: number;
  defaultGroupId: string;
  personalGroupId: string;
  fastGroupId: string;
  /** 托管账号内部邮箱域名；KLA 存确定性用户名，由此拼出 Sub2API 的 email 标识 */
  accountEmailDomain: string;
  /**
   * 共享上游账号模式：两者都非空时，所有 KLA 身份复用该 Sub2API 账号（不再逐个建号）。
   * 用于上游只给一个账号/一份额度的联调与部署场景。
   */
  sharedAccountEmail: string;
  sharedAccountPassword: string;
};

export type Sub2ApiUser = {
  id: string;
  username: string;
  balance: number;
  status: string;
};

export type Sub2ApiKey = {
  id: string;
  name: string;
  keyPrefix: string;
  keyFingerprint: string;
  status: string;
  /** §7.2：建 Key 时上游若回传完整 Key，仅用于一次性展示，不落库（§16 待联调确认） */
  secret?: string;
};

export type Sub2ApiUsageItem = {
  id: string;
  userId: string;
  model: string;
  amountUsd: number;
  promptTokens: number;
  completionTokens: number;
  timestamp: string;
};

export type Sub2ApiGroup = {
  id: string;
  name: string;
};

export class Sub2ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'Sub2ApiError';
  }
}

const RETRYABLE_CODES = new Set(['UNAVAILABLE', 'INTERNAL', 'RATE_LIMITED', 'TIMEOUT']);

function mapStatusToCode(status: number): { code: string; retryable: boolean } {
  if (status === 408 || status === 429) return { code: 'RATE_LIMITED', retryable: true };
  if (status === 401) return { code: 'UNAUTHENTICATED', retryable: false };
  if (status === 403) return { code: 'FORBIDDEN', retryable: false };
  if (status === 404) return { code: 'NOT_FOUND', retryable: false };
  if (status === 409) return { code: 'CONFLICT', retryable: false };
  if (status >= 500) return { code: 'UNAVAILABLE', retryable: true };
  return { code: 'INTERNAL', retryable: status >= 500 };
}

type RequestOptions = {
  method: string;
  path: string;
  body?: unknown;
  apiKey: string;
  bearer?: string; // 用户 JWT
};

export class Sub2ApiClient {
  private readonly jwtCache = new Map<string, { token: string; expiresAt: number }>();
  /** 代理面 Key 明文的短缓存（5 分钟），仅在内存，不落库、不下发前端 */
  private readonly keySecretCache = new Map<string, { secret: string; expiresAt: number }>();

  constructor(
    private readonly config: Sub2ApiConfig,
    private readonly redis?: RedisDatabase,
  ) {}

  private async request<T>(opts: RequestOptions): Promise<T> {
    const maxAttempts = 3;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`;
          else headers['x-api-key'] = opts.apiKey;
          const url = `${this.config.baseUrl.replace(/\/$/, '')}${opts.path}`;
          const resp = await fetch(url, {
            method: opts.method,
            headers,
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            signal: controller.signal,
          });
          const text = await resp.text();
          if (!resp.ok) {
            const mapped = mapStatusToCode(resp.status);
            throw new Sub2ApiError(mapped.code, text || resp.statusText, resp.status, mapped.retryable);
          }
          // Sub2API 统一返回 { code, message, data } 信封；/health 之类不套信封，按存在性解包。
          const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
          return ((parsed && typeof parsed === 'object' && 'data' in parsed) ? parsed.data : parsed) as T;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (isAbort) {
          lastError = new Sub2ApiError('TIMEOUT', 'Sub2API 请求超时', 408, true);
        } else if (error instanceof Sub2ApiError) {
          lastError = error;
        } else {
          lastError = new Sub2ApiError('INTERNAL', error instanceof Error ? error.message : String(error), 500, true);
        }
        const canRetry = (lastError as Sub2ApiError).retryable && attempt < maxAttempts;
        if (!canRetry) break;
        await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt - 1)));
      }
    }
    throw lastError ?? new Sub2ApiError('INTERNAL', '未知错误', 500, false);
  }

  /**
   * Sub2API 的账号标识是 email（实测建号/登录都要求 email 字段，且只校验格式不校验真实性）。
   * KLA 侧保存确定性用户名，这里按配置域名拼出内部邮箱；已是邮箱时原样返回。
   */
  private accountEmail(username: string): string {
    if (username.includes('@')) return username;
    const domain = this.config.accountEmailDomain || 'kla.internal';
    return `${username}@${domain}`;
  }

  // ---- Admin API（真实路径：/api/v1/admin/*；实测 /api/admin/* 为 404） ----

  async createUser(username: string, password: string): Promise<Sub2ApiUser> {
    const raw = await this.request<Record<string, unknown>>({
      method: 'POST',
      path: '/api/v1/admin/users',
      apiKey: this.config.adminApiKey,
      body: { email: this.accountEmail(username), password, role: 'user' },
    });
    return parseUser(raw);
  }

  async getUser(userId: string): Promise<Sub2ApiUser | null> {
    try {
      const raw = await this.request<Record<string, unknown>>({
        method: 'GET',
        path: `/api/v1/admin/users/${userId}`,
        apiKey: this.config.adminApiKey,
      });
      return parseUser(raw);
    } catch (err) {
      if (err instanceof Sub2ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** 按邮箱在管理面检索账号（实测 `?search=` 生效，其余过滤参数会被忽略）。 */
  async findUserByEmail(email: string): Promise<Sub2ApiUser | null> {
    const raw = await this.request<{ items?: Record<string, unknown>[] }>({
      method: 'GET',
      path: `/api/v1/admin/users?page=1&page_size=5&search=${encodeURIComponent(email)}`,
      apiKey: this.config.adminApiKey,
    });
    const items = Array.isArray(raw) ? raw : raw.items ?? [];
    const match = items.find((item) => String(item.email ?? '') === email);
    return match ? parseUser(match) : null;
  }

  async disableUser(userId: string): Promise<void> {
    await this.request({
      method: 'PUT',
      path: `/api/v1/admin/users/${userId}`,
      apiKey: this.config.adminApiKey,
      body: { status: 'disabled' },
    });
  }

  /**
   * 调整用户余额（增量，可为负）。
   * Sub2API 要求 body 为 { balance: 正数, operation: 'add' | 'subtract' }，balance 字段校验 gt=0。
   * 因此正增量用 add、负增量取绝对值用 subtract。
   */
  async adjustBalance(userId: string, deltaUsd: number): Promise<{ balance: number }> {
    const abs = Math.abs(deltaUsd);
    if (abs === 0) {
      return this.request<{ balance: number }>({
        method: 'POST',
        path: `/api/v1/admin/users/${userId}/balance`,
        apiKey: this.config.adminApiKey,
        body: { balance: 0, operation: 'add' },
      });
    }
    return this.request<{ balance: number }>({
      method: 'POST',
      path: `/api/v1/admin/users/${userId}/balance`,
      apiKey: this.config.adminApiKey,
      body: { balance: abs, operation: deltaUsd > 0 ? 'add' : 'subtract' },
    });
  }

  async listUsage(userId: string, since?: string, until?: string): Promise<Sub2ApiUsageItem[]> {
    const params = new URLSearchParams();
    if (since) params.set('since', since);
    if (until) params.set('until', until);
    const qs = params.toString();
    return this.request<Sub2ApiUsageItem[]>({
      method: 'GET',
      path: `/api/v1/admin/users/${userId}/usage${qs ? `?${qs}` : ''}`,
      apiKey: this.config.adminApiKey,
    });
  }

  // ---- User API（真实路径：/api/v1/*；实测 /api/user/*、/api/auth/* 均为 404） ----

  /**
   * 代理登录。实测 Sub2API 登录体要求 `email` 字段（发 username 会被 400 拒绝）；
   * 此处把身份标识串放进 email，具体内部邮箱域名的确定见待办（设计文档 §3.2）。
   */
  async loginUser(identifier: string, password: string): Promise<{ token: string }> {
    const raw = await this.request<Record<string, unknown>>({
      method: 'POST',
      path: '/api/v1/auth/login',
      apiKey: '',
      body: { email: this.accountEmail(identifier), password },
    });
    // 实测登录响应字段为 access_token（snake_case），其余为兜底候选。
    const token = raw.access_token ?? raw.accessToken ?? raw.token;
    return { token: typeof token === 'string' ? token : '' };
  }

  /** 获取用户 JWT（带内存缓存） */
  async getUserJwt(userId: string, username: string, managedPassword: string): Promise<string> {
    const cached = this.jwtCache.get(userId);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
    const { token } = await this.loginUser(username, managedPassword);
    // 保守估计 1 小时过期（Sub2API 实际过期时间由服务端决定，留 30s 缓冲）
    this.jwtCache.set(userId, { token, expiresAt: Date.now() + 3_600_000 });
    return token;
  }

  /** §6.2：建 Key 支持 name/group_id/quota/限速/IP 黑白名单/有效期，按需透传。 */
  async createApiKey(
    jwt: string,
    name: string,
    groupId: string,
    options?: { quota?: number; rpm?: number; ipAllowList?: string[]; expiresAt?: string },
  ): Promise<Sub2ApiKey> {
    // 实测 Sub2API 的 group_id 是 int64，传字符串会被 400 拒绝（配置侧是字符串，这里按需转换）。
    const parsedGroupId = Number(groupId);
    const group = groupId !== '' && Number.isFinite(parsedGroupId) ? parsedGroupId : undefined;
    const raw = await this.request<Record<string, unknown>>({
      method: 'POST',
      path: '/api/v1/keys',
      apiKey: '',
      bearer: jwt,
      body: {
        name,
        ...(group !== undefined ? { group_id: group } : {}),
        ...(options?.quota !== undefined ? { quota: options.quota } : {}),
        ...(options?.rpm !== undefined ? { rpm: options.rpm } : {}),
        ...(options?.ipAllowList && options.ipAllowList.length > 0 ? { ip_allow_list: options.ipAllowList } : {}),
        ...(options?.expiresAt !== undefined ? { expires_at: options.expiresAt } : {}),
      },
    });
    return parseKey(raw);
  }

  /** §6.2：改 Key（PUT /api/v1/keys/:id）支持配额/状态/限速。 */
  async updateApiKey(
    jwt: string,
    keyId: string,
    patch: { name?: string; quota?: number | null; rpm?: number | null; ipAllowList?: string[]; expiresAt?: string | null; status?: string },
  ): Promise<void> {
    await this.request({
      method: 'PUT',
      path: `/api/v1/keys/${keyId}`,
      apiKey: '',
      bearer: jwt,
      body: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.quota !== undefined ? { quota: patch.quota } : {}),
        ...(patch.rpm !== undefined ? { rpm: patch.rpm } : {}),
        ...(patch.ipAllowList !== undefined ? { ip_allow_list: patch.ipAllowList } : {}),
        ...(patch.expiresAt !== undefined ? { expires_at: patch.expiresAt } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      },
    });
  }

  async listApiKeys(jwt: string): Promise<Sub2ApiKey[]> {
    // 实测返回 { items: [...] }；这里同时兼容直接数组。
    const raw = await this.request<Sub2ApiKey[] | { items?: Sub2ApiKey[] }>({
      method: 'GET',
      path: '/api/v1/keys',
      apiKey: '',
      bearer: jwt,
    });
    const items = Array.isArray(raw) ? raw : raw.items ?? [];
    return items.map((item) => parseKey(item as unknown as Record<string, unknown>));
  }

  async disableApiKey(jwt: string, keyId: string): Promise<void> {
    await this.request({
      method: 'PUT',
      path: `/api/v1/keys/${keyId}`,
      apiKey: '',
      bearer: jwt,
      body: { status: 'disabled' },
    });
  }

  async deleteApiKey(jwt: string, keyId: string): Promise<void> {
    await this.request({
      method: 'DELETE',
      path: `/api/v1/keys/${keyId}`,
      apiKey: '',
      bearer: jwt,
    });
  }

  async listAvailableGroups(jwt: string): Promise<Sub2ApiGroup[]> {
    return this.request<Sub2ApiGroup[]>({
      method: 'GET',
      path: '/api/v1/groups/available',
      apiKey: '',
      bearer: jwt,
    });
  }

  // ---- 健康检查 ----

  /**
   * §8：OpenAI 兼容 chat completions，返回原始 Response 以支持 SSE 透传。
   * 实测代理面只认 API Key：`Bearer <用户 JWT>` 与 `x-api-key: <JWT>` 都会 401 INVALID_API_KEY，
   * 因此这里必须传入 Key 明文（由 resolveApiKeySecret 用 JWT 现取，不落库）。
   */
  async chatCompletions(apiKey: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    });
  }

  /**
   * 代理面所需的 Key 明文：用用户 JWT 调 `/api/v1/keys` 现取，仅在内存短缓存（5 分钟）。
   * 设计约束：KLA 数据库只保存前缀与指纹，明文既不落库也不下发前端（§12）。
   */
  async resolveApiKeySecret(jwt: string, keyId: string): Promise<string | null> {
    const cached = this.keySecretCache.get(keyId);
    if (cached && cached.expiresAt > Date.now()) return cached.secret;
    const keys = await this.listApiKeys(jwt);
    const found = keys.find((key) => key.id === keyId);
    if (!found?.secret) return null;
    this.keySecretCache.set(keyId, { secret: found.secret, expiresAt: Date.now() + 5 * 60_000 });
    return found.secret;
  }

  /** 健康检查：实测真实路径为 `/health`（`/api/health` 为 404），返回 `{status:"ok"}`。 */
  async health(): Promise<{ ok: boolean }> {
    const raw = await this.request<Record<string, unknown>>({
      method: 'GET',
      path: '/health',
      apiKey: this.config.adminApiKey,
    });
    return { ok: raw.ok === true || raw.status === 'ok' };
  }
}

// 工具：从 Sub2API 响应中提取字段（兼容 snake_case 与 camelCase）
export function parseUser(raw: Record<string, unknown>): Sub2ApiUser {
  return {
    id: String(raw.id ?? raw.user_id ?? ''),
    username: String(raw.username ?? raw.user_name ?? ''),
    balance: Number(raw.balance ?? 0),
    status: String(raw.status ?? 'active'),
  };
}

export function parseKey(raw: Record<string, unknown>): Sub2ApiKey {
  // §7.2：完整 Key 只用于创建响应一次性展示，不落库（KLA 只保存前缀与指纹）。
  const secret = [raw.key, raw.secret, raw.plain_key, raw.raw_key].find((value): value is string => typeof value === 'string' && value !== '');
  // 实测 Sub2API 不回传 key_prefix / fingerprint，只回传完整 key；缺失时由完整 Key 推导。
  const prefix = String(raw.key_prefix ?? raw.prefix ?? (secret ? secret.slice(0, 11) : ''));
  const fingerprint = String(raw.key_fingerprint ?? raw.fingerprint ?? (secret ? createHash('sha256').update(secret).digest('hex') : ''));
  return {
    id: String(raw.id ?? raw.key_id ?? ''),
    name: String(raw.name ?? ''),
    keyPrefix: prefix,
    keyFingerprint: fingerprint,
    status: String(raw.status ?? 'active'),
    ...(secret ? { secret } : {}),
  };
}

export { RETRYABLE_CODES };
