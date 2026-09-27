import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { app } from 'electron';
import { getEnterpriseProjectRoot, getEnterpriseWorkspaceRoot, getProjectRoot, getStudioRoot } from './paths';

const GRAPH_DATA_PLACEHOLDER = '__KUNQING_GRAPH_DATA__';
const GRAPH_RUNTIME_PLACEHOLDER = '__KUNQING_ECHARTS_RUNTIME__';
const GRAPH_SKILL_ASSET_PARTS = [
  'agent-definitions',
  'built-in',
  'builtin.knowledge-manager',
  '1.0.0',
  'skills',
  'graph-projection',
  'assets',
] as const;

const GRAPH_COLORS = [
  '#FF6B35', '#2E86AB', '#A23B72', '#F18F01', '#02C07A', '#8E44AD',
  '#3498DB', '#E74C3C', '#27AE60', '#16A085', '#E67E22',
] as const;

const NODE_TYPE_NAMES: Record<string, string> = {
  company: '公司实体',
  concept: '概念',
  document: '文档',
  organization: '组织机构',
  other: '其他实体',
  person: '人物',
  process: '业务流程',
  protocol: '规范协议',
  technology: '技术',
  tool: '工具',
};

const EDGE_TYPE_NAMES: Record<string, string> = {
  belongs_to: '属于',
  communicates_with: '交互',
  contains: '包含',
  depends_on: '依赖',
  implements: '实现',
  precedes: '前置于',
  related_to: '相关',
  uses: '使用',
};

export type GraphNodeRow = {
  id: string;
  nodeType: string;
  canonicalName: string;
  summary: string | null;
  confidence: number;
};

export type GraphEdgeRow = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: string;
  confidence: number;
};

export type DocumentProfileRow = {
  sourceId: string;
  fileName: string | null;
  summary: string | null;
  keywordsJson: string | null;
  tagsJson: string | null;
  language: string | null;
  metadataJson: string | null;
};

export type VisualizationData = {
  title: string;
  subtitle: string;
  source: string;
  panelTitle: string;
  footer: string;
  coreNodeId: string;
  stats: Array<{ value: string; label: string }>;
  categories: Array<{ id: string; name: string; color: string }>;
  nodes: Array<{
    id: string;
    label: string;
    category: string;
    size: number;
    details: string;
    confidence: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    label: string;
    weight: number;
  }>;
};

const safeJson = (value: unknown): string => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => ({
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}[char] ?? char));

const displayTypeName = (value: string, dictionary: Record<string, string>): string => dictionary[value]
  ?? value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());

const resolveGraphAsset = (fileName: string): string => {
  const relativeParts = [...GRAPH_SKILL_ASSET_PARTS, fileName];
  const candidates = [
    join(getStudioRoot(), ...relativeParts),
    join(process.resourcesPath, 'resources', ...relativeParts),
    join(app.getAppPath(), 'resources', ...relativeParts),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) throw new Error(`图谱模板资源缺失：${fileName}`);
  return resolved;
};

export const buildVisualizationData = (
  nodes: GraphNodeRow[],
  edges: GraphEdgeRow[],
  documents: DocumentProfileRow[],
  generatedAt: Date,
): VisualizationData => {
  const typeCounts = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const node of nodes) {
    typeCounts.set(node.nodeType, (typeCounts.get(node.nodeType) ?? 0) + 1);
    degree.set(node.id, 0);
  }
  for (const edge of edges) {
    degree.set(edge.sourceNodeId, (degree.get(edge.sourceNodeId) ?? 0) + 1);
    degree.set(edge.targetNodeId, (degree.get(edge.targetNodeId) ?? 0) + 1);
  }

  const sortedTypes = [...typeCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const categories = sortedTypes.map(([type], index) => ({
    id: type,
    name: displayTypeName(type, NODE_TYPE_NAMES),
    color: GRAPH_COLORS[index % GRAPH_COLORS.length] ?? GRAPH_COLORS[0],
  }));
  if (categories.length === 0) categories.push({ id: 'other', name: NODE_TYPE_NAMES.other ?? '其他实体', color: GRAPH_COLORS[0] });

  const maxDegree = Math.max(1, ...degree.values());
  const visualizationNodes = nodes.map((node) => {
    const nodeDegree = degree.get(node.id) ?? 0;
    const confidence = Number.isFinite(node.confidence) ? node.confidence : 0;
    const details = [
      node.summary ? `摘要：${node.summary}` : '',
      `关联关系：${nodeDegree} 条`,
      `置信度：${Math.round(confidence * 100)}%`,
    ].filter(Boolean).join('\n');
    return {
      id: node.id,
      label: node.canonicalName,
      category: node.nodeType,
      size: Math.round(28 + Math.sqrt(nodeDegree / maxDegree) * 58),
      details,
      confidence,
    };
  });
  const visualizationEdges = edges.map((edge) => ({
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    label: displayTypeName(edge.edgeType, EDGE_TYPE_NAMES),
    weight: Math.max(2, Math.round((Number.isFinite(edge.confidence) ? edge.confidence : 0.5) * 10)),
  }));

  const fileNames = [...new Set(documents.map((document) => document.fileName).filter((name): name is string => Boolean(name)))];
  const sourceTitle = fileNames.length === 1
    ? basename(fileNames[0]!, extname(fileNames[0]!))
    : fileNames.length > 1 ? '群聊资料' : '本地知识库';
  const title = `${sourceTitle}知识图谱`;
  const sourceSummary = fileNames.length > 0 ? fileNames.slice(0, 4).join('、') + (fileNames.length > 4 ? `等${fileNames.length}份文件` : '') : '本地知识库';
  const generatedText = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(generatedAt);
  const averageConfidence = nodes.length > 0
    ? Math.round(nodes.reduce((sum, node) => sum + (Number.isFinite(node.confidence) ? node.confidence : 0), 0) / nodes.length * 100)
    : 0;
  const leadingType = sortedTypes[0];
  const coreNodeId = [...degree.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? nodes[0]?.id ?? '';

  return {
    title,
    subtitle: `基于${fileNames.length}份本地资料 · 完整实体关系可视化 · ${nodes.length}节点 / ${edges.length}关系`,
    source: `数据来源：${sourceSummary} | 生成时间：${generatedText}`,
    panelTitle: '完整知识图谱',
    footer: `${title} · 数据来源：${sourceSummary} · 自动生成`,
    coreNodeId,
    stats: [
      { value: String(nodes.length), label: '实体节点' },
      { value: String(edges.length), label: '关系边' },
      { value: String(fileNames.length), label: '资料文件' },
      { value: String(categories.length), label: '实体类型' },
      { value: String(leadingType?.[1] ?? 0), label: leadingType ? displayTypeName(leadingType[0], NODE_TYPE_NAMES) : '主要实体' },
      { value: `${averageConfidence}%`, label: '平均置信度' },
    ],
    categories,
    nodes: visualizationNodes,
    edges: visualizationEdges,
  };
};

export const renderGraphHtml = (template: string, runtime: string, data: VisualizationData): string => {
  const dataPlaceholderCount = template.split(GRAPH_DATA_PLACEHOLDER).length - 1;
  const runtimePlaceholderCount = template.split(GRAPH_RUNTIME_PLACEHOLDER).length - 1;
  if (dataPlaceholderCount !== 1) throw new Error(`图谱模板数据占位符数量错误：${dataPlaceholderCount}`);
  if (runtimePlaceholderCount !== 1) throw new Error(`图谱模板运行库占位符数量错误：${runtimePlaceholderCount}`);
  const safeRuntime = runtime.replace(/<\/script/gi, '<\\/script');
  return template
    .replace(GRAPH_RUNTIME_PLACEHOLDER, safeRuntime)
    .replace(GRAPH_DATA_PLACEHOLDER, safeJson(data));
};

function wikiHtml(pages: Array<{ slug: string; title: string; bodyMd: string | null }>): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知识 Wiki</title><style>
*{box-sizing:border-box}body{margin:0;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;color:#252932;background:#fff}.layout{display:grid;grid-template-columns:250px 1fr;height:100vh}aside{padding:18px;border-right:1px solid #e7e9ee;background:#f8f9fb;overflow:auto}input{width:100%;height:34px;border:1px solid #d9dde5;border-radius:6px;padding:0 10px;margin:12px 0}.item{display:block;width:100%;border:0;background:none;text-align:left;padding:8px;border-radius:5px;cursor:pointer}.item:hover,.item.active{background:#e9eefb;color:#1d4ed8}main{padding:30px 42px;overflow:auto;max-width:980px}pre{white-space:pre-wrap;font:inherit}h1{font-size:24px}</style></head><body><div class="layout"><aside><strong>知识 Wiki</strong><input id="q" placeholder="搜索条目"><div id="list"></div></aside><main><h1 id="title">选择一个条目</h1><pre id="body"></pre></main></div><script>
const pages=${safeJson(pages)};const list=document.getElementById('list'),q=document.getElementById('q'),title=document.getElementById('title'),body=document.getElementById('body');function render(filter=''){list.innerHTML='';pages.filter(p=>(p.title+' '+p.bodyMd).toLowerCase().includes(filter.toLowerCase())).forEach((p,i)=>{const b=document.createElement('button');b.className='item';b.textContent=p.title;b.onclick=()=>{document.querySelectorAll('.item').forEach(x=>x.classList.remove('active'));b.classList.add('active');title.textContent=p.title;body.textContent=p.bodyMd||''};list.append(b);if(i===0&&!body.textContent)b.click()})}q.oninput=()=>render(q.value);render();</script></body></html>`;
}

export async function materializeKnowledgeArtifacts(db: Database.Database, scopeType: string, scopeId: string): Promise<void> {
  let enterpriseProject = false;
  if (scopeType === 'project') {
    try { enterpriseProject = !!db.prepare('SELECT 1 FROM enterprise_projects WHERE id = ?').get(scopeId); } catch { /* legacy database */ }
  }
  const root = scopeType === 'shared'
    ? getEnterpriseWorkspaceRoot()
    : enterpriseProject
      ? getEnterpriseProjectRoot(scopeId)
      : getProjectRoot(scopeId);
  const nodes = db.prepare(
    'SELECT id, node_type as nodeType, canonical_name as canonicalName, summary, confidence FROM knowledge_nodes WHERE scope_type = ? AND scope_id = ?',
  ).all(scopeType, scopeId) as GraphNodeRow[];
  const edges = db.prepare(
    'SELECT id, source_node_id as sourceNodeId, target_node_id as targetNodeId, edge_type as edgeType, confidence FROM knowledge_edges WHERE scope_type = ? AND scope_id = ?',
  ).all(scopeType, scopeId) as GraphEdgeRow[];
  const pages = db.prepare(
    'SELECT slug, title, body_md as bodyMd FROM wiki_pages WHERE scope_type = ? AND scope_id = ? ORDER BY title',
  ).all(scopeType, scopeId) as Array<{ slug: string; title: string; bodyMd: string | null }>;
  const documents = db.prepare(
    `SELECT p.source_id as sourceId, f.name as fileName, p.summary, p.keywords_json as keywordsJson,
            p.tags_json as tagsJson, p.language, p.metadata_json as metadataJson
     FROM knowledge_document_profiles p JOIN knowledge_sources s ON s.id = p.source_id
     LEFT JOIN files f ON f.id = s.file_id WHERE s.scope_type = ? AND s.scope_id = ? AND s.status = 'ready'`,
  ).all(scopeType, scopeId) as DocumentProfileRow[];
  const graphDir = join(root, 'graph-visualization');
  const wikiDir = join(root, 'knowledge', 'wiki');
  const knowledgeDir = join(root, 'knowledge');
  await Promise.all([mkdir(graphDir, { recursive: true }), mkdir(wikiDir, { recursive: true }), mkdir(knowledgeDir, { recursive: true })]);

  const templatePath = resolveGraphAsset('knowledge-graph.template.html');
  const runtimePath = resolveGraphAsset('echarts.min.js');
  const [template, graphRuntime] = await Promise.all([
    readFile(templatePath, 'utf8'),
    readFile(runtimePath, 'utf8'),
  ]);
  const generatedAt = new Date();
  const visualization = buildVisualizationData(nodes, edges, documents, generatedAt);
  await Promise.all([
    writeFile(join(graphDir, 'knowledge-graph.html'), renderGraphHtml(template, graphRuntime, visualization), 'utf8'),
    copyFile(runtimePath, join(graphDir, 'echarts.min.js')),
    writeFile(join(graphDir, 'knowledge-graph.json'), JSON.stringify({ nodes, edges, visualization, generatedAt: generatedAt.toISOString() }, null, 2), 'utf8'),
    writeFile(join(wikiDir, 'index.html'), wikiHtml(pages), 'utf8'),
    writeFile(join(knowledgeDir, 'knowledge-index.json'), JSON.stringify({ documents, generatedAt: generatedAt.toISOString() }, null, 2), 'utf8'),
  ]);
}
