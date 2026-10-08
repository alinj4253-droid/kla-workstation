import { moduleState } from './context.js';
function state() { return moduleState('transport', () => ({requests: new Map<AbortController, number>()})); }
import type { ErrorCode } from '@kla-workstation/contracts/knowledge';
import type { ZodType, ZodTypeDef } from 'zod';
import { assertService, authHeaders } from './config.js';
export class KnowledgeError extends Error {
    constructor(public code: ErrorCode, message: string, public retryable = false, public details?: Record<string, unknown>) { super(message); }
}
export function abortRequests(owner?: number): void {
    for (const [controller, id] of state().requests)
        if (owner === undefined || owner === id)
            controller.abort();
}
export async function withResponse<T>(owner: number, serviceId: string, path: string, init: RequestInit, consume: (response: Response) => Promise<T>, controller = new AbortController(), timeout?: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispatched = false;
    state().requests.set(controller, owner);
    try {
        const connection = assertService(serviceId);
        const headers = { ...(path === '/health' ? {} : authHeaders()), ...init.headers };
        const duration = timeout ?? (init.method === 'POST' && path === '/v1/process/async' ? connection.settings.uploadTimeoutMs : connection.settings.requestTimeoutMs);
        timer = setTimeout(() => controller.abort(), duration);
        if (controller.signal.aborted)
            throw new KnowledgeError('RUN_CANCELLED', '传输已中止，未发送请求。');
        dispatched = true;
        const response = await fetch(`${connection.baseUrl}${path}`, {
            ...init, redirect: 'error', signal: controller.signal,
            headers,
        });
        if (!response.ok) {
            await response.body?.cancel();
            const code = response.status === 401 || response.status === 403 ? 'PERMISSION_DENIED' : response.status === 404 ? 'NOT_FOUND' : response.status === 409 ? 'CONFLICT' : response.status === 413 ? 'FILE_TOO_LARGE' : response.status === 422 ? 'VALIDATION_FAILED' : 'KNOWLEDGE_INGEST_FAILED';
            throw new KnowledgeError(code, response.status === 401 || response.status === 403 ? '服务拒绝访问，请检查 API Key 与权限。' : `知识服务请求失败（HTTP ${response.status}）。`, init.method !== 'POST' && response.status >= 500, { status: response.status });
        }
        const data = await consume(response);
        assertService(serviceId);
        return data;
    }
    catch (error) {
        if (error instanceof KnowledgeError) {
            if (init.method === 'POST' && !dispatched)
                error.details = { ...error.details, notSubmitted: true };
            throw error;
        }
        throw new KnowledgeError(controller.signal.aborted ? 'RUN_CANCELLED' : 'CHANNEL_CONNECTION_FAILED', controller.signal.aborted ? '传输已中止或超时；提交结果可能需要确认。' : '无法连接知识服务，请检查地址和网络。', !init.method || init.method === 'GET', { uncertainSubmission: init.method === 'POST' && dispatched, notSubmitted: init.method === 'POST' && !dispatched });
    }
    finally {
        clearTimeout(timer);
        state().requests.delete(controller);
    }
}
export async function jsonRequest<T>(owner: number, serviceId: string, path: string, schema: ZodType<T, ZodTypeDef, unknown>, init: RequestInit = {}, controller?: AbortController): Promise<T> {
    return withResponse(owner, serviceId, path, init, async (response) => {
        const reader = response.body?.getReader();
        if (!reader)
            throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '服务响应没有内容。');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const part = await reader.read();
                if (part.done)
                    break;
                size += part.value.byteLength;
                if (size > 32 * 1024 * 1024)
                    throw new KnowledgeError('FILE_TOO_LARGE', '服务响应超过客户端处理上限。');
                chunks.push(part.value);
            }
            const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            if (!parsed.success)
                throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '服务响应字段与约定不一致，请确认部署版本。');
            return parsed.data;
        }
        catch (error) {
            if (error instanceof SyntaxError)
                throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '服务返回了非 JSON 内容。');
            throw error;
        }
        finally {
            await reader.cancel().catch(() => undefined);
        }
    }, controller);
}
