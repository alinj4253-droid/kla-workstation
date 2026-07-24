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

/**
 * Split parsed document text into overlapping chunks.
 * Uses paragraph/sentence boundaries for natural splits.
 */
export function chunkDocument(doc: ParsedDocument, options: ChunkerOptions = {}): Chunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { text } = doc;

  if (!text || text.trim().length === 0) return [];

  // Split into paragraphs first
  const paragraphs = splitParagraphs(text);
  const chunks: Chunk[] = [];
  let currentChunk = '';
  let ordinal = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // If adding this paragraph would exceed target size, emit current chunk
    if (currentChunk && (currentChunk.length + trimmed.length) > opts.targetSize) {
      // If current chunk is too small, keep adding
      if (currentChunk.length < opts.minSize) {
        currentChunk += '\n\n' + trimmed;
        continue;
      }

      chunks.push(makeChunk(currentChunk.trim(), ordinal++, doc.metadata));
      // Start new chunk with overlap from previous
      currentChunk = getOverlap(currentChunk, opts.overlap) + '\n\n' + trimmed;
    } else {
      currentChunk = currentChunk ? currentChunk + '\n\n' + trimmed : trimmed;
    }
  }

  // Emit the last chunk
  if (currentChunk.trim()) {
    chunks.push(makeChunk(currentChunk.trim(), ordinal++, doc.metadata));
  }

  return chunks;
}

function makeChunk(text: string, ordinal: number, metadata: ParsedDocument['metadata']): Chunk {
  const chunk: Chunk = {
    ordinal,
    text,
    contentHash: hashContent(text),
  };
  if (metadata.pageCount) {
    chunk.locationJson = JSON.stringify({ page: Math.floor(ordinal / 2) + 1 });
  }
  return chunk;
}

function splitParagraphs(text: string): string[] {
  // Split on double newlines (paragraph boundaries)
  return text.split(/\n\s*\n/).filter(Boolean);
}

function getOverlap(text: string, overlapSize: number): string {
  if (text.length <= overlapSize) return text;
  // Take the last `overlapSize` characters, starting from a word boundary
  const suffix = text.slice(-overlapSize);
  const wordBoundary = suffix.search(/[\s\n]/);
  return wordBoundary > 0 ? suffix.slice(wordBoundary + 1) : suffix;
}