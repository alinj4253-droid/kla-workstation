const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Preserve a generated HTML document instead of displaying its source as text. */
export function htmlArtifactContent(title: string, answer: string): string {
  const fenced = answer.match(/(?:^|\n)```html\s*\n([\s\S]*?)\n```/i)?.[1]?.trim();
  const candidate = fenced ?? answer.trim();
  if (/^(?:<!doctype\s+html\b[^>]*>\s*)?<html\b/i.test(candidate) && /<\/html>\s*$/i.test(candidate)) return candidate;
  if (fenced) return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(title)}</title><body>${fenced}</body></html>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(title)}</title><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(answer).replaceAll('\n', '<br>')}</p><p>生成时间：${new Date().toLocaleString('zh-CN')}</p></body></html>`;
}
