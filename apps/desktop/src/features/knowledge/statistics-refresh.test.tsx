import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentSlices, JobEvent, JobSnapshot, KnowledgeBase, KnowledgeConnection, KnowledgeContext, RemoteDocument, SourceJobBinding } from '@kla-workstation/contracts/knowledge';
import { KnowledgeDetail } from './KnowledgeDetail';
import { knowledgeKeys } from './api';
import { useJobs, latestJobHistory } from './queries/jobs';
import { useKnowledgeSlices } from './queries/slices';
import { summarizeKnowledgeFiles } from './statistics';
import { BQueryError } from '../knowledge-b/shared';

const mock = vi.hoisted(() => ({
  job: vi.fn(), jobs: vi.fn(), sources: vi.fn(), bindings: vi.fn(), unconfirmed: vi.fn(),
  slices: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), onEvent: vi.fn(),
}));
vi.mock('./api', async importOriginal => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, knowledgeApi: { ...actual.knowledgeApi, job: mock.job, jobs: mock.jobs, sources: mock.sources, bindings: mock.bindings, unconfirmed: mock.unconfirmed }, bridge: () => ({ subscribeJob: mock.subscribe, unsubscribeJob: mock.unsubscribe, onJobEvent: mock.onEvent }) };
});
vi.mock('../knowledge-b/slices/adapter', async importOriginal => ({ ...await importOriginal<typeof import('../knowledge-b/slices/adapter')>(), fetchDocumentSlices: mock.slices }));
const context: KnowledgeContext = { serviceInstanceId: 'refresh-fixture-service', collection: 'refresh-fixture-only', attribution: 'collection-files', capabilities: { hasLibraryMetadata: false, hasScopeAuthorization: false, canUpload: true, canCancel: true, canRetryText: false, hasPreview: false } };
const doc: RemoteDocument = { doc_id: 'doc-1', name: 'fixture.txt', ext: 'txt', category: '上传文档', size: 20, modified: '2026-10-08 10:00:00', readable: true, stale: false };
const binding: SourceJobBinding = { clientUploadId: 'fixture-upload', serviceInstanceId: context.serviceInstanceId, collection: context.collection, displayName: 'fixture.txt', jobId: 'fixture-job', docId: doc.doc_id, submittedAt: '2026-10-08T10:00:00Z' };
const running: JobSnapshot = { job_id: binding.jobId, type: 'process', filename: doc.name, params: {}, state: 'running', stage: 'slice', artifacts: {}, created_at: '2026-10-08 10:00:00', updated_at: '2026-10-08 10:00:01' };
const done: JobSnapshot = { ...running, state: 'done', stage: 'done', updated_at: '2026-10-08 10:00:02' };
const connection: KnowledgeConnection = { serviceInstanceId: context.serviceInstanceId, baseUrl: 'http://fixture.invalid:8120', collection: context.collection, hasCredential: false, secretRef: null, secureStorageAvailable: false, hasUploadConsent: true, settings: { requestTimeoutMs: 120000, uploadTimeoutMs: 300000, uploadConcurrency: 1, pollIntervalMs: 4000 } };
const base: KnowledgeBase = { id: 'fixture-base', name: 'fixture-library', description: '', scope: 'personal', status: 'ready', updatedAt: '', context, sourceDocIds: [doc.doc_id] };
const slices = (count: number, document = doc): DocumentSlices => ({ doc_id: document.doc_id, collection: context.collection, source: document.name, count, slices: Array.from({ length: count }, (_, index) => ({ id: index, title: 'fixture title', content: 'fixture ' + index })) });
let client: QueryClient;
let listener: (event: JobEvent) => void;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30000, gcTime: Infinity } } });
  mock.jobs.mockResolvedValue({ count: 1, jobs: [done] });
  mock.job.mockResolvedValue(done);
  mock.sources.mockResolvedValue({ documents: [doc], bindings: [binding], totalWorkspaceCount: 1 });
  mock.bindings.mockResolvedValue([binding]);
  mock.unconfirmed.mockResolvedValue([]);
  mock.slices.mockResolvedValue(slices(2));
  mock.subscribe.mockResolvedValue({ ok: true, requestId: 'fixture', data: true });
  mock.unsubscribe.mockResolvedValue({ ok: true, requestId: 'fixture', data: true });
  mock.onEvent.mockImplementation(callback => { listener = callback; return () => undefined; });
});
afterEach(() => { cleanup(); client.clear(); });
function wrapper({ children }: { children: React.ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
function mountDetail() {
  return render(<QueryClientProvider client={client}><MemoryRouter><KnowledgeDetail context={context} connection={connection} base={base} onConfigure={() => undefined}/></MemoryRouter></QueryClientProvider>);
}
function stat(label: string) {
  const article = Array.from(document.querySelectorAll('.kl-detail-stats article')).find(item => item.querySelector('span')?.textContent === label);
  if (!article) throw new Error('Missing statistic: ' + label);
  return { value: article.querySelector('strong')?.textContent, note: article.querySelector('small')?.textContent };
}

describe('knowledge statistics refresh (local fixtures only)', () => {
  it('uses valid slices when an expired job query has stale cached data', () => {
    expect(summarizeKnowledgeFiles([doc], [binding], new Map([[done.job_id, done]]), new Set([done.job_id]), [{ data: slices(2), isSuccess: true }])).toEqual({ done: 1, processing: 0, failed: 0, unknown: 0 });
  });
  it('shows confirmed zero counts and an explicit pending-state notice for unknown files', async () => {
    mock.bindings.mockResolvedValue([]);
    mock.sources.mockResolvedValue({ documents: [doc], bindings: [], totalWorkspaceCount: 1 });
    mock.slices.mockRejectedValue(new BQueryError('slices_pending'));
    mountDetail();
    await waitFor(() => expect(stat('已处理文件').value).toBe('0'));
    expect(stat('处理中').value).toBe('0');
    expect(stat('异常文件').value).toBe('0');
    expect(stat('已处理文件').note).toContain('1 个文件待确认');
  });
  it('keeps confirmed file counts when another source has no job or slices', () => {
    const second = { ...doc, doc_id: 'doc-2' };
    expect(summarizeKnowledgeFiles([doc, second], [binding], new Map([[done.job_id, done]]), new Set(), [{ data: slices(2), isSuccess: true }, { data: undefined, isSuccess: false }])).toEqual({ done: 1, processing: 0, failed: 0, unknown: 1 });
  });
  it('recognizes old files with validated current slices without inventing a task', () => {
    expect(summarizeKnowledgeFiles([doc], [], new Map(), new Set(), [{ data: slices(2), isSuccess: true }])).toEqual({ done: 1, processing: 0, failed: 0, unknown: 0 });
    expect(summarizeKnowledgeFiles([{ ...doc, stale: true }], [], new Map(), new Set(), [{ data: slices(2), isSuccess: true }]).unknown).toBe(1);
  });
  it('retains file statistics after the task record is deleted', () => {
    expect(summarizeKnowledgeFiles([doc], [{ ...binding, taskRecordDeletedAt: '2026-10-08T11:00:00Z' }], new Map([[done.job_id, done]]), new Set(), []).done).toBe(1);
  });
  it('does not count cancelled files as failed or completed', () => {
    expect(summarizeKnowledgeFiles([doc], [binding], new Map([[done.job_id, { ...done, state: 'cancelled' }]]), new Set(), [])).toEqual({ done: 0, processing: 0, failed: 0, unknown: 0 });
  });
  it('rejects late older task history', () => {
    expect(latestJobHistory({ count: 1, jobs: [done] }, { count: 1, jobs: [running] }).jobs[0]?.state).toBe('done');
  });
  it('recovers automatically when slices appear after a temporary 404', async () => {
    mock.slices.mockRejectedValueOnce(new BQueryError('slices_pending')).mockResolvedValue(slices(2));
    const { result } = renderHook(() => useKnowledgeSlices(context, [doc], { processing: true, pollIntervalMs: 50 }), { wrapper });
    await waitFor(() => expect(mock.slices.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(result.current.count).toBe(2));
  });
  it('shares one slice request across statistics and content observers', async () => {
    const { result } = renderHook(() => ({ a: useKnowledgeSlices(context, [doc]), b: useKnowledgeSlices(context, [doc]) }), { wrapper });
    await waitFor(() => expect(result.current.a.count).toBe(2));
    expect(result.current.b.count).toBe(2);
    expect(mock.slices).toHaveBeenCalledTimes(1);
  });
  it('keeps polling a running task even after the SSE stream becomes silent', async () => {
    mock.jobs.mockResolvedValue({ count: 1, jobs: [running] });
    mock.job.mockResolvedValueOnce(running).mockResolvedValue(done);
    const { result } = renderHook(() => useJobs(context, [binding], undefined, 100), { wrapper });
    await waitFor(() => expect(result.current.queries[0]?.data?.state).toBe('running'));
    const input = mock.subscribe.mock.calls[0]![0];
    await act(async () => listener({ serviceInstanceId: context.serviceInstanceId, subscriptionId: input.subscriptionId, jobId: running.job_id, snapshot: running }));
    await waitFor(() => expect(result.current.queries[0]?.data?.state).toBe('done'));
    await waitFor(() => expect(client.getQueryData<{ jobs: JobSnapshot[] }>(knowledgeKeys.jobs(context.serviceInstanceId, context.collection))?.jobs[0]?.state).toBe('done'));
  });
  it('refreshes content when a completed task is associated with its source later', async () => {
    const { docId: _docId, ...unmapped } = binding;
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { rerender } = renderHook(({ record }) => useJobs(context, [record]), { wrapper, initialProps: { record: unmapped as SourceJobBinding } });
    await waitFor(() => expect(mock.job).toHaveBeenCalled());
    await waitFor(() => expect(client.getQueryData<{ jobs: JobSnapshot[] }>(knowledgeKeys.jobs(context.serviceInstanceId, context.collection))?.jobs[0]?.state).toBe('done'));
    invalidate.mockClear();
    rerender({ record: binding });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: knowledgeKeys.sourceContent(context.serviceInstanceId, context.collection, doc.doc_id) }));
  });
  it('updates slice statistics without opening the chunks tab', async () => {
    mountDetail();
    await waitFor(() => expect(stat('知识切片').value).toBe('2'));
    expect(screen.getByRole('tab', { name: '知识切片' })).toHaveAttribute('data-state', 'inactive');
    expect(stat('已处理文件').value).toBe('1');
  });
  it('manual refresh also refreshes slices whose source modified time has not changed', async () => {
    mountDetail();
    await waitFor(() => expect(stat('知识切片').value).toBe('2'));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新任务' })).toBeEnabled());
    mock.slices.mockResolvedValue(slices(3));
    fireEvent.click(screen.getByRole('button', { name: '刷新任务' }));
    await waitFor(() => expect(stat('知识切片').value).toBe('3'));
  });
  it('shows known counts and labels the unresolved file instead of blanking all cards', async () => {
    const second = { ...doc, doc_id: 'doc-2', name: 'unresolved.txt' };
    mock.sources.mockResolvedValue({ documents: [doc, second], bindings: [binding], totalWorkspaceCount: 2 });
    mock.slices.mockImplementation((_context, source) => source.docId === doc.doc_id ? Promise.resolve(slices(2)) : Promise.reject(new BQueryError('slices_pending')));
    mountDetail();
    await waitFor(() => expect(stat('原始文件').value).toBe('2'));
    await waitFor(() => expect(stat('已处理文件').value).toBe('1'));
    expect(stat('已处理文件').note).toContain('1 个文件待确认');
    expect(stat('处理中').value).toBe('0');
    expect(stat('知识切片').value).toBe('2');
  });
});
