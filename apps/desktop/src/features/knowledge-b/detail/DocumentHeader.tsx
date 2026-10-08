import type { JSX } from 'react';
import type { DocumentDetail } from '@kla-workstation/contracts/knowledge';
import { adaptDocumentDetail } from './adapter.js';

export function DocumentHeader({ detail, displayName, hideTitle = false }: {
  detail: DocumentDetail;
  displayName?: string;
  hideTitle?: boolean;
}): JSX.Element {
  const view = adaptDocumentDetail(detail, displayName);
  const hasSecondaryStatus = view.stale !== undefined || view.hasBackup !== undefined || view.backupTime !== undefined;

  return (
    <section className="kb-b-document-header" aria-label="文档详情">
      {!hideTitle && (
        <header className="kb-b-document-header__title">
          <div>
            <p className="kb-b-document-header__eyebrow">文档详情</p>
            <h2>{view.name}</h2>
          </div>
        </header>
      )}

      <dl className="kb-b-document-header__source">
        <div><dt>来源类别</dt><dd>{view.sourceCategory}</dd></div>
        <div><dt>格式</dt><dd>{view.format}</dd></div>
        <div><dt>大小</dt><dd>{view.size}</dd></div>
        <div><dt>修改时间</dt><dd>{view.modified}</dd></div>
      </dl>

      <div className="kb-b-document-header__capabilities" role="group" aria-label="文档能力">
        <p><span>全文读取</span><strong>{view.readable ? '支持' : '不支持'}</strong></p>
        <p><span>编辑能力</span><strong>{view.editable ? '支持' : '不支持'}</strong></p>
      </div>

      {hasSecondaryStatus && (
        <details>
          <summary>状态与备份信息</summary>
          <dl className="kb-b-document-header__status">
            {view.stale !== undefined && <div><dt>索引状态</dt><dd>{view.stale ? '待重建' : '无待重建标记'}</dd></div>}
            {view.hasBackup !== undefined && <div><dt>备份</dt><dd>{view.hasBackup ? '存在' : '不存在'}</dd></div>}
            {view.backupTime !== undefined && <div><dt>备份时间</dt><dd>{view.backupTime}</dd></div>}
          </dl>
        </details>
      )}
    </section>
  );
}
