// 工作站共享 UI 原语：从 Workstation 抽出，供算力等子模块复用。

export function IconButton({ title, children, onClick }: { title: string; children: React.ReactNode; onClick?: () => void }) {
  return <button className="ws-icon-button" title={title} aria-label={title} onClick={onClick}>{children}</button>;
}

export function Badge({ children, tone = 'blue' }: { children: React.ReactNode; tone?: 'blue' | 'green' | 'muted' | 'orange' }) {
  return <span className={`ws-badge ${tone}`}>{children}</span>;
}

export function Panel({ title, subtitle, action, children, className = '' }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`ws-panel ${className}`}><header className="ws-panel-head"><div><h3>{title}</h3>{subtitle && <small className="ws-panel-sub">{subtitle}</small>}</div>{action}</header>{children}</section>;
}

export function Stat({ icon, label, value, hint, color = 'blue' }: { icon: React.ReactNode; label: string; value: string; hint?: string; color?: string }) {
  return <div className="ws-stat"><span className={`ws-stat-icon ${color}`}>{icon}</span><span className="ws-stat-label">{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}

export function Chart({ kind = 'line' }: { kind?: 'line' | 'bars' }) {
  return <div className={`ws-chart ${kind}`} aria-label="模拟趋势图">{kind === 'bars' ? [42, 58, 38, 72, 53, 86, 67, 94].map((n, i) => <i key={i} style={{ height: `${n}%` }} />) : <><div className="ws-chart-grid" /><div className="ws-chart-line" /><div className="ws-chart-line secondary" /></>}</div>;
}

/** 统一错误文案：优先取服务端 envelope 内的 message。 */
export function apiErrorMessage(result: { message?: string; error?: { message?: string } }): string {
  return result.error?.message ?? result.message ?? '请求失败';
}

/** 积分展示：千分位 + 最多 2 位小数（P1-11，用户侧只见积分不见 USD）。运行时值来自 JSON 响应，非有限数字一律显示占位符。 */
export function formatPoints(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return String(value);
}

export function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
