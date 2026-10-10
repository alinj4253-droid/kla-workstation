import { z } from 'zod';
import type { SearchRequest } from './knowledge-b.js';
import type { RpcResult } from './error-codes.js';

export const KNOWLEDGE_UPLOAD_LIMIT = 50 * 1024 * 1024;
export const KNOWLEDGE_UPLOAD_EXTENSIONS = ['txt', 'md', 'pdf', 'docx', 'html', 'mp3', 'wav', 'm4a', 'mp4', 'mov', 'mkv', 'avi', 'flv'] as const;
export const KNOWLEDGE_UPLOAD_NOTICE_VERSION = '2026-10-07-v1' as const;
export const knowledgeTransportSettingsSchema = z.object({
  requestTimeoutMs: z.number().int().min(5000).max(300000).default(120000),
  uploadTimeoutMs: z.number().int().min(30000).max(1800000).default(300000),
  uploadConcurrency: z.number().int().min(1).max(3).default(1),
  pollIntervalMs: z.number().int().min(2000).max(30000).default(4000),
});
export type KnowledgeTransportSettings = z.infer<typeof knowledgeTransportSettingsSchema>;
export const jobStateSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted']);
export type JobState = z.infer<typeof jobStateSchema>;
export function isTerminalJobState(state: JobState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled' || state === 'interrupted';
}
export const jobSnapshotSchema = z.object({
  job_id: z.string().min(1), type: z.string(), filename: z.string(),
  params: z.record(z.unknown()).default({}), state: jobStateSchema,
  stage: z.string().nullish(), progress: z.record(z.unknown()).nullish(),
  error: z.string().nullish(), artifacts: z.record(z.unknown()).nullish(),
  created_at: z.string(), updated_at: z.string(),
});
export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;
export const remoteDocumentSchema = z.object({
  doc_id: z.string().min(1), name: z.string(), ext: z.string(),
  category: z.string(), size: z.number().nonnegative(), modified: z.string(),
  readable: z.boolean(), stale: z.boolean(), abs_path: z.string(),
});
export type RemoteDocument = Omit<z.infer<typeof remoteDocumentSchema>, 'abs_path'>;
export const documentListSchema = z.object({
  count: z.number().int().nonnegative(), by_category: z.record(z.number()), pending: z.number(),
  documents: z.array(remoteDocumentSchema),
});
export interface SourceRef { docId: string; displayName: string; knowledgeBaseId?: string; sourceId?: string; version?: string; locateText?: string }
export interface SourceJobBinding {
  clientUploadId: string; serviceInstanceId: string; collection: string;
  displayName: string; jobId: string; docId?: string; submittedAt: string; terminalAt?: string;
  /** Removed from the local task history; source attribution is retained. */
  taskRecordDeletedAt?: string;
}
export interface FeatureCapabilities {
  hasLibraryMetadata: boolean; hasScopeAuthorization: boolean; canUpload: boolean;
  canCancel: boolean; canRetryText: boolean; hasPreview: boolean;
}
export interface KnowledgeContext {
  serviceInstanceId: string; collection: string; knowledgeBaseId?: string;
  scope?: 'company' | 'project' | 'personal'; projectId?: string; organizationId?: string; personalIdentityId?: string;
  attribution: 'client-submissions' | 'collection-files' | 'confirmed-library';
  capabilities: FeatureCapabilities;
}
export interface KnowledgeBase {
  id: string; name: string; description: string; scope: 'company' | 'project' | 'personal';
  status: 'ready' | 'processing' | 'error' | 'pending'; updatedAt: string; fileCount?: number; chunkCount?: number; canWrite?: boolean;
  context: KnowledgeContext; sourceDocIds: string[];
  /** Only names supplied for sources in this authorized library; never global workspace names. */
  sourceNames?: string[];
}
export interface ChunkCountReport { serviceInstanceId: string; collection: string; knowledgeBaseId?: string; sourceVersion: string; count: number; complete: boolean; error?: string }
export interface ResourceLocation { version?: string; page?: number; chapter?: string; offset?: number; timeSeconds?: number }
export interface KnowledgeConnection {
  serviceInstanceId: string; baseUrl: string; collection: string;
  hasCredential: boolean; secretRef: string | null; secureStorageAvailable: boolean;
  settings: KnowledgeTransportSettings; hasUploadConsent: boolean;
}
export const connectionInputSchema = z.object({
  baseUrl: z.string().min(1).max(500), collection: z.string().trim().max(200),
  apiKey: z.string().max(4096).optional(), clearCredential: z.boolean().optional(),
  settings: knowledgeTransportSettingsSchema.optional(), clearUploadConsent: z.boolean().optional(),
});
export type KnowledgeConnectionInput = z.infer<typeof connectionInputSchema>;
export const serviceInputSchema = z.object({ serviceInstanceId: z.string().min(1).max(100) });
export const jobInputSchema = serviceInputSchema.extend({ jobId: z.string().min(1).max(200) });
export interface UploadInput {
  serviceInstanceId: string; collection: string; knowledgeBaseId: string; clientUploadId: string;
  name: string; mime: string; bytes: ArrayBuffer;
}
export const submitResponseSchema = z.object({ job_id: z.string().min(1), state: jobStateSchema, filename: z.string(), stored_path: z.string().min(1), scope_accepted: z.literal(true) });
export interface SourceList { documents: RemoteDocument[]; bindings: SourceJobBinding[]; totalWorkspaceCount: number; verifiedServerDocIds?: string[]; unclassifiedCount?: number }
export interface UnconfirmedSubmission { clientUploadId: string; displayName: string; physicalName: string; collection: string; submittedAt: string }
export interface SubmissionRecovery { recovered: number; unresolved: number }
export interface JobEvent { serviceInstanceId: string; subscriptionId: string; jobId: string; snapshot?: JobSnapshot; disconnected?: boolean }
export interface ContentRequest {
  serviceInstanceId: string; endpoint: 'document' | 'meta' | 'content' | 'slices' | 'search';
  docId?: string; para?: number; limit?: number; knowledgeBaseId?: string;
  search?: SearchRequest;
}
export interface KnowledgeLibraryBridge {
  getConnection(): Promise<RpcResult<KnowledgeConnection>>;
  configure(input: KnowledgeConnectionInput): Promise<RpcResult<KnowledgeConnection>>;
  acceptUploadConsent(input: { serviceInstanceId: string; noticeVersion: typeof KNOWLEDGE_UPLOAD_NOTICE_VERSION }): Promise<RpcResult<KnowledgeConnection>>;
  health(input: { serviceInstanceId: string }): Promise<RpcResult<{ status: string; jobs_running?: number }>>;
  listSources(input: { serviceInstanceId: string; collection: string; knowledgeBaseId?: string }): Promise<RpcResult<SourceList>>;
  getBindings(input: { serviceInstanceId: string; collection: string }): Promise<RpcResult<SourceJobBinding[]>>;
  getUnconfirmed(input: { serviceInstanceId: string; collection: string }): Promise<RpcResult<UnconfirmedSubmission[]>>;
  recoverSubmissions(input: { serviceInstanceId: string; collection: string }): Promise<RpcResult<SubmissionRecovery>>;
  submit(input: UploadInput): Promise<RpcResult<SourceJobBinding>>;
  cancelUpload(input: { clientUploadId: string }): Promise<RpcResult<boolean>>;
  listJobs(input: { serviceInstanceId: string }): Promise<RpcResult<{ count: number; jobs: JobSnapshot[] }>>;
  getJob(input: { serviceInstanceId: string; jobId: string }): Promise<RpcResult<JobSnapshot>>;
  cancelJob(input: { serviceInstanceId: string; jobId: string }): Promise<RpcResult<JobSnapshot>>;
  deleteJobRecord(input: { serviceInstanceId: string; jobId: string }): Promise<RpcResult<SourceJobBinding>>;
  subscribeJob(input: { serviceInstanceId: string; jobId: string; subscriptionId: string }): Promise<RpcResult<boolean>>;
  unsubscribeJob(input: { subscriptionId: string }): Promise<RpcResult<boolean>>;
  onJobEvent(listener: (event: JobEvent) => void): () => void;
  contentRequest(input: ContentRequest): Promise<RpcResult<unknown>>;
}

export const rpcFailureSchema = z.object({ ok: z.literal(false), requestId: z.string(), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), details: z.record(z.unknown()).optional() }) });
