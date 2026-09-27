import type { Chunk, ParsedDocument } from './types.js';
import { hashContent } from './types.js';

export interface ChunkerOptions {
  /** Target chunk size in characters (default: 2000) */
  targetSize?: number;
  /** Overlap between consecutive chunks in characters (default: 400) */
  overlap?: number;
  /** Minimum chunk size - below this, chunks are merged (default: 200) */
  minSize?: number;
}

const DEFAULT_OPTIONS: Required<ChunkerOptions> = {
  targetSize: 2000,
  overlap: 400,
  minSize: 200,
};

const LOGICAL_PAGE_SIZE = 8_000;

type TextRange = { start: number; end: number };
type SectionRange = TextRange & { title: string };

/**
 * Split parsed document text into overlapping chunks.
 * Uses paragraph/sentence boundaries for natural splits.
 */
export function chunkDocument(doc: ParsedDocument, options: ChunkerOptions = {}): Chunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { text } = doc;

  if (!text || text.trim().length === 0) return [];

  // Split into paragraphs first
  const paragraphs = splitParagraphs(text, opts.targetSize);
  const sections = findSections(text);
  const chunks: Chunk[] = [];
  let currentStart = -1;
  let currentEnd = -1;
  let ordinal = 0;

  for (const para of paragraphs) {
    if (currentStart >= 0 && (para.end - currentStart) > opts.targetSize) {
      // If current chunk is too small, keep adding
      if ((currentEnd - currentStart) < opts.minSize) {
        currentEnd = para.end;
        continue;
      }

      chunks.push(makeChunk(text, currentStart, currentEnd, ordinal++, doc.metadata, sections));
      currentStart = overlapStart(text, currentStart, currentEnd, opts.overlap);
      currentEnd = para.end;
    } else {
      if (currentStart < 0) currentStart = para.start;
      currentEnd = para.end;
    }
  }

  // Emit the last chunk
  if (currentStart >= 0 && currentEnd > currentStart) {
    chunks.push(makeChunk(text, currentStart, currentEnd, ordinal++, doc.metadata, sections));
  }

  return chunks;
}

function makeChunk(
  sourceText: string,
  rawStart: number,
  rawEnd: number,
  ordinal: number,
  metadata: ParsedDocument['metadata'],
  sections: SectionRange[],
): Chunk {
  let startOffset = rawStart;
  let endOffset = rawEnd;
  while (startOffset < endOffset && /\s/.test(sourceText[startOffset]!)) startOffset++;
  while (endOffset > startOffset && /\s/.test(sourceText[endOffset - 1]!)) endOffset--;
  const text = sourceText.slice(startOffset, endOffset);
  let sourcePageIndex = -1;
  for (let index = 0; index < (metadata.pageOffsets?.length ?? 0); index++) {
    if (metadata.pageOffsets![index]! <= startOffset) sourcePageIndex = index;
    else break;
  }
  const pageNumber = sourcePageIndex >= 0 ? sourcePageIndex + 1 : Math.floor(startOffset / LOGICAL_PAGE_SIZE) + 1;
  let sectionPath: string | undefined;
  for (const section of sections) {
    if (section.start < endOffset) sectionPath = section.title;
    else break;
  }
  const location = {
    startOffset,
    endOffset,
    pageNumber,
    pageKind: sourcePageIndex >= 0 ? 'source' : 'logical',
    ...(sectionPath ? { sectionPath } : {}),
  };
  const chunk: Chunk = {
    ordinal,
    text,
    contentHash: hashContent(text),
    startOffset,
    endOffset,
    pageNumber,
    locationJson: JSON.stringify(location),
  };
  if (sectionPath) chunk.sectionPath = sectionPath;
  return chunk;
}

function splitParagraphs(text: string, maxSize: number): TextRange[] {
  const ranges: TextRange[] = [];
  const separator = /\n\s*\n/g;
  let start = 0;
  for (const match of text.matchAll(separator)) {
    const end = match.index;
    if (text.slice(start, end).trim()) ranges.push(...splitOversizedRange(text, { start, end }, maxSize));
    start = end + match[0].length;
  }
  if (text.slice(start).trim()) ranges.push(...splitOversizedRange(text, { start, end: text.length }, maxSize));
  return ranges;
}

function splitOversizedRange(text: string, range: TextRange, maxSize: number): TextRange[] {
  if ((range.end - range.start) <= maxSize) return [range];
  const ranges: TextRange[] = [];
  let start = range.start;
  while ((range.end - start) > maxSize) {
    const hardEnd = start + maxSize;
    const naturalStart = start + Math.floor(maxSize * 0.6);
    const window = text.slice(naturalStart, hardEnd);
    let boundary = -1;
    for (const match of window.matchAll(/[。！？!?；;\n]/g)) boundary = naturalStart + match.index + match[0].length;
    if (boundary <= start) {
      const whitespace = window.search(/\s(?=\S*$)/);
      if (whitespace >= 0) boundary = naturalStart + whitespace + 1;
    }
    const end = boundary > start ? boundary : hardEnd;
    ranges.push({ start, end });
    start = end;
  }
  if (start < range.end) ranges.push({ start, end: range.end });
  return ranges;
}

function overlapStart(text: string, start: number, end: number, overlapSize: number): number {
  if (overlapSize <= 0) return end;
  const candidate = Math.max(start, end - overlapSize);
  const boundary = text.slice(candidate, end).search(/[\s\n]/);
  return boundary >= 0 ? candidate + boundary + 1 : candidate;
}

function findSections(text: string): SectionRange[] {
  const matches = [...text.matchAll(/^(?:#{1,6}\s+.+|第[^\n]{1,30}[章节篇]|[一二三四五六七八九十]+、[^\n]+|\d+(?:\.\d+)*[.、]?\s+[^\n]+)$/gm)];
  return matches.map((match, index) => ({
    title: match[0].replace(/^#{1,6}\s+/, '').trim().slice(0, 160),
    start: match.index,
    end: matches[index + 1]?.index ?? text.length,
  }));
}
