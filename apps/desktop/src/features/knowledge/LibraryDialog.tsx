import { useEffect, useState } from 'react';
import { v4 as randomUUID } from 'uuid';
import * as Dialog from '@radix-ui/react-dialog';
import { Building2, FileText, FolderKanban, UserRound, X } from 'lucide-react';
import { klaApi } from '../../api/client';
import { defaultCollection, KNOWLEDGE_SERVICE_URL, type LibraryEntry } from './catalog';
import { scopeLabels } from './KnowledgeBaseCard';
import './upload.css';

type Scope = LibraryEntry['scope'];

const scopeOptions: { value: Scope; label: string; icon: typeof Building2; hint: string }[] = [
  { value: 'company', label: '公司知识库', icon: Building2, hint: '公司知识库 · 集团可见，按员工数据权限自动过滤' },
  { value: 'project', label: '项目知识库', icon: FolderKanban, hint: '项目知识库 · 仅该项目成员可见' },
  { value: 'personal', label: '个人知识库', icon: UserRound, hint: '个人知识库 · 仅本人可见，无需额外绑定' },
];

/**
 * 项目候选：先取当前身份的真实项目列表，取不到时回落到原型演示用的虚拟项目名，
 * 保证「项目知识库」始终能选到一个归属项目（否则该作用域无从归属）。
 */
const fallbackProjects = [
  { id: 'demo-project-1', name: '测试版本', meta: '测试版本1.0 · 2 个关联节点' },
  { id: 'demo-project-2', name: '测试版本1.0', meta: '个人项目' },
];

function useProjectOptions(): { id: string; name: string }[] {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await klaApi.request<{ projects: { id: string; name: string }[] }>('/v1/bootstrap');
        if (!cancelled && result.ok && result.data.projects.length) setProjects(result.data.projects);
      } catch { /* 登录态缺失或后端不可用时用虚拟项目兜底 */ }
    })();
    return () => { cancelled = true; };
  }, []);
  return projects.length ? projects : fallbackProjects;
}

export function LibraryDialog({ entry, onClose, onSave }: { entry?: LibraryEntry; onClose: () => void; onSave: (entry: LibraryEntry) => void | Promise<void> }) {
  const [name, setName] = useState(entry?.name ?? '');
  const [description, setDescription] = useState(entry?.description ?? '');
  const [scope, setScope] = useState<Scope>(entry?.scope ?? 'company');
  const [id] = useState(() => entry?.id ?? randomUUID());
  const [collection, setCollection] = useState(entry?.collection ?? defaultCollection({ id, name: '' }));
  const [error, setError] = useState('');
  const projects = useProjectOptions();
  const [projectId, setProjectId] = useState('');
  const editing = Boolean(entry);
  const activeHint = scopeOptions.find(option => option.value === scope)?.hint ?? '';
  const ActiveIcon = scopeOptions.find(option => option.value === scope)?.icon ?? Building2;
  const selectedProject = projects.find(project => project.id === projectId) ?? projects[0];
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Overlay className="kl-modal-overlay"/><Dialog.Content className="kl-connection-dialog kl-module">
    <header><Dialog.Title>{editing ? '编辑知识库' : '新建知识库'}</Dialog.Title><button className="kl-icon-button" aria-label="关闭知识库配置" onClick={onClose}><X size={18}/></button></header>
    <form onSubmit={async event => {
      event.preventDefault(); setError('');
      try { await onSave({ id, name: name.trim(), description: description.trim() || (scope === 'project' ? `归属项目：${selectedProject?.name ?? '未指定'}` : description.trim()), scope, collection: collection.trim(), updatedAt: new Date().toISOString() }); }
      catch (reason) { setError((reason as Error).message); }
    }}>
      <label>知识库名称<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：生产工艺库"/></label>
      <label>知识库说明<input maxLength={500} value={description} onChange={event => setDescription(event.target.value)} placeholder="一句话说明这个知识库存什么"/></label>
      {editing
        // 原型：编辑态作用域只读展示 + 「创建时确定」标签，不开放修改
        ? <><div className="kl-scope-lock"><ActiveIcon size={17}/><span><strong>{scopeLabels[scope]}</strong><small>{activeHint}</small></span><em>创建时确定</em></div><p className="kl-scope-hint">作用域在创建知识库时确定，本版本不开放修改；如需调整请新建知识库。</p></>
        // 原型：三选一卡片行（role=radiogroup + label「作用域」），选中态描边高亮，下方一行说明当前作用域含义
        : <><p className="kl-field-label">作用域</p><div className="kl-scope-pick" role="radiogroup" aria-label="作用域">{scopeOptions.map(({ value, label, icon: Icon }) =>
          <button type="button" role="radio" aria-checked={scope === value} data-on={scope === value} className="kl-scope-row" key={value} onClick={() => setScope(value)}><span/><Icon size={16}/><strong>{label}</strong></button>)}</div><p className="kl-scope-hint">{activeHint}</p></>}
      {!editing && scope === 'project' && <label className="kl-field">项目<select value={selectedProject?.id ?? ''} onChange={event => setProjectId(event.target.value)}>{projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>}
      <details className="kl-connection-advanced"><summary>高级设置 · 连接已有集合</summary><label className="kl-collection-field">连接集合（collection）<input maxLength={200} value={collection} onChange={event => setCollection(event.target.value)} placeholder="留空自动分配集合"/><small>默认自动分配，无需填写。相同集合会共享内容；新的集合在首次有效文件入库时由服务创建。当前连接 {KNOWLEDGE_SERVICE_URL}。</small></label></details>
      {error && <p className="kl-error-text" role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>取消</button><button className="kl-primary" type="submit">{editing ? '保存配置' : '创建知识库'}</button></footer>
    </form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

/** 说明字段在原型里带图标，这里复用同一图标语义供调用方按需展示。 */
export const libraryFieldIcons = { name: FolderKanban, description: FileText };
