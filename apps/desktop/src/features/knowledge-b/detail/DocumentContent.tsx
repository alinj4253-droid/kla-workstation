import type { JSX } from 'react';
import { BQueryError } from '../shared.js';
import type { QueryContext } from '../shared.js';
import { TextPreview } from '../content/TextPreview.js';
import { MetaSummary } from '../meta/MetaSummary.js';
import { DocumentHeader } from './DocumentHeader.js';
import { useDocumentDetail } from './query.js';

export interface DocumentContentProps {
  context: QueryContext;
  docId: string;
  displayName: string;
  sliceIndex?: number;
}

/**
 * Body for the host's document drawer. The host owns drawer semantics and focus;
 * this component only composes the independent detail, metadata, and text views.
 */
export function DocumentContent({ context, docId, displayName, sliceIndex }: DocumentContentProps): JSX.Element {
  const detailQuery = useDocumentDetail(context, docId);

  return (
    <div className="kb-b-document-content">
      {detailQuery.isPending && (
        <section className="kb-b-document-content__detail-state" aria-label="文档详情" aria-busy="true">
          <p role="status">正在加载文档详情…</p>
        </section>
      )}

      {detailQuery.isError && !detailQuery.data && (
        <section className="kb-b-document-content__detail-state" aria-label="文档详情">
          <div className="kb-b-document-content__detail-error" role="alert">
            <p>文档详情加载失败。</p>
            <p>{detailQuery.error instanceof BQueryError ? detailQuery.error.message : '知识服务请求失败。'}</p>
          </div>
          <button
            type="button"
            className="kb-b-document-content__retry"
            onClick={() => { void detailQuery.refetch(); }}
            disabled={detailQuery.isFetching}
          >
            重试详情
          </button>
        </section>
      )}

      {detailQuery.data && <DocumentHeader detail={detailQuery.data} displayName={displayName} hideTitle />}

      <MetaSummary context={context} docId={docId} />

      {sliceIndex !== undefined && detailQuery.data?.readable && (
        <p className="kb-b-document-content__slice-note">
          来自切片 {sliceIndex}。正文从首段读取，接口未提供切片对应的段落位置。
        </p>
      )}

      {detailQuery.data?.readable && (
        <TextPreview
          context={context}
          docId={docId}
          format={detailQuery.data.ext.trim().toLowerCase() === 'md' ? 'md' : 'txt'}
          readable
        />
      )}

      {detailQuery.data && !detailQuery.data.readable && (
        <section className="kb-b-document-content__body-state" aria-label="文档正文">
          <p role="status">此文档不支持全文预览</p>
        </section>
      )}

      {detailQuery.isError && !detailQuery.data && (
        <section className="kb-b-document-content__body-state" aria-label="文档正文">
          <p role="status">无法确认全文读取能力，正文暂未请求。</p>
        </section>
      )}
    </div>
  );
}
