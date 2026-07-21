import type { ParsedDocument } from '../types';

export type { ParsedDocument } from '../types';

/**
 * Parse a document buffer into text. Routes to the appropriate parser based on file extension.
 */
export async function parseDocument(buf: Uint8Array, ext: string, fileName: string): Promise<ParsedDocument> {
  const e = ext.toLowerCase();

  if (e === 'html' || e === 'htm') {
    return parseHtml(buf, fileName);
  }

  if (e === 'pdf') {
    return parsePdf(buf, fileName);
  }

  if (e === 'docx') {
    return parseDocx(buf, fileName);
  }

  if (e === 'xlsx' || e === 'xls') {
    return parseXlsx(buf, fileName);
  }

  // Default: text-based parsing
  return parseText(buf, e, fileName);
}

// ── Text parser (txt, md, json, csv, xml, code, etc.) ──

function parseText(buf: Uint8Array, _ext: string, fileName: string): ParsedDocument {
  const text = new TextDecoder().decode(buf);
  return {
    text,
    mimeType: 'text/plain',
    metadata: { fileName },
  };
}

// ── HTML parser ──

function parseHtml(buf: Uint8Array, fileName: string): ParsedDocument {
  let html = new TextDecoder().decode(buf);

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim();

  // Remove script and style tags
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Remove HTML tags and convert to plain text
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Collapse multiple newlines
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return {
    text,
    mimeType: 'text/html',
    metadata: { fileName, title: title ?? fileName },
  };
}

// ── PDF parser (stub - requires pdf-parse dependency) ──

function parsePdf(_buf: Uint8Array, fileName: string): ParsedDocument {
  // TODO: Add pdf-parse dependency and implement real PDF parsing
  return {
    text: `[PDF 文件: ${fileName}。PDF 解析需要安装 pdf-parse 依赖。]`,
    mimeType: 'application/pdf',
    metadata: { fileName, parsingNote: 'pdf-parse not yet installed' },
  };
}

// ── DOCX parser (stub - requires mammoth dependency) ──

function parseDocx(_buf: Uint8Array, fileName: string): ParsedDocument {
  // TODO: Add mammoth dependency and implement real DOCX parsing
  return {
    text: `[DOCX 文件: ${fileName}。DOCX 解析需要安装 mammoth 依赖。]`,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    metadata: { fileName, parsingNote: 'mammoth not yet installed' },
  };
}

// ── XLSX parser (stub - requires xlsx dependency) ──

function parseXlsx(_buf: Uint8Array, fileName: string): ParsedDocument {
  // TODO: Add xlsx (SheetJS) dependency and implement real XLSX parsing
  return {
    text: `[XLSX 文件: ${fileName}。XLSX 解析需要安装 xlsx 依赖。]`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    metadata: { fileName, parsingNote: 'xlsx not yet installed' },
  };
}