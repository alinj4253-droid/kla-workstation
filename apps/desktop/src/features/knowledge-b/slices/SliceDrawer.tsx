import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import type { KnowledgeSlice, KnowledgeSource, OpenKnowledgeSource } from '@kla-workstation/contracts/knowledge';
import { SafeBody } from '../SafeBody.js';

export interface SliceDetailContentProps {
  slice: KnowledgeSlice;
  source: KnowledgeSource;
  onOpenSource: (source: OpenKnowledgeSource) => void;
  hideTitle?: boolean | undefined;
}

/** Drawer body only. The host owns its title, focus, close behavior, and dialog shell. */
export function SliceDetailContent({ slice, source, onOpenSource, hideTitle = false }: SliceDetailContentProps): JSX.Element {
  return (
    <div className="kb-b-slice-detail-content">
      {!hideTitle && <h3>{slice.title || '（未提供标题）'}</h3>}
      <dl>
        <div><dt>来源文件</dt><dd>{source.name}</dd></div>
        <div><dt>切片 ID</dt><dd>{slice.id}</dd></div>
        {slice.group !== undefined && slice.group !== null && <div><dt>分组</dt><dd>{slice.group}</dd></div>}
      </dl>

      <h4>正文</h4>
      <SafeBody content={slice.content} />
      <button type="button" onClick={() => onOpenSource({ docId: source.docId, locateText: slice.content })}>
        查看来源正文
      </button>
    </div>
  );
}

export interface SliceDrawerProps {
  slice: KnowledgeSlice;
  source: KnowledgeSource;
  onClose: () => void;
  onOpenSource: (source: OpenKnowledgeSource) => void;
}

export function SliceDrawer({ slice, source, onClose, onOpenSource }: SliceDrawerProps): JSX.Element {
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

      <SliceDetailContent slice={slice} source={source} onOpenSource={onOpenSource} hideTitle />
    </aside>
  );
}
