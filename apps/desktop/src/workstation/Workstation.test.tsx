import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workstation } from './Workstation';

const { request, setSession, setIdentity } = vi.hoisted(() => ({ request: vi.fn(), setSession: vi.fn(), setIdentity: vi.fn() }));
vi.mock('../api/client', () => ({
  authExpiredEventName: 'kla:auth-expired',
  klaApi: { request, setSession, setIdentity, getIdentity: () => sessionStorage.getItem('kla.identity-id'), clearAccessToken: () => sessionStorage.clear() },
}));

const projects = [{ id: 'project-a', name: '同名项目' }, { id: 'project-b', name: '同名项目' }];
const conversations = [{ id: 'chat-a', projectId: 'project-a', name: '已有群聊' }];
const historicalReply = { id: 'history', senderType: 'agent', senderName: '统筹智能体', text: '上一轮的回复', createdAt: '2026-10-08T01:00:00Z' };
type Result = { ok: boolean; data?: unknown; message?: string };
let overrides: Record<string, () => Result | Promise<Result>>;

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem('kla.access-token', 'test-token');
  sessionStorage.setItem('kla.identity-id', 'identity-a');
  overrides = {};
  request.mockReset();
  setSession.mockReset();
  setIdentity.mockReset();
  setIdentity.mockImplementation((id: string) => sessionStorage.setItem('kla.identity-id', id));
  request.mockImplementation(async (path: string, init: RequestInit = {}) => {
    const override = overrides[`${init.method ?? 'GET'} ${path}`];
    if (override) return override();
    if (path === '/v1/me') return { ok: true, data: { nickname: '测试用户' } };
    if (path === '/v1/me/identities') return { ok: true, data: [{ id: 'identity-a', type: 'personal', displayName: '个人工作区', isDefault: true }] };
    if (path === '/v1/bootstrap') return { ok: true, data: { projects, conversations } };
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
  await user.click(screen.getByRole('button', { name: /已有群聊/ }));
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
    overrides['POST /v1/auth/register'] = () => ({ ok: true, data: { session, identities: [identity] } });
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
    expect(setIdentity).toHaveBeenCalledWith(identity.id);
    const submission = request.mock.calls.find(([path]) => path === '/v1/auth/register');
    expect(JSON.parse(submission![1].body)).toEqual({ email: 'new@example.test', password: 'ValidPass2026', nickname: 'NewUser' });
  });

  it('登录后个人身份通过后端激活，失败时保留身份弹窗供重试', async () => {
    sessionStorage.clear();
    const session = { accessToken: 'login-access', refreshToken: 'login-refresh', expiresAt: '2026-10-15T00:00:00Z' };
    const identity = { id: 'personal-login', type: 'personal', displayName: '个人工作区', isDefault: true };
    overrides['POST /v1/auth/login'] = () => ({ ok: true, data: { session, identities: [identity] } });
    overrides['POST /v1/me/identities/personal-login/activate'] = () => ({ ok: false, message: '身份激活暂不可用' });
    const user = userEvent.setup();
    render(<Workstation />);
    await user.type(screen.getByPlaceholderText('请输入账号或邮箱'), 'MyAccount');
    await user.type(screen.getByPlaceholderText('请输入密码'), 'MyPassword2026');
    await user.click(screen.getByRole('button', { name: /立即登录并连接/ }));
    expect(await screen.findByText('选择进入身份')).toBeVisible();
    expect(setSession).toHaveBeenCalledWith(session);
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
    await user.type(screen.getByLabelText('群聊名称'), '待创建群聊');
    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('后端暂不可用')).toBeVisible();
    expect(screen.getByLabelText('群聊名称')).toHaveValue('待创建群聊');
    expect(screen.getByText('2 个项目 · 1 个群组')).toBeVisible();
    expect(screen.queryByPlaceholderText('发送消息给群组 (支持 @ 智能体)...')).not.toBeInTheDocument();
  });

  it('同名项目按 ID 关联，等待提交时阻止重复创建，成功后保留项目树', async () => {
    let resolveCreate!: (value: Result) => void;
    overrides['POST /v1/conversations'] = () => new Promise(resolve => { resolveCreate = resolve; });
    const user = await openProjects();
    await user.click(screen.getAllByTitle('在此项目下新建群聊')[1]);
    expect(screen.getByLabelText('关联项目')).toHaveValue('project-b');
    await user.type(screen.getByLabelText('群聊名称'), '新的真实群聊');
    await user.click(screen.getByRole('button', { name: '创建' }));
    const submitting = screen.getByRole('button', { name: '创建中…' });
    expect(submitting).toBeDisabled();
    fireEvent.click(submitting);
    const submissions = request.mock.calls.filter(([path, init]) => path === '/v1/conversations' && init.method === 'POST');
    expect(submissions).toHaveLength(1);
    expect(JSON.parse(submissions[0][1].body)).toMatchObject({ projectId: 'project-b', name: '新的真实群聊' });
    resolveCreate({ ok: true, data: { id: 'chat-b', projectId: 'project-b', name: '新的真实群聊' } });
    await screen.findByPlaceholderText('发送消息给群组 (支持 @ 智能体)...');
    expect(screen.getByText('2 个项目 · 2 个群组')).toBeVisible();
    expect(screen.queryByLabelText('群聊名称')).not.toBeInTheDocument();
  });

  it('发送失败保留草稿，不添加未落库的消息气泡', async () => {
    overrides['POST /v1/conversations/chat-a/messages'] = () => ({ ok: false, message: '发送服务不可用' });
    const user = await openChat();
    const input = screen.getByPlaceholderText('发送消息给群组 (支持 @ 智能体)...');
    await user.type(input, '请记住项目代号蓝鲸');
    await user.click(screen.getByRole('button', { name: '发送给群组' }));
    expect(await screen.findByText('发送服务不可用')).toBeVisible();
    expect(input).toHaveValue('请记住项目代号蓝鲸');
    expect(screen.queryByText('请记住项目代号蓝鲸', { selector: 'p' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送给群组' })).toBeEnabled();
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
    expect(preview).toHaveAttribute('sandbox', '');
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
    await user.type(screen.getByPlaceholderText('发送消息给群组 (支持 @ 智能体)...'), '本次的问题');
    await user.click(screen.getByRole('button', { name: '发送给群组' }));
    await screen.findByText('本次的问题', { selector: 'p' });
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path.endsWith('/runs')).length).toBeGreaterThan(1));
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled();
    expect(screen.getByText('上一轮的回复')).toBeVisible();
    status = 'completed';
    expect(await screen.findByText('本次答复', {}, { timeout: 3000 })).toBeVisible();
    expect(screen.getByRole('button', { name: '发送给群组' })).toBeEnabled();
    expect(screen.getAllByText('本次的问题', { selector: 'p' })).toHaveLength(1);
  });
});
