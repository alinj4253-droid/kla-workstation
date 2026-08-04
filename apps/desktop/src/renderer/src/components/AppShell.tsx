import {
  Bell,
  CircleHelp,
  ClipboardList,
  Gauge,
  Folder,
  House,
  Megaphone,
  Plus,
  Search,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { NewChatModal } from './NewChatModal';
import { GlobalSearchDialog } from './GlobalSearchDialog';

const navClassName = ({ isActive }: { isActive: boolean }): string =>
  `sidebar-link${isActive ? ' sidebar-link--active' : ''}`;

const DEFAULT_TOKEN_TOTAL = 1_000_000;
const tokenNumberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

export function AppShell(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tokenBudget, setTokenBudget] = useState({ used: 0, total: DEFAULT_TOKEN_TOTAL });

  useEffect(() => {
    const loadTokenUsage = async (): Promise<void> => {
      const result = await window.kunqing?.settings.getAll() as {
        ok: boolean;
        data?: { tokenUsageTotal?: unknown; operationsAvailableTokens?: unknown };
      } | undefined;
      const usedValue = Number(result?.data?.tokenUsageTotal ?? 0);
      const totalValue = Number(result?.data?.operationsAvailableTokens ?? DEFAULT_TOKEN_TOTAL);
      setTokenBudget({
        used: Number.isFinite(usedValue) ? Math.max(0, Math.floor(usedValue)) : 0,
        total: Number.isFinite(totalValue) ? Math.max(0, Math.floor(totalValue)) : DEFAULT_TOKEN_TOTAL,
      });
    };
    void loadTokenUsage();
    const timer = window.setInterval(() => void loadTokenUsage(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const isMeta = e.ctrlKey || e.metaKey;

      if (e.key === 'Escape') {
        if (searchOpen) { setSearchOpen(false); return; }
        if (newChatOpen) { setNewChatOpen(false); return; }
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
  }, [navigate, newChatOpen, searchOpen]);

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

  return (
    <div className="app-shell">
      <aside className="global-sidebar">
        <div className="brand-lockup">
          <span className="brand-mark"><Sparkles size={21} strokeWidth={2.2} /></span>
          <span className="brand-copy">
            <strong>鲲擎平台</strong>
            <small>AI INTELLIGENCE</small>
          </span>
        </div>

        <nav className="primary-navigation" aria-label="主导航">
          <NavLink to="/" end className={navClassName} aria-label="首页">
            <House size={19} />
            <span>首页</span>
          </NavLink>
          <NavLink to="/projects" className={navClassName} aria-label="项目" onClick={(event) => void openFirstProject(event)}>
            <Folder size={19} />
            <span>项目</span>
          </NavLink>
          <button className="sidebar-link sidebar-link--disabled" type="button" disabled title="即将上线">
            <Megaphone size={19} />
            <span>运营</span>
            <em>即将上线</em>
          </button>
          <button className="sidebar-link sidebar-link--disabled" type="button" disabled title="即将上线">
            <Users size={19} />
            <span>会议</span>
            <em>即将上线</em>
          </button>
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
          <button className="sidebar-link sidebar-link--footer profile-link" type="button">
            <span className="profile-avatar">K</span>
            <span>个人中心</span>
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
            <button className="icon-button" type="button" aria-label="通知"><Bell size={18} /></button>
            <button className="icon-button" type="button" aria-label="说明文档"><CircleHelp size={18} /></button>
            <div
              className="token-usage"
              title="Token 剩余用量 / Token 总量；消耗量来自支持 usage 回传的模型调用"
              aria-label={`Token 剩余 ${Math.max(tokenBudget.total - tokenBudget.used, 0)}，总量 ${tokenBudget.total}`}
            >
              <Gauge size={16} />
              <span className="token-usage__title">Token</span>
              <span className="token-usage__field"><small>剩余</small><strong>{tokenNumberFormatter.format(Math.max(tokenBudget.total - tokenBudget.used, 0))}</strong></span>
              <i className="token-usage__divider">/</i>
              <span className="token-usage__field"><small>总量</small><strong>{tokenNumberFormatter.format(tokenBudget.total)}</strong></span>
            </div>
          </div>
        </header>
        <main className="route-canvas">
          <Outlet />
        </main>
      </div>
      {newChatOpen && <NewChatModal onClose={() => setNewChatOpen(false)} />}
      {searchOpen && <GlobalSearchDialog onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
