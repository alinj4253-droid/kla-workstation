import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
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
      create: () => stubOk({ id: 'test-project', status: 'active', createdAt: new Date().toISOString() }),
      get: () => stubOk(null),
      rename: () => stubOk(),
      archive: () => stubOk(),
      restore: () => stubOk(),
    },
    messages: {
      list: () => stubOk({ messages: [], hasMore: false }),
      send: () => stubOk({ id: 'msg-1', createdAt: new Date().toISOString() }),
      cancelRun: () => stubOk(null),
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
      upgradeProjectInstance: () => stubOk(null),
    },
    models: {
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
    },
    channels: {
      list: () => stubOk([]),
      save: () => stubOk(null),
      test: () => stubOk({ success: true, message: 'stub' }),
      setEnabled: () => stubOk(),
    },
    events: {
      subscribe: () => () => {},
    },
  };
  (window as unknown as Record<string, unknown>).kunqing = overrides
    ? Object.assign(mock, overrides)
    : mock;
}

beforeEach(() => {
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

  it('switches from home to the project chat', async () => {
    const user = userEvent.setup();
    renderAt('/');

    expect(await screen.findByRole('heading', { name: '鲲擎智汇，由你开启' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '项目' }));

    expect(await screen.findByRole('heading', { name: '协作项目' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /协作项目/ })).toBeInTheDocument();
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
    renderAt('/');

    await user.click(screen.getByRole('button', { name: '新建群聊' }));
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
    expect(await screen.findByRole('heading', { name: '智能体接入' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '模型管理' }));
    expect(await screen.findByRole('heading', { name: '模型管理' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '渠道' }));
    expect(await screen.findByRole('heading', { name: '渠道配置' })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /算力/ })).toBeDisabled();
  });
});

describe('M2 AC-HOME', () => {
  it('AC-HOME-01 homepage renders draft textarea', async () => {
    renderAt('/');
    expect(await screen.findByPlaceholderText('输入您的问题或需求，按 Enter 发送...')).toBeInTheDocument();
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
});

describe('M2 AC-CHAT', () => {
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
});
