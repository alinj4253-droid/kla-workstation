import { Check, CheckCircle2, CircleHelp, Clock3, FileText, Folder, Home, Send, Upload, Users, type LucideIcon } from 'lucide-react';
import { AdminAssignPage } from './pages/AdminAssignPage';
import { AdminCompanyPage } from './pages/AdminCompanyPage';
import { AdminHomePage } from './pages/AdminHomePage';
import { AdminOrgPage } from './pages/AdminOrgPage';
import { AdminOutputPage } from './pages/AdminOutputPage';
import { AdminReviewPage } from './pages/AdminReviewPage';
import { AdminTrackPage } from './pages/AdminTrackPage';
import { AdminVerifyPage } from './pages/AdminVerifyPage';
import { OwnerDocsPage } from './pages/OwnerDocsPage';
import { OwnerGapsPage } from './pages/OwnerGapsPage';
import { OwnerHomePage } from './pages/OwnerHomePage';
import { OwnerOutputPage } from './pages/OwnerOutputPage';
import { OwnerPrefillPage } from './pages/OwnerPrefillPage';
import { SanyDataProvider } from './SanyDataContext';
import './sany-planning.css';

export type SanyRole = 'admin' | 'owner';
export type SanyView = 'home' | 'org' | 'company' | 'verify' | 'assign' | 'track' | 'review' | 'output' | 'docs' | 'prefill' | 'gaps';
export type SanyNavItem = { id: SanyView; label: string; Icon: LucideIcon };
export type SanyNavGroup = { group: string; items: SanyNavItem[] };

export const SANY_ADMIN_NAV: SanyNavGroup[] = [
  { group: '组织', items: [{ id: 'org', label: '组织成员', Icon: Users }] },
  {
    group: '集团自身内容',
    items: [
      { id: 'home', label: '工作台', Icon: Home },
      { id: 'company', label: '公司层填报', Icon: Upload },
      { id: 'verify', label: '校验公司层内容', Icon: CheckCircle2 },
    ],
  },
  {
    group: '派发与汇总',
    items: [
      { id: 'assign', label: '派发任务', Icon: Send },
      { id: 'track', label: '任务收束', Icon: Clock3 },
      { id: 'review', label: '汇总合并', Icon: Check },
      { id: 'output', label: '公司级成果', Icon: FileText },
    ],
  },
];

export const SANY_OWNER_NAV: SanyNavGroup[] = [
  { group: '负责人工作台', items: [{ id: 'home', label: '工作台', Icon: Home }] },
  {
    group: '内容准备',
    items: [
      { id: 'docs', label: '材料准备', Icon: Folder },
      { id: 'prefill', label: '内容校验', Icon: CheckCircle2 },
      { id: 'gaps', label: '缺口处理', Icon: CircleHelp },
    ],
  },
  { group: '成果', items: [{ id: 'output', label: '我的成果', Icon: FileText }] },
];

export function sanyNavLabel(role: SanyRole, view: SanyView): string {
  const groups = role === 'admin' ? SANY_ADMIN_NAV : SANY_OWNER_NAV;
  return groups.flatMap(group => group.items).find(item => item.id === view)?.label ?? '工作台';
}

type PageProps = { onNavigate?: (view: SanyView) => void };

function renderAdmin(view: SanyView, onNavigate?: (view: SanyView) => void): React.JSX.Element {
  switch (view) {
    case 'org': return <AdminOrgPage onNavigate={onNavigate} />;
    case 'company': return <AdminCompanyPage onNavigate={onNavigate} />;
    case 'verify': return <AdminVerifyPage onNavigate={onNavigate} />;
    case 'assign': return <AdminAssignPage />;
    case 'track': return <AdminTrackPage onNavigate={onNavigate} />;
    case 'review': return <AdminReviewPage onNavigate={onNavigate} />;
    case 'output': return <AdminOutputPage onNavigate={onNavigate} />;
    default: return <AdminHomePage onNavigate={onNavigate} />;
  }
}

function renderOwner(view: SanyView, onNavigate?: (view: SanyView) => void): React.JSX.Element {
  switch (view) {
    case 'docs': return <OwnerDocsPage onNavigate={onNavigate} />;
    case 'prefill': return <OwnerPrefillPage onNavigate={onNavigate} />;
    case 'gaps': return <OwnerGapsPage onNavigate={onNavigate} />;
    case 'output': return <OwnerOutputPage />;
    default: return <OwnerHomePage onNavigate={onNavigate} />;
  }
}

type Props = { role: SanyRole; view: SanyView } & PageProps;

/** 三一战略规划内容区：导航与身份切换由 Workstation 侧栏承载，这里只渲染页面。 */
export function SanyPlanningSection({ role, view, onNavigate }: Props): React.JSX.Element {
  return (
    <div className="sany-section">
      <SanyDataProvider>
        {role === 'admin' ? renderAdmin(view, onNavigate) : renderOwner(view, onNavigate)}
      </SanyDataProvider>
    </div>
  );
}
