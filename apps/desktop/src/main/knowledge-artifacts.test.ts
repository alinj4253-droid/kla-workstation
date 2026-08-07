import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() },
}));

vi.mock('./paths', () => ({
  getProjectRoot: (scopeId: string) => join(process.cwd(), scopeId),
  getStudioRoot: () => process.cwd(),
}));

import { buildVisualizationData, renderGraphHtml } from './knowledge-artifacts';

const templatePath = join(
  process.cwd(),
  'resources',
  'agent-definitions',
  'built-in',
  'builtin.knowledge-manager',
  '1.0.0',
  'skills',
  'graph-projection',
  'assets',
  'knowledge-graph.template.html',
);

describe('knowledge graph report template', () => {
  it('injects graph data into the single fixed placeholder without a CDN', async () => {
    const template = await readFile(templatePath, 'utf8');
    const data = buildVisualizationData(
      [
        { id: 'n1', nodeType: 'organization', canonicalName: '擎洲光电', summary: '核心公司', confidence: 0.96 },
        { id: 'n2', nodeType: 'person', canonicalName: '负责人', summary: '公司负责人', confidence: 0.88 },
      ],
      [{ id: 'e1', sourceNodeId: 'n2', targetNodeId: 'n1', edgeType: 'belongs_to', confidence: 0.9 }],
      [{ sourceId: 's1', fileName: '审计报告.pdf', summary: null, keywordsJson: null, tagsJson: null, language: 'zh', metadataJson: null }],
      new Date('2026-08-07T04:00:00.000Z'),
    );

    const html = renderGraphHtml(template, 'window.echarts={};', data);
    expect(template.match(/__KUNQING_GRAPH_DATA__/g)).toHaveLength(1);
    expect(html).not.toContain('__KUNQING_GRAPH_DATA__');
    expect(html).not.toContain('__KUNQING_ECHARTS_RUNTIME__');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('审计报告知识图谱');
    expect(html).toContain('组织机构');
    expect(html).toContain('属于');
    expect(data.coreNodeId).toBe('n1');
  });

  it('rejects a template whose data contract is missing or duplicated', () => {
    const minimalData = buildVisualizationData([], [], [], new Date('2026-08-07T04:00:00.000Z'));
    expect(() => renderGraphHtml('<html></html>', '', minimalData)).toThrow('数据占位符数量错误');
    expect(() => renderGraphHtml('__KUNQING_GRAPH_DATA____KUNQING_GRAPH_DATA____KUNQING_ECHARTS_RUNTIME__', '', minimalData)).toThrow('数据占位符数量错误');
  });
});
