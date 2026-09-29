import {
  Bell,
  CalendarClock,
  CircleHelp,
  ClipboardList,
  Gauge,
  KeyRound,
  Folder,
  FolderKanban,
  House,
  MousePointerClick,
  Plus,
  Search,
  Settings,
  Users,
  X,
} from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { NewChatModal } from './NewChatModal';
import { GlobalSearchDialog } from './GlobalSearchDialog';
import klaSidebarLogoUrl from '../assets/kla-sidebar-logo.png';

const navClassName = ({ isActive }: { isActive: boolean }): string =>
  `sidebar-link${isActive ? ' sidebar-link--active' : ''}`;

// 新安装默认权益：300 万 token；已有工作区会优先使用 settings 中已保存的额度。
const DEFAULT_TOKEN_TOTAL = 3_000_000;
const tokenNumberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const OPERATIONS_SESSION_KEY = 'kunqing.operationsAccess';
window.sessionStorage.removeItem(OPERATIONS_SESSION_KEY);

type ShellSettings = {
  deploymentMode: 'saas' | 'private';
  tokenUsed: number;
  tokenTotal: number;
  activationStartedAt: string;
  activationExpiresAt: string;
  nickname: string;
  avatarDataUrl: string;
  theme: 'standard' | 'professional' | 'technology' | 'prestige';
};

type NotificationItem = { id: string; projectId: string; title: string; sender: string; preview: string; createdAt: string; read: boolean };

function readNotifications(): NotificationItem[] {
  try { return JSON.parse(window.localStorage.getItem('kunqing.notifications') ?? '[]') as NotificationItem[]; } catch { return []; }
}

export function AppShell(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settings, setSettings] = useState<ShellSettings>({ deploymentMode: 'saas', tokenUsed: 0, tokenTotal: DEFAULT_TOKEN_TOTAL, activationStartedAt: '', activationExpiresAt: '', nickname: '项目负责人', avatarDataUrl: '', theme: 'professional' });
  const [notifications, setNotifications] = useState<NotificationItem[]>(readNotifications);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [unlockKey, setUnlockKey] = useState('');
  const [unlockError, setUnlockError] = useState('');

  useEffect(() => {
    const loadShellSettings = async (): Promise<void> => {
      const result = await window.kunqing?.settings.getAll() as {
        ok: boolean;
        data?: Record<string, unknown>;
      } | undefined;
      const data = result?.data ?? {};
      const usedValue = Number(data.tokenUsageTotal ?? 0);
      const totalValue = Number(data.operationsAvailableTokens ?? DEFAULT_TOKEN_TOTAL);
      const rawTheme = String(data.theme ?? 'professional');
      const theme: ShellSettings['theme'] = rawTheme === 'standard' || rawTheme === 'technology' || rawTheme === 'prestige'
        ? rawTheme
        : 'professional';
      document.documentElement.setAttribute('data-theme', theme);
      setSettings({
        deploymentMode: data.deploymentMode === 'private' ? 'private' : 'saas',
        tokenUsed: Number.isFinite(usedValue) ? Math.max(0, Math.floor(usedValue)) : 0,
        tokenTotal: Number.isFinite(totalValue) ? Math.max(0, Math.floor(totalValue)) : DEFAULT_TOKEN_TOTAL,
        activationStartedAt: String(data.operationsActivationStartedAt ?? ''),
        activationExpiresAt: String(data.operationsActivationExpiresAt ?? ''),
        nickname: String(data.personalNickname ?? '').trim() || '项目负责人',
        avatarDataUrl: String(data.personalAvatarDataUrl ?? ''),
        theme,
      });
    };
    void loadShellSettings();
    const timer = window.setInterval(() => void loadShellSettings(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.localStorage.setItem('kunqing.notifications', JSON.stringify(notifications.slice(0, 50)));
  }, [notifications]);

  useEffect(() => {
    const unsubscribe = window.kunqing?.events.subscribe((raw) => {
      const event = raw as { type?: string; projectId?: string; senderId?: string; content?: string; messageId?: string; message?: { id?: string; senderType?: string; senderId?: string; contentJson?: string; createdAt?: string } };
      const agentMessage = event.type === 'message.committed'
        ? { id: event.messageId, senderId: event.senderId, contentJson: event.content, createdAt: new Date().toISOString() }
        : event.type === 'message.created' && event.message?.senderType === 'agent'
          ? { id: event.message.id, senderId: event.message.senderId, contentJson: event.message.contentJson, createdAt: event.message.createdAt }
          : null;
      if (!agentMessage?.id || !event.projectId) return;
      const activelyViewing = location.pathname === `/projects/${event.projectId}/chat` && document.visibilityState === 'visible';
      if (activelyViewing) return;
      void (async (): Promise<void> => {
        const [projectsResult, agentsResult] = await Promise.all([
          window.kunqing?.projects.list({}) as Promise<{ ok?: boolean; data?: Array<{ id: string; name: string }> }> | undefined,
          window.kunqing?.agents.getProjectInstances({ projectId: event.projectId! }) as Promise<{ ok?: boolean; data?: Array<{ id: string; agentName: string }> }> | undefined,
        ]);
        let preview = '';
        try { preview = (JSON.parse(agentMessage.contentJson ?? '') as { text?: string }).text ?? ''; } catch { preview = agentMessage.contentJson ?? ''; }
        const title = projectsResult?.data?.find((project) => project.id === event.projectId)?.name ?? '项目协作群组';
        const sender = agentMessage.senderId === 'system'
          ? '系统'
          : agentsResult?.data?.find((agent) => agent.id === agentMessage.senderId)?.agentName ?? '智能体';
        setNotifications((current) => current.some((item) => item.id === agentMessage.id)
          ? current
          : [{ id: agentMessage.id!, projectId: event.projectId!, title, sender, preview: preview.replace(/\s+/g, ' ').trim(), createdAt: agentMessage.createdAt ?? new Date().toISOString(), read: false }, ...current]
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .slice(0, 50));
      })();
    });
    return () => unsubscribe?.();
  }, [location.pathname]);

  useEffect(() => {
    const openNewChat = (): void => setNewChatOpen(true);
    window.addEventListener('kunqing:open-new-chat', openNewChat);
    return () => window.removeEventListener('kunqing:open-new-chat', openNewChat);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const isMeta = e.ctrlKey || e.metaKey;

      if (e.key === 'Escape') {
        if (searchOpen) { setSearchOpen(false); return; }
        if (newChatOpen) { setNewChatOpen(false); return; }
        if (helpOpen) { setHelpOpen(false); return; }
        return;
      }

      if (isMeta && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }

      if (isMeta && e.key === 'n') {
        e.preventDefault();
        navigate('/');
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [helpOpen, navigate, newChatOpen, searchOpen]);

  const openFirstProject = async (event: ReactMouseEvent<HTMLAnchorElement>): Promise<void> => {
    event.preventDefault();
    try {
      const result = await window.kunqing?.projects.list({}) as { ok: boolean; data?: Array<{ id: string }> } | undefined;
      const firstProject = result?.ok ? result.data?.[0] : undefined;
      navigate(firstProject ? `/projects/${firstProject.id}/chat` : '/');
    } catch {
      navigate('/');
    }
  };

  const privateDays = useMemo(() => {
    const expires = new Date(settings.activationExpiresAt).getTime();
    const starts = new Date(settings.activationStartedAt || new Date().toISOString().slice(0, 10)).getTime();
    const dayMs = 24 * 60 * 60 * 1_000;
    return {
      remaining: Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - Date.now()) / dayMs)) : 0,
      total: Number.isFinite(expires) && Number.isFinite(starts) ? Math.max(0, Math.ceil((expires - starts) / dayMs)) : 0,
    };
  }, [settings.activationExpiresAt, settings.activationStartedAt]);
  const expired = settings.deploymentMode === 'private'
    ? !settings.activationExpiresAt || privateDays.remaining <= 0
    : settings.tokenTotal - settings.tokenUsed <= 0;
  const operationsUnlocked = window.sessionStorage.getItem(OPERATIONS_SESSION_KEY) === 'granted';

  if (expired && !(operationsUnlocked && location.pathname === '/settings/operations')) {
    return <div className="service-expired-page">
      <div className="service-expired-panel">
        <span><KeyRound size={28} /></span>
        <h1>平台服务暂时中断</h1>
        <p>由于您的服务已到期，当前平台服务暂时中断，但您所积累的工作文件、知识、智能体经验都将完整保留，您可联系商务续约服务，感谢您的理解！</p>
        <form onSubmit={(event) => {
          event.preventDefault();
          const granted = window.kunqing?.app
            ? window.kunqing.app.verifyOperationsAccess({ key: unlockKey }).then((result) => {
              const res = result as { ok?: boolean; data?: { granted?: boolean } } | undefined;
              if (res?.data?.granted) {
                window.sessionStorage.setItem(OPERATIONS_SESSION_KEY, 'granted');
                setUnlockError('');
                navigate('/settings/operations');
              } else {
                setUnlockError('解锁码错误');
              }
            })
            : Promise.resolve();
          void granted;
        }}>
          <label><span>解锁码</span><input type="password" value={unlockKey} onChange={(event) => { setUnlockKey(event.target.value); setUnlockError(''); }} placeholder="请输入运维权限密钥" />{unlockError && <small>{unlockError}</small>}</label>
          <button type="submit" className="primary-button">进入运维管理</button>
        </form>
      </div>
    </div>;
  }

  if (expired && operationsUnlocked && location.pathname === '/settings/operations') {
    return <div className="locked-operations-layout"><Outlet /></div>;
  }

  return (
    <div className="app-shell">
      <aside className="global-sidebar">
        <div className="brand-lockup">
          <img className="brand-lockup__image" src={klaSidebarLogoUrl} alt="KLA" />
        </div>

        <nav className="primary-navigation" aria-label="主导航">
          <NavLink to="/" end className={navClassName} aria-label="首页">
            <House size={19} />
            <span>首页</span>
          </NavLink>
          <NavLink to="/enterprise-projects" className={navClassName} aria-label="项目">
            <FolderKanban size={19} />
            <span>项目</span>
            <em>Beta</em>
          </NavLink>
          <NavLink to="/projects" className={navClassName} aria-label="群组" onClick={(event) => void openFirstProject(event)}>
            <Folder size={19} />
            <span>群组</span>
          </NavLink>
          <NavLink to="/operations" className={navClassName} aria-label="操作">
            <MousePointerClick size={19} />
            <span>操作</span>
            <em>Beta</em>
          </NavLink>
          <NavLink to="/meetings" className={navClassName} aria-label="会议">
            <Users size={19} />
            <span>会议</span>
          </NavLink>
          <button className="sidebar-link sidebar-link--disabled" type="button" disabled title="即将上线">
            <ClipboardList size={19} />
            <span>任务</span>
            <em>即将上线</em>
          </button>
        </nav>

        <div className="sidebar-footer">
          <button className="new-chat-button" type="button" onClick={() => setNewChatOpen(true)} aria-label="创建群聊">
            <Plus size={17} />
            <span>创建群聊</span>
          </button>
          <NavLink to="/settings/agents" aria-label="设置" className={`${navClassName({ isActive: location.pathname.startsWith('/settings') })} sidebar-link--footer`}>
            <Settings size={19} />
            <span>设置</span>
          </NavLink>
          <button className="sidebar-link sidebar-link--footer profile-link" type="button" onClick={() => navigate('/settings/profile')}>
            <span className="profile-avatar">{settings.avatarDataUrl ? <img src={settings.avatarDataUrl} alt="" /> : settings.nickname.slice(0, 1).toUpperCase()}</span>
            <span>{settings.nickname}</span>
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="top-app-bar">
          <button className="search-button topbar-search" type="button" onClick={() => setSearchOpen(true)} aria-label="全局搜索">
            <Search size={15} />
            <span>搜索</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="topbar-actions">
            <div className="notification-center">
              <button className="icon-button" type="button" aria-label="通知" onClick={() => { const open = !notificationsOpen; setNotificationsOpen(open); if (open) setNotifications((current) => current.map((item) => ({ ...item, read: true }))); }}><Bell size={18} />{notifications.some((item) => !item.read) && <i className="notification-dot" />}</button>
              {notificationsOpen && <div className="notification-dropdown">
                <header><strong>消息通知</strong><span>{notifications.length} 条</span></header>
                {notifications.length === 0 ? <p className="notification-empty">暂无新消息</p> : notifications.map((item) => <button type="button" key={item.id} onClick={() => { setNotificationsOpen(false); navigate(`/projects/${item.projectId}/chat`); }}><strong>新消息&nbsp;&nbsp;{item.title}</strong><span>@{item.sender}：{item.preview || '发送了一个成果文件'}</span></button>)}
              </div>}
            </div>
            <button className={`icon-button${helpOpen ? ' icon-button--active' : ''}`} type="button" aria-label="说明文档" title="打开说明文档" onClick={() => setHelpOpen(true)}><CircleHelp size={18} /></button>
            <div
              className="token-usage"
              title="Token 剩余用量 / Token 总量；消耗量来自支持 usage 回传的模型调用"
              aria-label={settings.deploymentMode === 'private' ? `剩余 ${privateDays.remaining} 天，总量 ${privateDays.total} 天` : `Token 剩余 ${Math.max(settings.tokenTotal - settings.tokenUsed, 0)}，总量 ${settings.tokenTotal}`}
            >
              {settings.deploymentMode === 'private' ? <CalendarClock size={16} /> : <Gauge size={16} />}
              <span className="token-usage__title">{settings.deploymentMode === 'private' ? '有效期' : 'Token'}</span>
              <span className="token-usage__field"><small>剩余</small><strong>{settings.deploymentMode === 'private' ? `${privateDays.remaining}天` : tokenNumberFormatter.format(Math.max(settings.tokenTotal - settings.tokenUsed, 0))}</strong></span>
              <i className="token-usage__divider">/</i>
              <span className="token-usage__field"><small>总量</small><strong>{settings.deploymentMode === 'private' ? `${privateDays.total}天` : tokenNumberFormatter.format(settings.tokenTotal)}</strong></span>
            </div>
          </div>
        </header>
        <main className="route-canvas">
          <Outlet />
        </main>
      </div>
      {newChatOpen && <NewChatModal onClose={() => setNewChatOpen(false)} />}
      {searchOpen && <GlobalSearchDialog onClose={() => setSearchOpen(false)} />}
      {helpOpen && <div className="modal-backdrop help-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}>
        <section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-dialog-title">
          <header className="help-dialog__header">
            <div>
              <span className="help-dialog__eyebrow">KLA Workstation</span>
              <h2 id="help-dialog-title">使用说明</h2>
              <p>鲲擎多智能体协同工作站操作指南</p>
            </div>
            <button className="icon-button" type="button" aria-label="关闭说明文档" title="关闭" onClick={() => setHelpOpen(false)}><X size={18} /></button>
          </header>
          <div className="help-dialog__body">
            <iframe title="鲲擎多智能体协同工作站说明文档" src="help/kunqing-workstation-guide.pdf#view=FitH" />
          </div>
        </section>
      </div>}
    </div>
  );
}
