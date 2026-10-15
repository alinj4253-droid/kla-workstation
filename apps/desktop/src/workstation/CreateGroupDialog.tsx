import { useEffect, useRef, useState } from 'react';
import { Folder, Plus, Users, X } from 'lucide-react';
import type { CreateConversationRequest } from '@kla-workstation/contracts';
import { runtimeApi, type RuntimeAgent } from '../api/runtime';
import './create-group.css';

type Props = {
  identityId: string;
  projects: Array<{ id: string; name: string }>;
  initialProjectId: string;
  fixedProject?: boolean;
  onClose: () => void;
  onCreate: (input: CreateConversationRequest) => Promise<void>;
};

function description(agent: RuntimeAgent): string {
  if (agent.name === 'PPT助手') return '从材料生成可编辑 PPT，支持大纲确认、对话改稿与质量检查';
  return agent.role || '参与群组协作，完成分配的任务';
}

export function CreateGroupDialog({ identityId, projects, initialProjectId, fixedProject, onClose, onCreate }: Props): React.JSX.Element {
  const [projectId, setProjectId] = useState(initialProjectId);
  const [name, setName] = useState('');
  const [agents, setAgents] = useState<RuntimeAgent[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [retry, setRetry] = useState(0);
  const [creating, setCreating] = useState(false);
  const createLock = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const project = projects.find(item => item.id === projectId);
  const coordinator = agents.find(agent => agent.name === '统筹智能体' && agent.enabled);
  const candidates = agents.filter(agent => agent.name !== '统筹智能体' && agent.enabled);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(''); setAgents([]); setSelected([]); setSubmitError('');
    // 未选择归属项目时创建「独立群组」：智能体来自当前身份（不依赖项目）
    const load = projectId
      ? runtimeApi.groupAgents(projectId, identityId)
      : runtimeApi.agents();
    void load.then(result => {
      if (cancelled) return;
      if (!result.ok) { setLoadError(result.message); return; }
      setAgents(result.data);
      if (!result.data.some(agent => agent.name === '统筹智能体' && agent.enabled)) setLoadError('统筹智能体不可用，请刷新后重试');
    }).catch(() => { if (!cancelled) setLoadError('智能体加载失败，请检查后端连接后重试'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, identityId, retry]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>('input[name="groupName"]')?.focus();
    return () => { previous?.focus(); };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (createLock.current || loading || loadError || !coordinator || !selected.length || !name.trim()) return;
    createLock.current = true; setCreating(true); setSubmitError('');
    try { await onCreate({ projectId: projectId || undefined, name: name.trim(), agentIds: selected }); }
    catch (error) { setSubmitError(error instanceof Error ? error.message : '创建群组失败，请稍后重试'); }
    finally { createLock.current = false; setCreating(false); }
  };

  return <div className="kla-group-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !createLock.current) onClose(); }}>
    <div className="kla-group-dialog" role="dialog" aria-modal="true" aria-labelledby="kla-group-title" aria-describedby="kla-group-description" ref={dialog} onKeyDown={event => {
      if (event.key === 'Escape' && !createLock.current) { event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
        const first = focusable?.[0]; const last = focusable?.[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><h2 id="kla-group-title">{fixedProject && project ? `新建群组 · 归属项目「${project.name}」` : projectId && project ? `新建群组 · 归属项目「${project.name}」` : '新建群组 · 独立群组（不归属项目）'}</h2><button type="button" className="kla-group-close" aria-label="关闭" disabled={creating} onClick={onClose}><X size={16} /></button></header>
      <p id="kla-group-description" className="kla-group-subtitle">勾选参与本次协作的智能体，统筹智能体固定作为群主，负责任务拆解与调度。不归属项目的群组将显示在「群组」列表中。</p>
      <form onSubmit={event => { void submit(event); }}>
        <div className="kla-group-field"><label htmlFor="kla-group-project">关联项目</label><div className="kla-group-input"><Folder size={15} /><select id="kla-group-project" value={projectId} disabled={creating || fixedProject} onChange={event => setProjectId(event.target.value)}>{!fixedProject && <option value="">不归属项目（独立群组）</option>}{projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}{fixedProject && !project && <option value="">暂无可用项目</option>}</select><small>{fixedProject ? '创建后自动归入该项目' : projectId ? '创建后归入所选项目' : '不归属任何项目，创建后显示在「群组」列表'}</small></div></div>
        <div className="kla-group-field"><label htmlFor="kla-group-name">群组名称</label><div className="kla-group-input"><Users size={15} /><input id="kla-group-name" name="groupName" value={name} disabled={creating} maxLength={100} required placeholder="给这个协作群组起个名字" onChange={event => { setName(event.target.value); setSubmitError(''); }} /></div></div>
        <div className="kla-group-field kla-group-agent-field"><div className="kla-group-picker-head"><span>选择智能体（至少 1 个）</span><button type="button" disabled={creating || loading || !!loadError || !candidates.length} onClick={() => { setSelected(selected.length === candidates.length ? [] : candidates.map(agent => agent.id)); setSubmitError(''); }}>全选 / 全不选</button></div>
          {loading ? <div className="kla-group-status" role="status">正在加载可用智能体…</div> : loadError ? <div className="kla-group-status" role="alert">{loadError}<button type="button" onClick={() => setRetry(value => value + 1)}>重新加载</button></div> : !candidates.length ? <div className="kla-group-status">暂无可用的协作智能体，请先在“我的智能体”中创建或启用智能体。</div> : <div className="kla-group-picks">{candidates.map(agent => <label key={agent.id} className={`kla-group-pick ${selected.includes(agent.id) ? 'is-on' : ''}`}><input type="checkbox" aria-label={agent.name} checked={selected.includes(agent.id)} disabled={creating} onChange={event => { setSelected(items => event.target.checked ? [...items, agent.id] : items.filter(id => id !== agent.id)); setSubmitError(''); }} /><span><strong>{agent.name}</strong><small>{description(agent)}</small></span></label>)}</div>}
        </div>
        <div className="kla-group-field kla-group-master"><label>群主智能体（必选，无法取消）</label><div className="kla-group-pick is-on"><input type="radio" checked disabled readOnly aria-label="统筹智能体（固定群主）" /><span><strong>统筹智能体</strong><small>本次协作的主调度 · 固定加入，无法取消或更换</small></span></div></div>
        {submitError && <p className="kla-group-error" role="alert">{submitError}</p>}
        <footer><span className="kla-group-count">已选 {selected.length + (coordinator ? 1 : 0)} / {candidates.length + (coordinator ? 1 : 0)} 个智能体<br />群主智能体：统筹智能体</span><button type="button" className="kla-group-cancel" disabled={creating} onClick={onClose}>取消</button><button type="submit" className="kla-group-create" disabled={creating || loading || !!loadError || !coordinator || !selected.length || !name.trim()}><Plus size={14} />{creating ? '创建中…' : '创建群组'}</button></footer>
      </form>
    </div>
  </div>;
}
