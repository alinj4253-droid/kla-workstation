import { moduleState, readStored } from './context.js';
function state() { return moduleState('documents', () => ({bindings: [] as StoredBinding[],writes: Promise.resolve(),proofCache: new Map<string, { expires: number; collection: string | null }>(),verifiedScope: undefined as { serviceId: string; collection: string; ids: Map<string, number> } | undefined})); }
import { z } from 'zod';
import { documentListSchema, type SourceJobBinding, type SourceList } from '@kla-workstation/contracts/knowledge';
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
export async function listSources(owner: number, serviceId: string, collection: string, origin: string, credentialRef: string | null): Promise<SourceList> {
    const result = await jsonRequest(owner, serviceId, '/v1/documents?category=' + encodeURIComponent('上传文档'), documentListSchema);
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
    const worker = async () => {
        while (cursor < scanned.length) {
            const doc = scanned[cursor++]!;
            const key = `${serviceId}:${doc.doc_id}:${doc.modified}:${doc.size}:${doc.stale}`;
            let proof = state().proofCache.get(key);
            if (!proof || proof.expires <= Date.now()) {
                try {
                    const result = await jsonRequest(owner, serviceId, `/v1/documents/${encodeURIComponent(doc.doc_id)}/slices`, sourceProofSchema);
                    if (result.doc_id !== doc.doc_id || result.count !== result.slices.length)
                        throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '服务器文档与切片信息不一致。');
                    proof = { expires: Date.now() + 60000, collection: result.collection };
                }
                catch (error) {
                    assertService(serviceId);
                    if (error instanceof KnowledgeError && ['PERMISSION_DENIED', 'CONFLICT', 'RUN_CANCELLED', 'CHANNEL_CONNECTION_FAILED'].includes(error.code))
                        throw error;
                    proof = { expires: Date.now() + 5000, collection: null };
                }
                if (state().proofCache.size >= 400)
                    state().proofCache.delete(state().proofCache.keys().next().value!);
                state().proofCache.set(key, proof);
            }
            if (proof.collection === collection) {
                ids.add(doc.doc_id);
                verified.set(doc.doc_id, proof.expires + 60000);
            }
            else if (!proof.collection)
                unclassifiedCount++;
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, scanned.length) }, worker));
    assertService(serviceId);
    state().verifiedScope = { serviceId, collection, ids: verified };
    return {
        totalWorkspaceCount: result.count,
        documents: result.documents.filter(doc => ids.has(doc.doc_id)).map(({ abs_path: _path, ...doc }) => doc),
        bindings: mapped,
        verifiedServerDocIds: Array.from(verified.keys()), unclassifiedCount,
    };
}
