import { jobSnapshotSchema } from '@kla-workstation/contracts/knowledge';
import type { KnowledgeLibraryBridge, RpcResult, ErrorCode, JobEvent } from '@kla-workstation/contracts/knowledge';
import { klaApi } from './client';
import { v4 as randomUUID } from 'uuid';
const listeners = new Set<(event: JobEvent) => void>();
const subscriptions = new Map<string, AbortController>();
async function rpc<T>(operation: string, input: unknown = {}, init?: RequestInit): Promise<RpcResult<T>> {
  try {
    const result = await klaApi.request<T>('/v1/knowledge-library/' + operation, init ?? { method: 'POST', body: JSON.stringify(input) });
    const requestId = result.meta?.requestId ?? randomUUID();
    if (result.ok) return { ok: true, requestId, data: result.data };
    return { ok: false, requestId, error: { code: result.code as ErrorCode, message: result.message, retryable: result.error?.retryable ?? false, details: result.error?.details } };
  } catch { return { ok: false, requestId: randomUUID(), error: { code: 'CHANNEL_CONNECTION_FAILED', message: '无法连接 Workstation 服务端，请检查连接。', retryable: true } }; }
}
async function watch(input: { serviceInstanceId: string; jobId: string; subscriptionId: string }, controller: AbortController) {
  try {
    const response = await klaApi.stream('/v1/knowledge-library/job-events?' + new URLSearchParams(input), { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('Stream unavailable');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try {
      while (!controller.signal.aborted) {
        const part = await reader.read(); if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true }).replace(/\r/g, '');
        if (buffer.length > 2 * 1024 * 1024) throw new Error('Stream frame too large');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (data) { const event = JSON.parse(data) as JobEvent; if (event.snapshot) event.snapshot = jobSnapshotSchema.parse(event.snapshot); if (event.serviceInstanceId === input.serviceInstanceId && event.jobId === input.jobId && event.subscriptionId === input.subscriptionId) for (const listener of listeners) listener(event); }
        }
      }
    } finally { await reader.cancel().catch(() => undefined); }
  } catch { if (!controller.signal.aborted) for (const listener of listeners) listener({ ...input, disconnected: true }); }
  finally { if (subscriptions.get(input.subscriptionId) === controller) subscriptions.delete(input.subscriptionId); }
}
export const knowledgeClient: KnowledgeLibraryBridge = {
  getConnection: () => rpc('getConnection'),
  configure: input => rpc('configure', input),
  acceptUploadConsent: input => rpc('acceptUploadConsent', input),
  health: input => rpc('health', input),
  listSources: input => rpc('listSources', input),
  getBindings: input => rpc('getBindings', input),
  getUnconfirmed: input => rpc('getUnconfirmed', input),
  recoverSubmissions: input => rpc('recoverSubmissions', input),
  submit: input => {
    const { bytes, ...metadata } = input;
    return rpc('submit?' + new URLSearchParams(metadata), {}, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  },
  cancelUpload: input => rpc('cancelUpload', input),
  listJobs: input => rpc('listJobs', input),
  getJob: input => rpc('getJob', input),
  cancelJob: input => rpc('cancelJob', input),
  deleteJobRecord: input => rpc('deleteJobRecord', input),
  contentRequest: input => rpc('contentRequest', input),
  subscribeJob: async input => { subscriptions.get(input.subscriptionId)?.abort(); const controller = new AbortController(); subscriptions.set(input.subscriptionId, controller); void watch(input, controller); return { ok: true, requestId: randomUUID(), data: true }; },
  unsubscribeJob: async ({ subscriptionId }) => { subscriptions.get(subscriptionId)?.abort(); subscriptions.delete(subscriptionId); return { ok: true, requestId: randomUUID(), data: true }; },
  onJobEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export const knowledgeCatalogApi = {
  get: () => rpc<import('@kla-workstation/contracts/knowledge').LibraryEntry[]>('getCatalog'),
  save: (entries: import('@kla-workstation/contracts/knowledge').LibraryEntry[]) => rpc<import('@kla-workstation/contracts/knowledge').LibraryEntry[]>('saveCatalog', entries),
};
