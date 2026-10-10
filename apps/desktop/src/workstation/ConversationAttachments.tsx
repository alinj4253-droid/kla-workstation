import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Paperclip, X } from 'lucide-react';
import type { FileItem } from '@kla-workstation/contracts';
import { uploadConversationFile } from '../api/files';

export function ConversationAttachments({ conversationId, identityId, files, onChange, onBusy, onError }: {
  conversationId: string; identityId: string; files: FileItem[];
  onChange(files: FileItem[]): void; onBusy(busy: boolean): void; onError(message: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [uploading, setUploading] = useState(false);
  useEffect(() => () => { controller.current?.abort(); }, []);
  async function upload(selected: File[]) {
    if (!conversationId || uploading || !selected.length) return;
    if (selected.length + files.length > 20) { onError('每条消息最多添加 20 个附件'); return; }
    const abort = new AbortController(); controller.current = abort;
    setUploading(true); onBusy(true);
    const completed = [...files];
    try {
      for (const file of selected) {
        const item = await uploadConversationFile(conversationId, file, identityId, abort.signal);
        if (abort.signal.aborted) return;
        completed.push(item); onChange([...completed]);
      }
    } catch (error) { if (!abort.signal.aborted) onError(error instanceof Error ? error.message : '附件上传失败'); }
    finally { if (!abort.signal.aborted) { setUploading(false); onBusy(false); } }
  }
  return <div className="ws-chat-attachments">
    <input ref={input} type="file" multiple hidden aria-label="选择群聊附件" onChange={event => { void upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    <button type="button" disabled={uploading || !conversationId} onClick={() => input.current?.click()}>{uploading ? <LoaderCircle size={14} /> : <Paperclip size={14} />}{uploading ? '正在上传…' : '添加附件'}</button>
    {files.map(file => <span key={file.id} title={file.name}>{file.name}<button aria-label={`移除附件 ${file.name}`} disabled={uploading} onClick={() => onChange(files.filter(item => item.id !== file.id))}><X size={12} /></button></span>)}
    {!!files.length && <small>已保存到群聊 · 同群成员可访问</small>}
  </div>;
}
