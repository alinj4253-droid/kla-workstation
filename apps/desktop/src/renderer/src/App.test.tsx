import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from './App';

const renderAt = (path: string): void => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
};

describe('mock navigation', () => {
  it('switches from home to the project chat', async () => {
    const user = userEvent.setup();
    renderAt('/');

    expect(screen.getByRole('heading', { name: '鲲擎智汇，由你开启' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '项目' }));

    expect(await screen.findByRole('heading', { name: '协作项目' })).toBeInTheDocument();
    expect(screen.getByText('2023年度财务报销汇总报告')).toBeInTheDocument();
  });

  it('opens workspace from the chat folder action', async () => {
    const user = userEvent.setup();
    renderAt('/projects/annual-finance/chat');

    await user.click(screen.getByRole('button', { name: '打开工作区' }));

    expect(await screen.findByRole('heading', { name: '年度财务报销审核 · 工作区' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: '用户原始文件' })).toBeInTheDocument();
  });

  it('validates and creates a group chat from New Chat', async () => {
    const user = userEvent.setup();
    renderAt('/projects/annual-finance/chat');

    await user.click(screen.getByRole('button', { name: '新建群聊' }));
    expect(screen.getByRole('heading', { name: '创建新对话' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始协作' }));
    expect(screen.getByText('群聊名称为必填项')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '取消选择统筹管理智能体' }));
    await user.type(screen.getByPlaceholderText('请输入群聊名称...'), '本地资料整理');
    await user.click(screen.getByRole('button', { name: '开始协作' }));
    expect(screen.getByText('，请至少选择一个')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '选择知识管理智能体' }));
    await user.click(screen.getByRole('button', { name: '开始协作' }));
    expect(await screen.findByRole('heading', { name: '本地资料整理小组' })).toBeInTheDocument();
  });

  it('switches between agent, model and channel settings', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await user.click(screen.getByRole('link', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: '智能体接入' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '模型管理' }));
    expect(await screen.findByRole('heading', { name: '模型管理 (Model Management)' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '渠道' }));
    expect(await screen.findByRole('heading', { name: '渠道配置' })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /算力/ })).toBeDisabled();
  });
});
