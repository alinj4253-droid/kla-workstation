import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workstation } from './Workstation';

const { request, download, setSession, setIdentity, setAccount, warm, invalidate, memoryScopes, memoryEntries } = vi.hoisted(() => ({
  request: vi.fn(), download: vi.fn(), setSession: vi.fn(), setIdentity: vi.fn(), setAccount: vi.fn(), warm: vi.fn(), invalidate: vi.fn(), memoryScopes: vi.fn(), memoryEntries: vi.fn(),
}));
vi.mock('../api/client', () => ({
  authExpiredEventName: 'kla:auth-expired',
  klaApi: { request, download, setSession, setIdentity, setAccount, getIdentity: () => sessionStorage.getItem('kla.identity-id'), clearAccessToken: () => sessionStorage.clear() },
}));
vi.mock('../api/memories', () => ({ memoryApi: { warm, invalidate, scopes: memoryScopes, entries: memoryEntries } }));

const projects = [{ id: 'project-a', name: '同名项目' }, { id: 'project-b', name: '同名项目' }];
const conversations = [{ id: 'chat-a', projectId: 'project-a', name: '已有群聊' }];
const historicalReply = { id: 'history', senderType: 'agent', senderName: '统筹智能体', text: '上一轮的回复', createdAt: '2026-10-08T01:00:00Z' };
const groupAgents = [
  { id: '00000000-0000-4000-8000-000000000001', name: '统筹智能体', role: '协调任务', enabled: true, type: 'official', version: 1 },
  { id: '00000000-0000-4000-8000-000000000002', name: '本地执行智能体', role: '执行任务', enabled: true, type: 'official', version: 1 },
];
type Result = { ok: boolean; data?: unknown; message?: string };
let overrides: Record<string, () => Result | Promise<Result>>;

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem('kla.access-token', 'test-token');
  sessionStorage.setItem('kla.identity-id', 'identity-a');
  overrides = {};
  request.mockReset();
  download.mockReset();
  setSession.mockReset();
  setIdentity.mockReset();
  setAccount.mockReset();
  setAccount.mockImplementation((id: string) => sessionStorage.setItem('kla.account-id', id));
  warm.mockReset(); warm.mockResolvedValue(undefined);
  invalidate.mockReset(); invalidate.mockResolvedValue(undefined);
  memoryScopes.mockReset().mockResolvedValue({ ok: true, data: { projects: [], conversations: [], agents: [], counts: { longTerm: 0, shortTerm: 0 }, latestUpdatedAt: null } });
  memoryEntries.mockReset().mockResolvedValue({ ok: true, data: { items: [], page: { page: 1, pageSize: 20, total: 0 } } });
  setIdentity.mockImplementation((id: string) => sessionStorage.setItem('kla.identity-id', id));
  request.mockImplementation(async (path: string, init: RequestInit = {}) => {
    const override = overrides[`${init.method ?? 'GET'} ${path}`];
    if (override) return override();
    if (path === '/v1/me') return { ok: true, data: { id: 'user-a', nickname: '测试用户' } };
    if (path === '/v1/me/identities') return { ok: true, data: [{ id: 'identity-a', type: 'personal', displayName: '个人工作区', isDefault: true }] };
    if (path === '/v1/bootstrap') return { ok: true, data: { projects, conversations } };
    if (/^\/v1\/projects\/[^/]+\/agents$/.test(path)) return { ok: true, data: groupAgents };
    if (path.endsWith('/messages')) return { ok: true, data: [historicalReply] };
    return { ok: true, data: [] };
  });
});

async function openProjects() {
  const user = userEvent.setup();
  render(<Workstation />);
  await user.click(await screen.findByRole('button', { name: '项目' }));
  await screen.findByText('2 个项目 · 1 个群组');
  return user;
}

async function openChat() {
  const user = await openProjects();
  await user.click(screen.getByRole('button', { name: /^已有群聊/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: '发送给群组' })).toBeEnabled());
  return user;
}

describe('登录与注册入口', () => {
  it('未登录时显示空白凭据和卡片内的注册入口，注册表单可以打开并取消', async () => {
    sessionStorage.clear();
    const user = userEvent.setup();
    render(<Workstation />);
    expect(screen.getByPlaceholderText('请输入账号或邮箱')).toHaveValue('');
    expect(screen.getByPlaceholderText('请输入密码')).toHaveValue('');
    expect(screen.queryByRole('button', { name: '个人登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '企业登录' })).not.toBeInTheDocument();
    const registerLink = screen.getByRole('button', { name: '注册鲲擎账号' });
    expect(registerLink.closest('form')).toHaveClass('ws-login-card');
    await user.click(registerLink);
    expect(screen.getByPlaceholderText('设置登录账号，如 laok')).toBeVisible();
    expect(screen.getByPlaceholderText('请输入 6 位验证码')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByPlaceholderText('请输入 6 位验证码')).not.toBeInTheDocument();
  });

  it('注册先校验验证码和密码，再保存包含 refresh token 的会话并选择身份', async () => {
    sessionStorage.clear();
    const session = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: '2026-10-15T00:00:00Z' };
    const identity = { id: 'personal-new', type: 'personal', displayName: '个人空间', isDefault: true };
    overrides['POST /v1/auth/register'] = () => ({ ok: true, data: { user: { id: 'user-new' }, session, identities: [identity] } });
    const user = userEvent.setup();
    render(<Workstation />);
    await user.click(screen.getByRole('button', { name: '注册鲲擎账号' }));
    await user.type(screen.getByPlaceholderText('设置登录账号，如 laok'), 'NewUser');
    await user.type(screen.getByPlaceholderText('设置登录密码，至少 8 位'), 'weakpass');
    await user.type(screen.getByPlaceholderText('用于接收验证码与找回密码'), 'new@example.test');
    const code = screen.getByPlaceholderText('请输入 6 位验证码');
    await user.type(code, '000000');
    await user.click(screen.getByRole('button', { name: '注册' }));
    expect(await screen.findByText('邮箱验证码错误，演示环境请输入 123456')).toBeVisible();
    expect(request).not.toHaveBeenCalled();
    await user.clear(code);
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: '注册' }));
    expect(await screen.findByText('密码至少 8 位，且必须包含数字、大写字母和小写字母')).toBeVisible();
    expect(request).not.toHaveBeenCalled();
    const password = screen.getByPlaceholderText('设置登录密码，至少 8 位');
    await user.clear(password);
    await user.type(password, 'ValidPass2026');
    await user.click(screen.getByRole('button', { name: '注册' }));
    expect(await screen.findByText('选择进入身份')).toBeVisible();
    expect(setSession).toHaveBeenCalledWith(session);
    expect(setAccount).toHaveBeenCalledWith('user-new');
    expect(setIdentity).toHaveBeenCalledWith(identity.id);
    const submission = request.mock.calls.find(([path]) => path === '/v1/auth/register');
    expect(JSON.parse(submission![1].body)).toEqual({ email: 'new@example.test', password: 'ValidPass2026', nickname: 'NewUser' });
  });

  it('登录后个人身份通过后端激活，失败时保留身份弹窗供重试', async () => {
    sessionStorage.clear();
    const session = { accessToken: 'login-access', refreshToken: 'login-refresh', expiresAt: '2026-10-15T00:00:00Z' };
    const identity = { id: 'personal-login', type: 'personal', displayName: '个人工作区', isDefault: true };
    overrides['POST /v1/auth/login'] = () => ({ ok: true, data: { user: { id: 'user-login' }, session, identities: [identity] } });
    overrides['POST /v1/me/identities/personal-login/activate'] = () => ({ ok: false, message: '身份激活暂不可用' });
    const user = userEvent.setup();
    render(<Workstation />);
    await user.type(screen.getByPlaceholderText('请输入账号或邮箱'), 'MyAccount');
    await user.type(screen.getByPlaceholderText('请输入密码'), 'MyPassword2026');
    await user.click(screen.getByRole('button', { name: /立即登录并连接/ }));
    expect(await screen.findByText('选择进入身份')).toBeVisible();
    expect(setSession).toHaveBeenCalledWith(session);
    expect(setAccount).toHaveBeenCalledWith('user-login');
    await user.click(screen.getByRole('button', { name: /个人身份.*个人工作区/ }));
    expect(await screen.findByText('身份激活暂不可用')).toBeVisible();
    expect(screen.getByText('选择进入身份')).toBeVisible();
    const activation = request.mock.calls.find(([path]) => path.endsWith('/activate'));
    expect(activation![1].headers).toEqual({ 'x-identity-id': 'personal-login' });
    overrides['POST /v1/me/identities/personal-login/activate'] = () => ({ ok: true, data: identity });
    await user.click(screen.getByRole('button', { name: /个人身份.*个人工作区/ }));
    await waitFor(() => expect(screen.queryByText('选择进入身份')).not.toBeInTheDocument());
    expect(setIdentity).toHaveBeenLastCalledWith(identity.id);
  });
});

describe('首页快捷键发送', () => {
  it.each(['Enter', '发送按钮'])('首页通过 %s 将任务提交到已有群聊', async trigger => {
    const message = { id: 'home-message', senderType: 'user', text: '整理项目进展', createdAt: '2026-10-13T01:00:00Z' };
    overrides['POST /v1/conversations/chat-a/messages'] = () => ({ ok: true, data: { message, run: null } });
    overrides['GET /v1/conversations/chat-a/messages'] = () => ({ ok: true, data: [message] });
    const user = userEvent.setup();
    render(<Workstation />);
    const input = await screen.findByRole('textbox', { name: '首页任务输入' });
    expect(input).toHaveAccessibleDescription('Enter 发送 · Shift + Enter 换行');
    await user.type(input, message.text);
    if (trigger === 'Enter') await user.keyboard('{Enter}');
    else await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(request.mock.calls.filter(([path, init]) => path.endsWith('/messages') && init?.method === 'POST')).toHaveLength(1));
    const submission = request.mock.calls.find(([path, init]) => path.endsWith('/messages') && init?.method === 'POST');
    expect(submission![0]).toBe('/v1/conversations/chat-a/messages');
    expect(JSON.parse(submission![1].body)).toEqual({ text: message.text, mode: 'balanced', fileIds: [], executionAccess: 'approval', idempotencyKey: expect.any(String) });
    expect(submission![1].headers).toEqual({ 'x-identity-id': 'identity-a' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: '发送消息给群聊' })).toHaveValue(''));
    expect(screen.queryByRole('textbox', { name: '首页任务输入' })).not.toBeInTheDocument();
  });

  it('Shift + Enter 换行，中文输入法确认选词不会发送任务', async () => {
    const user = userEvent.setup();
    render(<Workstation />);
    const input = await screen.findByRole('textbox', { name: '首页任务输入' });
    await user.type(input, '第一行');
    await user.keyboard('{Shift>}{Enter}{/Shift}第二行');
    expect(input).toHaveValue('第一行\n第二行');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(request.mock.calls.filter(([path, init]) => path.endsWith('/messages') && init?.method === 'POST')).toHaveLength(0);
    expect(input).toHaveValue('第一行\n第二行');
  });

  it('空输入不发送，没有群聊时保留输入并提示创建或选择群组', async () => {
    overrides['GET /v1/bootstrap'] = () => ({ ok: true, data: { projects, conversations: [] } });
    const user = userEvent.setup();
    render(<Workstation />);
    const input = await screen.findByRole('textbox', { name: '首页任务输入' });
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(input).toHaveValue('');
    expect(screen.queryByText('请先创建或选择一个真实群组')).not.toBeInTheDocument();
    await user.type(input, '待发送任务{Enter}');
    expect(await screen.findByText('请先创建或选择一个真实群组')).toBeVisible();
    expect(input).toHaveValue('待发送任务');
    expect(request.mock.calls.filter(([path, init]) => path.endsWith('/messages') && init?.method === 'POST')).toHaveLength(0);
  });
});

describe('首页统一任务筛选', () => {
  it('使用当前身份的任务摘要统计待办，全部入口显示已完成和失败记录', async () => {
    const tasks = [
      { id: 'pending-task', title: '整理项目材料', status: 'pending', created_at: '2026-10-13T01:00:00Z' },
      { id: 'running-task', title: '生成项目报告', status: 'running', created_at: '2026-10-13T02:00:00Z' },
      { id: 'completed-task', title: '已完成的审阅', status: 'completed', created_at: '2026-10-12T01:00:00Z' },
      { id: 'failed-task', title: '失败的历史任务', status: 'failed', created_at: '2026-10-11T01:00:00Z' },
    ];
    overrides['GET /v1/bootstrap'] = () => ({ ok: true, data: { projects, conversations, tasks } });
    const user = userEvent.setup();
    render(<Workstation />);
    const mine = await screen.findByRole('button', { name: '我的任务 2 项' });
    expect(mine).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('整理项目材料')).toBeVisible();
    expect(screen.getByText('生成项目报告')).toBeVisible();
    expect(screen.queryByText('已完成的审阅')).not.toBeInTheDocument();
    const filters = within(screen.getByRole('group', { name: '任务筛选' }));
    await user.click(filters.getByRole('button', { name: '全部' }));
    expect(screen.getByRole('list', { name: '全部任务' })).toBeVisible();
    expect(screen.getByText('已完成的审阅')).toBeVisible();
    expect(screen.getByText('失败的历史任务')).toBeVisible();
    expect(filters.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(mine);
    expect(screen.getByRole('list', { name: '我的待办任务' })).toBeVisible();
    expect(screen.queryByText('已完成的审阅')).not.toBeInTheDocument();
    expect(screen.queryByText('失败的历史任务')).not.toBeInTheDocument();
  });

  it('空任务时显示原型的筛选区，并分别显示待办和全部任务的空态', async () => {
    overrides['GET /v1/bootstrap'] = () => ({ ok: true, data: { projects, conversations, tasks: [] } });
    const user = userEvent.setup();
    render(<Workstation />);
    await screen.findByRole('button', { name: '我的任务 0 项' });
    expect(screen.getByText('今天没有待办')).toBeVisible();
    expect(screen.getByRole('button', { name: '+ 新建任务' })).toBeVisible();
    await user.click(within(screen.getByRole('group', { name: '任务筛选' })).getByRole('button', { name: '全部' }));
    expect(screen.getByText('暂无任务')).toBeVisible();
  });

  it('工作区加载失败时不将未知任务数量显示为零', async () => {
    overrides['GET /v1/bootstrap'] = () => ({ ok: false, message: '工作区暂不可用' });
    render(<Workstation />);
    expect(await screen.findByText('任务暂时无法加载，请刷新页面重试。')).toBeVisible();
    expect(screen.getByRole('button', { name: '我的任务 — 项' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '我的任务 0 项' })).not.toBeInTheDocument();
  });
});

describe('首页快捷功能跳转', () => {
  async function openHomeShortcuts() {
    const user = userEvent.setup();
    render(<Workstation />);
    await screen.findByRole('textbox', { name: '首页任务输入' });
    const shortcuts = within(screen.getByRole('heading', { name: '快捷功能入口' }).closest('section')!);
    return { user, shortcuts };
  }

  it('智能体入口始终打开智能体管理，而不是上次查看的技能子页', async () => {
    overrides['GET /v1/compute/keys'] = () => ({ ok: true, data: { items: [] } });
    const { user, shortcuts } = await openHomeShortcuts();
    await user.click(shortcuts.getByRole('button', { name: /^智能体/ }));
    expect(await screen.findByText('智能体 / 智能体管理')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '技能' }));
    await screen.findByRole('heading', { name: '技能' });
    await user.click(screen.getByRole('button', { name: '首页' }));
    const homeShortcuts = within(screen.getByRole('heading', { name: '快捷功能入口' }).closest('section')!);
    await user.click(homeShortcuts.getByRole('button', { name: /^智能体/ }));
    expect(await screen.findByText('智能体 / 智能体管理')).toBeVisible();
    expect(screen.getByRole('heading', { name: '智能体' })).toBeVisible();
  });

  it('记忆入口打开当前身份的记忆页面', async () => {
    const { user, shortcuts } = await openHomeShortcuts();
    await user.click(shortcuts.getByRole('button', { name: /^记忆/ }));
    expect(await screen.findByRole('heading', { name: '记忆' })).toBeVisible();
    await waitFor(() => expect(memoryScopes).toHaveBeenCalledWith('identity-a', expect.any(AbortSignal)));
    expect(await screen.findByText('当前筛选范围暂无长期记忆')).toBeVisible();
  });

  it('统一任务入口滚动定位并聚焦任务筛选，键盘可继续操作', async () => {
    const { user, shortcuts } = await openHomeShortcuts();
    const mine = await screen.findByRole('button', { name: '我的任务 0 项' });
    const scroll = vi.fn();
    Object.defineProperty(mine, 'scrollIntoView', { value: scroll });
    await user.click(shortcuts.getByRole('button', { name: /^统一任务/ }));
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(mine).toHaveFocus();
  });

  it('企业管理员从成员入口直接打开成员管理子页', async () => {
    overrides['GET /v1/me/identities'] = () => ({ ok: true, data: [{ id: 'identity-a', type: 'enterprise', role: 'admin', organizationId: 'org-a', displayName: '管理员身份', isDefault: true }] });
    const { user, shortcuts } = await openHomeShortcuts();
    await user.click(shortcuts.getByRole('button', { name: /^成员管理/ }));
    expect(await screen.findByRole('heading', { name: '成员管理', level: 1 })).toBeVisible();
    expect(screen.getByText('平台设置 / 成员管理')).toBeVisible();
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === '/v1/organizations/org-a/members')).toBe(true));
  });

  it.each(['personal', 'member'])('非管理员 %s 身份点击成员入口时保留首页并提示权限', async role => {
    overrides['GET /v1/me/identities'] = () => ({ ok: true, data: [{ id: 'identity-a', type: role === 'personal' ? 'personal' : 'enterprise', role, organizationId: role === 'personal' ? null : 'org-a', displayName: '非管理员身份', isDefault: true }] });
    const { user, shortcuts } = await openHomeShortcuts();
    await user.click(shortcuts.getByRole('button', { name: /^成员管理/ }));
    expect(await screen.findByText('成员管理仅限企业管理员，请先切换到管理员身份')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '首页任务输入' })).toBeVisible();
    expect(request.mock.calls.some(([path]) => path === '/v1/organizations/org-a/members')).toBe(false);
  });
});

describe('新版项目和群聊的真实接口交互', () => {
  it('项目或群聊创建失败时保留弹窗和输入，当前页面仍可使用', async () => {
    overrides['POST /v1/projects'] = () => ({ ok: false, message: '缺少 write 权限' });
    overrides['POST /v1/conversations'] = () => ({ ok: false, message: '后端暂不可用' });
    const user = await openProjects();
    await user.click(screen.getByRole('button', { name: '创建项目' }));
    await user.type(screen.getByLabelText('项目名称'), '待创建项目');
    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('缺少 write 权限')).toBeVisible();
    expect(screen.getByLabelText('项目名称')).toHaveValue('待创建项目');
    await user.click(screen.getByRole('button', { name: '取消' }));
    await user.click(screen.getAllByTitle('在此项目下新建群聊')[0]);
    await user.type(screen.getByLabelText('群组名称'), '待创建群聊');
    await user.click(await screen.findByRole('checkbox', { name: '本地执行智能体' }));
    await user.click(screen.getByRole('button', { name: '创建群组' }));
    expect(await screen.findByText('后端暂不可用')).toBeVisible();
    expect(screen.getByLabelText('群组名称')).toHaveValue('待创建群聊');
    expect(screen.getByRole('checkbox', { name: '本地执行智能体' })).toBeChecked();
    expect(screen.getByText('2 个项目 · 1 个群组')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: '发送消息给群聊' })).not.toBeInTheDocument();
  });

  it('同名项目按 ID 关联，等待提交时阻止重复创建，成功后保留项目树', async () => {
    let resolveCreate!: (value: Result) => void;
    overrides['POST /v1/conversations'] = () => new Promise(resolve => { resolveCreate = resolve; });
    const user = await openProjects();
    await user.click(screen.getAllByTitle('在此项目下新建群聊')[1]);
    expect(screen.getByLabelText('关联项目')).toHaveValue('project-b');
    await user.type(screen.getByLabelText('群组名称'), '新的真实群聊');
    await user.click(await screen.findByRole('checkbox', { name: '本地执行智能体' }));
    await user.click(screen.getByRole('button', { name: '创建群组' }));
    const submitting = screen.getByRole('button', { name: '创建中…' });
    expect(submitting).toBeDisabled();
    fireEvent.click(submitting);
    const submissions = request.mock.calls.filter(([path, init]) => path === '/v1/conversations' && init.method === 'POST');
    expect(submissions).toHaveLength(1);
    expect(JSON.parse(submissions[0][1].body)).toEqual({ projectId: 'project-b', name: '新的真实群聊', agentIds: [groupAgents[1].id] });
    expect(submissions[0][1].headers).toEqual({ 'x-identity-id': 'identity-a' });
    resolveCreate({ ok: true, data: { id: 'chat-b', projectId: 'project-b', name: '新的真实群聊' } });
    await screen.findByRole('textbox', { name: '发送消息给群聊' });
    expect(screen.getByText('2 个项目 · 2 个群组')).toBeVisible();
    expect(screen.queryByLabelText('群组名称')).not.toBeInTheDocument();
  });

  it('发送失败保留草稿，不添加未落库的消息气泡', async () => {
    overrides['POST /v1/conversations/chat-a/messages'] = () => ({ ok: false, message: '发送服务不可用' });
    const user = await openChat();
    const input = screen.getByRole('textbox', { name: '发送消息给群聊' });
    await user.type(input, '请记住项目代号蓝鲸');
    await user.click(screen.getByRole('button', { name: '发送给群组' }));
    expect(await screen.findByText('发送服务不可用')).toBeVisible();
    expect(input).toHaveValue('请记住项目代号蓝鲸');
    expect(screen.queryByText('请记住项目代号蓝鲸', { selector: 'p' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送给群组' })).toBeEnabled();
  });

  it('提及群聊秘书使用系统路由，不提交统筹智能体的 agent ID', async () => {
    overrides['GET /v1/conversations/chat-a/agents'] = () => ({ ok: true, data: groupAgents });
    overrides['GET /v1/conversations/chat-a/members'] = () => ({ ok: true, data: [] });
    const message = { id: 'coordinator-message', senderType: 'user', text: '@群聊秘书 请处理', createdAt: '2026-10-13T01:00:00Z' };
    overrides['POST /v1/conversations/chat-a/messages'] = () => ({ ok: true, data: { message, run: null } });
    const user = await openChat();
    const input = screen.getByRole('textbox', { name: '发送消息给群聊' });
    await user.type(input, '@群聊');
    await user.click(screen.getByRole('option', { name: '系统路由 · 群聊秘书' }));
    await user.type(input, '请处理');
    await user.click(screen.getByRole('button', { name: '发送给群组' }));
    await waitFor(() => expect(request.mock.calls.some(([path, init]) => path === '/v1/conversations/chat-a/messages' && init?.method === 'POST')).toBe(true));
    const submission = request.mock.calls.find(([path, init]) => path === '/v1/conversations/chat-a/messages' && init?.method === 'POST');
    expect(JSON.parse(submission![1].body).submitObject).toEqual([{ type: 'command', id: 'coordinator' }]);
    expect(JSON.parse(submission![1].body).submitObject).not.toContainEqual({ type: 'agent', id: groupAgents[0].id });
  });

  it('附件真实走上传会话、内容上传和完成接口，发送文件引用并可在右侧预览', async () => {
    const file = { id: '00000000-0000-4000-8000-000000000003', workspaceId: null, name: '共享资料.md', storageKey: 'uploads/opaque/content', checksum: null,
      contentType: 'text/markdown', sizeBytes: 23, status: 'uploaded', createdAt: '2026-10-10T01:00:00Z' };
    const uploadId = 'upload-a';
    overrides['POST /v1/files/upload-sessions'] = () => ({ ok: true, data: { id: uploadId, file_name: file.name, content_type: file.contentType, size_bytes: String(file.sizeBytes), checksum: null,
      status: 'created', expires_at: '2026-10-10T02:00:00Z', uploadUrl: `/api/v1/files/upload-sessions/${uploadId}/content`, completeUrl: `/api/v1/files/upload-sessions/${uploadId}/complete`, mode: 'server-object-storage' } });
    overrides[`PUT /v1/files/upload-sessions/${uploadId}/content`] = () => ({ ok: true });
    overrides[`POST /v1/files/upload-sessions/${uploadId}/complete`] = () => ({ ok: true, data: file });
    const message = { id: 'file-message', senderType: 'user', text: '', createdAt: file.createdAt, metadata: { fileIds: [file.id], files: [{ id: file.id, name: file.name, contentType: file.contentType, sizeBytes: file.sizeBytes }] } };
    let submitted = false;
    overrides['POST /v1/conversations/chat-a/messages'] = () => { submitted = true; return { ok: true, data: { message, run: null } }; };
    overrides['GET /v1/conversations/chat-a/messages'] = () => ({ ok: true, data: submitted ? [message] : [] });
    download.mockResolvedValue({ ok: true, blob: { text: async () => '# 共享文件内容\n已持久化' } });
    const user = await openChat();
    const selected = new File(['# 共享文件内容'], file.name, { type: file.contentType });
    await user.upload(screen.getByLabelText('选择群聊附件'), selected);
    await screen.findByText('已保存到群聊 · 同群成员可访问');
    const uploaded = request.mock.calls.find(([path, init]) => path.endsWith('/content') && init?.method === 'PUT');
    expect(uploaded![1].body).toBe(selected);
    expect(uploaded![1].headers).toEqual({ 'x-identity-id': 'identity-a', 'content-type': 'application/octet-stream' });
    await user.click(screen.getByRole('button', { name: '发送给群组' }));
    const sent = request.mock.calls.find(([path, init]) => path === '/v1/conversations/chat-a/messages' && init?.method === 'POST');
    expect(JSON.parse(sent![1].body)).toEqual({ text: '', mode: 'balanced', fileIds: [file.id], executionAccess: 'approval', idempotencyKey: expect.any(String) });
    expect(screen.queryByLabelText(`移除附件 ${file.name}`)).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: file.name }));
    expect(await screen.findByRole('heading', { name: '共享文件内容' })).toBeVisible();
    expect(download).toHaveBeenCalledWith(`/v1/files/${file.id}/content`);
    await user.click(screen.getAllByRole('button', { name: file.name })[1]);
    expect(screen.getByRole('heading', { name: '共享文件内容' })).toBeVisible();
    expect(request.mock.calls.some(([path]) => path === `/v1/artifacts/${file.id}`)).toBe(false);
  });

  it('附件上传失败不加入草稿，也不会提交未完成的文件引用', async () => {
    overrides['POST /v1/files/upload-sessions'] = () => ({ ok: false, message: '文件存储服务未配置' });
    const user = await openChat();
    await user.upload(screen.getByLabelText('选择群聊附件'), new File(['data'], '失败.txt', { type: 'text/plain' }));
    expect(await screen.findByText('文件存储服务未配置')).toBeVisible();
    expect(screen.queryByLabelText('移除附件 失败.txt')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '发送给群组' }));
    expect(request.mock.calls.filter(([path, init]) => path.endsWith('/messages') && init?.method === 'POST')).toHaveLength(0);
  });

  it('成果读取失败会提示，成功后使用隔离的 HTML 预览', async () => {
    overrides['GET /v1/conversations/chat-a/messages'] = () => ({ ok: true, data: [{ ...historicalReply, metadata: { artifactId: 'report-a' } }] });
    overrides['GET /v1/artifacts/report-a'] = () => ({ ok: false, message: '成果文件不存在' });
    const user = await openChat();
    await user.click(screen.getByRole('button', { name: '打开成果文件' }));
    expect(await screen.findByText('成果文件不存在')).toBeVisible();
    expect(screen.queryByTitle('报告.html')).not.toBeInTheDocument();
    overrides['GET /v1/artifacts/report-a'] = () => ({ ok: true, data: { name: '报告.html', content: '<h1>蓝鲸报告</h1>' } });
    await user.click(screen.getByRole('button', { name: '打开成果文件' }));
    const preview = await screen.findByTitle('报告.html');
    expect(preview).toHaveAttribute('srcdoc', '<h1>蓝鲸报告</h1>');
    expect(preview).toHaveAttribute('sandbox', 'allow-scripts');
    await user.click(screen.getByRole('button', { name: '关闭预览' }));
    expect(screen.queryByTitle('报告.html')).not.toBeInTheDocument();
  });

  it('历史回复不会提前结束本次任务，直到本次 run 完成才解除发送状态', async () => {
    let status = 'running';
    let submitted = false;
    const message = { id: 'new-user', senderType: 'user', text: '本次的问题', createdAt: '2026-10-08T02:00:00Z' };
    overrides['POST /v1/conversations/chat-a/messages'] = () => {
      submitted = true;
      return { ok: true, data: { message, run: { id: 'run-new', status } } };
    };
    overrides['GET /v1/conversations/chat-a/runs'] = () => ({ ok: true, data: submitted ? [{ id: 'run-new', status }] : [] });
    overrides['GET /v1/conversations/chat-a/messages'] = () => ({ ok: true, data: submitted ? [historicalReply, message, ...(status === 'completed' ? [{ ...historicalReply, id: 'reply-new', text: '本次答复' }] : [])] : [historicalReply] });
    const user = await openChat();
    await user.type(screen.getByRole('textbox', { name: '发送消息给群聊' }), '本次的问题');
    await user.click(screen.getByRole('button', { name: '发送给群组' }));
    await screen.findByText('本次的问题', { selector: 'p' });
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path.endsWith('/runs')).length).toBeGreaterThan(1));
    expect(screen.getAllByRole('button', { name: '终止生成' })[0]).toBeEnabled();
    expect(screen.getByText('上一轮的回复')).toBeVisible();
    status = 'completed';
    expect(await screen.findByText('本次答复', {}, { timeout: 3000 })).toBeVisible();
    expect(screen.getByRole('button', { name: '发送给群组' })).toBeEnabled();
    expect(screen.getAllByText('本次的问题', { selector: 'p' })).toHaveLength(1);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith('identity-a'));
  });
});
