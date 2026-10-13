import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clearAdminToken, getAdminToken, grantPoints, listCompanies, login, logout, revokePoints, type Company } from './api';
import './styles.css';

function formatPoints(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(value);
}

function LoginPage({ onLogin }: { onLogin: () => void }): React.JSX.Element {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      await login(username, password);
      onLogin();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败');
    } finally {
      setPending(false);
    }
  }

  return <main className="login-shell">
    <section className="login-card">
      <div className="brand-mark">K</div>
      <p className="eyebrow">KUNLUI WORKSTATION</p>
      <h1>积分管理后台</h1>
      <p className="login-copy">管理企业算力余额，所有变更都会记录到积分流水。</p>
      <form onSubmit={submit} className="login-form">
        <label>管理员账号<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" /></label>
        <label>管理员密码<input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" /></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="primary-button" disabled={pending}>{pending ? '登录中…' : '登录后台'}</button>
      </form>
      <p className="credential-hint">账号由服务端环境变量配置。</p>
    </section>
  </main>;
}

type Operation = 'grant' | 'revoke';

function OperationModal({ company, account, operation, onClose, onDone }: {
  company: Company;
  account: Company['admins'][number];
  operation: Operation;
  onClose: () => void;
  onDone: () => Promise<void>;
}): React.JSX.Element {
  const [points, setPoints] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const numericPoints = Number(points);
  const isRevoke = operation === 'revoke';
  const invalid = !Number.isFinite(numericPoints) || numericPoints <= 0 || (isRevoke && numericPoints > account.available);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (invalid) {
      setError(isRevoke ? `收回积分不能超过管理员当前可用积分 ${formatPoints(account.available)}` : '请输入大于 0 的积分');
      return;
    }
    setError('');
    setPending(true);
    try {
      if (isRevoke) await revokePoints(company.organizationId, account.identityId, numericPoints);
      else await grantPoints(company.organizationId, account.identityId, numericPoints);
      await onDone();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setPending(false);
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="operation-title">
      <div className="modal-header"><div><p className="eyebrow">{isRevoke ? 'RECLAIM POINTS' : 'GRANT POINTS'}</p><h2 id="operation-title">{isRevoke ? '收回积分' : '增加积分'}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></div>
      <div className="target-summary"><strong>{company.organizationName}</strong><span>{account.email}</span><span>管理员当前可用：{formatPoints(account.available)} 积分</span></div>
      <form onSubmit={submit} className="operation-form">
        <label>积分数量<input autoFocus type="number" min="0.001" step="0.001" value={points} onChange={event => setPoints(event.target.value)} placeholder="请输入积分数量" /></label>
        {isRevoke && <p className="field-note">收回后管理员余额不能为负数，服务端会再次校验。</p>}
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className={isRevoke ? 'danger-button' : 'primary-button'} disabled={pending}>{pending ? '提交中…' : isRevoke ? '确认收回' : '确认增加'}</button></div>
      </form>
    </section>
  </div>;
}

function Dashboard({ onLogout }: { onLogout: () => void }): React.JSX.Element {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [summary, setSummary] = useState({ totalCompanies: 0, totalPoints: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<{ company: Company; account: Company['admins'][number]; type: Operation } | null>(null);

  async function refresh(targetPage = page): Promise<void> {
    setError('');
    try {
      const result = await listCompanies(targetPage);
      setCompanies(result.items);
      setPagination(result.pagination);
      setSummary(result.summary);
      setPage(result.pagination.page);
    }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : '数据加载失败';
      if (!getAdminToken()) { onLogout(); return; }
      setError(message);
    } finally { setLoading(false); }
  }

  useEffect(() => { void refresh(1); }, []);

  return <main className="dashboard-shell">
    <header className="topbar"><div className="topbar-brand"><div className="brand-mark small">K</div><div><strong>鲲擎</strong><span>积分管理后台</span></div></div><div className="topbar-actions"><span className="admin-chip">管理员 · admin</span><button className="text-button" onClick={async () => { await logout(); onLogout(); }}>退出登录</button></div></header>
    <section className="content">
      <div className="page-heading"><div><p className="eyebrow">POINTS CONTROL CENTER</p><h1>企业积分</h1><p>查看企业总积分与管理员额度，支持平台增加和收回积分。</p></div><button className="secondary-button" onClick={() => void refresh()}>刷新数据</button></div>
      <div className="metric-grid"><div className="metric-card"><span>企业数量</span><strong>{summary.totalCompanies}</strong><small>当前已配置企业</small></div><div className="metric-card accent"><span>企业积分合计</span><strong>{formatPoints(summary.totalPoints)}</strong><small>企业成员额度总和</small></div><div className="metric-card"><span>操作规则</span><strong>管理员</strong><small>增加与收回均作用于管理员账号</small></div></div>
      {error && <div className="page-error" role="alert">{error}</div>}
      <section className="table-card"><div className="table-heading"><div><h2>公司积分列表</h2><span>平台管理员可对企业管理员执行积分调整</span></div><span className="count-badge">共 {pagination.total} 家企业 · 每页 20 条</span></div>
        {loading ? <div className="empty-state">正在加载企业数据…</div> : companies.length === 0 ? <div className="empty-state">暂无可管理企业</div> : <div className="table-wrap"><table><thead><tr><th>公司</th><th>管理员账号</th><th>公司总积分</th><th>管理员积分</th><th className="action-column">配置</th></tr></thead><tbody>{companies.map(company => company.admins.map((account, index) => <tr key={`${company.organizationId}-${account.identityId}`}>
          {index === 0 && <td rowSpan={company.admins.length}><div className="company-cell"><span className="company-icon">{company.organizationName.slice(0, 1)}</span><div><strong>{company.organizationName}</strong><small>{company.organizationId}</small></div></div></td>}
          <td><div className="account-cell"><strong>{account.email}</strong><small>{account.displayName}</small></div></td><td>{index === 0 && <strong className="company-total">{formatPoints(company.companyPoints)}</strong>}</td><td><strong>{formatPoints(account.available)}</strong></td><td><div className="row-actions"><button className="primary-small" onClick={() => setOperation({ company, account, type: 'grant' })}>增加</button><button className="danger-small" onClick={() => setOperation({ company, account, type: 'revoke' })} disabled={account.available <= 0}>收回</button></div></td>
        </tr>))}</tbody></table></div>}
        {!loading && pagination.totalPages > 1 && <div className="pagination"><button className="secondary-button" disabled={page <= 1} onClick={() => void refresh(page - 1)}>上一页</button><span>第 {page} / {pagination.totalPages} 页</span><button className="secondary-button" disabled={page >= pagination.totalPages} onClick={() => void refresh(page + 1)}>下一页</button></div>}
      </section>
      <p className="footer-note">积分变更使用服务端统一额度服务，操作结果会写入积分流水并尝试同步 Sub2API。</p>
    </section>
    {operation && <OperationModal company={operation.company} account={operation.account} operation={operation.type} onClose={() => setOperation(null)} onDone={refresh} />}
  </main>;
}

function App(): React.JSX.Element {
  const [authenticated, setAuthenticated] = useState(Boolean(getAdminToken()));
  if (!authenticated) return <LoginPage onLogin={() => setAuthenticated(true)} />;
  return <Dashboard onLogout={() => { clearAdminToken(); setAuthenticated(false); }} />;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
