import type { DocumentContent } from '@kla-workstation/contracts/knowledge';

// Reading pages are bounded even when the service returns a very long paragraph.
// Keep code points intact and prefer an existing line break near the page edge.
export function readingPages(pages: readonly DocumentContent[]) {
  return pages.flatMap(page => {
    const text = Array.from(page.paragraphs.join('\n\n'));
    const result: { content: string; para: number; returned: number; total: number }[] = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + 900, text.length);
      if (end < text.length) {
        const breakAt = text.slice(start + 600, end).lastIndexOf('\n');
        if (breakAt >= 0) end = start + 600 + breakAt + 1;
      }
      const lineEnds = text.slice(start, end).flatMap((char, index) => char === '\n' ? [index] : []);
      if (lineEnds.length >= 18) end = start + lineEnds[17]! + 1;
      result.push({ content: text.slice(start, end).join(''), para: page.para, returned: page.returned, total: page.total_paragraphs });
      start = end;
    }
    return result;
  });
}
