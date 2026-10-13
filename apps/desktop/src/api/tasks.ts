import { createTaskRequestSchema, taskDtoSchema, type CreateTaskRequest, type TaskDto } from '@kla-workstation/contracts';
import { klaApi, type ApiResult } from './client';

export const tasksApi = {
  async create(identityId: string, input: CreateTaskRequest, requestKey: string): Promise<ApiResult<TaskDto>> {
    const body = createTaskRequestSchema.safeParse(input);
    if (!body.success) return { ok: false, code: 'INVALID_ARGUMENT', message: body.error.issues[0]?.message ?? '任务参数无效' };
    const response = await klaApi.request<TaskDto>('/v1/tasks', {
      method: 'POST', headers: { 'x-identity-id': identityId, 'idempotency-key': requestKey }, body: JSON.stringify(body.data),
    });
    if (!response.ok) return response;
    const parsed = taskDtoSchema.safeParse(response.data);
    return parsed.success ? { ...response, data: parsed.data } : { ok: false, code: 'INVALID_RESPONSE', message: '任务响应异常，请重试确认保存结果' };
  },
  async updateStatus(identityId: string, id: string, status: 'pending' | 'completed'): Promise<ApiResult<TaskDto>> {
    const response = await klaApi.request<TaskDto>(`/v1/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'x-identity-id': identityId, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ status }),
    });
    if (!response.ok) return response;
    const parsed = taskDtoSchema.safeParse(response.data);
    return parsed.success ? { ...response, data: parsed.data } : { ok: false, code: 'INVALID_RESPONSE', message: '任务响应异常，请刷新确认状态' };
  },
  remove(identityId: string, id: string): Promise<ApiResult<{ id: string }>> {
    return klaApi.request(`/v1/tasks/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'x-identity-id': identityId, 'idempotency-key': crypto.randomUUID() },
    });
  },
};
