export type AdminAccount = {
  identityId: string;
  email: string;
  displayName: string;
  available: number;
};

export type Company = {
  organizationId: string;
  organizationName: string;
  status: string;
  companyPoints: number;
  admins: AdminAccount[];
};

export type CompanyPage = {
  items: Company[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  summary: { totalCompanies: number; totalPoints: number };
};

type Envelope<T> = { ok: boolean; data?: T; error?: { message?: string } };

const TOKEN_KEY = 'kla.points-admin.token';
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export function getAdminToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setAdminToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  const token = getAdminToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => ({})) as Envelope<T>;
  if (!response.ok || payload.ok === false) {
    if (response.status === 401) clearAdminToken();
    throw new Error(payload.error?.message ?? `请求失败（${response.status}）`);
  }
  return payload.data as T;
}

export async function login(username: string, password: string): Promise<void> {
  const data = await request<{ token: string }>('/api/v1/admin/points/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setAdminToken(data.token);
}

export async function logout(): Promise<void> {
  try {
    await request<null>('/api/v1/admin/points/logout', { method: 'POST', body: '{}' });
  } finally {
    clearAdminToken();
  }
}

export function listCompanies(page = 1): Promise<CompanyPage> {
  return request<CompanyPage>(`/api/v1/admin/points/companies?page=${page}`);
}

export function grantPoints(organizationId: string, identityId: string, points: number): Promise<unknown> {
  return request(`/api/v1/admin/points/companies/${organizationId}/grant`, {
    method: 'POST',
    body: JSON.stringify({ identityId, points, requestId: crypto.randomUUID() }),
  });
}

export function revokePoints(organizationId: string, identityId: string, points: number): Promise<unknown> {
  return request(`/api/v1/admin/points/companies/${organizationId}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ identityId, points, requestId: crypto.randomUUID() }),
  });
}
