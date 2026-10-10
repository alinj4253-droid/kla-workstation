import { moduleState, readStored } from './context.js';
function state() { return moduleState('documents', () => ({bindings: [] as StoredBinding[],writes: Promise.resolve(),proofCache: new Map<string, { expires: number; collection: string | null; count: number }>(),proofRequests: new Map<string, Promise<{ expires: number; collection: string | null; count: number }>>(),verifiedScope: undefined as { serviceId: string; collection: string; ids: Map<string, number> } | undefined})); }
import { z } from 'zod';
import { documentListSchema, type SourceJobBinding, type SourceList, type RemoteDocument } from '@kla-workstation/contracts/knowledge';
import { assertService, atomicJson } from './config.js';
import { jsonRequest, KnowledgeError } from './transport.js';
const bindingSchema = z.object({
    clientUploadId: z.string(), serviceInstanceId: z.string(), serverOrigin: z.string(), collection: z.string(),
    displayName: z.string(), jobId: z.string(), storedPath: z.string(), docId: z.string().optional(),
    credentialRef: z.string().nullable(), physicalName: z.string().optional(),
    submittedAt: z.string(), terminalAt: z.string().optional(), taskRecordDeletedAt: z.string().optional(),
});
type StoredBinding = z.infer<typeof bindingSchema>;
const sourceProofSchema = z.object({ doc_id: z.string(), source: z.string(), collection: z.string(), count: z.number().int().nonnegative(), slices: z.array(z.unknown()) });
export async function loadBindings(): Promise<void> {
    try {
        state().bindings = z.array(bindingSchema).parse(await readStored('bindings.json'));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
    }
}
export function publicBinding(binding: StoredBinding, serviceInstanceId = binding.serviceInstanceId): SourceJobBinding {
    const { storedPath: _path, serverOrigin: _origin, credentialRef: _credentialRef, physicalName: _physicalName, docId, terminalAt, taskRecordDeletedAt, ...rest } = binding;
    return { ...rest, serviceInstanceId, ...(docId ? { docId } : {}), ...(terminalAt ? { terminalAt } : {}), ...(taskRecordDeletedAt ? { taskRecordDeletedAt } : {}) };
}
export async function saveBinding(binding: StoredBinding): Promise<SourceJobBinding> {
    const work = state().writes.catch(() => undefined).then(async () => {
        const next = [...state().bindings.filter(item => item.clientUploadId !== binding.clientUploadId), binding];
        await atomicJson('bindings.json', next);
        state().bindings = next;
        return publicBinding(binding);
    });
    state().writes = work.then(() => undefined, () => undefined);
    return work;
}
export function getBindings(serviceId: string, collection: string, origin: string, credentialRef: string | null): SourceJobBinding[] {
    return state().bindings.filter(b => b.serverOrigin === origin && b.collection === collection && b.credentialRef === credentialRef).map(b => publicBinding(b, serviceId));
}
export function hasBinding(id: string): boolean { return state().bindings.some(b => b.clientUploadId === id); }
export async function markJobRecordDeleted(serviceId: string, jobId: string): Promise<SourceJobBinding> {
    const config = assertService(serviceId);
    const matches = (binding: StoredBinding) => binding.jobId === jobId && binding.serverOrigin === config.baseUrl && binding.collection === config.collection && binding.credentialRef === config.secretRef;
    const work = state().writes.catch(() => undefined).then(async () => {
        assertService(serviceId);
        const binding = state().bindings.find(matches);
        if (!binding)
            throw new KnowledgeError('NOT_FOUND', '当前集合没有此任务记录，请刷新任务列表。');
        if (binding.taskRecordDeletedAt)
            return publicBinding(binding, serviceId);
        const deleted = { ...binding, taskRecordDeletedAt: new Date().toISOString() };
        const next = state().bindings.map(item => matches(item) ? { ...item, taskRecordDeletedAt: deleted.taskRecordDeletedAt } : item);
        await atomicJson('bindings.json', next);
        state().bindings = next;
        return publicBinding(deleted, serviceId);
    });
    state().writes = work.then(() => undefined, () => undefined);
    return work;
}
export function assertBoundResource(serviceId: string, resource: {
    jobId: string;
} | {
    docId: string;
}): void {
    const config = assertService(serviceId);
    const allowed = getBindings(serviceId, config.collection, config.baseUrl, config.secretRef);
    const verifiedScope = state().verifiedScope;
    const verifiedDocument = 'docId' in resource && verifiedScope?.serviceId === serviceId && verifiedScope.collection === config.collection && (verifiedScope.ids.get(resource.docId) ?? 0) > Date.now();
    if (!verifiedDocument && !allowed.some(binding => 'jobId' in resource ? binding.jobId === resource.jobId : binding.docId === resource.docId)) {
        throw new KnowledgeError('PERMISSION_DENIED', '此任务或文档尚未确认关联到当前服务和集合，请刷新文件列表。', false, { notSubmitted: true });
    }
}

/**
 * 对不在本地绑定表的文档做实时归属校验（listSources 的 proof 扫描同款判定）：
 * 远端 /slices 明确返回「本文档属于当前集合」才放行，并把结果写入 verifiedScope。
 *
 * 背景：已存在的服务器文件（如其他端上传的视频）不在 bindings.json 里，原先只能靠
 * listSources 扫描时写入的 verifiedScope（内存态、约 2 分钟过期、server 重启即清空）
 * 在窗口期内访问；一旦过期，/slices、/document 等读取全部 403，前端出现整片
 * 「没有权限读取该来源的切片」红条。真正的授权依据是远端服务的归属确认，这里在
 * 访问时按需补做一次，成功后延长缓存（10 分钟）以避免逐请求重复打远端。
 */
export async function verifyDocumentScope(owner: number, serviceId: string, docId: string): Promise<boolean> {
    const config = assertService(serviceId);
    try {
        const proof = await jsonRequest(owner, serviceId, `/v1/documents/${encodeURIComponent(docId)}/slices`, sourceProofSchema);
        if (proof.doc_id !== docId || proof.count !== proof.slices.length || proof.collection !== config.collection)
            return false;
        const previous = state().verifiedScope;
        const ids = previous?.serviceId === serviceId && previous.collection === config.collection ? previous.ids : new Map<string, number>();
        ids.set(docId, Date.now() + 600000);
        state().verifiedScope = { serviceId, collection: config.collection, ids };
        return true;
    }
    catch {
        return false;
    }
}
export async function listSources(owner: number, serviceId: string, collection: string, origin: string, credentialRef: string | null): Promise<SourceList> {
    const result = await jsonRequest(owner, serviceId, '/v1/documents?category=' + encodeURIComponent('上传文档'), documentListSchema, {}, undefined, 10000);
    // Only exact returned storage paths associate a remote source with a client submission.
    // Unknown global workspace files are never presented as authorized library contents.
    const work = state().writes.catch(() => undefined).then(async () => {
        assertService(serviceId);
        let changed = false;
        const next = state().bindings.map(binding => {
            if (binding.serverOrigin !== origin || binding.collection !== collection || binding.credentialRef !== credentialRef)
                return binding;
            const name = binding.physicalName ?? binding.storedPath.split(/[\\/]/).pop();
            const matches = result.documents.filter(doc => doc.abs_path === binding.storedPath && doc.name === name);
            const docId = matches.length === 1 ? matches[0]!.doc_id : undefined;
            if (binding.docId === docId)
                return binding;
            changed = true;
            const { docId: _oldDocId, ...rest } = binding;
            return { ...rest, ...(docId ? { docId } : {}) };
        });
        if (changed) {
            await atomicJson('bindings.json', next);
            state().bindings = next;
        }
        assertService(serviceId);
        return getBindings(serviceId, collection, origin, credentialRef);
    });
    state().writes = work.then(() => undefined, () => undefined);
    const mapped = await work;
    const ids = new Set(mapped.flatMap(b => b.docId ? [b.docId] : []));
    // Existing server files are included only when that document's slices endpoint
    // explicitly identifies the current collection. No scope or path is guessed.
    const candidates = result.documents.filter(doc => !ids.has(doc.doc_id)).sort((a, b) => b.modified.localeCompare(a.modified));
    const scanned = candidates.slice(0, 200);
    const verified = new Map<string, number>();
    let unclassifiedCount = candidates.length - scanned.length;
    let cursor = 0;
    const scanDeadline = Date.now() + 10000;
    const worker = async () => {
        while (cursor < scanned.length && Date.now() < scanDeadline) {
            const doc = scanned[cursor++]!;
            const proof = await documentProof(owner, serviceId, doc);
            if (proof.collection === collection) {
                ids.add(doc.doc_id);
                verified.set(doc.doc_id, proof.expires + 60000);
            }
            else if (!proof.collection)
                unclassifiedCount++;
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, scanned.length) }, worker));
    unclassifiedCount += scanned.length - cursor;
    assertService(serviceId);
    state().verifiedScope = { serviceId, collection, ids: verified };
    return {
        totalWorkspaceCount: result.count,
        documents: result.documents.filter(doc => ids.has(doc.doc_id)).map(({ abs_path: _path, ...doc }) => doc),
        bindings: mapped,
        verifiedServerDocIds: Array.from(verified.keys()), unclassifiedCount,
    };
}

/** Classification proofs are shared across collection switches, scoped to this identity and credential. */
export async function documentProof(owner: number, serviceId: string, doc: RemoteDocument) {
    const config = assertService(serviceId);
    const key = JSON.stringify([config.baseUrl, config.secretRef, doc.doc_id, doc.modified, doc.size, doc.stale]);
    const cached = state().proofCache.get(key);
    if (cached && cached.expires > Date.now()) return cached;
    const requestKey = JSON.stringify([serviceId, key]);
    let pending = state().proofRequests.get(requestKey);
    if (!pending) {
        pending = (async () => {
            let proof;
            try {
                // A single slow/unprocessed document must not hold every collection for 120 seconds.
                const result = await jsonRequest(owner, serviceId, '/v1/documents/' + encodeURIComponent(doc.doc_id) + '/slices', sourceProofSchema, {}, undefined, Math.min(5000, config.settings.requestTimeoutMs));
                if (result.doc_id !== doc.doc_id || result.count !== result.slices.length) throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '服务器文档与切片信息不一致。');
                proof = { expires: Date.now() + 15000, collection: result.collection, count: result.count };
            } catch (error) {
                // Changed services still fail; individual classification timeouts remain unresolved.
                assertService(serviceId);
                if (error instanceof KnowledgeError && ['PERMISSION_DENIED', 'CONFLICT', 'CHANNEL_CONNECTION_FAILED'].includes(error.code)) throw error;
                proof = { expires: Date.now() + 5000, collection: null, count: 0 };
            }
            if (state().proofCache.size >= 400) state().proofCache.delete(state().proofCache.keys().next().value!);
            state().proofCache.set(key, proof);
            return proof;
        })();
        state().proofRequests.set(requestKey, pending);
    }
    try { const proof = await pending; assertService(serviceId); return proof; }
    finally { if (state().proofRequests.get(requestKey) === pending) state().proofRequests.delete(requestKey); }
}

/** Exact storage association, also used for pending documents that have no slices yet. */
export function matchedDocumentBinding(serviceId: string, collection: string, doc: RemoteDocument & { abs_path: string }) {
    const config = assertService(serviceId);
    const matches = state().bindings.filter(binding => binding.serverOrigin === config.baseUrl && binding.collection === collection
      && binding.credentialRef === config.secretRef && binding.storedPath === doc.abs_path
      && (binding.physicalName ?? binding.storedPath.split(/[\\/]/).pop()) === doc.name);
    return matches.length === 1 ? publicBinding(matches[0]!, serviceId) : undefined;
}
