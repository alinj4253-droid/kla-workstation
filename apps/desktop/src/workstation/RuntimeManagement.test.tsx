import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_MODEL_ID } from '@kla-workstation/contracts';
import { RuntimeAgentManagement, RuntimeSkillManagement } from './RuntimeManagement';

const { agents, keys, keyModels, saveAgent, installHomeAi, skills, toggleSkill, saveSkill, restoreSkills } = vi.hoisted(() => ({ agents: vi.fn(), keys: vi.fn(), keyModels: vi.fn(), saveAgent: vi.fn(), installHomeAi:vi.fn(), skills: vi.fn(), toggleSkill: vi.fn(), saveSkill: vi.fn(), restoreSkills: vi.fn() }));
vi.mock('../api/runtime', () => ({ runtimeApi: { agents, devices: async () => ({ ok: true, data: [] }), keyModels, saveAgent, installHomeAi, skills, toggleSkill, saveSkill, restoreSkills } }));
vi.mock('../api/compute', () => ({ computeApi: { keys } }));
const defaultKey = { id: 'default-key', name: '默认工作站 Key', keyPrefix: 'sk-default', status: 'active', isDefault: true };
const alternateKey = { id: 'alternate-key', name: '自选 Key', keyPrefix: 'sk-alt', status: 'active', isDefault: false };
beforeEach(() => {
  vi.clearAllMocks();
  agents.mockResolvedValue({ ok: true, data: [{ id: 'agent-1', name: '本地执行智能体', role: '执行任务', enabled: true, type: 'official', modelId: DEFAULT_AGENT_MODEL_ID, modelKeyId: defaultKey.id, modelMountInitialized: true }] });
  keys.mockResolvedValue({ ok: true, data: { items: [alternateKey, defaultKey] } });
  keyModels.mockResolvedValue({ ok: true, data: [{ id: DEFAULT_AGENT_MODEL_ID, name: 'GLM 5.3 Flash' }, { id: 'deepseek-chat', name: 'DeepSeek Chat' }] });
  saveAgent.mockResolvedValue({ ok: true, data: {} });
  installHomeAi.mockResolvedValue({ok:true,data:{agentId:'home-agent',installed:true}});
});

describe('智能体默认模型与 Key', () => {
  it('uses the atomic server preset when installing home diagnosis from the market',async()=>{
    const user=userEvent.setup();const notify=vi.fn();render(<RuntimeAgentManagement identityId="identity-1" notify={notify}/>);
    await screen.findByText('本地执行智能体');await user.click(screen.getByRole('button',{name:/智能体市场/}));
    const card=screen.getByText('家居 AI 机会诊断').closest('article')!;
    const button=Array.from(card.querySelectorAll('button')).find(button=>button.textContent?.includes('安装'))!;
    await user.click(button);await waitFor(()=>expect(installHomeAi).toHaveBeenCalledOnce());
    expect(saveAgent).not.toHaveBeenCalled();await waitFor(()=>expect(notify).toHaveBeenCalledWith('家居 AI 机会诊断已安装到我的智能体'));
  });
  it('Key 列表暂时不可用时仍展示已经挂载的智能体', async () => {
    keys.mockRejectedValue(new Error('temporary network failure'));
    render(<RuntimeAgentManagement identityId="identity-1" notify={vi.fn()} />);
    expect(await screen.findByText('本地执行智能体')).toBeInTheDocument();
    expect(screen.getByText('GLM 5.3 Flash')).toBeInTheDocument();
  });

  it('在「我的智能体」末尾提供添加自定义智能体入口卡片', async () => {
    const user = userEvent.setup();
    render(<RuntimeAgentManagement identityId="identity-1" notify={vi.fn()} />);
    await screen.findByText('GLM 5.3 Flash');
    expect(screen.getByText('添加自定义智能体')).toBeInTheDocument();
    // 工具栏与卡片各有一个「新建智能体」入口（与原型一致），点卡片那个同样打开新建弹窗。
    await user.click(screen.getAllByRole('button', { name: '新建智能体' })[1]!);
    expect(await screen.findByRole('heading', { name: '新建智能体' })).toBeInTheDocument();
  });

  it('展示内置智能体稳定编码，并在接口提供技能数时显示「技能管理 · N」', async () => {
    agents.mockResolvedValue({ ok: true, data: [
      { id: 'agent-1', name: '本地执行智能体', role: '执行任务', enabled: true, type: 'official', modelId: DEFAULT_AGENT_MODEL_ID, modelKeyId: defaultKey.id, modelMountInitialized: true, skillCount: 3 },
      { id: 'agent-2', name: '邮箱操作智能体', role: '收发邮件', enabled: true, type: 'custom', modelId: null, modelKeyId: null, modelMountInitialized: false, skillCount: 0 },
    ] });
    render(<RuntimeAgentManagement identityId="identity-1" notify={vi.fn()} />);
    await screen.findByText('本地执行智能体');
    // 内置智能体用演示版同款稳定编码；非内置沿用 builtin.<id 前 8 位>。
    expect(screen.getByText('builtin.local-executor')).toBeInTheDocument();
    expect(screen.getByText('builtin.agent-2')).toBeInTheDocument();
    const local = screen.getByText('本地执行智能体').closest('article')!;
    expect(within(local).getByRole('button', { name: /技能管理 · 3/ })).toBeInTheDocument();
    const custom = screen.getByText('邮箱操作智能体').closest('article')!;
    expect(within(custom).getByRole('button', { name: /技能管理 · 0/ })).toBeInTheDocument();
  });

  it('技能页：显示绑定智能体、开关立即写回，并支持新建与恢复默认', async () => {
    const user = userEvent.setup();
    const notify = vi.fn();
    skills.mockResolvedValue({ ok: true, data: [
      { code: 'knowledge_research', name: '知识检索', description: '检索知识库并标注来源', tool_codes: ['kb_search'], enabled: true, agents: ['本地执行智能体', 'PPT助手'] },
      { code: 'custom_report', name: '报表生成', description: '按模板生成报表', tool_codes: [], enabled: false, agents: [] },
    ] });
    toggleSkill.mockResolvedValue({ ok: true, data: { code: 'knowledge_research', name: '知识检索', description: '', tool_codes: [], enabled: false } });
    saveSkill.mockResolvedValue({ ok: true, data: { code: 'custom_x', name: '自定义技能', description: '', tool_codes: [], enabled: true } });
    restoreSkills.mockResolvedValue({ ok: true, data: { restored: 8 } });
    render(<RuntimeSkillManagement identityId="identity-1" notify={notify} />);
    // 绑定智能体列（原型技能页要求）
    expect(await screen.findByText('本地执行智能体、PPT助手')).toBeInTheDocument();
    // 未绑定的技能在「绑定智能体」列显示未绑定（select 里也有同名选项，所以在行内断言）
    const customRow = screen.getByText('报表生成').closest('.ws-skill-row') as HTMLElement;
    expect(within(customRow).getByText('未绑定')).toBeInTheDocument();
    // 开关直接调用既有 PATCH 接口
    await user.click(screen.getByRole('switch', { name: '知识检索 启用状态' }));
    await waitFor(() => expect(toggleSkill).toHaveBeenCalledWith('knowledge_research', false));
    // 恢复默认
    await user.click(screen.getByRole('button', { name: /恢复默认/ }));
    await waitFor(() => expect(restoreSkills).toHaveBeenCalled());
    await waitFor(() => expect(notify).toHaveBeenCalledWith('已恢复 8 个内置技能的默认配置'));
    // 新建技能：编号与名称必填
    await user.click(screen.getByRole('button', { name: /新建技能/ }));
    await user.click(screen.getByRole('button', { name: '创建并启用' }));
    expect(notify).toHaveBeenCalledWith('技能编号与名称不能为空');
    await user.type(screen.getByLabelText(/技能编号/), 'custom_x');
    await user.type(screen.getByLabelText(/名称/), '自定义技能');
    await user.click(screen.getByRole('button', { name: '创建并启用' }));
    await waitFor(() => expect(saveSkill).toHaveBeenCalledWith({ code: 'custom_x', name: '自定义技能', description: '', toolCodes: [] }));
  });

  it('新建时预选默认 Key 和 GLM，仍允许切换为其他 Key 和模型', async () => {
    const user = userEvent.setup();
    render(<RuntimeAgentManagement identityId="identity-1" notify={vi.fn()} />);
    await screen.findByText('GLM 5.3 Flash');
    await user.click(screen.getAllByRole('button', { name: '新建智能体' })[0]!);
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
    await user.click(screen.getAllByRole('button', { name: '新建智能体' })[0]!);
    expect(screen.getByText(/Key 初始化完成后会自动挂载/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('名称'), '等待默认挂载');
    await user.type(screen.getByLabelText('身份与职责'), '回答问题');
    await user.click(screen.getByRole('button', { name: '保存挂载' }));
    await waitFor(() => expect(saveAgent).toHaveBeenCalledWith(null, expect.objectContaining({ modelKeyId: null, modelId: null })));
  });
});
