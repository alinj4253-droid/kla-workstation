import {
  Bell,
  CircleHelp,
  CircleUserRound,
  ClipboardList,
  Folder,
  House,
  Plus,
  Search,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { NewChatModal } from './NewChatModal';
import { GlobalSearchDialog } from './GlobalSearchDialog';

const navClassName = ({ isActive }: { isActive: boolean }): string =>
  `sidebar-link${isActive ? ' sidebar-link--active' : ''}`;

export function AppShell(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const inProject = location.pathname.startsWith('/projects/');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

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
          <NavLink to="/projects/annual-finance/chat" className={navClassName} aria-label="项目">
            <Folder size={19} />
            <span>项目</span>
          </NavLink>
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
          <button className="new-chat-button" type="button" onClick={() => setNewChatOpen(true)} aria-label="新建群聊">
            <Plus size={17} />
            <span>New Chat</span>
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
          <h1>{inProject ? '鲲擎多智能体平台' : '鲲擎多智能体平台'}</h1>
          <div className="topbar-actions">
            <button className="search-button" type="button" onClick={() => setSearchOpen(true)} aria-label="全局搜索">
              <Search size={15} />
              <span>搜索</span>
              <kbd>⌘K</kbd>
            </button>
            <button className="icon-button" type="button" aria-label="通知"><Bell size={18} /></button>
            <button className="icon-button" type="button" aria-label="帮助"><CircleHelp size={18} /></button>
            <button className="top-profile" type="button" aria-label="个人中心"><CircleUserRound size={29} /></button>
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