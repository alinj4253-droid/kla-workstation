import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Trash2, X } from 'lucide-react';
import type { LibraryEntry } from './catalog';
import './upload.css';

export function DeleteLibraryDialog({ entry, onClose, onDelete }: { entry: LibraryEntry; onClose: () => void; onDelete: () => void | Promise<void> }) {
  const [error, setError] = useState('');
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Overlay className="kl-modal-overlay"/><Dialog.Content className="kl-connection-dialog kl-module kl-delete-dialog">
    <header><Dialog.Title><Trash2 size={20}/>删除知识库</Dialog.Title><button className="kl-icon-button" aria-label="关闭删除确认" onClick={onClose}><X size={18}/></button></header>
    <Dialog.Description>确认删除「{entry.name}」？删除后，当前身份列表将不再显示此知识库，配置无法撤销。</Dialog.Description>
    <p className="kl-notice">服务器尚未提供知识库删除接口。本次仅删除当前身份卡片和配置，服务器集合「{entry.collection}」中的文件、知识切片和处理任务仍保留。</p>
    {error && <p className="kl-error-text" role="alert">{error}</p>}
    <footer><button autoFocus onClick={onClose}>取消</button><button className="kl-danger" onClick={async () => { try { await onDelete(); } catch (reason) { setError((reason as Error).message); } }}>确认删除</button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
