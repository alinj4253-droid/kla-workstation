import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Trash2, X } from 'lucide-react';
import type { SourceJobBinding } from '@kla-workstation/contracts/knowledge';
import { knowledgeApi } from './api';
import './upload.css';

export function DeleteJobRecordDialog({ binding, onClose, onDeleted }: {
  binding: SourceJobBinding; onClose: () => void; onDeleted: (binding: SourceJobBinding) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    if (deleting) return;
    setDeleting(true); setError('');
    try {
      const deleted = await knowledgeApi.deleteJobRecord(binding.serviceInstanceId, binding.jobId);
      onDeleted(deleted);
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '删除任务记录失败，请重试。'); }
    finally { setDeleting(false); }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !deleting) onClose(); }}><Dialog.Portal><Dialog.Overlay className="kl-modal-overlay"/><Dialog.Content className="kl-connection-dialog kl-module kl-delete-job-dialog" aria-busy={deleting}>
    <header><Dialog.Title><Trash2 size={20}/>删除任务记录</Dialog.Title><button className="kl-icon-button" aria-label="关闭删除确认" disabled={deleting} onClick={onClose}><X size={18}/></button></header>
    <Dialog.Description>确认删除「{binding.displayName}」的处理任务记录？</Dialog.Description>
    <p className="kl-notice">仅从当前身份任务列表移除这条记录，已上传文件、知识切片和文件处理状态保留。</p>
    <small className="kl-muted kl-block">任务编号：{binding.jobId}</small>
    {error && <p className="kl-error-text" role="alert">{error}</p>}
    <footer><button autoFocus disabled={deleting} onClick={onClose}>取消</button><button className="kl-danger" disabled={deleting} onClick={() => void remove()}>{deleting ? '正在删除……' : '确认删除'}</button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
