export type TextLocation = { kind: 'found'; page: number; partial?: boolean } | { kind: 'missing' | 'ambiguous' };
// Ignore whitespace and common Markdown presentation marks removed by slicing. No fuzzy matching,
// title guessing, or interpretation of slice IDs as paragraph positions.
function comparable(text: string): string {
  return text.replace(/\*\*|__|`/gu, '').replace(/^\s*(?:#{1,6}|[-+*])\s+/gmu, '').replace(/\s+/gu, '');
}
export function locateTextPage(pages: readonly { content: string }[], target: string): TextLocation {
  const needle = comparable(target);
  if (!needle) return { kind: 'missing' };
  const texts = pages.map(page => comparable(page.content));
  const text = texts.join('');
  let start = text.indexOf(needle);
  let partial = false;
  if (start < 0) {
    // Cleaned slices may rewrite introductions. Require multiple long, exact,
    // unique anchors in the same order and local range, never just a title/ID.
    const anchors = target.split(/[。！？\n：:]/u).map(comparable).filter(part => part.length >= 12);
    const matches = anchors.flatMap(anchor => {
      const at = text.indexOf(anchor);
      return at >= 0 && text.indexOf(anchor, at + 1) < 0 ? [{ at, length: anchor.length }] : [];
    });
    if (matches.length < 2 || matches.reduce((size, match) => size + match.length, 0) < 28
      || matches.some((match, index) => index > 0 && match.at < matches[index - 1]!.at + matches[index - 1]!.length)
      || matches.at(-1)!.at + matches.at(-1)!.length - matches[0]!.at > Math.max(300, needle.length * 2)) return { kind: 'missing' };
    start = matches[0]!.at;
    partial = true;
  } else if (text.indexOf(needle, start + 1) >= 0) return { kind: 'ambiguous' };
  let offset = 0;
  for (let page = 0; page < texts.length; page++) {
    offset += texts[page]!.length;
    if (offset > start) return { kind: 'found', page, ...(partial ? { partial } : {}) };
  }
  return { kind: 'missing' };
}
