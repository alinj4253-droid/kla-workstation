import type { KnowledgeLibraryBridge, RpcResult } from '@kla-workstation/contracts/knowledge';
import { knowledgeClient } from '../../api/knowledge';

export class KnowledgeApiError extends Error {
  constructor(public error: Extract<RpcResult<never>, { ok: false }>['error']) { super(error.message); }
}
export function bridge(): KnowledgeLibraryBridge { return knowledgeClient; }
export async function unwrap<T>(promise: Promise<RpcResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new KnowledgeApiError(result.error);
  return result.data;
}
export const knowledgeApi = {
  checkUploadNames: (input: Parameters<KnowledgeLibraryBridge['checkUploadNames']>[0]) => unwrap(bridge().checkUploadNames(input)),
  connection: () => unwrap(bridge().getConnection()),
  configure: (input: Parameters<KnowledgeLibraryBridge['configure']>[0]) => unwrap(bridge().configure(input)),
  acceptUploadConsent: (input: Parameters<KnowledgeLibraryBridge['acceptUploadConsent']>[0]) => unwrap(bridge().acceptUploadConsent(input)),
  health: (serviceInstanceId: string) => unwrap(bridge().health({ serviceInstanceId })),
  sources: (serviceInstanceId: string, collection: string, knowledgeBaseId?: string) => unwrap(bridge().listSources({ serviceInstanceId, collection, knowledgeBaseId })),
  bindings: (serviceInstanceId: string, collection: string, knowledgeBaseId?: string) => unwrap(bridge().getBindings({ serviceInstanceId, collection, knowledgeBaseId })),
  unconfirmed: (serviceInstanceId: string, collection: string, knowledgeBaseId?: string) => unwrap(bridge().getUnconfirmed({ serviceInstanceId, collection, knowledgeBaseId })),
  recoverSubmissions: (serviceInstanceId: string, collection: string, knowledgeBaseId?: string) => unwrap(bridge().recoverSubmissions({ serviceInstanceId, collection, knowledgeBaseId })),
  submit: (input: Parameters<KnowledgeLibraryBridge['submit']>[0]) => unwrap(bridge().submit(input)),
  cancelUpload: (clientUploadId: string) => unwrap(bridge().cancelUpload({ clientUploadId })),
  jobs: (serviceInstanceId: string) => unwrap(bridge().listJobs({ serviceInstanceId })),
  job: (serviceInstanceId: string, jobId: string) => unwrap(bridge().getJob({ serviceInstanceId, jobId })),
  cancelJob: (serviceInstanceId: string, jobId: string) => unwrap(bridge().cancelJob({ serviceInstanceId, jobId })),
  deleteJobRecord: (serviceInstanceId: string, jobId: string) => unwrap(bridge().deleteJobRecord({ serviceInstanceId, jobId })),
};
export const knowledgeKeys = {
  all: ['knowledgeLibrary'] as const,
  connection: ['knowledgeLibrary', 'connection'] as const,
  collection: (service: string, collection: string) => ['knowledgeLibrary', service, collection] as const,
  reading: (service: string, collection: string, knowledgeBaseId?: string) => ['knowledgeLibrary', 'reading', JSON.stringify(knowledgeBaseId ? [service, collection, knowledgeBaseId] : [service, collection])] as const,
  sourceContent: (service: string, collection: string, docId: string) => ['knowledgeLibrary', 'reading', JSON.stringify([service, collection]), 'slices', docId] as const,
  sources: (service: string, collection: string, knowledgeBaseId?: string) => ['knowledgeLibrary', service, collection, 'sources', knowledgeBaseId] as const,
  bindings: (service: string, collection: string, knowledgeBaseId?: string) => [...['knowledgeLibrary', service, collection, 'bindings'], ...(knowledgeBaseId ? [knowledgeBaseId] : [])] as const,
  unconfirmed: (service: string, collection: string, knowledgeBaseId?: string) => [...['knowledgeLibrary', service, collection, 'unconfirmed'], ...(knowledgeBaseId ? [knowledgeBaseId] : [])] as const,
  jobs: (service: string, collection: string) => ['knowledgeLibrary', service, collection, 'jobs'] as const,
  job: (service: string, collection: string, id: string) => ['knowledgeLibrary', service, collection, 'job', id] as const,
};
