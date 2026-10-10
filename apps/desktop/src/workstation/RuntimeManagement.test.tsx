import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_MODEL_ID } from '@kla-workstation/contracts';
import { RuntimeAgentManagement } from './RuntimeManagement';

const { agents, keys, keyModels, saveAgent } = vi.hoisted(() => ({ agents: vi.fn(), keys: vi.fn(), keyModels: vi.fn(), saveAgent: vi.fn() }));
vi.mock('../api/runtime', () => ({ runtimeApi: { agents, devices: async () => ({ ok: true, data: [] }), keyModels, saveAgent } }));
vi.mock('../api/compute', () => ({ computeApi: { keys } }));
const defaultKey = { id: 'default-key', name: '默认工作站 Key', keyPrefix: 'sk-default', status: 'active', isDefault: true };
const alternateKey = { id: 'alternate-key', name: '自选 Key', keyPrefix: 'sk-alt', status: 'active', isDefault: false };
beforeEach(() => {
  vi.clearAllMocks();
  agents.mockResolvedValue({ ok: true, data: [{ id: 'agent-1', name: '本地执行智能体', role: '执行任务', enabled: true, type: 'official', modelId: DEFAULT_AGENT_MODEL_ID, modelKeyId: defaultKey.id, modelMountInitialized: true }] });
  keys.mockResolvedValue({ ok: true, data: { items: [alternateKey, defaultKey] } });
  keyModels.mockResolvedValue({ ok: true, data: [{ id: DEFAULT_AGENT_MODEL_ID, name: 'GLM 5.3 Flash' }, { id: 'deepseek-chat', name: 'DeepSeek Chat' }] });
  saveAgent.mockResolvedValue({ ok: true, data: {} });
});

describe('智能体默认模型与 Key', () => {
  it('Key 列表暂时不可用时仍展示已经挂载的智能体', async () => {
    keys.mockRejectedValue(new Error('temporary network failure'));
    render(<RuntimeAgentManagement identityId="identity-1" notify={vi.fn()} />);
    expect(await screen.findByText('本地执行智能体')).toBeInTheDocument();
    expect(screen.getByText('GLM 5.3 Flash')).toBeInTheDocument();
  });

  it('新建时预选默认 Key 和 GLM，仍允许切换为其他 Key 和模型', async () => {
    const user = userEvent.setup();
    render(<RuntimeAgentManagement identityId="identity-1" notify={vi.fn()} />);
    await screen.findByText('GLM 5.3 Flash');
    await user.click(screen.getByRole('button', { name: '新建智能体' }));
    const keySelect = screen.getByLabelText('当前身份的 API Key');
    const modelSelect = screen.getByLabelText('该 Key 下可用模型');
    await waitFor(() => expect(modelSelect).toHaveValue(DEFAULT_AGENT_MODEL_ID));
    expect(keySelect).toHaveValue(defaultKey.id);
    await user.type(screen.getByLabelText('名称'), '自选模型助手');
    await user.type(screen.getByLabelText('身份与职责'), '回答问题');
    await user.selectOptions(keySelect, alternateKey.id);
    expect(modelSelect).toHaveValue('');
    await waitFor(() => expect(modelSelect).toBeEnabled());
    await user.selectOptions(modelSelect, 'deepseek-chat');
    await user.click(screen.getByRole('button', { name: '保存挂载' }));
    await waitFor(() => expect(saveAgent).toHaveBeenCalledWith(null, expect.objectContaining({ modelKeyId: alternateKey.id, modelId: 'deepseek-chat' })));
  });

  it('默认 Key 尚在创建时仍可创建智能体，交由后端自动补齐', async () => {
    keys.mockResolvedValue({ ok: true, data: { items: [] } });
    agents.mockResolvedValue({ ok: true, data: [] });
    const user = userEvent.setup();
    render(<RuntimeAgentManagement identityId="identity-1" notify={vi.fn()} />);
    await waitFor(() => expect(keys).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: '新建智能体' }));
    expect(screen.getByText(/Key 初始化完成后会自动挂载/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('名称'), '等待默认挂载');
    await user.type(screen.getByLabelText('身份与职责'), '回答问题');
    await user.click(screen.getByRole('button', { name: '保存挂载' }));
    await waitFor(() => expect(saveAgent).toHaveBeenCalledWith(null, expect.objectContaining({ modelKeyId: null, modelId: null })));
  });
});
