import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryManager } from './MemoryManager';

describe('MemoryManager access gate', () => {
  const listMemories = vi.fn().mockResolvedValue({ ok: true, data: [] });

  beforeEach(() => {
    listMemories.mockClear();
    (window as unknown as { kunqing: unknown }).kunqing = {
      memory: {
        list: listMemories,
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
      },
    };
  });

  it('does not read memory before the operations key is verified', async () => {
    const user = userEvent.setup();
    render(
      <MemoryManager
        projectId="project-1"
        agents={[{ id: 'agent-1', agentName: '统筹管理智能体', role: 'leader' }]}
        initialAgentInstanceId="agent-1"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('记忆内容受保护')).toBeInTheDocument();
    expect(listMemories).not.toHaveBeenCalled();

    const keyInput = screen.getByLabelText('运维权限密钥');
    await user.type(keyInput, 'wrong-key');
    await user.click(screen.getByRole('button', { name: '验证并进入' }));
    expect(screen.getByText('运维权限密钥不正确')).toBeInTheDocument();
    expect(listMemories).not.toHaveBeenCalled();

    await user.clear(keyInput);
    await user.type(keyInput, '123456');
    await user.click(screen.getByRole('button', { name: '验证并进入' }));

    await waitFor(() => expect(listMemories).toHaveBeenCalledWith({ projectId: 'project-1', agentInstanceId: 'agent-1' }));
    expect(await screen.findByText('暂无记忆')).toBeInTheDocument();
  });
});
