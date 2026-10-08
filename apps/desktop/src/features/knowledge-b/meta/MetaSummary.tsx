import type { JSX } from 'react';
import { adaptDocumentMeta } from './adapter.js';
import { useDocumentMeta } from './query.js';
import { BQueryError } from '../shared.js';
import type { QueryContext } from '../shared.js';

export interface MetaSummaryProps {
  context: QueryContext;
  docId: string;
}

export function MetaSummary({ context, docId }: MetaSummaryProps): JSX.Element {
  const query = useDocumentMeta(context, docId);

  if (query.isPending) {
    return <section className="kb-b-meta" aria-label="文档统计" aria-busy="true"><p role="status">正在加载文档统计…</p></section>;
  }

  if (query.isError) {
    const message = query.error instanceof BQueryError ? query.error.message : '知识服务请求失败。';
    return (
      <section className="kb-b-meta" aria-label="文档统计">
        <div className="kb-b-meta__error" role="alert">
          <p>文档统计加载失败。</p>
          <p>{message}</p>
        </div>
        <button type="button" className="kb-b-meta__retry" onClick={() => { void query.refetch(); }} disabled={query.isFetching}>重试统计</button>
      </section>
    );
  }

  const summary = adaptDocumentMeta(query.data);
  return (
    <section className="kb-b-meta" aria-label="文档统计">
      <dl className="kb-b-meta__counts">
        <div><dt>全文字数</dt><dd>{summary.totalChars.toLocaleString('zh-CN')}</dd></div>
        <div><dt>段落数</dt><dd>{summary.totalParagraphs.toLocaleString('zh-CN')}</dd></div>
      </dl>
      <p className="kb-b-meta__note">全文与正文字符数采用不同统计口径。</p>
      <details className="kb-b-meta__details">
        <summary>查看统计口径</summary>
        <p>全文字数按原始全文统计，保留空白；正文字符数会先去掉每段首尾空白再统计，因此两项数值可能不同。</p>
      </details>
    </section>
  );
}
