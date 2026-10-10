import { useEffect, useRef, useState } from 'react';
import { v4 as randomUUID } from 'uuid';
import { useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { CloudUpload, X } from 'lucide-react';
import { KNOWLEDGE_UPLOAD_EXTENSIONS, KNOWLEDGE_UPLOAD_LIMIT, KNOWLEDGE_UPLOAD_NOTICE_VERSION, type KnowledgeConnection, type KnowledgeContext, type SourceJobBinding } from '@kla-workstation/contracts/knowledge';
import { KnowledgeApiError, knowledgeApi, knowledgeKeys } from './api';
import { UploadQueue, type UploadItem } from './UploadQueue';
import { planUploadNames } from './upload-names';
import './upload.css';

export function UploadDialog({ context, connection, onClose, onSubmitted }: {
  context: KnowledgeContext; connection: KnowledgeConnection; onClose: () => void; onSubmitted: (binding: SourceJobBinding) => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  const [checkingNames, setCheckingNames] = useState(false);
  const [checkedQueue, setCheckedQueue] = useState('');
  const [nameAttempt, setNameAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(new Set<string>());
  const cancelled = useRef(new Set<string>());
  const alive = useRef(true);
  const busy = useRef(false);
  const queueKey = JSON.stringify([context.serviceInstanceId, context.collection, items.map(item => [item.id, item.state])]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  async function namesFor(queue: UploadItem[], isCurrent = () => alive.current) {
    const reserved = itemsRef.current.filter(item => ['submitted', 'uncertain', 'uploading'].includes(item.state)).map(item => item.uploadName ?? item.file.name);
    return planUploadNames(queue.map(item => item.file.name), reserved, names => {
      if (!isCurrent()) throw new Error('名称检查已取消。');
      return knowledgeApi.checkUploadNames({ serviceInstanceId: context.serviceInstanceId, collection: context.collection, knowledgeBaseId: context.knowledgeBaseId, names });
    });
  }
  useEffect(() => {
    let current = true;
    const queue = itemsRef.current.filter(item => ['waiting', 'waiting-for-consent'].includes(item.state));
    setCheckedQueue('');
    setNameError('');
    if (!queue.length || running) { setCheckingNames(false); return; }
    setCheckingNames(true);
    void namesFor(queue, () => current).then(names => {
      if (!current) return;
      const planned = new Map(queue.map((item, index) => [item.id, names[index]!]));
      setItems(old => old.map(item => planned.has(item.id) ? { ...item, uploadName: planned.get(item.id) } : item));
      setCheckedQueue(queueKey);
    }).catch(() => {
      if (current) setNameError('无法完整检查服务中的同名原件，暂不能上传，请重试。');
    }).finally(() => { if (current) setCheckingNames(false); });
    return () => { current = false; };
    // Queue identity, service and collection determine the scope; planned names do not trigger another check.
  }, [queueKey, nameAttempt, running]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const id of active.current) {
        cancelled.current.add(id);
        void knowledgeApi.cancelUpload(id).catch(() => undefined);
      }
    };
  }, []);
  const update = (id: string, patch: Partial<UploadItem>) => {
    if (alive.current) setItems(old => old.map(item => item.id === id ? { ...item, ...patch } : item));
  };
  function add(files: File[]) {
    const incoming: UploadItem[] = files.map(file => {
      const ext = file.name.split('.').pop()?.toLowerCase();
      const invalid = new TextEncoder().encode(file.name).length > 255 || /[\\/\u0000-\u001f]/.test(file.name) || file.name !== file.name.trim() ? '文件名称过长或含不支持的字符，请改名后选择' : !file.size ? '文件为空' : file.size > KNOWLEDGE_UPLOAD_LIMIT ? '超过单文件 50MiB 限制' : !ext || !(KNOWLEDGE_UPLOAD_EXTENSIONS as readonly string[]).includes(ext) ? '当前服务不支持此格式' : undefined;
      return { id: randomUUID(), file, state: invalid ? 'failed' : connection.hasUploadConsent ? 'waiting' : 'waiting-for-consent', ...(invalid ? { error: invalid } : {}) };
    });
    setItems(old => [...old, ...incoming]);
  }
  async function start() {
    if (busy.current || checkingNames || checkedQueue !== queueKey || nameError || !context.collection || (!connection.hasUploadConsent && !consentChecked)) return;
    const waiting = items.filter(item => ['waiting', 'waiting-for-consent'].includes(item.state));
    if (!waiting.length) return;
    busy.current = true;
    setRunning(true);
    setError('');
    try {
      // Recheck immediately before submission: another client may have uploaded since selection.
      const names = await namesFor(waiting);
      if (!alive.current) return;
      if (waiting.some((item, index) => item.uploadName !== names[index])) {
        const planned = new Map(waiting.map((item, index) => [item.id, names[index]!]));
        setItems(old => old.map(item => planned.has(item.id) ? { ...item, uploadName: planned.get(item.id) } : item));
        setError('服务中的同名文件已变化，上传名称已更新，请核对后再次开始上传。');
        return;
      }
      if (!connection.hasUploadConsent) {
        const accepted = await knowledgeApi.acceptUploadConsent({ serviceInstanceId: context.serviceInstanceId, noticeVersion: KNOWLEDGE_UPLOAD_NOTICE_VERSION });
        client.setQueryData(knowledgeKeys.connection, accepted);
      }
      if (!alive.current) return;
      setItems(old => old.map(item => item.state === 'waiting-for-consent' ? { ...item, state: 'waiting' } : item));
      let next = 0;
      async function worker() {
        while (alive.current && next < waiting.length) {
          const item = waiting[next++]!;
          if (cancelled.current.has(item.id)) continue;
          active.current.add(item.id);
          update(item.id, { state: 'uploading', error: undefined, errorCode: undefined });
          let sent = false;
          try {
            const bytes = await item.file.arrayBuffer();
            if (cancelled.current.has(item.id) || !alive.current) { update(item.id, { state: 'aborted' }); continue; }
            sent = true;
            if (!context.knowledgeBaseId) throw new Error('请选择已创建的知识库');
            const binding = await knowledgeApi.submit({ serviceInstanceId: context.serviceInstanceId, collection: context.collection, knowledgeBaseId: context.knowledgeBaseId, clientUploadId: item.id, name: item.uploadName!, mime: item.file.type || 'application/octet-stream', bytes });
            if (alive.current) {
              update(item.id, { state: 'submitted', jobId: binding.jobId });
              onSubmitted(binding);
            }
          } catch (failure) {
            const details = failure instanceof KnowledgeApiError ? failure.error.details : undefined;
            const status = details?.status;
            const rejected = details?.notSubmitted || details?.waitingForConsent || (typeof status === 'number' && status >= 400 && status < 500);
            const uncertain = sent && !rejected && (!(failure instanceof KnowledgeApiError) || Boolean(details?.uncertainSubmission) || ['INTERNAL_ERROR', 'FILE_OPERATION_FAILED', 'KNOWLEDGE_INGEST_FAILED', 'CONFLICT'].includes(failure.error.code));
            update(item.id, {
              state: uncertain ? 'uncertain' : cancelled.current.has(item.id) ? 'aborted' : 'failed',
              errorCode: failure instanceof KnowledgeApiError ? failure.error.code : undefined,
              error: uncertain ? '请求已发送但未确认任务编号。请刷新任务记录并核对服务，勿直接重复上传。' : (failure as Error).message,
            });
          } finally { active.current.delete(item.id); }
        }
      }
      await Promise.all(Array.from({ length: Math.min(waiting.length, connection.settings.uploadConcurrency) }, worker));
    } catch (failure) {
      if (alive.current) setError((failure as Error).message);
    } finally {
      busy.current = false;
      if (alive.current) setRunning(false);
    }
  }
  function cancel(id: string) {
    cancelled.current.add(id);
    if (!active.current.has(id)) { update(id, { state: 'aborted' }); return; }
    void knowledgeApi.cancelUpload(id).catch(failure => update(id, { error: (failure as Error).message }));
  }
  const awaiting = items.some(item => ['waiting', 'waiting-for-consent'].includes(item.state));
  return <Dialog.Root open onOpenChange={open => { if (!open && !running) onClose(); }}><Dialog.Portal><Dialog.Overlay className="kl-modal-overlay"/><Dialog.Content className="kl-upload-dialog kl-module" onEscapeKeyDown={event => { if (running) event.preventDefault(); }} onPointerDownOutside={event => { if (running) event.preventDefault(); }}>
    <header><div><Dialog.Title>上传知识文件</Dialog.Title><Dialog.Description>上传后立即解析、清洗、切片并入库至指定 collection。</Dialog.Description></div><button aria-label="关闭上传窗口" className="kl-icon-button" disabled={running} onClick={onClose}><X size={20}/></button></header>
    <div className="kl-upload-body">
      <div className="kl-upload-target">目标集合 <strong>{context.collection || '未配置'}</strong></div>
      <button className={`kl-dropzone ${dragging ? 'kl-dragging' : ''}`} disabled={running} onClick={() => input.current?.click()} onDragOver={event => { event.preventDefault(); if (!running) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!running) add(Array.from(event.dataTransfer.files)); }}><CloudUpload size={36}/><strong>点击选择或拖拽文件到这里</strong><span>支持多文件选择，单个文件最大 50MiB</span><small>TXT、MD、PDF、DOCX、HTML 及常见音视频格式</small></button>
      <input hidden ref={input} type="file" multiple accept={KNOWLEDGE_UPLOAD_EXTENSIONS.map(ext => `.${ext}`).join(',')} onChange={event => { add(Array.from(event.target.files ?? [])); event.target.value = ''; }}/>
      <UploadQueue items={items} running={running} onRemove={id => { if (!running) setItems(old => old.filter(item => item.id !== id)); }} onCancel={cancel}/>
      {checkingNames && <p role="status" className="kl-notice">正在检查同名原件……</p>}
      {nameError && <p role="alert" className="kl-error-text">{nameError} <button disabled={running || checkingNames} onClick={() => setNameAttempt(old => old + 1)}>重新检查名称</button></p>}
      <section className="kl-upload-consent" aria-label="数据发送说明"><h3>上传前请了解数据发送范围</h3><p>接收服务：<strong>{connection.baseUrl}</strong></p><p>所选文件的完整内容将发送到该服务。解析出的文本及后续切片可能交给服务方配置的 OCR、语音识别、清洗和向量模型处理；各片段可能包含原文。原件和处理结果保存在服务工作区，切片向量写入所选集合。</p><p>模型部署位置、保存期限及删除方式由服务方确定。若不希望发送，可以关闭弹窗，文件不会上传。</p>
        {connection.hasUploadConsent ? <small>已确认当前服务与集合的数据发送说明，可在“服务连接”中撤销。</small> : <label className="kl-consent-checkbox"><input type="checkbox" checked={consentChecked} disabled={running} onChange={event => setConsentChecked(event.target.checked)}/><span>我已了解并同意向上述服务发送所选文件及其处理片段。</span></label>}
      </section>
      <div className="kl-notice">同时提交 {connection.settings.uploadConcurrency} 个文件。同名原件（不含扩展名）将自动编号，编号名称用于实际上传，不改动已有文件。其他客户端同时上传仍可能产生冲突。中止传输后仍需核对任务。</div>
      {error && <p role="alert" className="kl-error-text">{error}</p>}
    </div>
    <footer><span>{items.filter(item => item.state === 'submitted').length} / {items.length} 已提交</span><button disabled={running} onClick={onClose}>关闭</button><button className="kl-primary" disabled={running || checkingNames || checkedQueue !== queueKey || Boolean(nameError) || !context.collection || !awaiting || (!connection.hasUploadConsent && !consentChecked)} onClick={() => void start()}>{running ? '正在提交……' : connection.hasUploadConsent ? '开始上传并处理' : '同意并上传处理'}</button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
