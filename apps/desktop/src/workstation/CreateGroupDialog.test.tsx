import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateGroupDialog } from './CreateGroupDialog';

const { groupAgents } = vi.hoisted(() => ({ groupAgents: vi.fn() }));
vi.mock('../api/runtime', () => ({ runtimeApi: { groupAgents } }));
const agents = [
  { id: 'coordinator', name: '统筹智能体', role: '统筹', enabled: true },
  { id: 'local', name: '本地执行智能体', role: '读写文件和代码', enabled: true },
  { id: 'ppt', name: 'PPT助手', role: '很长的系统提示', enabled: true },
  { id: 'disabled', name: '禁用智能体', role: '已禁用', enabled: false },
];
const projects = [{ id: 'project-a', name: '项目甲' }, { id: 'project-b', name: '项目乙' }];
beforeEach(() => { groupAgents.mockReset(); groupAgents.mockResolvedValue({ ok: true, data: agents }); });

describe('创建群组的智能体选择', () => {
  it('统筹只显示为固定群主，全选和全不选仅影响协作智能体，提交准确的选择', async () => {
    const user = userEvent.setup(); const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CreateGroupDialog identityId="identity" projects={projects} initialProjectId="project-a" onClose={vi.fn()} onCreate={onCreate} />);
    await screen.findByRole('checkbox', { name: 'PPT助手' });
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryByRole('checkbox', { name: '统筹智能体' })).not.toBeInTheDocument();
    expect(screen.queryByText('禁用智能体')).not.toBeInTheDocument();
    const coordinator = screen.getByRole('radio', { name: '统筹智能体（固定群主）' });
    expect(coordinator).toBeChecked(); expect(coordinator).toBeDisabled();
    await user.type(screen.getByLabelText('群组名称'), '  PPT协作群  ');
    expect(screen.getByRole('button', { name: '创建群组' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '全选 / 全不选' }));
    expect(screen.getByText(/已选 3 \/ 3 个智能体/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '全选 / 全不选' }));
    expect(screen.getAllByRole('checkbox').every(item => !(item as HTMLInputElement).checked)).toBe(true);
    expect(coordinator).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'PPT助手' }));
    await user.click(screen.getByRole('button', { name: '创建群组' }));
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({ projectId: 'project-a', name: 'PPT协作群', agentIds: ['ppt'] });
    expect(groupAgents).toHaveBeenCalledWith('project-a', 'identity');
  });

  it('换项目清除旧选择，候选加载完成前不能创建', async () => {
    const user = userEvent.setup(); let resolveLoad!: (value: unknown) => void;
    render(<CreateGroupDialog identityId="identity" projects={projects} initialProjectId="project-a" onClose={vi.fn()} onCreate={vi.fn()} />);
    await user.click(await screen.findByRole('checkbox', { name: 'PPT助手' }));
    groupAgents.mockImplementation(() => new Promise(resolve => { resolveLoad = resolve; }));
    await user.selectOptions(screen.getByLabelText('关联项目'), 'project-b');
    expect(screen.getByRole('status')).toHaveTextContent('正在加载');
    expect(screen.getByRole('button', { name: '创建群组' })).toBeDisabled();
    resolveLoad({ ok: true, data: agents });
    expect(await screen.findByRole('checkbox', { name: 'PPT助手' })).not.toBeChecked();
  });

  it('加载错误支持重试，创建错误保留名称和选择', async () => {
    const user = userEvent.setup();
    groupAgents.mockResolvedValueOnce({ ok: false, message: '候选加载暂不可用' });
    const onCreate = vi.fn().mockRejectedValue(new Error('数据库暂不可用'));
    render(<CreateGroupDialog identityId="identity" projects={projects} initialProjectId="project-a" onClose={vi.fn()} onCreate={onCreate} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('候选加载暂不可用');
    await user.click(screen.getByRole('button', { name: '重新加载' }));
    await user.click(await screen.findByRole('checkbox', { name: '本地执行智能体' }));
    await user.type(screen.getByLabelText('群组名称'), '保留输入');
    await user.click(screen.getByRole('button', { name: '创建群组' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('数据库暂不可用');
    expect(screen.getByLabelText('群组名称')).toHaveValue('保留输入');
    expect(screen.getByRole('checkbox', { name: '本地执行智能体' })).toBeChecked();
    await waitFor(() => expect(screen.getByRole('button', { name: '创建群组' })).toBeEnabled());
  });

  it('统筹不可用时不能提交，项目行入口固定归属项目', async () => {
    groupAgents.mockResolvedValue({ ok: true, data: agents.filter(agent => agent.name !== '统筹智能体') });
    render(<CreateGroupDialog identityId="identity" projects={projects} initialProjectId="project-b" fixedProject onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('统筹智能体不可用');
    expect(screen.getByLabelText('关联项目')).toBeDisabled();
    expect(screen.getByLabelText('关联项目')).toHaveValue('project-b');
    expect(screen.getByRole('button', { name: '创建群组' })).toBeDisabled();
  });
});
