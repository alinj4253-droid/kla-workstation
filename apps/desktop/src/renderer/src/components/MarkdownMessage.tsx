import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';

const MENTION_RE = /@([\u4e00-\u9fff\w]+)/g;

interface MarkdownMessageProps {
  content: string;
}

function preprocessMentions(text: string): string {
  return text.replace(MENTION_RE, '<span class="chat-mention">@$1</span>');
}

export function MarkdownMessage({ content }: MarkdownMessageProps): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw]}
    >
      {preprocessMentions(content)}
    </ReactMarkdown>
  );
}
