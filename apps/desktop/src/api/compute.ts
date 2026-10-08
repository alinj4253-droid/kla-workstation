// 算力模块 API 适配层（§7.1–§7.4）
// 统一走 klaApi，携带 Bearer 会话令牌；不接触任何 Sub2API 密钥（§12）。

import type {
  ComputeAllocationRequest,
  ComputeAllocationResponse,
  ComputeBalance,
  ComputeKeyList,
  ComputeModelList,
  ComputeOrgLedger,
  ComputeOrgMemberList,
  ComputeOrgOverview,
  ComputeOrgSummary,
  ComputeSummary,
  ComputeUsageRecord,
  ComputeUsageSummary,
  ComputeUsageQuery,
  CreateComputeKeyRequest,
  CreateComputeKeyResponse,
  OrganizationInfo,
  PagedData,
  ProvisionState,
  ProvisionStatus,
  UpdateComputeKeyRequest,
} from '@kla-workstation/contracts';
import { klaApi, type ApiResult } from './client';

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const computeApi = {
  summary: (): Promise<ApiResult<ComputeSummary>> => klaApi.request<ComputeSummary>('/v1/compute/summary'),

  balance: (): Promise<ApiResult<ComputeBalance>> => klaApi.request<ComputeBalance>('/v1/compute/balance'),

  provisionStatus: (): Promise<ApiResult<ProvisionStatus>> => klaApi.request<ProvisionStatus>('/v1/compute/provision-status'),

  retryProvision: (): Promise<ApiResult<{ identityId: string; state: ProvisionState; accepted: boolean }>> =>
    klaApi.request('/v1/compute/provision/retry', { method: 'POST' }),

  keys: (): Promise<ApiResult<ComputeKeyList>> => klaApi.request<ComputeKeyList>('/v1/compute/keys'),

  createKey: (body: CreateComputeKeyRequest): Promise<ApiResult<CreateComputeKeyResponse>> =>
    klaApi.request<CreateComputeKeyResponse>('/v1/compute/keys', { method: 'POST', body: JSON.stringify(body) }),

  updateKey: (keyId: string, body: UpdateComputeKeyRequest): Promise<ApiResult<unknown>> =>
    klaApi.request(`/v1/compute/keys/${keyId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  disableKey: (keyId: string): Promise<ApiResult<unknown>> => klaApi.request(`/v1/compute/keys/${keyId}/disable`, { method: 'POST' }),

  deleteKey: (keyId: string): Promise<ApiResult<unknown>> => klaApi.request(`/v1/compute/keys/${keyId}`, { method: 'DELETE' }),

  models: (): Promise<ApiResult<ComputeModelList>> => klaApi.request<ComputeModelList>('/v1/compute/models'),

  usage: (query: Partial<ComputeUsageQuery>): Promise<ApiResult<PagedData<ComputeUsageRecord>>> =>
    klaApi.request<PagedData<ComputeUsageRecord>>(`/v1/compute/usage${queryString(query as Record<string, string | number | undefined>)}`),

  usageSummary: (query: { from?: string; to?: string; scope?: 'self' | 'organization' }): Promise<ApiResult<ComputeUsageSummary>> =>
    klaApi.request<ComputeUsageSummary>(`/v1/compute/usage/summary${queryString(query)}`),

  /** §7.4：导出由服务端生成并做权限校验；前端仅下载。 */
  exportUsage: (query: { from?: string; to?: string; scope?: 'self' | 'organization' }): Promise<{ ok: true; blob: Blob } | { ok: false; code: string; message: string }> =>
    klaApi.download(`/v1/compute/usage/export${queryString({ ...query, format: 'csv' })}`),

  // ---- §7.5 企业额度管理（企业管理员视角；A 侧接口，服务端二次校验成员与权限）----

  orgSummary: (orgId: string): Promise<ApiResult<ComputeOrgSummary>> =>
    klaApi.request<ComputeOrgSummary>(`/v1/organizations/${orgId}/compute/summary`),

  /** 成员管理页一次性数据：企业池聚合 + 成员（角色/额度/建号状态）+ 流水 + 邀请码 */
  orgOverview: (orgId: string): Promise<ApiResult<ComputeOrgOverview>> =>
    klaApi.request<ComputeOrgOverview>(`/v1/organizations/${orgId}/compute/overview`),

  /** 企业基本信息（含邀请码），仅本企业成员可查 */
  orgInfo: (orgId: string): Promise<ApiResult<OrganizationInfo>> =>
    klaApi.request<OrganizationInfo>(`/v1/organizations/${orgId}`),

  orgMembers: (orgId: string): Promise<ApiResult<ComputeOrgMemberList>> =>
    klaApi.request<ComputeOrgMemberList>(`/v1/organizations/${orgId}/compute/members`),

  orgLedger: (orgId: string): Promise<ApiResult<ComputeOrgLedger>> =>
    klaApi.request<ComputeOrgLedger>(`/v1/organizations/${orgId}/compute/ledger`),

  /** 从企业池分配额度给成员；服务端会二次校验目标身份属于该企业。 */
  allocate: (orgId: string, body: ComputeAllocationRequest): Promise<ApiResult<ComputeAllocationResponse>> =>
    klaApi.request<ComputeAllocationResponse>(`/v1/organizations/${orgId}/compute/allocations`, { method: 'POST', body: JSON.stringify(body) }),

  /** 从成员回收额度，ledgerId 为对应的分配流水。 */
  reclaim: (orgId: string, ledgerId: string, body: ComputeAllocationRequest): Promise<ApiResult<ComputeAllocationResponse>> =>
    klaApi.request<ComputeAllocationResponse>(`/v1/organizations/${orgId}/compute/allocations/${ledgerId}/reclaim`, { method: 'POST', body: JSON.stringify(body) }),
};