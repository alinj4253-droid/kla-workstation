import type { ApiEnvelope, ApiErrorEnvelope } from '@kla-workstation/contracts';

const defaultBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787/api';

export type ApiResult<T> = ApiEnvelope<T>;

export type ApiError = ApiErrorEnvelope;

export class KlaApiClient {
  constructor(private readonly baseUrl = defaultBaseUrl) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    return (await response.json()) as ApiResult<T>;
  }
}

export const klaApi = new KlaApiClient();
