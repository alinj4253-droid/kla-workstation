import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

const rehypeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'audio', 'video', 'source'],
  attributes: {
    ...defaultSchema.attributes,
    span: [['className']],
    code: [['className']],
    audio: ['src', 'controls', 'preload'],
    video: ['src', 'controls', 'preload', 'poster'],
    source: ['src', 'type'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'app-file', 'data'],
    href: [...(defaultSchema.protocols?.href ?? []), 'app-file'],
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
  onOpenLink?: (url: string) => void;
  onOpenImage?: (url: string, alt?: string) => void;
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

function transformMediaUrl(url: string): string {
  if (/^app-file:/i.test(url)) return url;
  if (/^data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(url)) return url;
  return defaultUrlTransform(url);
}

function isImageUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (/^data:image\//i.test(url)) return true;
  const normalized = url.split('#')[0]?.toLocaleLowerCase() ?? '';
  const path = normalized.split('?')[0] ?? '';
  return /\.(?:png|jpe?g|webp|gif|bmp|avif|svg)$/.test(path)
    || /[?&](?:format|fm|ext)=(?:png|jpe?g|webp|gif|bmp|avif)(?:&|$)/.test(normalized);
}

export function MarkdownMessage({ content, mentions = [], onOpenLink, onOpenImage }: MarkdownMessageProps): React.JSX.Element {
  const normalized = normalizeHtmlOutput(content);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, rehypeSchema]]}
      urlTransform={transformMediaUrl}
      components={{
        img: ({ src, alt, ...props }) => (
          <img src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" {...props} onClick={() => src && onOpenImage?.(src, alt ?? undefined)} />
        ),
        a: ({ href, children, ...props }) => {
          const mediaPath = href?.split(/[?#]/)[0]?.toLocaleLowerCase() ?? '';
          if (isImageUrl(href)) {
            const alt = typeof children === 'string' ? children : '图片';
            return <img src={href} alt={alt} loading="lazy" referrerPolicy="no-referrer" onClick={() => href && onOpenImage?.(href, alt)} />;
          }
          if (/\.(mp4|webm|mov|m4v|ogv)$/.test(mediaPath)) {
            return <video src={href} controls preload="metadata">{children}</video>;
          }
          if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(mediaPath)) {
            return <audio src={href} controls preload="metadata">{children}</audio>;
          }
          const previewable = typeof href === 'string' && /^https?:\/\//i.test(href);
          return <a
            href={href}
            {...props}
            onClick={(event) => {
              if (!previewable || !onOpenLink) return;
              event.preventDefault();
              onOpenLink(href);
            }}
          >{children}</a>;
        },
      }}
    >
      {preprocessMentions(normalized, normalized === content ? mentions : [])}
    </ReactMarkdown>
  );
}
