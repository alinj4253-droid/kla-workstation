import type { ParsedDocument } from '../types';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { load as loadHtml } from 'cheerio';

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

  if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'].includes(e)) {
    return { text: '', mimeType: `image/${e === 'jpg' ? 'jpeg' : e}`, metadata: { fileName, parserId: 'local-ocr', requiresOcr: true } };
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
    metadata: { fileName, parserId: 'text-decoder' },
  };
}

// ── HTML parser ──

function parseHtml(buf: Uint8Array, fileName: string): ParsedDocument {
  const $ = loadHtml(new TextDecoder().decode(buf));
  const title = $('title').first().text().trim();
  $('script,style,noscript,template').remove();
  $('br').replaceWith('\n');
  $('h1,h2,h3,h4,h5,h6').each((_index, element) => {
    const level = Number(element.tagName.slice(1));
    $(element).prepend(`${'#'.repeat(level)} `).append('\n\n');
  });
  $('p,section,article').each((_index, element) => { $(element).append('\n\n'); });
  $('li,tr').each((_index, element) => { $(element).append('\n'); });
  const text = $.root().text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

  return {
    text,
    mimeType: 'text/html',
    metadata: { fileName, title: title || fileName, parserId: 'cheerio' },
  };
}

async function parsePdf(buf: Uint8Array, fileName: string): Promise<ParsedDocument> {
  const pageTexts: string[] = [];
  const result = await pdfParse(Buffer.from(buf), {
    async pagerender(page) {
      const content = await page.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      let lastY: number | undefined;
      let text = '';
      for (const item of content.items) {
        const value = typeof item.str === 'string' ? item.str : '';
        const y = item.transform?.[5];
        text += lastY === undefined || y === lastY ? value : `\n${value}`;
        lastY = y;
      }
      const normalized = text.trim();
      pageTexts.push(normalized);
      return normalized;
    },
  });
  let text = '';
  const pageOffsets: number[] = [];
  for (const pageText of pageTexts) {
    if (pageOffsets.length > 0) text += '\n\n';
    pageOffsets.push(text.length);
    text += pageText;
  }
  return {
    text,
    mimeType: 'application/pdf',
    metadata: {
      fileName,
      pageCount: result.numpages,
      pageOffsets,
      parserId: 'pdf-parse',
      requiresOcr: text.trim().length < 20,
    },
  };
}

async function parseDocx(buf: Uint8Array, fileName: string): Promise<ParsedDocument> {
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(buf) });
  const parsed = parseHtml(new TextEncoder().encode(result.value), fileName);
  return {
    text: parsed.text,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    metadata: { fileName, parserId: 'mammoth', warnings: result.messages.map((item) => item.message) },
  };
}

async function parseXlsx(buf: Uint8Array, fileName: string): Promise<ParsedDocument> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(buf) as unknown as ExcelJS.Buffer);
  const sheets: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow((row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : Object.values(row.values);
      rows.push(values.map((value) => String(value ?? '')).join('\t'));
    });
    sheets.push(`# ${sheet.name}\n${rows.join('\n')}`);
  });
  return {
    text: sheets.join('\n\n').trim(),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    metadata: { fileName, parserId: 'exceljs', sheetCount: workbook.worksheets.length },
  };
}
