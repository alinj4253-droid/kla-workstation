import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export function SafeBody({ content, markdown = false }: { content: string; markdown?: boolean }): React.JSX.Element {
  if (!markdown) return <div className="kb-b-text">{content}</div>;
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: ({ alt }) => <span>{alt ?? '图片'}</span> }}>{content}</ReactMarkdown>;
}
