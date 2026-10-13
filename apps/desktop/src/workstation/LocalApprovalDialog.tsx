import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronDown, FileText, Loader2, LockKeyhole, Monitor, ShieldAlert, X } from 'lucide-react';
import type { LocalApprovalRequest } from '../platform/local-approval';
import './local-approval.css';

type ViewProps = { request: LocalApprovalRequest; busy: boolean; error: string; onDecision: (approved: boolean) => void };
export function LocalApprovalView({ request, busy, error, onDecision }: ViewProps): React.JSX.Element {
  const rejectButton = useRef<HTMLButtonElement>(null);
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onDecision(false); }}>
    <Dialog.Portal><Dialog.Overlay className="ws-approval-overlay" /><Dialog.Content className="ws-approval-dialog" aria-busy={busy} onOpenAutoFocus={event => { event.preventDefault(); rejectButton.current?.focus(); }} onEscapeKeyDown={event => { event.preventDefault(); if (!busy) onDecision(false); }} onInteractOutside={event => event.preventDefault()}>
      <header className="ws-approval-header"><span className="ws-approval-icon"><ShieldAlert size={24} /></span><div><span className="ws-approval-eyebrow">智能体操作授权</span><Dialog.Title asChild><h2>此操作需要你的确认</h2></Dialog.Title></div><button type="button" className="ws-approval-close" aria-label="拒绝并关闭授权请求" disabled={busy} onClick={() => onDecision(false)}><X size={18} /></button></header>
      <Dialog.Description className="ws-approval-description">智能体请求执行以下本地操作。确认后，将使用你的本机用户权限继续执行。</Dialog.Description>
      <div className="ws-approval-body">
        <section className="ws-approval-operation" aria-label="待授权的操作"><div className="ws-approval-operation-title"><FileText size={17} /><strong>{request.action}</strong><span>仅本次</span></div><dl>{request.details.length ? request.details.map((detail, index) => <div key={`${detail.label}-${index}`}><dt>{detail.label}</dt><dd className={detail.code ? 'ws-approval-code' : undefined}>{detail.value}</dd></div>) : <div><dt>操作对象</dt><dd>当前任务的本地工作区</dd></div>}<div className="ws-approval-execution"><dt><Monitor size={14} />执行位置</dt><dd>{request.execution}</dd></div></dl></section>
        <div className="ws-approval-notice"><LockKeyhole size={16} /><p>读取内容或命令输出会回传服务端供智能体处理；新建文件默认回传可预览副本。<strong>授权仅对本次操作生效。</strong></p></div>
        <details className="ws-approval-details"><summary>查看请求详情<ChevronDown size={14} /></summary><dl><div><dt>任务编号</dt><dd>{request.runId}</dd></div><div><dt>工具名称</dt><dd>{request.tool}</dd></div></dl></details>
        {error && <p className="ws-approval-error" role="alert">{error}</p>}
      </div>
      <footer><span><LockKeyhole size={13} />由你决定是否继续</span><div><button ref={rejectButton} type="button" className="ws-approval-reject" disabled={busy} onClick={() => onDecision(false)}>拒绝</button><button type="button" className="ws-primary ws-approval-allow" disabled={busy} onClick={() => onDecision(true)}>{busy ? <Loader2 size={15} className="ws-approval-spinner" /> : <Check size={15} />}{busy ? '正在提交…' : '允许本次操作'}</button></div></footer>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}

export function LocalApprovalDialog(): React.JSX.Element | null {
  const [request, setRequest] = useState<LocalApprovalRequest | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const active = useRef<LocalApprovalRequest | null>(null);
  const deciding = useRef<string | null>(null);
  useEffect(() => {
    const bridge = window.klaPlatform?.localApproval;
    if (!bridge) return;
    let cancelled = false;
    let changes = 0;
    const update = (next: LocalApprovalRequest | null) => { active.current = next; setRequest(next); setError(''); };
    const unsubscribe = bridge.onChange(next => { changes++; if (!cancelled) update(next); });
    const baseline = changes;
    void bridge.pending().then(next => { if (!cancelled && changes === baseline) update(next); }).catch(() => { /* No execution can proceed without a decision. */ });
    return () => { cancelled = true; unsubscribe(); active.current = null; };
  }, []);
  const decide = async (approved: boolean) => {
    const current = active.current;
    const bridge = window.klaPlatform?.localApproval;
    if (!current || !bridge || deciding.current === current.id) return;
    deciding.current = current.id; setBusyId(current.id); setError('');
    try {
      await bridge.decide({ id: current.id, approved });
      if (active.current?.id !== current.id) return;
      // A rejected stale response also closes only this request, never a newer one.
      active.current = null; setRequest(null);
    } catch { if (active.current?.id === current.id) setError('授权结果未提交成功，请重试。'); }
    finally { if (deciding.current === current.id) { deciding.current = null; setBusyId(null); } }
  };
  return request ? <LocalApprovalView key={request.id} request={request} busy={busyId === request.id} error={error} onDecision={approved => void decide(approved)} /> : null;
}
