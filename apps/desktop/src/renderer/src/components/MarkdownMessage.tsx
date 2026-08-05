import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

const rehypeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [['className']],
    code: [['className']],
  },
};

export type ConfirmedMention = {
  target: { scope: string; id: string };
  label: string;
  start: number;
  end: number;
};

interface MarkdownMessageProps {
  content: string;
  mentions?: ConfirmedMention[];
}

function preprocessMentions(text: string, mentions: ConfirmedMention[]): string {
  const confirmed = mentions
    .filter((mention) => (
      Number.isInteger(mention.start)
      && Number.isInteger(mention.end)
      && mention.start >= 0
      && mention.end <= text.length
      && mention.start < mention.end
      && text.slice(mention.start, mention.end) === `@${mention.label}`
    ))
    .sort((left, right) => right.start - left.start);
  let result = text;
  for (const mention of confirmed) {
    result = `${result.slice(0, mention.start)}<span class="chat-mention">${result.slice(mention.start, mention.end)}</span>${result.slice(mention.end)}`;
  }
  return result;
}

function normalizeHtmlOutput(text: string): string {
  if (/```(?:html)?[\s\S]*```/i.test(text)) return text;
  if (!/(?:<!doctype\s+html|<html\b)/i.test(text)) return text;
  return `\`\`\`html\n${text.trim()}\n\`\`\``;
}

export function MarkdownMessage({ content, mentions = [] }: MarkdownMessageProps): React.JSX.Element {
  const normalized = normalizeHtmlOutput(content);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, rehypeSchema]]}
    >
      {preprocessMentions(normalized, normalized === content ? mentions : [])}
    </ReactMarkdown>
  );
}
