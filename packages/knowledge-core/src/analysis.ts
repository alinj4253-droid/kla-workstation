import type { KnowledgeDocumentProfile } from './types.js';

const STOP_WORDS = new Set([
  '一个', '以及', '因为', '所以', '可以', '进行', '需要', '这个', '这些', '其中', '通过', '对于', '相关',
  'the', 'and', 'for', 'that', 'with', 'from', 'this', 'have', 'will', 'are', 'was', 'were', 'into',
]);

export function analyzeDocumentLocally(text: string, fileName = ''): KnowledgeDocumentProfile {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const chineseCount = (normalized.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinCount = (normalized.match(/[A-Za-z]/g) ?? []).length;
  const language = chineseCount === 0 && latinCount === 0
    ? 'unknown'
    : chineseCount > latinCount * 2
      ? 'zh'
      : latinCount > chineseCount * 2
        ? 'en'
        : 'mixed';

  const sentences = normalized.split(/(?<=[。！？.!?])\s*/).filter((item) => item.length >= 12);
  const summary = (sentences.slice(0, 3).join(' ') || normalized).slice(0, 600);
  const frequencies = new Map<string, number>();
  const english = normalized.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  const chineseRuns = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const chineseTerms = chineseRuns.flatMap((run) => {
    if (run.length <= 6) return [run];
    const terms: string[] = [];
    for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + Math.min(4, run.length - i)));
    return terms;
  });
  for (const term of [...english, ...chineseTerms]) {
    if (STOP_WORDS.has(term) || term.length < 2) continue;
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  const keywords = [...frequencies.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
    .slice(0, 16)
    .map(([term]) => term);
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : undefined;
  const tags = [...new Set([extension ? `格式:${extension}` : '', `语言:${language}`, ...keywords.slice(0, 6)])].filter(Boolean);
  return { summary, keywords, tags, language };
}
