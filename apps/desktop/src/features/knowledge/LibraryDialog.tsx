import { useState } from 'react';
import { v4 as randomUUID } from 'uuid';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { defaultCollection, KNOWLEDGE_SERVICE_URL, type LibraryEntry } from './catalog';
import { scopeLabels } from './KnowledgeBaseCard';
import './upload.css';

export function LibraryDialog({ entry, onClose, onSave }: { entry?: LibraryEntry; onClose: () => void; onSave: (entry: LibraryEntry) => void | Promise<void> }) {
  const [name, setName] = useState(entry?.name ?? '');
  const [description, setDescription] = useState(entry?.description ?? '');
  const [scope, setScope] = useState<LibraryEntry['scope']>(entry?.scope ?? 'company');
  const [id] = useState(() => entry?.id ?? randomUUID());
  const [collection, setCollection] = useState(entry?.collection ?? defaultCollection({ id, name: '' }));
  const [error, setError] = useState('');
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Overlay className="kl-modal-overlay"/><Dialog.Content className="kl-connection-dialog kl-module">
    <header><Dialog.Title>{entry ? '编辑知识库' : '新建知识库'}</Dialog.Title><button className="kl-icon-button" aria-label="关闭知识库配置" onClick={onClose}><X size={18}/></button></header>
    <Dialog.Description>文件处理与检索统一连接 {KNOWLEDGE_SERVICE_URL}。知识库配置保存在服务端，按当前身份隔离，每个新建知识库自动分配独立集合。</Dialog.Description>
    <form onSubmit={async event => {
      event.preventDefault(); setError('');
      try { await onSave({ id, name: name.trim(), description: description.trim(), scope, collection: collection.trim(), updatedAt: new Date().toISOString() }); }
      catch (reason) { setError((reason as Error).message); }
    }}>
      <label>知识库名称<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="输入知识库名称"/></label>
      <label>知识库类型<select disabled={Boolean(entry)} value={scope} onChange={event => setScope(event.target.value as LibraryEntry['scope'])}>{Object.entries(scopeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>{entry && <small>知识库类型创建后固定。</small>}</label>
      <label>知识库说明<textarea maxLength={500} rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder="描述知识库包含的内容与用途"/></label>
      <details className="kl-connection-advanced"><summary>高级设置 · 连接已有集合</summary><label className="kl-collection-field">连接集合（collection）<input maxLength={200} value={collection} onChange={event => setCollection(event.target.value)} placeholder="留空自动分配集合"/><small>默认自动分配，无需填写。相同集合会共享内容；新的集合在首次有效文件入库时由服务创建。</small></label></details>
      {error && <p className="kl-error-text" role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>取消</button><button className="kl-primary" type="submit">{entry ? '保存配置' : '创建知识库'}</button></footer>
    </form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
