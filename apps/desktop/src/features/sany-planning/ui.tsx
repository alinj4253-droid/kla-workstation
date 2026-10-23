import { useEffect, type CSSProperties, type ReactNode } from 'react';

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return (
    <header className="sany-ph">
      <div>
        <h1>{title}</h1>
        {sub ? <p>{sub}</p> : null}
      </div>
      {actions ? <div className="sany-ph__a">{actions}</div> : null}
    </header>
  );
}

export function Section({ title, sub, action, children, className, style }: {
  title?: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}): React.JSX.Element {
  return (
    <section className={`sany-sec ${className ?? ''}`} style={style}>
      {title ? (
        <div className="sany-sec__h">
          <div className="sany-sec__t">{title}</div>
          {sub ? <div className="sany-sec__s">{sub}</div> : null}
          {action ? <div className="sany-sec__a">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Card({ children, className, onClick, style }: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  style?: CSSProperties;
}): React.JSX.Element {
  return (
    <div
      className={`sany-card ${className ?? ''}`}
      style={style}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {children}
    </div>
  );
}

export type TagTone = '' | 'b' | 'g' | 'w' | 'r' | 'v' | 'c' | 'line';

export function Tag({ tone = '', dot, children, className }: {
  tone?: TagTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={`sany-tag ${tone} ${className ?? ''}`}>
      {dot ? <span className="sany-dot" /> : null}
      {children}
    </span>
  );
}

const REQ_TONE: Record<string, TagTone> = {
  待上传: '',
  分析中: 'v',
  校验中: 'b',
  待补充: 'w',
  已提交: 'g',
  已通过: 'g',
  已退回: 'r',
};

export function StatusTag({ status }: { status: string }): React.JSX.Element {
  return (
    <Tag tone={REQ_TONE[status] ?? ''} dot>
      {status}
    </Tag>
  );
}

export function Kpi({ label, value, extra, sub, tone }: {
  label: ReactNode;
  value: ReactNode;
  extra?: ReactNode;
  sub?: ReactNode;
  tone?: 'ok' | 'warn' | 'danger';
}): React.JSX.Element {
  return (
    <div className="sany-kpi">
      <div className="sany-kpi__l">{label}</div>
      <div className={`sany-kpi__v ${tone ?? ''}`}>
        {value}
        {extra ? <span className="sany-kpi__ex">{extra}</span> : null}
      </div>
      {sub ? <div className="sany-kpi__s">{sub}</div> : null}
    </div>
  );
}

export function KpiGrid({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={`sany-kpis ${className ?? ''}`}>{children}</div>;
}

export function Pbar({ value, tone, height }: { value: number; tone?: 'ok' | 'warn' | 'vio'; height?: number }): React.JSX.Element {
  return (
    <div className={`sany-pbar ${tone ?? ''}`} style={height ? { height } : undefined}>
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Btn({ children, tone, size, onClick, disabled, block, style }: {
  children: ReactNode;
  tone?: 'pri' | 'ok' | 'ghost';
  size?: 'sm';
  onClick?: () => void;
  disabled?: boolean;
  block?: boolean;
  style?: CSSProperties;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`sany-btn ${tone ?? ''} ${size ?? ''} ${block ? 'block' : ''}`}
      onClick={onClick}
      disabled={disabled}
      style={style}
    >
      {children}
    </button>
  );
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }): React.JSX.Element {
  return (
    <div className="sany-empty">
      {icon ? <div className="sany-empty__i">{icon}</div> : null}
      <div>{children}</div>
    </div>
  );
}

export function Modal({ open, title, sub, children, footer, onClose, wide }: {
  open: boolean;
  title: string;
  sub?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="sany-modal-mask" onClick={onClose}>
      <div className={`sany-modal ${wide ? 'wide' : ''}`} onClick={event => event.stopPropagation()}>
        <div className="sany-modal__h">
          <div>
            <div className="sany-modal__t">{title}</div>
            {sub ? <div className="sany-modal__s">{sub}</div> : null}
          </div>
          <button type="button" className="sany-modal__x" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="sany-modal__b">{children}</div>
        {footer ? <div className="sany-modal__f">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Alert({ tone, icon, children }: {
  tone?: 'w' | 'r' | 'g';
  icon?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className={`sany-alert ${tone ?? ''}`}>
      <span className="sany-alert__i">{icon ?? 'i'}</span>
      <div>{children}</div>
    </div>
  );
}

export function Check({ checked, disabled }: { checked: boolean; disabled?: boolean }): React.JSX.Element {
  return <input className="sany-chk" type="checkbox" checked={checked} readOnly disabled={disabled} />;
}
