import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryBrowserEntry, MemoryBrowserPage, MemoryBrowserScopes } from '@kla-workstation/contracts';
import { MemorySection } from './MemorySection';

const { scopesRequest, entriesRequest } = vi.hoisted(() => ({ scopesRequest: vi.fn(), entriesRequest: vi.fn() }));
vi.mock('../api/memories', () => ({ memoryApi: { scopes: scopesRequest, entries: entriesRequest, invalidate: vi.fn().mockResolvedValue(undefined) } }));
const scopes: MemoryBrowserScopes = {
  projects: [{ id: 'p1', name: '项目一', agents: [{ key: 'a1', name: '编写智能体' }] }, { id: 'p2', name: '项目二', agents: [{ key: 'a2', name: '分析智能体' }] }],
  conversations: [{ id: 'c1', projectId: 'p1', name: '群组一', agents: [{ key: 'a1', name: '编写智能体' }] }, { id: 'c2', projectId: 'p2', name: '群组二', agents: [{ key: 'a2', name: '分析智能体' }] }],
  agents: [{ key: 'a1', name: '编写智能体' }, { key: 'a2', name: '分析智能体' }],
  counts: { longTerm: 1, shortTerm: 2 }, latestUpdatedAt: '2026-10-09T01:00:00Z',
};
const entry: MemoryBrowserEntry = {
  id: 'memory:1', content: '项目约定：使用经确认的正式材料。', term: 'long_term', kind: 'long_term', source: 'stored_memory',
  projectId: 'p1', projectName: '项目一', conversationId: 'c1', conversationName: '群组一', agentKey: 'a1', agentName: '编写智能体', shared: false,
  sourceMessageId: null, createdAt: '2026-10-09T01:00:00Z', updatedAt: '2026-10-09T01:00:00Z', expiresAt: null,
};
const empty: MemoryBrowserPage = { items: [], page: { page: 1, pageSize: 20, total: 0 } };

beforeEach(() => {
  scopesRequest.mockReset().mockResolvedValue({ ok: true, data: scopes });
  entriesRequest.mockReset().mockResolvedValue({ ok: true, data: empty });
});

describe('只读记忆浏览', () => {
  it('按项目、群组、智能体和周期筛选，切换项目清空下级选择', async () => {
    const user = userEvent.setup();
    render(<MemorySection identityId="identity-one" />);
    await screen.findByText('当前筛选范围暂无长期记忆');
    await user.click(screen.getByRole('button', { name: '项目一' }));
    expect(screen.queryByRole('button', { name: '群组二' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '分析智能体' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '群组一' }));
    await user.click(screen.getByRole('button', { name: '编写智能体' }));
    await user.click(screen.getByRole('tab', { name: '短期记忆' }));
    await waitFor(() => expect(entriesRequest).toHaveBeenLastCalledWith('identity-one', { projectId: 'p1', conversationId: 'c1', agentKey: 'a1', term: 'short_term', page: 1, pageSize: 20, from: expect.any(String) }, expect.any(AbortSignal)));
    await user.click(screen.getByRole('button', { name: '最近1年' }));
    await waitFor(() => expect(Date.parse(entriesRequest.mock.calls.at(-1)![1].from)).toBeLessThan(Date.now() - 364 * 86_400_000));
    await user.click(screen.getByRole('button', { name: '项目二' }));
    await waitFor(() => expect(entriesRequest).toHaveBeenLastCalledWith('identity-one', expect.objectContaining({ projectId: 'p2', conversationId: undefined, agentKey: undefined, page: 1 }), expect.any(AbortSignal)));
    expect(screen.getByRole('button', { name: '分析智能体' })).toBeVisible();
  });

  it('显示真实正文与来源，支持分页，不提供任何修改入口', async () => {
    entriesRequest.mockImplementation(async (_id, query) => ({ ok: true, data: { items: [{ ...entry, content: query.page === 1 ? entry.content : '第二页正文' }], page: { page: query.page, pageSize: 20, total: 21 } } }));
    const user = userEvent.setup();
    render(<MemorySection identityId="identity-one" />);
    expect(await screen.findByText(entry.content)).toBeVisible();
    expect(screen.getByText(/来源：编写智能体/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /新增|编辑|删除|重置|导入/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByText('第二页正文')).toBeVisible();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  it('筛选后的迟到响应不会覆盖新筛选结果，切换身份会中止旧请求', async () => {
    let resolveOld!: (value: { ok: true; data: MemoryBrowserPage }) => void;
    entriesRequest.mockImplementation((_id, query) => query.term === 'long_term' ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ ok: true, data: empty }));
    const user = userEvent.setup();
    const { rerender } = render(<MemorySection key="identity-one" identityId="identity-one" />);
    await waitFor(() => expect(entriesRequest).toHaveBeenCalledOnce());
    const oldSignal = entriesRequest.mock.calls[0][2] as AbortSignal;
    await user.click(screen.getByRole('tab', { name: '短期记忆' }));
    await screen.findByText('当前筛选范围暂无短期记忆');
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolveOld({ ok: true, data: { ...empty, items: [entry] } }));
    expect(screen.queryByText(entry.content)).not.toBeInTheDocument();
    scopesRequest.mockResolvedValueOnce({ ok: true, data: { ...scopes, projects: [], conversations: [], agents: [] } });
    entriesRequest.mockResolvedValue({ ok: true, data: empty });
    rerender(<MemorySection key="identity-two" identityId="identity-two" />);
    await screen.findByText('当前筛选范围暂无长期记忆');
    expect(screen.queryByRole('button', { name: '项目一' })).not.toBeInTheDocument();
    expect(entriesRequest).toHaveBeenLastCalledWith('identity-two', expect.any(Object), expect.any(AbortSignal));
  });

  it('接口失败显示错误，允许只读重试', async () => {
    scopesRequest.mockResolvedValueOnce({ ok: false, code: 'UNAVAILABLE', message: '连接暂不可用' });
    const user = userEvent.setup();
    render(<MemorySection identityId="identity-one" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('连接暂不可用');
    await user.click(screen.getByRole('button', { name: '重新加载' }));
    await screen.findByText('当前筛选范围暂无长期记忆');
    expect(scopesRequest).toHaveBeenCalledTimes(2);
  });
});
