import { moduleState } from './context.js';
function state() { return moduleState('process', () => ({uploads: new Map<string, AbortController>()})); }
import { randomUUID } from 'node:crypto';
import { KNOWLEDGE_UPLOAD_LIMIT, KNOWLEDGE_UPLOAD_EXTENSIONS, submitResponseSchema, type UploadInput } from '@kla-workstation/contracts/knowledge';
import { assertService } from './config.js';
import { saveBinding, hasBinding } from './documents.js';
import { beginSubmission, confirmSubmission, hasSubmission } from './submissions.js';
import { jsonRequest, KnowledgeError } from './transport.js';
export function isUploadActive(id: string): boolean { return Array.from(state().uploads.keys()).some(key => key.endsWith(`:${id}`)); }
export function abortUploads(owner?: number): void {
    for (const [key, controller] of state().uploads)
        if (owner === undefined || key.startsWith(`${owner}:`))
            controller.abort();
}
export function cancelUpload(owner: number, id: string): boolean {
    const controller = state().uploads.get(`${owner}:${id}`);
    controller?.abort();
    return Boolean(controller);
}
export async function submit(owner: number, input: UploadInput) {
    const connection = assertService(input.serviceInstanceId);
    if (!input.collection.trim() || input.collection !== connection.collection)
        throw new KnowledgeError('VALIDATION_FAILED', '请先配置明确的目标 collection。');
    if (!connection.hasUploadConsent)
        throw new KnowledgeError('PERMISSION_DENIED', '请阅读并同意当前服务的数据发送说明后上传。', false, { waitingForConsent: true });
    if (state().uploads.size >= connection.settings.uploadConcurrency)
        throw new KnowledgeError('CONFLICT', '已达到同时上传上限，请等待当前文件提交完成。', false, { notSubmitted: true });
    if (!(input.bytes instanceof ArrayBuffer) || !input.bytes.byteLength)
        throw new KnowledgeError('VALIDATION_FAILED', '文件内容为空或不可读取。');
    if (input.bytes.byteLength > KNOWLEDGE_UPLOAD_LIMIT)
        throw new KnowledgeError('FILE_TOO_LARGE', '单个文件不得超过 50MiB。');
    const ext = input.name.split('.').pop()?.toLowerCase();
    if (!ext || !(KNOWLEDGE_UPLOAD_EXTENSIONS as readonly string[]).includes(ext))
        throw new KnowledgeError('FILE_TYPE_UNSUPPORTED', '当前处理服务不支持此文件格式。');
    const key = `${owner}:${input.clientUploadId}`;
    if (state().uploads.has(key) || hasSubmission(input.clientUploadId) || hasBinding(input.clientUploadId))
        throw new KnowledgeError('DUPLICATE_REQUEST', '此提交编号已使用，请先核对现有结果。');
    const controller = new AbortController();
    state().uploads.set(key, controller);
    let sent = false;
    try {
        const physicalName = `upload-${randomUUID()}.${ext}`;
        await beginSubmission({ clientUploadId: input.clientUploadId, displayName: input.name, physicalName, collection: input.collection, serverOrigin: connection.baseUrl, credentialRef: connection.secretRef, submittedAt: new Date().toISOString() });
        if (controller.signal.aborted) {
            await confirmSubmission(input.clientUploadId);
            throw new KnowledgeError('RUN_CANCELLED', '上传已取消，未发送文件。');
        }
        // Unique physical names avoid overwriting another original in the filename-based server.
        const form = new FormData();
        form.set('file', new Blob([input.bytes], { type: input.mime }), physicalName);
        form.set('collection', input.collection);
        form.set('ingest', 'true');
        form.set('save_slices', 'true');
        form.set('fix_terms', 'false');
        sent = true;
        const response = await jsonRequest(owner, input.serviceInstanceId, '/v1/process/async', submitResponseSchema, { method: 'POST', body: form }, controller);
        if (response.filename !== physicalName)
            throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '服务返回的文件名与当前提交不一致，请核对提交记录。', false, { uncertainSubmission: true });
        const binding = await saveBinding({ clientUploadId: input.clientUploadId, serviceInstanceId: input.serviceInstanceId, serverOrigin: connection.baseUrl, credentialRef: connection.secretRef, collection: input.collection, displayName: input.name, physicalName, jobId: response.job_id, storedPath: response.stored_path, submittedAt: new Date().toISOString() });
        await confirmSubmission(input.clientUploadId);
        return binding;
    }
    catch (error) {
        const status = error instanceof KnowledgeError ? error.details?.status : undefined;
        if (!sent || (error instanceof KnowledgeError && error.details?.notSubmitted) || (typeof status === 'number' && status >= 400 && status < 500))
            await confirmSubmission(input.clientUploadId).catch(() => undefined);
        throw error;
    }
    finally {
        state().uploads.delete(key);
    }
}
