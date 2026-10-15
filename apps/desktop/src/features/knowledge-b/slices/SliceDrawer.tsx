import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { KnowledgeSlice, KnowledgeSource, OpenKnowledgeSource } from '@kla-workstation/contracts/knowledge';
import { SafeBody } from '../SafeBody.js';

/** 保存切片编辑：由宿主注入（需要 serviceInstanceId / docId 等上下文）。 */
export type SaveSliceEdit = (input: { sliceId: number; title: string; content: string }) => Promise<void>;

export interface SliceDetailContentProps {
  slice: KnowledgeSlice;
  source: KnowledgeSource;
  onOpenSource: (source: OpenKnowledgeSource) => void;
  hideTitle?: boolean | undefined;
  /** 未提供时不显示「编辑切片」（只读宿主）。 */
  onSave?: SaveSliceEdit | undefined;
}

/** Drawer body only. The host owns its title, focus, close behavior, and dialog shell. */
export function SliceDetailContent({ slice, source, onOpenSource, hideTitle = false, onSave }: SliceDetailContentProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(slice.title ?? '');
  const [content, setContent] = useState(slice.content ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) titleRef.current?.focus(); }, [editing]);
  // 切换到另一条切片时退出编辑态，避免把 A 的草稿存到 B 上。
  useEffect(() => { setEditing(false); setError(''); setTitle(slice.title ?? ''); setContent(slice.content ?? ''); }, [slice.id, slice.title, slice.content]);

  const submit = async () => {
    if (!onSave || saving) return;
    if (!title.trim()) { setError('切片标题不能为空'); return; }
    if (!content.trim()) { setError('切片正文不能为空'); return; }
    setSaving(true); setError('');
    try {
      await onSave({ sliceId: Number(slice.id), title: title.trim(), content: content.trim() });
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败，请重试。');
    } finally { setSaving(false); }
  };

  if (editing) return (
    <div className="kb-b-slice-detail-content">
      <div className="kb-b-slice-edit">
        <label>标题<input ref={titleRef} value={title} maxLength={400} onChange={event => setTitle(event.target.value)} placeholder="知识切片标题"/></label>
        <label>正文<textarea value={content} rows={12} maxLength={20000} onChange={event => setContent(event.target.value)} placeholder="切片正文内容"/></label>
        <p className="kb-b-note">可直接修改该知识切片的内容，保存后写入知识库并刷新更新时间。</p>
        {error && <p className="kb-b-error" role="alert">{error}</p>}
        <div className="kb-b-slice-edit-actions">
          <button type="button" disabled={saving} onClick={() => { setEditing(false); setTitle(slice.title ?? ''); setContent(slice.content ?? ''); setError(''); }}>取消</button>
          <button type="button" className="kb-b-primary" disabled={saving} onClick={() => void submit()}>{saving ? '保存中…' : '保存修改'}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="kb-b-slice-detail-content">
      {!hideTitle && <h3>{slice.title || '（未提供标题）'}</h3>}
      <dl>
        <div><dt>来源文件</dt><dd>{source.name}</dd></div>
        <div><dt>切片 ID</dt><dd>{slice.id}</dd></div>
      </dl>

      <h4>正文</h4>
      <SafeBody content={slice.content} />
      {error && <p className="kb-b-error" role="alert">{error}</p>}
      <div className="kb-b-slice-detail-actions">
        {onSave && <button type="button" onClick={() => setEditing(true)}>编辑切片</button>}
        <button type="button" onClick={() => onOpenSource({ docId: source.docId, locateText: slice.content })}>
          查看来源正文
        </button>
      </div>
    </div>
  );
}

export interface SliceDrawerProps {
  slice: KnowledgeSlice;
  source: KnowledgeSource;
  onClose: () => void;
  onOpenSource: (source: OpenKnowledgeSource) => void;
  onSave?: SaveSliceEdit | undefined;
}

export function SliceDrawer({ slice, source, onClose, onOpenSource, onSave }: SliceDrawerProps): JSX.Element {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButtonRef.current?.focus(); }, []);

  return (
    <aside
      className="kb-b-drawer kb-b-slice-drawer"
      role="dialog"
      aria-modal="false"
      aria-label="知识切片详情"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="kb-b-slice-drawer__header">
        <div>
          <p className="kb-b-note">知识切片详情</p>
          <h2>{slice.title || '（未提供标题）'}</h2>
        </div>
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭切片详情">关闭</button>
      </header>

      <SliceDetailContent slice={slice} source={source} onOpenSource={onOpenSource} hideTitle {...(onSave ? { onSave } : {})} />
    </aside>
  );
}
