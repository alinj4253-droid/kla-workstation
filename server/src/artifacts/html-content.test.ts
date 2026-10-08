import { describe, expect, it } from 'vitest';
import { htmlArtifactContent } from './html-content.js';

describe('HTML artifact content', () => {
  it('renders a complete generated report rather than escaping it', () => {
    const document = '<!DOCTYPE html><html lang="zh-CN"><body><h1>蓝鲸项目报告</h1></body></html>';
    expect(htmlArtifactContent('报告', `以下是报告：\n\n\`\`\`html\n${document}\n\`\`\`\n可在右侧查看。`)).toBe(document);
    expect(htmlArtifactContent('报告', document)).toBe(document);
  });

  it('wraps a fenced HTML fragment in a document', () => {
    const content = htmlArtifactContent('报告', '```html\n<h1>蓝鲸</h1><p>负责人：小林</p>\n```');
    expect(content).toContain('<body><h1>蓝鲸</h1>');
    expect(content).not.toContain('```');
  });

  it('keeps ordinary text and filenames from becoming HTML markup', () => {
    const content = htmlArtifactContent('<img src=x>', '结论：\nA < B & C > D');
    expect(content).toContain('<title>&lt;img src=x&gt;</title>');
    expect(content).toContain('结论：<br>A &lt; B &amp; C &gt; D');
  });
});
