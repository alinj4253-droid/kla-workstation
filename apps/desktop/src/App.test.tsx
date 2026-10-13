import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './App';

const stubOk = (data?: unknown) => Promise.resolve(data != null ? { ok: true, data } : { ok: true });

function createMockKunqing(overrides?: Partial<Record<string, unknown>>): void {
  const mock = {
    app: {
      bootstrap: () => stubOk({}),
      getVersion: () => Promise.resolve('0.1.0'),
      search: () => stubOk([]),
      openExternal: () => stubOk(),
      ensureStudio: () => stubOk({}),
      verifyOperationsAccess: (input: { key?: string }) => stubOk({ granted: input?.key === '123456' }),
    },
    studio: {
      getStatus: () => stubOk({ initialized: true }),
      chooseAndInitialize: () => stubOk(null),
      chooseAndOpenExisting: () => stubOk(null),
      validate: () => stubOk({ valid: true }),
      migrate: () => stubOk({ success: true }),
    },
    drafts: {
      get: () => stubOk(null),
      update: () => stubOk(),
      chooseAttachments: () => stubOk([]),
      removeAttachment: () => stubOk(),
    },
    projects: {
      list: () => stubOk([{ id: 'annual-finance', name: '年度财务报销审核', status: 'active', lastActiveAt: new Date().toISOString(), createdAt: new Date().toISOString() }]),
      planHomeRequest: () => stubOk({ groupName: '测试协作群', requestedAgentProfileIds: ['builtin-orchestrator-profile'] }),
      create: () => stubOk({ id: 'test-project', status: 'active', createdAt: new Date().toISOString() }),
      get: () => stubOk(null),
      rename: () => stubOk(),
      archive: () => stubOk(),
      restore: () => stubOk(),
    },
    messages: {
      list: () => stubOk({ messages: [], hasMore: false }),
      listRunActivity: () => stubOk([]),
      send: () => stubOk({ id: 'msg-1', createdAt: new Date().toISOString() }),
      cancelRun: () => stubOk(null),
      cancelProjectRuns: () => stubOk(null),
      retryRun: () => stubOk({ runId: '' }),
    },
    workspace: {
      ensureProject: () => stubOk(),
      listFiles: () => Promise.resolve([] as Array<Record<string, unknown>>),
      uploadFiles: () => Promise.resolve({ cancelled: true, importedCount: 0 }),
      openItem: () => stubOk(),
      createFolder: () => stubOk(),
      list: () => Promise.resolve([] as Array<Record<string, unknown>>),
      rename: () => stubOk(),
      move: () => stubOk(),
      softDelete: () => stubOk(),
      getPreview: () => stubOk(null),
      listVersions: () => stubOk([]),
      openWithSystem: () => stubOk(),
    },
    agents: {
      listDefinitions: () => stubOk([]),
      listProfiles: () => stubOk([]),
      getProjectInstances: () => stubOk([]),
      detectCli: () => stubOk([]),
      saveCliConnection: () => stubOk(null),
      testCliConnection: () => stubOk({ success: true, capabilities: [] }),
      saveProfile: () => stubOk(null),
      setDefaultLeader: () => stubOk(),
      setProfileEnabled: () => stubOk(),
      updateProfileModel: () => stubOk(),
      updateProfileSkills: () => stubOk(),
      updateProfilePermissions: () => stubOk(),
      upgradeProjectInstance: () => stubOk(null),
      listAdapterTypes: () => stubOk(['codex', 'codebuddy']),
      wizardCancel: () => stubOk(),
    },
    models: {
      listUnified: () => stubOk([]),
      saveUnified: () => stubOk(null),
      testUnified: () => stubOk({ success: true, latencyMs: 0 }),
      deleteUnified: () => stubOk(),
      listProviders: () => stubOk([]),
      listProfiles: () => stubOk([]),
      saveProvider: () => stubOk(null),
      testProvider: () => stubOk({ success: true, latencyMs: 0 }),
      saveProfile: () => stubOk(null),
      testCapabilities: () => stubOk({ capabilities: [] }),
      setSlot: () => stubOk(),
    },
    memory: {
      list: () => stubOk([]),
      update: () => stubOk(null),
      remove: () => stubOk(),
    },
    knowledge: {
      search: () => stubOk([]),
      listJobs: () => stubOk([]),
      ingest: () => stubOk(null),
      retryJob: () => stubOk(null),
      getGraph: () => stubOk({ nodes: [], edges: [] }),
    },
    settings: {
      getAll: () => stubOk({}),
      update: () => stubOk({}),
      saveSecret: () => stubOk({ secretRef: 'stub' }),
      deleteSecret: () => stubOk(),
      exportDiagnostics: () => stubOk(),
      listSkills: () => stubOk([]),
      listTools: () => stubOk([]),
      listMcpServers: () => stubOk([]),
      setSkillEnabled: () => stubOk(),
      setToolEnabled: () => stubOk(),
      setMcpServerEnabled: () => stubOk(),
      addMcpServer: () => stubOk(null),
      scanSecrets: () => stubOk([]),
    },
    channels: {
      list: () => stubOk([]),
      save: () => stubOk(null),
      test: () => stubOk({ success: true, message: 'stub' }),
      setEnabled: () => stubOk(),
      listBindings: () => stubOk([]),
      previewConversation: () => stubOk({ exists: true, verified: false }),
      bind: () => stubOk(null),
      unbind: () => stubOk(),
    },
    events: {
      subscribe: () => () => {},
      subscribeChannels: () => () => {},
    },
  };
  (window as unknown as Record<string, unknown>).kunqing = overrides
    ? Object.assign(mock, overrides)
    : mock;
}

beforeEach(() => {
  window.sessionStorage.clear();
  createMockKunqing();
});

const renderAt = (path: string): void => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
};

describe('mock navigation', () => {

  it('locks an expired private deployment until operations unlock', async () => {
    createMockKunqing({
      settings: {
        getAll: () => stubOk({
          deploymentMode: 'private',
          operationsActivationStartedAt: '2025-01-01',
          operationsActivationExpiresAt: '2025-12-31',
        }),
      },
    });
    renderAt('/');

    expect(await screen.findByRole('heading', { name: '平台服务暂时中断' })).toBeInTheDocument();
    expect(screen.getByLabelText('解锁码')).toBeInTheDocument();
  });

  it('shows the saved nickname and avatar in the global sidebar', async () => {
    createMockKunqing({
      settings: {
        getAll: () => stubOk({ personalNickname: '林岚', personalAvatarDataUrl: 'data:image/png;base64,AA==' }),
      },
    });
    renderAt('/');

    expect(await screen.findByText('林岚')).toBeInTheDocument();
    expect(document.querySelector('.profile-avatar img')).toHaveAttribute('src', 'data:image/png;base64,AA==');
  });

  it('adds an unread notification for an agent message outside the active chat', async () => {
    let emit: (event: unknown) => void = () => {};
    createMockKunqing({
      events: {
        subscribe: (handler: (event: unknown) => void) => { emit = handler; return () => {}; },
        subscribeChannels: () => () => {},
      },
    });
    renderAt('/');
    await screen.findByRole('button', { name: '通知' });

    await act(async () => {
      emit({
        type: 'message.committed',
        projectId: 'annual-finance',
        messageId: 'agent-message-1',
        senderId: 'orchestrator',
        content: JSON.stringify({ text: '报告已经完成' }),
      });
    });

    await waitFor(() => expect(document.querySelector('.notification-dot')).not.toBeNull());
    await userEvent.click(screen.getByRole('button', { name: '通知' }));
    expect(await screen.findByText(/报告已经完成/)).toBeInTheDocument();
  });

  it('switches from home to the project chat', async () => {
    createMockKunqing({
      projects: {
        list: () => stubOk([
          { id: 'first-project', name: '列表首个群聊', status: 'active', lastActiveAt: new Date().toISOString(), createdAt: new Date().toISOString() },
          { id: 'annual-finance', name: '年度财务报销审核', status: 'active', lastActiveAt: new Date().toISOString(), createdAt: new Date().toISOString() },
        ]),
      },
    });
    const user = userEvent.setup();
    renderAt('/');

    expect(await screen.findByRole('heading', { name: '鲲擎智汇，由你开启' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '群组' }));

    expect(await screen.findByRole('heading', { name: '项目协作群组' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '列表首个群聊' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起项目栏' })).toBeInTheDocument();
  });

  it('fully collapses the project panel and reopens it beside the group title', async () => {
    const user = userEvent.setup();
    renderAt('/projects/annual-finance/chat');

    await screen.findByRole('heading', { name: '项目协作群组' });
    await user.click(screen.getByRole('button', { name: '收起项目栏' }));

    expect(screen.queryByRole('complementary', { name: '项目协作群组' })).not.toBeInTheDocument();
    const reopen = screen.getByRole('button', { name: '展开项目栏' });
    expect(reopen).toBeInTheDocument();

    await user.click(reopen);
    expect(screen.getByRole('heading', { name: '项目协作群组' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起项目栏' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '创建群组' }));
    expect(screen.getByRole('heading', { name: '创建新对话' })).toBeInTheDocument();
  });

  it('opens workspace from the chat folder action', async () => {
    const user = userEvent.setup();
    renderAt('/projects/annual-finance/chat');

    await user.click(screen.getByRole('button', { name: '打开工作区' }));

    expect(await screen.findByRole('heading', { name: '年度财务报销审核 · 工作区' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: '个人工作区文件' })).toBeInTheDocument();
  });

  it('validates and creates a group chat from New Chat', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await user.click(screen.getByRole('button', { name: '创建群聊' }));
    expect(screen.getByRole('heading', { name: '创建新对话' })).toBeInTheDocument();
  });

  it('creates a project from template', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await user.click(await screen.findByText('财务审计协同'));
    expect(await screen.findByText('新建协作群聊')).toBeInTheDocument();
  });

  it('switches between agent, model and channel settings', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await user.click(screen.getByRole('link', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: '智能体管理' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '模型管理' }));
    expect(await screen.findByRole('heading', { name: '模型管理' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '渠道' }));
    expect(await screen.findByRole('heading', { name: '渠道配置' })).toBeInTheDocument();

    const skillsLink = screen.getByRole('link', { name: '技能' });
    await user.click(skillsLink);
    expect(await screen.findByLabelText('技能设置页面')).toBeInTheDocument();
    expect(skillsLink).toHaveClass('settings-nav-link--active');
    const toolsLink = screen.getByRole('link', { name: '工具' });
    await user.click(toolsLink);
    expect(await screen.findByLabelText('工具设置页面')).toBeInTheDocument();
    expect(toolsLink).toHaveClass('settings-nav-link--active');

    expect(screen.getByRole('button', { name: /算力/ })).toBeDisabled();
  });

  it('shows and edits the enterprise project association for a group', async () => {
    createMockKunqing({ settings: { getAll: () => stubOk({
      enterpriseProjects: [{ id: 'enterprise-client', name: '客户增长项目', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      enterpriseProjectAssociations: { 'group:annual-finance': 'enterprise-client' },
    }) } });
    const user = userEvent.setup();
    renderAt('/projects/annual-finance/chat');

    expect(await screen.findByText('客户增长项目')).toHaveClass('project-association--linked');
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('button', { name: '关联项目' }));
    expect(await screen.findByRole('dialog', { name: '关联项目' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '所属项目' })).toHaveValue('enterprise-client');
  });

  it('opens the existing CLI connection wizard from an external agent card', async () => {
    createMockKunqing({
      agents: {
        listProfiles: () => stubOk([{ id: 'profile-codebuddy', name: 'CodeBuddy', definitionId: 'custom.codebuddy', runtimeMode: 'external-cli', adapterType: 'codebuddy', enabled: true, isBuiltin: false }]),
        listAdapterTypes: () => stubOk(['codex', 'codebuddy']),
        wizardCancel: () => stubOk(),
      },
    });
    const user = userEvent.setup();
    renderAt('/settings/agents');

    await user.click(await screen.findByRole('button', { name: /外接三方/ }));
    await user.click(await screen.findByRole('button', { name: '配置接入' }));

    expect(screen.getByRole('heading', { name: '接入智能体' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '适配器类型' })).toHaveValue('codebuddy');
  });

  it('opens the operation platform page directly from the primary navigation', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await user.click(screen.getByRole('link', { name: '操作' }));
    expect(screen.getByRole('link', { name: '操作' })).toHaveTextContent('Beta');

    expect(await screen.findByRole('heading', { name: '操作平台' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建操作平台' })).toBeInTheDocument();
  });

  it('creates a local enterprise project', async () => {
    const user = userEvent.setup();
    const update = vi.fn((_input: Record<string, unknown>) => stubOk({}));
    createMockKunqing({ settings: { getAll: () => stubOk({ enterpriseProjects: [] }), update } });
    renderAt('/');

    await user.click(screen.getByRole('link', { name: '项目' }));

    expect(await screen.findByRole('heading', { name: '企业项目' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '收起企业项目栏' }));
    expect(screen.queryByRole('complementary', { name: '企业项目列表' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开企业项目栏' }));
    await user.click(screen.getAllByRole('button', { name: '创建项目' })[0]!);
    await user.type(screen.getByLabelText('项目名称'), '客户增长项目');
    await user.click(screen.getByRole('button', { name: '确定创建' }));

    expect(await screen.findByRole('heading', { name: '客户增长项目', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '项目看板' })).toHaveClass('active');
    expect(screen.getByText('执行趋势')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '项目执行趋势图' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '项目看板全屏' }));
    expect(screen.getByRole('button', { name: '退出全屏' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: '退出全屏' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '项目详情' }));
    expect(screen.getByRole('heading', { name: '三、项目关联人员' })).toBeInTheDocument();
    expect(screen.getByText('项目立项文档')).toBeInTheDocument();
    expect(screen.getByText('128,640')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '项目进度' }));
    expect(screen.getByText('任务列表')).toBeInTheDocument();
    expect(screen.getByText(/内部资料检索与知识整理/)).toBeInTheDocument();
    expect(screen.getByText('任务完成占比')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关联节点' }));
    expect(screen.getByText('会议能力即将上线')).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      enterpriseProjects: [expect.objectContaining({ name: '客户增长项目' })],
    }));
  });

  it('creates and embeds a local operation platform', async () => {
    const user = userEvent.setup();
    const update = vi.fn((_input: Record<string, unknown>) => stubOk({}));
    createMockKunqing({
      settings: { getAll: () => stubOk({
        operationPlatforms: [],
        enterpriseProjects: [{ id: 'enterprise-client', name: '客户增长项目', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      }), update },
      models: { listUnified: () => stubOk([{ id: 'model-reasoning', name: '推理模型', modelId: 'gpt-5', type: 'openai' }]) },
    });
    renderAt('/');

    await user.click(screen.getByRole('link', { name: '操作' }));
    await user.click(await screen.findByRole('button', { name: '创建操作平台' }));
    await user.type(screen.getByLabelText('操作平台名称'), '客户运营后台');
    await user.type(screen.getByLabelText('网站地址'), 'https://example.com/console');
    await user.selectOptions(screen.getByLabelText('智能体模型'), 'model-reasoning');
    await user.click(screen.getByRole('button', { name: '确定创建' }));

    expect(await screen.findByTitle('客户运营后台 操作平台')).toHaveAttribute('src', 'https://example.com/console');
    expect(screen.getByRole('button', { name: '操作监控' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: '创建技能' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '技能管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '智能体管理' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '历史记录' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '对话' })).toHaveClass('active');
    expect(screen.getByPlaceholderText('输入对操作智能体的说明')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '历史' }));
    expect(screen.queryByPlaceholderText('输入对操作智能体的说明')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '创建技能' }));
    expect(screen.queryByRole('button', { name: '历史' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '对话' })).not.toBeInTheDocument();
    expect(screen.getByText('技能信息')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '创建技能' }).some((button) => button.hasAttribute('disabled'))).toBe(true);
    expect(screen.getByText('暂无保存视频')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '操作监控' }));
    await user.click(screen.getByRole('button', { name: '收起操作平台栏' }));
    expect(screen.queryByRole('complementary', { name: '操作平台列表' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开操作平台栏' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      operationPlatforms: [expect.objectContaining({ name: '客户运营后台', url: 'https://example.com/console' })],
    }));

    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('button', { name: '关联项目' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '所属项目' }), 'enterprise-client');
    await user.click(screen.getByRole('button', { name: '确认关联' }));
    expect(update.mock.calls.some(([input]) => Object.values((input as { enterpriseProjectAssociations?: Record<string, string> }).enterpriseProjectAssociations ?? {}).includes('enterprise-client'))).toBe(true);
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('button', { name: '重命名' }));
    const renameInput = screen.getByLabelText('操作平台名称');
    await user.clear(renameInput);
    await user.type(renameInput, '客户服务后台');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('heading', { name: '客户服务后台' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('button', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(await screen.findByText('暂无操作平台')).toBeInTheDocument();
  });

  it('shows remaining and total token values in the top bar', async () => {
    createMockKunqing({
      settings: {
        getAll: () => stubOk({ tokenUsageTotal: 250_000, operationsAvailableTokens: 1_000_000 }),
      },
    });
    renderAt('/');

    expect(await screen.findByLabelText('Token 剩余 750000，总量 1000000')).toBeInTheDocument();
    expect(screen.getByText('750,000')).toBeInTheDocument();
    expect(screen.getByText('1,000,000')).toBeInTheDocument();
  });

  it('verifies the operations key before opening operations management', async () => {
    const user = userEvent.setup();
    renderAt('/settings/agents');

    await user.click(screen.getByRole('link', { name: '运维管理' }));
    expect(screen.getByRole('dialog', { name: '运维权限验证' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('运维权限密钥'), '123456');
    await user.click(screen.getByRole('button', { name: '验证并进入' }));

    expect(await screen.findByRole('heading', { name: '运维管理' })).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: /SaaS 版本/ })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /私有化部署版本/ }));
    expect(screen.getByLabelText('产品激活有效期')).toBeInTheDocument();
  });
});

describe('M2 AC-HOME', () => {
  it('AC-HOME-01 homepage renders draft textarea', async () => {
    renderAt('/');
    expect(await screen.findByPlaceholderText('输入您的问题或需求，按 Enter 发送...')).toBeInTheDocument();
    expect(screen.getByText('Enter 发送 · Shift + Enter 换行 · 支持文件、图片和 @智能体')).toBeInTheDocument();
  });

  it('AC-HOME-03 creation failure shows error', async () => {
    createMockKunqing({
      projects: {
        create: () => Promise.resolve({ ok: false, error: { message: '创建失败: 网络错误' } }),
        list: () => stubOk([]),
        get: () => stubOk(null),
        rename: () => stubOk(),
        archive: () => stubOk(),
        restore: () => stubOk(),
      },
    });
    const user = userEvent.setup();
    renderAt('/');

    const textarea = await screen.findByPlaceholderText('输入您的问题或需求，按 Enter 发送...');
    await user.type(textarea, '会失败的项目');
    await user.keyboard('{Enter}');

    expect(await screen.findByText(/创建失败/)).toBeInTheDocument();
  });

  it('uses GM planning and starts the orchestrator for a homepage request', async () => {
    const user = userEvent.setup();
    const planHomeRequest = vi.fn(() => stubOk({
      groupName: '市场机会分析',
      requestedAgentProfileIds: ['builtin-orchestrator-profile', 'builtin-researcher-profile'],
    }));
    const create = vi.fn(() => stubOk({ id: 'gm-project', status: 'active', createdAt: new Date().toISOString() }));
    createMockKunqing({
      projects: {
        list: () => stubOk([]), planHomeRequest, create, get: () => stubOk(null),
        rename: () => stubOk(), archive: () => stubOk(), restore: () => stubOk(),
      },
    });
    renderAt('/');

    const textarea = await screen.findByPlaceholderText('输入您的问题或需求，按 Enter 发送...');
    await user.type(textarea, '分析最新市场机会');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(planHomeRequest).toHaveBeenCalledWith({ text: '分析最新市场机会' }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      customName: '市场机会分析',
      requestedAgentProfileIds: ['builtin-orchestrator-profile', 'builtin-researcher-profile'],
      autoStart: true,
    }));
  });
});

describe('M2 AC-CHAT', () => {
  it('opens an agent web link inside the right preview panel', async () => {
    const user = userEvent.setup();
    const webMessage = {
      id: 'web-link-1',
      projectId: 'annual-finance',
      senderType: 'agent',
      senderId: 'orchestrator',
      kind: 'text',
      contentJson: JSON.stringify({ text: '[产品网页](https://example.com/report)' }),
      status: 'sent',
      createdAt: new Date().toISOString(),
    };
    createMockKunqing({
      messages: {
        list: () => stubOk({ messages: [webMessage], hasMore: false }),
        listRunActivity: () => stubOk([]),
        send: () => stubOk({ id: 'message-2', createdAt: new Date().toISOString() }),
        cancelRun: () => stubOk(null),
        cancelProjectRuns: () => stubOk(null),
        retryRun: () => stubOk({ runId: '' }),
      },
    });
    renderAt('/projects/annual-finance/chat');

    await user.click(await screen.findByRole('link', { name: '产品网页' }));

    const frame = await screen.findByTitle('网页预览 example.com');
    expect(frame).toHaveAttribute('src', 'https://example.com/report');
    expect(screen.getByRole('button', { name: '打开工作区' })).toBeInTheDocument();
  });

  it('quotes a message in the composer and persists replyToId when sent', async () => {
    const user = userEvent.setup();
    const question = {
      id: 'question-1',
      projectId: 'annual-finance',
      senderType: 'agent',
      senderId: 'orchestrator',
      kind: 'text',
      contentJson: JSON.stringify({ text: '请告诉我所在城市' }),
      status: 'sent',
      createdAt: new Date().toISOString(),
    };
    const send = vi.fn((input: { replyToId?: string }) => stubOk({
      id: 'answer-1',
      createdAt: new Date().toISOString(),
      replyToId: input.replyToId,
    }));
    createMockKunqing({
      messages: {
        list: () => stubOk({ messages: [question], hasMore: false }),
        listRunActivity: () => stubOk([]),
        send,
        cancelRun: () => stubOk(null),
        cancelProjectRuns: () => stubOk(null),
        retryRun: () => stubOk({ runId: '' }),
      },
    });
    renderAt('/projects/annual-finance/chat');

    fireEvent.contextMenu(await screen.findByText('请告诉我所在城市'));
    await user.click(screen.getByRole('menuitem', { name: '回复消息' }));
    expect(screen.getByText('回复 智能体')).toBeInTheDocument();

    const composer = screen.getByRole('textbox');
    await user.type(composer, '我在上海');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ replyToId: 'question-1' })));
  });

  it('AC-CHAT-05 loads messages and shows load more button', async () => {
    const manyMessages = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      projectId: 'annual-finance',
      senderType: i % 2 === 0 ? 'user' : 'agent',
      senderId: i % 2 === 0 ? 'local-user' : 'orchestrator',
      kind: 'text',
      contentJson: JSON.stringify({ text: `测试消息 ${i}` }),
      status: 'sent',
      createdAt: new Date(Date.now() - i * 60000).toISOString(),
    }));

    createMockKunqing({
      messages: {
        list: () => stubOk({ messages: manyMessages, hasMore: true }),
        send: () => stubOk({ id: 'msg-new', createdAt: new Date().toISOString() }),
        cancelRun: () => stubOk(null),
        retryRun: () => stubOk({ runId: '' }),
      },
    });
    renderAt('/projects/annual-finance/chat');

    expect(await screen.findByText('加载更多消息')).toBeInTheDocument();
  });

  it('renders chat page with VirtualMessageList and composer', async () => {
    renderAt('/projects/annual-finance/chat');
    expect(screen.getByPlaceholderText('发送消息给智能体小组...')).toBeInTheDocument();
  });

  it('uses expert collaboration by default and can send in fast mode', async () => {
    const user = userEvent.setup();
    const send = vi.fn(() => stubOk({ id: 'mode-message', createdAt: new Date().toISOString() }));
    window.localStorage.removeItem('kunqing.collaborationMode.annual-finance');
    createMockKunqing({
      messages: {
        list: () => stubOk({ messages: [], hasMore: false }),
        listRunActivity: () => stubOk([]),
        send,
        cancelRun: () => stubOk(null),
        cancelProjectRuns: () => stubOk(null),
        retryRun: () => stubOk({ runId: '' }),
      },
    });
    renderAt('/projects/annual-finance/chat');

    expect(await screen.findByRole('button', { name: '专家' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: '快速' }));
    expect(screen.getByRole('button', { name: '快速' })).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByPlaceholderText('发送消息给智能体小组...'), '查询今天上海天气');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ collaborationMode: 'fast' }),
    })));
    expect(window.localStorage.getItem('kunqing.collaborationMode.annual-finance')).toBe('fast');
    window.localStorage.removeItem('kunqing.collaborationMode.annual-finance');
  });

  it('persists balanced collaboration and sends it with the user message', async () => {
    const user = userEvent.setup();
    const send = vi.fn(() => stubOk({ id: 'balanced-mode-message', createdAt: new Date().toISOString() }));
    window.localStorage.removeItem('kunqing.collaborationMode.annual-finance');
    createMockKunqing({
      messages: {
        list: () => stubOk({ messages: [], hasMore: false }),
        listRunActivity: () => stubOk([]),
        send,
        cancelRun: () => stubOk(null),
        cancelProjectRuns: () => stubOk(null),
        retryRun: () => stubOk({ runId: '' }),
      },
    });
    renderAt('/projects/annual-finance/chat');

    expect(await screen.findByRole('button', { name: '均衡' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: '均衡' }));
    expect(screen.getByRole('button', { name: '均衡' })).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByPlaceholderText('发送消息给智能体小组...'), '整理一份月度经营摘要');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ collaborationMode: 'balanced' }),
    })));
    expect(window.localStorage.getItem('kunqing.collaborationMode.annual-finance')).toBe('balanced');
    window.localStorage.removeItem('kunqing.collaborationMode.annual-finance');
  });

  it('shows executing agents in a pill and stops all project runs', async () => {
    const user = userEvent.setup();
    const cancelProjectRuns = vi.fn(() => stubOk(null));
    const now = new Date().toISOString();
    createMockKunqing({
      messages: {
        list: () => stubOk({ messages: [], hasMore: false }),
        listRunActivity: () => stubOk([{
          runId: 'run-active',
          agentId: 'agent-leader',
          agentName: '统筹智能体',
          status: 'running',
          traces: [],
          updatedAt: now,
        }]),
        send: () => stubOk({ id: 'msg-new', createdAt: now }),
        cancelRun: () => stubOk(null),
        cancelProjectRuns,
        retryRun: () => stubOk({ runId: '' }),
      },
      agents: {
        getProjectInstances: () => stubOk([{
          id: 'agent-leader',
          projectId: 'annual-finance',
          agentName: '统筹智能体',
          role: 'leader',
          runtimeMode: 'builtin',
        }]),
      },
    });
    renderAt('/projects/annual-finance/chat');

    expect(await screen.findByRole('status', { name: '统筹智能体执行中' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '停止全部任务' }));

    expect(cancelProjectRuns).toHaveBeenCalledWith({ projectId: 'annual-finance' });
    await waitFor(() => expect(screen.queryByRole('status', { name: '统筹智能体执行中' })).not.toBeInTheDocument());
  });
});
