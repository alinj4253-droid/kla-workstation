const defaultBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787/api';

export type ApiResult<T> = { ok: true; data: T } | {
  ok: false;
  code: string;
  message: string;
};

export class KlaApiClient {
  constructor(private readonly baseUrl = defaultBaseUrl) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    const body = await response.json() as ApiResult<T>;
    return body;
  }
}

export const klaApi = new KlaApiClient();
