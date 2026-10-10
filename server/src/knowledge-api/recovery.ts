import { currentScope, moduleState } from './context.js';
function state() { return moduleState('recovery', () => ({running: new Map<string, Promise<SubmissionRecovery>>()})); }
import { documentListSchema, type SubmissionRecovery } from '@kla-workstation/contracts/knowledge';
import { assertService } from './config.js';
import { getUnconfirmed, confirmSubmission } from './submissions.js';
import { saveBinding, hasBinding, storedBindings } from './documents.js';
import { listJobs } from './jobs.js';
import { isUploadActive } from './process.js';
import { jsonRequest, KnowledgeError } from './transport.js';
import { fetchScopedDocuments } from './scoped-resources.js';
import { recordConfirmedUpload } from './upload-records.js';
export function recoverSubmissions(owner: number, serviceId: string, collection: string, knowledgeBaseId?: string): Promise<SubmissionRecovery> {
    const current = assertService(serviceId);
    if (current.collection !== collection)
        throw new KnowledgeError('CONFLICT', '目标集合已变更。');
    const key = `${owner}:${serviceId}:${knowledgeBaseId ?? ''}`;
    const pending = state().running.get(key);
    if (pending)
        return pending;
    const work = reconcile(owner, serviceId, collection, knowledgeBaseId).finally(() => state().running.delete(key));
    state().running.set(key, work);
    return work;
}
async function reconcile(owner: number, serviceId: string, collection: string, knowledgeBaseId?: string): Promise<SubmissionRecovery> {
    const current = assertService(serviceId);
    const pendingRecords = () => getUnconfirmed(current.baseUrl, collection, current.secretRef).filter(record => !knowledgeBaseId || record.knowledgeBaseId === knowledgeBaseId);
    const records = pendingRecords().filter(record => !isUploadActive(record.clientUploadId));
    if (!records.length)
        return { recovered: 0, unresolved: pendingRecords().length };
    const [history, files] = await Promise.all([
        listJobs(owner, serviceId),
        knowledgeBaseId && currentScope().pool
          ? fetchScopedDocuments(currentScope().pool!, { serviceInstanceId: serviceId, collection, knowledgeBaseId }).then(({ result }) => result)
          : jsonRequest(owner, serviceId, '/v1/documents?category=' + encodeURIComponent('上传文档'), documentListSchema),
    ]);
    let recovered = 0;
    for (const record of records) {
        assertService(serviceId);
        if (isUploadActive(record.clientUploadId))
            continue;
        if (hasBinding(record.clientUploadId)) {
            const binding = storedBindings(serviceId, collection).find(item => item.clientUploadId === record.clientUploadId
                && (!knowledgeBaseId || item.knowledgeBaseId === knowledgeBaseId));
            if (!binding) continue;
            await recordConfirmedUpload(binding);
            await confirmSubmission(record.clientUploadId);
            recovered++;
            continue;
        }
        // Correlate only the exact client-generated UUID storage token plus explicit
        // collection and real job/document IDs. User filenames are never guessed.
        if (!/^upload-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.[a-z0-9]+$/i.test(record.physicalName))
            continue;
        const jobs = history.jobs.filter(job => job.type === 'process' && job.filename === record.physicalName && job.params?.collection === collection && job.params?.ingest === true);
        const originals = files.documents.filter(doc => doc.category === '上传文档' && doc.name === record.physicalName);
        if (jobs.length !== 1 || originals.length !== 1)
            continue;
        const job = jobs[0]!;
        const original = originals[0]!;
        if (typeof job.artifacts?.stored_path === 'string' && job.artifacts.stored_path !== original.abs_path)
            continue;
        const binding = { clientUploadId: record.clientUploadId, knowledgeBaseId, displayName: record.displayName, physicalName: record.physicalName, submittedAt: record.submittedAt, collection, serviceInstanceId: serviceId, serverOrigin: current.baseUrl, credentialRef: current.secretRef, jobId: job.job_id, storedPath: original.abs_path, docId: original.doc_id };
        await saveBinding(binding);
        await recordConfirmedUpload(binding);
        await confirmSubmission(record.clientUploadId);
        recovered++;
    }
    assertService(serviceId);
    return { recovered, unresolved: pendingRecords().length };
}
