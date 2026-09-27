import type Database from 'better-sqlite3';
import { LocalOcrService } from './local-ocr';
import { hasBochaApiKey } from './bocha-web-search';

export type BuiltinToolStatus = 'ready' | 'optional' | 'disabled';

export type BuiltinToolInfo = {
  id: string;
  name: string;
  description: string;
  category: '解析' | 'OCR' | '向量' | '检索' | '知识资产';
  enabled: boolean;
  status: BuiltinToolStatus;
  statusText: string;
  isBuiltin: true;
  config: Record<string, string>;
};

export const isBuiltinToolEnabled = (db: Database.Database, id: string, defaultValue = true): boolean => {
  try {
    const row = db.prepare('SELECT value_json as valueJson FROM settings WHERE key = ?').get(`builtin-tool:${id}`) as { valueJson: string } | undefined;
    if (!row) return defaultValue;
    return Boolean((JSON.parse(row.valueJson) as { enabled?: boolean }).enabled);
  } catch {
    return defaultValue;
  }
};

export async function listBuiltinTools(db: Database.Database): Promise<BuiltinToolInfo[]> {
  const ocr = await new LocalOcrService().status();
  const definitions: Array<Omit<BuiltinToolInfo, 'enabled'>> = [
    { id: 'tool.bocha-web-search', name: '博查网页搜索', description: '通过博查 API 搜索公开网页，返回带来源链接和摘要的资料，供资料调研智能体使用。', category: '检索', status: hasBochaApiKey(db) ? 'ready' : 'optional', statusText: hasBochaApiKey(db) ? '已配置并可用' : '等待配置 API Key', isBuiltin: true, config: { endpoint: 'https://api.bocha.cn/v1/web-search', scope: '公开网页' } },
    { id: 'tool.document-parser', name: '本地文档解析器', description: '解析 TXT、Markdown、HTML、JSON、CSV、PDF、DOCX 和 XLSX，不上传原始文件。', category: '解析', status: 'ready', statusText: '已就绪', isBuiltin: true, config: { formats: 'TXT / MD / HTML / PDF / DOCX / XLSX', runtime: 'Node.js' } },
    { id: 'tool.paddle-ocr', name: 'PaddleOCR 本地模型包', description: '识别图片与扫描件文字，仅在常规解析无法获得正文时调用。', category: 'OCR', status: ocr.available ? 'ready' : 'optional', statusText: ocr.detail, isBuiltin: true, config: { runtime: 'PaddleOCR CLI', dataPolicy: '仅本地' } },
    { id: 'tool.local-embedding', name: '本地向量化引擎', description: '生成 384 维多语言离线向量；可无缝替换为 BGE-small-zh ONNX 模型包。', category: '向量', status: 'ready', statusText: '内置基础模型已就绪', isBuiltin: true, config: { model: 'kunqing-feature-hash-multilingual-v1', dimensions: '384' } },
    { id: 'tool.sqlite-vector-index', name: 'SQLite 本地向量索引', description: '在 K_Studio 数据库中保存切片向量并执行余弦相似度排序。', category: '向量', status: 'ready', statusText: '已就绪', isBuiltin: true, config: { storage: 'SQLite', metric: 'cosine' } },
    { id: 'tool.fts5-search', name: 'FTS5 全文检索', description: '对知识切片执行精确词语与原文检索。', category: '检索', status: 'ready', statusText: '已就绪', isBuiltin: true, config: { engine: 'SQLite FTS5' } },
    { id: 'tool.hybrid-retriever', name: '混合检索与融合排序', description: '根据问题动态融合全文、向量、图谱和 Wiki，并返回来源证据。', category: '检索', status: 'ready', statusText: '已就绪', isBuiltin: true, config: { fusion: 'Weighted RRF', scopes: '个人 + 关联项目 + 企业工作区' } },
    { id: 'tool.knowledge-assets', name: '图谱与 Wiki 生成器', description: '生成本地图谱、Wiki、JSON 索引及无需外部 CDN 的 HTML 可视化。', category: '知识资产', status: 'ready', statusText: '已就绪', isBuiltin: true, config: { graph: 'JSON + HTML', wiki: 'Markdown + HTML' } },
  ];
  return definitions.map((tool) => ({ ...tool, enabled: isBuiltinToolEnabled(db, tool.id, tool.status === 'ready') }));
}

export function setBuiltinToolEnabled(db: Database.Database, toolId: string, enabled: boolean): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(`builtin-tool:${toolId}`, JSON.stringify({ enabled }), now);
}
