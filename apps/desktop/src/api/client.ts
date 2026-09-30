const defaultBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787/api';
const tokenKey = 'kla.access-token';
const expiryKey = 'kla.access-expiry';
const authExpiredEvent = 'kla:auth-expired';

export type ApiResult<T> = { ok: true; data: T } | {
  ok: false;
  code: string;
  message: string;
};

export class KlaApiClient {
  constructor(private readonly baseUrl = defaultBaseUrl) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    const token = sessionStorage.getItem(tokenKey);
    const expiresAt = Number(sessionStorage.getItem(expiryKey) ?? 0);
    if (token && expiresAt && Date.now() >= expiresAt) {
      this.clearAccessToken();
      window.dispatchEvent(new Event(authExpiredEvent));
      return { ok: false, code: 'SESSION_EXPIRED', message: '登录状态已过期，请重新登录' };
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    });
    const body = await response.json().catch(() => ({})) as ApiResult<T> & { error?: { code?: string; message?: string } };
    if (response.status === 401) {
      this.clearAccessToken();
      window.dispatchEvent(new Event(authExpiredEvent));
    }
    if (!response.ok || body.ok === false) return { ok: false, code: body.ok === false ? body.code : body.error?.code ?? `HTTP_${response.status}`, message: body.ok === false ? body.message : body.error?.message ?? '请求失败' };
    return body;
  }

  setAccessToken(token: string | null, expiresAt?: string) {
    if (token) { sessionStorage.setItem(tokenKey, token); if (expiresAt) sessionStorage.setItem(expiryKey, String(new Date(expiresAt).getTime())); }
    else this.clearAccessToken();
  }
  clearAccessToken() { sessionStorage.removeItem(tokenKey); sessionStorage.removeItem(expiryKey); }
}

export const klaApi = new KlaApiClient();
export const authExpiredEventName = authExpiredEvent;
