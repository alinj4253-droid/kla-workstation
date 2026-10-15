import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { KnowledgeBApi, KnowledgeBContentRequest, KnowledgeContext } from '@kla-workstation/contracts/knowledge';
import { TextPreview } from './content/TextPreview';
import { MultiSourceSlices } from './slices/MultiSourceSlices';
import { SliceDetailContent } from './slices/SliceDrawer';
import type { QueryContext } from './shared';

const api: KnowledgeBApi = { detail: vi.fn(), meta: vi.fn(), content: vi.fn(), slices: vi.fn(), search: vi.fn() };
const context: QueryContext = { api, cacheScope: 'ui-fixes-fixture' };
const scope: KnowledgeContext = { serviceInstanceId: 'fixture', collection: 'fixture', attribution: 'collection-files', capabilities: { hasLibraryMetadata: false, hasScopeAuthorization: false, canUpload: false, canCancel: false, canRetryText: false, hasPreview: true } };
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  vi.mocked(api.content).mockImplementation(async ({ docId, para = 0, limit = 2 }: KnowledgeBContentRequest) => ({
    ok: true, requestId: 'fixture',
    data: { doc_id: docId, name: 'fixture.txt', para, limit, returned: 2, total_paragraphs: 4, total_chars: 40, next_para: para === 0 ? 2 : null, has_more: para === 0, paragraphs: [docId + '-paragraph-' + (para + 1), docId + '-paragraph-' + (para + 2)] },
  }));
});
afterEach(() => { cleanup(); client.clear(); });
function wrapper({ children }: { children: React.ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }

it('shows one page, requests the next cursor, and reuses previous pages', async () => {
  render(<TextPreview context={context} docId="doc-a" format="txt" readable />, { wrapper });
  await screen.findByText(/doc-a-paragraph-1/);
  expect(screen.getByText('第 1 页 · 已加载 1 页')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText(/doc-a-paragraph-3/);
  expect(screen.queryByText(/doc-a-paragraph-1/)).not.toBeInTheDocument();
  expect(api.content).toHaveBeenLastCalledWith({ docId: 'doc-a', para: 2, limit: 2 });
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  await screen.findByText(/doc-a-paragraph-1/);
  expect(api.content).toHaveBeenCalledTimes(2);
});

it('preserves the current page on failure and retries the same cursor', async () => {
  const impl = vi.mocked(api.content).getMockImplementation()!;
  vi.mocked(api.content).mockImplementation(async input => {
    if (input.para === 2) throw new Error('fixture unavailable');
    return impl(input);
  });
  render(<TextPreview context={context} docId="doc-a" format="txt" readable />, { wrapper });
  await screen.findByText(/doc-a-paragraph-1/);
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('下一页加载失败，当前页仍可查看，请重试下一页。');
  expect(screen.getByText(/doc-a-paragraph-1/)).toBeInTheDocument();
  vi.mocked(api.content).mockImplementation(impl);
  fireEvent.click(screen.getByRole('button', { name: '重试下一页' }));
  await screen.findByText(/doc-a-paragraph-3/);
});

it('resets the selected page when switching documents', async () => {
  const { rerender } = render(<TextPreview context={context} docId="doc-a" format="txt" readable />, { wrapper });
  await screen.findByText(/doc-a-paragraph-1/);
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText(/doc-a-paragraph-3/);
  rerender(<TextPreview context={context} docId="doc-b" format="txt" readable />);
  await screen.findByText(/doc-b-paragraph-1/);
  expect(screen.getByText('第 1 页 · 已加载 1 页')).toBeInTheDocument();
  expect(screen.queryByText(/doc-a-paragraph-3/)).not.toBeInTheDocument();
});

it('provides a view action for each slice and opens its matching source', async () => {
  const slices = [{ id: 1, title: '第一条', content: '内容一' }, { id: 2, title: '第二条', content: '内容二' }];
  const source = { docId: 'doc-a', name: 'fixture.txt', collection: 'fixture', searchSources: ['fixture.txt'] };
  vi.mocked(api.slices).mockResolvedValue({ ok: true, requestId: 'fixture', data: { doc_id: 'doc-a', source: source.name, collection: 'fixture', count: 2, slices } });
  const open = vi.fn();
  render(<MultiSourceSlices context={context} sources={[source]} sourceVersion="fixture" onChunkCount={() => undefined} scope={scope} onOpenSlice={open} />, { wrapper });
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^查看切片：/ })).toHaveLength(2));
  fireEvent.click(screen.getByRole('button', { name: /查看切片：第二条/ }));
  expect(open).toHaveBeenCalledWith({ slice: slices[1], source });
});

it('splits long paragraphs without losing content or splitting Unicode code points', async () => {
  const { readingPages } = await import('./content/reading-pages');
  const text = '长正文😀\n'.repeat(500);
  const result = readingPages([{ doc_id: 'long', name: 'long.txt', para: 0, limit: 2, returned: 1, total_paragraphs: 1, total_chars: text.length, next_para: null, has_more: false, paragraphs: [text] }]);
  expect(result.length).toBeGreaterThan(1);
  expect(result.map(item => item.content).join('')).toBe(text);
  expect(result.every(item => Array.from(item.content).length <= 900)).toBe(true);
});
it('turns long paragraph pages locally without another API request', async () => {
  vi.mocked(api.content).mockResolvedValue({ ok: true, requestId: 'fixture', data: { doc_id: 'long', name: 'long.txt', para: 0, limit: 2, returned: 1, total_paragraphs: 1, total_chars: 2000, next_para: null, has_more: false, paragraphs: ['文'.repeat(2000)] } });
  render(<TextPreview context={context} docId="long" format="txt" readable />, { wrapper });
  await screen.findByLabelText('正文第 1 页');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(screen.getByLabelText('正文第 2 页')).toBeInTheDocument();
  expect(api.content).toHaveBeenCalledTimes(1);
});
it('编辑切片：保存把标题与正文回写，并校验空白', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const source = { docId: 'doc-1', name: 'fixture.txt', collection: 'fixture', searchSources: [] };
  render(<SliceDetailContent slice={{ id: 3, title: '旧标题', content: '旧正文' }} source={source} onOpenSource={() => undefined} onSave={onSave} />);
  // 只读态：不显示编辑表单，点「编辑切片」进入编辑态。
  expect(screen.queryByLabelText('标题')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '编辑切片' }));
  const title = screen.getByLabelText('标题');
  const content = screen.getByLabelText('正文');
  expect(title).toHaveValue('旧标题');
  expect(content).toHaveValue('旧正文');
  // 标题清空后不允许保存（原型要求标题与正文都不能为空）。
  fireEvent.change(title, { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('切片标题不能为空');
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.change(title, { target: { value: '新标题' } });
  fireEvent.change(content, { target: { value: '新正文' } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ sliceId: 3, title: '新标题', content: '新正文' }));
  await waitFor(() => expect(screen.queryByLabelText('标题')).not.toBeInTheDocument());
});
