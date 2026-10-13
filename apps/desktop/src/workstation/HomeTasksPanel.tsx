import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, ChevronRight, Trash2, Undo2, X } from 'lucide-react';
import { tasksApi } from '../api/tasks';
import { Badge, Panel } from './ui';
import './home-tasks.css';

export type HomeTaskSummary = { id: string; title: string; status: string; created_at: string };
const finishedStatuses = new Set(['completed', 'done', 'succeeded', 'failed', 'cancelled', 'canceled']);
const statusLabels: Record<string, string> = { pending: '待办', queued: '待处理', running: '进行中', in_progress: '进行中', completed: '已完成', done: '已完成', succeeded: '已完成', failed: '失败', cancelled: '已取消', canceled: '已取消' };

export type TaskFocusRequest = { nonce: number; taskId?: string; create?: boolean };

type Props = {
  identityId: string;
  tasks: HomeTaskSummary[] | null;
  loading: boolean;
  notify: (message: string) => void;
  onCreated: (task: HomeTaskSummary) => void;
  onChanged: (task: HomeTaskSummary) => void;
  onDeleted: (id: string) => void;
  focusRequest?: TaskFocusRequest | null;
  onFocusHandled?: (nonce: number) => void;
  mineButtonRef?: Ref<HTMLButtonElement>;
};

export function HomeTasksPanel({ identityId, tasks, loading, notify, onCreated, onChanged, onDeleted, focusRequest, onFocusHandled, mineButtonRef }: Props): React.JSX.Element {
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<HomeTaskSummary | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [workingId, setWorkingId] = useState<string | null>(null);
  const mutationBusy = useRef(false);
  const mineFilter = useRef<HTMLButtonElement>(null);
  const [focusedTaskId, setFocusedTaskId] = useState('');
  const taskRows = useRef(new Map<string, HTMLLIElement>());
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const [saving, setSaving] = useState(false);
  const submission = useRef<{ key: string; title: string } | null>(null);
  const busy = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pending = (tasks ?? []).filter(task => !finishedStatuses.has(task.status));
  const visible = scope === 'mine' ? pending : tasks ?? [];
  const count = loading ? '…' : tasks === null ? '—' : pending.length;
  const changeOpen = (next: boolean) => {
    if (busy.current) return;
    if (next) { setTitle(''); setError(''); submission.current = null; }
    setOpen(next);
  };
  const createTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current || !identityId) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) { setError('请输入任务名称'); return; }
    busy.current = true; setSaving(true); setError('');
    try {
      if (!submission.current || submission.current.title !== cleanTitle) submission.current = { key: crypto.randomUUID(), title: cleanTitle };
      const result = await tasksApi.create(identityId, { title: cleanTitle }, submission.current.key);
      if (result.ok) onCreated(result.data);
      if (!mounted.current) return;
      if (!result.ok) { setError(result.message); return; }
      setScope('mine'); setOpen(false); notify('任务已创建');
    } catch {
      if (mounted.current) setError('无法连接任务服务，请检查网络后重试');
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  useEffect(() => {
    if (!focusRequest || loading || tasks === null) return;
    if (focusRequest.create) {
      setTitle(''); setError(''); submission.current = null; setOpen(true);
      onFocusHandled?.(focusRequest.nonce);
      return;
    }
    if (focusRequest.taskId) { setScope('all'); setFocusedTaskId(focusRequest.taskId); }
    const frame = requestAnimationFrame(() => {
      const row = (focusRequest.taskId ? taskRows.current.get(focusRequest.taskId) : null) ?? mineFilter.current;
      row?.scrollIntoView({ behavior: document.documentElement.dataset.klaReducedMotion === 'true' ? 'auto' : 'smooth', block: 'center' });
      row?.focus({ preventScroll: true });
      onFocusHandled?.(focusRequest.nonce);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, loading, tasks === null]);

  const updateTask = async (task: HomeTaskSummary) => {
    if (mutationBusy.current) return;
    mutationBusy.current = true; setWorkingId(task.id);
    const status = task.status === 'completed' ? 'pending' : 'completed';
    try {
      const result = await tasksApi.updateStatus(identityId, task.id, status);
      if (result.ok) onChanged(result.data);
      if (!mounted.current) return;
      if (result.ok) {
        notify(status === 'completed' ? '任务已标记完成' : '任务已恢复为待办');
        if (scope === 'mine' && status === 'completed') requestAnimationFrame(() => mineFilter.current?.focus());
      }
      else notify(result.message);
    } catch { if (mounted.current) notify('任务状态保存失败，请检查网络后重试'); }
    finally { mutationBusy.current = false; if (mounted.current) setWorkingId(null); }
  };
  const deleteTask = async () => {
    if (!deleteTarget || mutationBusy.current) return;
    mutationBusy.current = true; setWorkingId(deleteTarget.id); setDeleteError('');
    try {
      const result = await tasksApi.remove(identityId, deleteTarget.id);
      if (result.ok) onDeleted(deleteTarget.id);
      if (!mounted.current) return;
      if (result.ok) { setDeleteTarget(null); notify('任务已删除'); }
      else setDeleteError(result.message);
    } catch { if (mounted.current) setDeleteError('任务删除失败，请检查网络后重试'); }
    finally { mutationBusy.current = false; if (mounted.current) setWorkingId(null); }
  };
  return <><Dialog.Root open={open} onOpenChange={changeOpen}>
    <Panel title="统一任务" className="ws-home-tasks" action={<div className="ws-home-task-actions">
      <div className="ws-home-task-filter" role="group" aria-label="任务筛选">
        <button ref={element => { mineFilter.current = element; if (typeof mineButtonRef === 'function') mineButtonRef(element); else if (mineButtonRef) mineButtonRef.current = element; }} type="button" className={scope === 'mine' ? 'active' : ''} aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>我的任务 {count} 项</button>
        <button type="button" className={scope === 'all' ? 'active' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>全部 <ChevronRight size={12} /></button>
      </div>
      <Dialog.Trigger asChild><button type="button" className="ws-primary" disabled={loading || !identityId || tasks === null}>+ 新建任务</button></Dialog.Trigger>
    </div>}>
      {loading ? <p className="ws-empty-line">正在加载任务…</p> : tasks === null ? <p className="ws-empty-line">任务暂时无法加载，请刷新页面重试。</p> : !visible.length ? <div className="ws-empty"><CheckCircle2 size={28} /><strong>{scope === 'mine' ? '今天没有待办' : '暂无任务'}</strong><small>{scope === 'mine' ? '点击上方“新建任务”即可安排工作' : '当前身份暂无任务记录'}</small></div> : <ul className="ws-home-task-list" aria-label={scope === 'mine' ? '我的待办任务' : '全部任务'}>{visible.map(task => <li key={task.id} tabIndex={-1} className={focusedTaskId === task.id ? 'ws-task-selected' : undefined} ref={element => { if (element) taskRows.current.set(task.id, element); else taskRows.current.delete(task.id); }}><span className="ws-home-task-copy"><strong>{task.title}</strong><small>{new Date(task.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></span><div className="ws-home-task-row-actions"><Badge tone={['completed', 'done', 'succeeded'].includes(task.status) ? 'green' : task.status === 'failed' ? 'orange' : 'muted'}>{statusLabels[task.status] ?? task.status}</Badge><div>{['pending', 'completed'].includes(task.status) && <button type="button" disabled={workingId !== null} aria-label={`${task.status === 'completed' ? '取消完成' : '标记完成'}：${task.title}`} onClick={() => void updateTask(task)}>{task.status === 'completed' ? <Undo2 size={13} /> : <CheckCircle2 size={13} />}{workingId === task.id ? '处理中…' : task.status === 'completed' ? '取消完成' : '标记完成'}</button>}<button type="button" className="ws-task-delete" disabled={workingId !== null} aria-label={`删除任务：${task.title}`} onClick={event => { deleteTrigger.current = event.currentTarget; setDeleteError(''); setDeleteTarget(task); }}><Trash2 size={13} />删除</button></div></div></li>)}</ul>}
      {tasks?.length === 50 && <small className="ws-home-task-limit">当前展示最近 50 项任务</small>}
      <div className="ws-proto-card-foot">当前身份的待办任务 <button onClick={() => notify('通知偏好')}>配置通知偏好</button></div>
    </Panel>
    <Dialog.Portal>
      <Dialog.Overlay className="ws-task-dialog-overlay" />
      <Dialog.Content className="ws-modal ws-task-dialog" onOpenAutoFocus={event => { event.preventDefault(); titleInput.current?.focus(); }} onEscapeKeyDown={event => { if (busy.current) event.preventDefault(); }} onInteractOutside={event => { if (busy.current) event.preventDefault(); }}>
        <header><Dialog.Title asChild><h2>新建任务</h2></Dialog.Title><Dialog.Close asChild><button type="button" aria-label="关闭新建任务" disabled={saving}><X size={18} /></button></Dialog.Close></header>
        <Dialog.Description className="ws-task-dialog-description">保存到当前身份的待办列表。</Dialog.Description>
        <form onSubmit={event => void createTask(event)} aria-busy={saving}>
          <label>任务名称<input ref={titleInput} value={title} onChange={event => { setTitle(event.target.value); setError(''); }} placeholder="例如：整理本周项目进展" maxLength={200} required disabled={saving} aria-invalid={!!error} aria-describedby={error ? 'ws-task-create-error' : undefined} /></label>
          {error && <p id="ws-task-create-error" className="ws-task-dialog-error" role="alert">{error}</p>}
          <footer><Dialog.Close asChild><button type="button" disabled={saving}>取消</button></Dialog.Close><button type="submit" className="ws-primary" disabled={saving || !title.trim()}>{saving ? '正在创建…' : '创建任务'}</button></footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
    <Dialog.Root open={deleteTarget !== null} onOpenChange={next => { if (!next && !mutationBusy.current) setDeleteTarget(null); }}>
      <Dialog.Portal><Dialog.Overlay className="ws-task-dialog-overlay" /><Dialog.Content className="ws-modal ws-task-dialog" onCloseAutoFocus={event => { event.preventDefault(); if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus(); else mineFilter.current?.focus(); }} onEscapeKeyDown={event => { if (mutationBusy.current) event.preventDefault(); }} onInteractOutside={event => { if (mutationBusy.current) event.preventDefault(); }}>
        <header><Dialog.Title asChild><h2>删除任务</h2></Dialog.Title><Dialog.Close asChild><button type="button" aria-label="关闭删除任务" disabled={workingId !== null}><X size={18} /></button></Dialog.Close></header>
        <Dialog.Description className="ws-task-dialog-description">确定删除“{deleteTarget?.title}”吗？删除后无法恢复。</Dialog.Description>
        {deleteError && <p className="ws-task-dialog-error" role="alert">{deleteError}</p>}
        <footer><Dialog.Close asChild><button type="button" disabled={workingId !== null}>取消</button></Dialog.Close><button type="button" className="ws-primary ws-task-delete-confirm" disabled={workingId !== null} onClick={() => void deleteTask()}>{workingId !== null ? '正在删除…' : '确认删除'}</button></footer>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </>;
}
