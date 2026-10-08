import type { ApiEnvelope, ApiErrorEnvelope } from '@kla-workstation/contracts';

const defaultBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787/api';
const tokenKey = 'kla.access-token';
const expiryKey = 'kla.access-expiry';
const refreshKey = 'kla.refresh-token';
const identityKey = 'kla.identity-id';
const authExpiredEvent = 'kla:auth-expired';

export type ApiResult<T> = { ok: true; data: T; meta?: { requestId: string } } | { ok: false; code: string; message: string; error?: { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> }; meta?: { requestId: string } };

export type ApiError = ApiErrorEnvelope;

export class KlaApiClient {
  private refreshInFlight: Promise<boolean> | null = null;
  constructor(private readonly baseUrl = defaultBaseUrl) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    const isAuthEndpoint = path.startsWith('/v1/auth/');
    const expiresAt = Number(sessionStorage.getItem(expiryKey) ?? 0);
    if (!isAuthEndpoint && sessionStorage.getItem(tokenKey) && expiresAt && Date.now() >= expiresAt && !(await this.refresh())) {
      this.expireSession();
      return { ok: false, code: 'SESSION_EXPIRED', message: '登录状态已过期，请重新登录' };
    }
    const response = await this.fetchWithToken(path, init);
    const body = await response.json().catch(() => ({})) as ApiResult<T> & { error?: { code?: string; message?: string } };
    if (response.status === 401 && !isAuthEndpoint && await this.refresh()) {
      const retry = await this.fetchWithToken(path, init);
      const retryBody = await retry.json().catch(() => ({})) as ApiResult<T> & { error?: { code?: string; message?: string } };
      if (retry.ok && retryBody.ok !== false) return retryBody as ApiResult<T>;
    }
    if (!response.ok || body.ok === false) { const error = body.ok === false && 'error' in body ? body.error : undefined; return { ok: false, code: error?.code ?? `HTTP_${response.status}`, message: error?.message ?? '请求失败', error }; }
    return body as ApiResult<T>;
  }

  async stream(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchWithToken(path, init);
    if (response.status === 401 && await this.refresh()) return this.fetchWithToken(path, init);
    return response;
  }

  private async fetchWithToken(path: string, init: RequestInit): Promise<Response> {
    const token = sessionStorage.getItem(tokenKey);
    const headers = new Headers(init.headers);
    // 仅在确有请求体时才声明 JSON：Fastify 对「带 application/json 头但 body 为空」的请求直接 400
    // （曾导致身份切换、重试初始化、退出登录这类无 body 的 POST 全部失败）。
    if (init.body !== undefined && init.body !== null && !headers.has('content-type') && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    const requestedIdentity = headers.get('x-identity-id');
    if (requestedIdentity) headers.set('x-identity-id', requestedIdentity);
    else {
      const storedIdentity = sessionStorage.getItem(identityKey);
      if (storedIdentity) headers.set('x-identity-id', storedIdentity);
    }
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
  }

  private async refresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refreshToken = sessionStorage.getItem(refreshKey);
    if (!refreshToken) return false;
    this.refreshInFlight = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/v1/auth/refresh`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken, deviceId: sessionStorage.getItem('kla.device-id') ?? undefined }),
        });
        const body = await response.json().catch(() => ({})) as ApiResult<{ session: { accessToken: string; refreshToken: string; expiresAt: string } }>;
        if (!response.ok || body.ok === false || !body.data?.session) return false;
        this.setSession(body.data.session);
        return true;
      } catch { return false; }
      finally { this.refreshInFlight = null; }
    })();
    return this.refreshInFlight;
  }

  private expireSession() {
    this.clearAccessToken();
    window.dispatchEvent(new Event(authExpiredEvent));
  }

  setAccessToken(token: string | null, expiresAt?: string) {
    if (token) { sessionStorage.setItem(tokenKey, token); if (expiresAt) sessionStorage.setItem(expiryKey, String(new Date(expiresAt).getTime())); }
    else this.clearAccessToken();
  }
  setSession(session: { accessToken: string; refreshToken?: string; expiresAt: string; deviceId?: string | null }) {
    this.setAccessToken(session.accessToken, session.expiresAt);
    if (session.refreshToken) sessionStorage.setItem(refreshKey, session.refreshToken);
    if (session.deviceId) sessionStorage.setItem('kla.device-id', session.deviceId);
  }
  getRefreshToken() { return sessionStorage.getItem(refreshKey); }
  setIdentity(identityId: string | null) { if (identityId) sessionStorage.setItem(identityKey, identityId); else sessionStorage.removeItem(identityKey); }
  getIdentity() { return sessionStorage.getItem(identityKey); }
  clearAccessToken() { sessionStorage.removeItem(tokenKey); sessionStorage.removeItem(expiryKey); sessionStorage.removeItem(refreshKey); sessionStorage.removeItem(identityKey); }

  /** §7.4：导出等非 JSON 响应；仍带 Bearer，绝不把凭据放进 URL。 */
  async download(path: string): Promise<{ ok: true; blob: Blob } | { ok: false; code: string; message: string }> {
    const token = sessionStorage.getItem(tokenKey);
    const response = await fetch(`${this.baseUrl}${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (!response.ok) return { ok: false, code: `HTTP_${response.status}`, message: '导出失败，请稍后重试' };
    return { ok: true, blob: await response.blob() };
  }
}

export const klaApi = new KlaApiClient();
export const authExpiredEventName = authExpiredEvent;
