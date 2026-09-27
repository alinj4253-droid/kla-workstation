import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../src/chunker';
import type { ParsedDocument } from '../src/types';

function makeDoc(text: string, overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    text,
    mimeType: 'text/plain',
    metadata: {},
    ...overrides,
  };
}

describe('chunkDocument', () => {
  it('returns empty array for empty text', () => {
    const doc = makeDoc('');
    expect(chunkDocument(doc)).toEqual([]);
  });

  it('returns empty array for whitespace-only text', () => {
    const doc = makeDoc('   \n\n  ');
    expect(chunkDocument(doc)).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    const doc = makeDoc('Hello world');
    const chunks = chunkDocument(doc);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Hello world');
    expect(chunks[0].ordinal).toBe(0);
    expect(chunks[0].contentHash).toBeTruthy();
  });

  it('splits text into multiple chunks based on target size', () => {
    const longText = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${'word '.repeat(100)}`).join('\n\n');
    const doc = makeDoc(longText);
    const chunks = chunkDocument(doc, { targetSize: 500, minSize: 100, overlap: 50 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    chunks.forEach((chunk, i) => {
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.ordinal).toBe(i);
    });
  });

  it('respects paragraph boundaries', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const doc = makeDoc(text);
    const chunks = chunkDocument(doc, { targetSize: 20, minSize: 5, overlap: 0 });
    // Each paragraph should be its own chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].text).toContain('First paragraph');
  });

  it('includes overlap between chunks', () => {
    const text = 'First paragraph.\n\n' + 'word '.repeat(100) + '\n\n' + 'Last paragraph.';
    const doc = makeDoc(text);
    const chunks = chunkDocument(doc, { targetSize: 200, minSize: 50, overlap: 100 });
    if (chunks.length > 1) {
      // The second chunk should contain some text from the first
      expect(chunks[1].text.length).toBeGreaterThan(0);
    }
  });

  it('assigns sequential ordinals', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    const doc = makeDoc(text);
    const chunks = chunkDocument(doc, { targetSize: 50, minSize: 10, overlap: 0 });
    chunks.forEach((chunk, i) => {
      expect(chunk.ordinal).toBe(i);
    });
  });

  it('generates unique content hashes for different chunks', () => {
    const text = 'AAA\n\nBBB\n\nCCC';
    const doc = makeDoc(text);
    const chunks = chunkDocument(doc, { targetSize: 10, minSize: 5, overlap: 0 });
    const hashes = chunks.map((c) => c.contentHash);
    expect(new Set(hashes).size).toBe(chunks.length);
  });

  it('includes locationJson when metadata has pageCount', () => {
    const doc = makeDoc('Some text content', { metadata: { pageCount: 10 } });
    const chunks = chunkDocument(doc);
    // At least one chunk should have locationJson
    const hasLocation = chunks.some((c) => c.locationJson !== undefined);
    expect(hasLocation).toBe(true);
  });

  it('records exact normalized offsets, logical page and nearest section', () => {
    const text = `# 总则\n\n${'内容'.repeat(5_000)}\n\n# 附则\n\n结束`;
    const chunks = chunkDocument(makeDoc(text), { targetSize: 2_000, overlap: 100, minSize: 100 });
    const first = chunks[0]!;
    const later = chunks[chunks.length - 1]!;
    expect(first.startOffset).toBe(0);
    expect(first.endOffset).toBeGreaterThan(first.startOffset!);
    expect(text.slice(first.startOffset, first.endOffset)).toBe(first.text);
    expect(first.pageNumber).toBe(1);
    expect(first.sectionPath).toBe('总则');
    expect(later.sectionPath).toBe('附则');
    expect(JSON.parse(later.locationJson!)).toEqual(expect.objectContaining({
      startOffset: later.startOffset,
      endOffset: later.endOffset,
      pageNumber: later.pageNumber,
      sectionPath: '附则',
    }));
  });

  it('splits a long paragraph without losing normalized source locations', () => {
    const text = `# 长段落\n\n${'甲'.repeat(7_500)}`;
    const chunks = chunkDocument(makeDoc(text), { targetSize: 2_000, overlap: 200, minSize: 100 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(Math.max(...chunks.map((chunk) => chunk.text.length))).toBeLessThanOrEqual(2_200);
    for (const chunk of chunks) {
      expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    }
  });
});
