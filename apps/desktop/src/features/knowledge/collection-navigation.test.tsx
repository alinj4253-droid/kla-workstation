import React, { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialKnowledgeCatalog, type KnowledgeConnection } from '@kla-workstation/contracts/knowledge';
import { KnowledgeSection } from '../../workstation/KnowledgeSection';
const mock = vi.hoisted(() => ({ connection: vi.fn(), configure: vi.fn(), sources: vi.fn(), health: vi.fn(), jobs: vi.fn(), catalog: vi.fn(), statistics: vi.fn() }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), knowledgeApi: { connection: mock.connection, configure: mock.configure, sources: mock.sources, health: mock.health, jobs: mock.jobs } }));
vi.mock('../../api/knowledge', () => ({ knowledgeClient: {}, knowledgeCatalogApi: { get: mock.catalog }, knowledgeStatisticsApi: { get: mock.statistics } }));
vi.mock('./KnowledgeDetail', async () => {
  const { Link } = await import('react-router-dom');
  return { KnowledgeDetail: ({ base, context, onConfigure }: { base: { name: string }; context: { collection: string }; onConfigure: () => void }) => <><h2>{base.name}已连接：{context.collection}</h2><button onClick={onConfigure}>服务连接</button><Link to="/knowledge">返回知识库</Link></> };
});
vi.mock('./ConnectionDialog', () => ({ ConnectionDialog: ({ connection: current, onSaved }: { connection: KnowledgeConnection; onSaved: (next: KnowledgeConnection) => void }) => <button onClick={() => onSaved({ ...current, serviceInstanceId: 'saved-company' })}>保存连接</button> }));
const connection: KnowledgeConnection = { serviceInstanceId: 'initial-service', baseUrl: 'http://192.168.10.206:8120', collection: '金牌知识库', hasCredential: false, secretRef: null, secureStorageAvailable: false, hasUploadConsent: false, settings: { requestTimeoutMs: 120000, uploadTimeoutMs: 300000, uploadConcurrency: 1, pollIntervalMs: 4000 } };
beforeEach(() => {
  vi.clearAllMocks();
  mock.connection.mockResolvedValue(connection);
  mock.configure.mockImplementation(async (input: { collection: string }) => ({ ...connection, serviceInstanceId: input.collection, collection: input.collection }));
  mock.sources.mockResolvedValue({ documents: [], bindings: [], totalWorkspaceCount: 0 });
  mock.health.mockResolvedValue({ status: 'ok' });
  mock.jobs.mockResolvedValue({ count: 0, jobs: [] });
  mock.statistics.mockResolvedValue({ ok: true, data: { collections: initialKnowledgeCatalog.map(entry => ({ collection: entry.collection, fileCount: 0, chunkCount: 0, sourceNames: [] })), unclassifiedCount: 0 } });
  mock.catalog.mockResolvedValue({ ok: true, data: initialKnowledgeCatalog });
});
describe('knowledge collection navigation', () => {
  it('switches to the latest route after a slower earlier connection', async () => {
    let finish!: (value: KnowledgeConnection) => void;
    mock.configure.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<KnowledgeSection />);
    const project = await screen.findByRole('heading', { name: '项目知识库' });
    fireEvent.click(within(project.closest('article')!).getByRole('link', { name: '进入知识库' }));
    await waitFor(() => expect(mock.configure).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('link', { name: '← 返回知识库' }));
    const personal = await screen.findByRole('heading', { name: '个人知识库' });
    fireEvent.click(within(personal.closest('article')!).getByRole('link', { name: '进入知识库' }));
    await act(async () => finish({ ...connection, serviceInstanceId: 'slow-project', collection: '项目知识库' }));
    expect(await screen.findByRole('heading', { name: '个人知识库已连接：个人知识库' })).toBeInTheDocument();
    expect(mock.configure.mock.calls.map(call => call[0].collection)).toEqual(['项目知识库', '个人知识库']);
  });
  it('shows a retry action for a mismatched response and can recover', async () => {
    mock.configure.mockResolvedValueOnce(connection);
    render(<KnowledgeSection />);
    const project = await screen.findByRole('heading', { name: '项目知识库' });
    fireEvent.click(within(project.closest('article')!).getByRole('link', { name: '进入知识库' }));
    expect(await screen.findByText(/自动连接失败/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '重新连接' })[0]!);
    expect(await screen.findByRole('heading', { name: '项目知识库已连接：项目知识库' })).toBeInTheDocument();
  });
  it('shows independent counts for all collections and zero for an empty library', async () => {
    mock.statistics.mockResolvedValue({ ok: true, data: { collections: [
      { collection: '金牌知识库', fileCount: 2, chunkCount: 19, sourceNames: ['company.txt'] },
      { collection: '项目知识库', fileCount: 1, chunkCount: 3, sourceNames: ['project.txt'] },
      { collection: '个人知识库', fileCount: 0, chunkCount: 0, sourceNames: [] },
    ], unclassifiedCount: 0 } });
    render(<StrictMode><KnowledgeSection /></StrictMode>);
    await waitFor(() => expect(mock.statistics).toHaveBeenCalled());
    const project = (await screen.findByRole('heading', { name: '项目知识库' })).closest('article')!;
    await waitFor(() => expect(project.querySelector('.kl-card-counts')).toHaveTextContent('1 文件3 切片'));
    const personal = screen.getByRole('heading', { name: '个人知识库' }).closest('article')!;
    expect(personal.querySelector('.kl-card-counts')).toHaveTextContent('0 文件0 切片');
    expect(screen.getByText('知识切片总数').closest('article')).toHaveTextContent('22');
    expect(mock.configure).not.toHaveBeenCalled();
  });
  it('recovers a lost configure response by reading the confirmed connection', async () => {
    mock.configure.mockRejectedValueOnce(new Error('response timed out'));
    mock.connection.mockResolvedValueOnce(connection).mockResolvedValue({ ...connection, serviceInstanceId: 'confirmed-project', collection: '项目知识库' });
    render(<KnowledgeSection />);
    const project = await screen.findByRole('heading', { name: '项目知识库' });
    fireEvent.click(within(project.closest('article')!).getByRole('link', { name: '进入知识库' }));
    expect(await screen.findByRole('heading', { name: '项目知识库已连接：项目知识库' })).toBeInTheDocument();
  });

  it('can switch after saving the company connection', async () => {
    render(<StrictMode><KnowledgeSection /></StrictMode>);
    const company = await screen.findByRole('heading', { name: '公司知识库' });
    fireEvent.click(within(company.closest('article')!).getByRole('link', { name: '进入知识库' }));
    fireEvent.click(await screen.findByRole('button', { name: '服务连接' }));
    fireEvent.click(await screen.findByRole('button', { name: '保存连接' }));
    fireEvent.click(await screen.findByRole('link', { name: '返回知识库' }));
    const project = await screen.findByRole('heading', { name: '项目知识库' });
    fireEvent.click(within(project.closest('article')!).getByRole('link', { name: '进入知识库' }));
    expect(await screen.findByRole('heading', { name: '项目知识库已连接：项目知识库' })).toBeInTheDocument();
  });
  it.each(['项目知识库', '个人知识库'])('enters %s under StrictMode', async name => {
    render(<StrictMode><KnowledgeSection /></StrictMode>);
    const title = await screen.findByRole('heading', { name });
    fireEvent.click(within(title.closest('article')!).getByRole('link', { name: '进入知识库' }));
    await waitFor(() => expect(mock.configure).toHaveBeenCalledWith(expect.objectContaining({ collection: name })));
    expect(await screen.findByRole('heading', { name: `${name}已连接：${name}` })).toBeInTheDocument();
  });
});