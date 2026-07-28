import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { StateGraph, END, Annotation } from '@langchain/langgraph';
import { KnowledgeRepository, FileRepository } from '@kunqing/database';
import {
  parseDocument,
  chunkDocument,
  hashContent,
  slugify,
} from '@kunqing/knowledge-core';
import type {
  Chunk,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractedGraph,
  GeneratedWikiPage,
  ParsedDocument,
} from '@kunqing/knowledge-core';
import { createPipelineContext } from './knowledge-pipeline-adapter';
import { ModelGateway } from './model-gateway';
import { getLogger } from './logger';

// ─── State ───────────────────────────────────────────────────────────────────

const KnowledgeManagerState = Annotation.Root({
  projectId: Annotation<string>(),
  agentInstanceId: Annotation<string>(),
  runId: Annotation<string>(),
  instruction: Annotation<string>(),
  triggerMessageId: Annotation<string>(),

  // Discovery
  sourceFileId: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  sourceFilePath: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  sourceId: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  scopeType: Annotation<string>({ value: (_a: string, b: string) => b, default: () => 'project' }),
  scopeId: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),

  // Intermediate: parsed text
  parsedText: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  mimeType: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),

  // Intermediate: chunks
  chunks: Annotation<any>({ value: (_a: any, b: any) => b, default: () => [] }),

  // Intermediate: extracted graph
  extractedGraph: Annotation<any>({ value: (_a: any, b: any) => b, default: () => null }),

  // Intermediate: validated entities/relationships
  validatedEntities: Annotation<any>({ value: (_a: any, b: any) => b, default: () => [] }),
  validatedRelationships: Annotation<any>({ value: (_a: any, b: any) => b, default: () => [] }),

  // Intermediate: wiki pages
  wikiPages: Annotation<any>({ value: (_a: any, b: any) => b, default: () => [] }),

  // Intermediate: visualization projection
  visualizationProjection: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),

  // Pipeline results
  pipelineCompleted: Annotation<boolean>({ value: (_a: boolean, b: boolean) => b, default: () => false }),
  entityCount: Annotation<number>({ value: (_a: number, b: number) => b, default: () => 0 }),
  relationshipCount: Annotation<number>({ value: (_a: number, b: number) => b, default: () => 0 }),
  wikiPageCount: Annotation<number>({ value: (_a: number, b: number) => b, default: () => 0 }),

  // Error
  error: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),

  // Final report
  report: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
});

type KMState = {
  projectId: string;
  agentInstanceId: string;
  runId: string;
  instruction: string;
  triggerMessageId: string;
  sourceFileId: string;
  sourceFilePath: string;
  sourceId: string;
  scopeType: string;
  scopeId: string;
  parsedText: string;
  mimeType: string;
  chunks: Chunk[];
  extractedGraph: ExtractedGraph | null;
  validatedEntities: ExtractedEntity[];
  validatedRelationships: ExtractedRelationship[];
  wikiPages: GeneratedWikiPage[];
  visualizationProjection: string;
  pipelineCompleted: boolean;
  entityCount: number;
  relationshipCount: number;
  wikiPageCount: number;
  error: string;
  report: string;
};

// ─── ExecContext ─────────────────────────────────────────────────────────────

export type KMExecContext = {
  db: any;
  gateway: ModelGateway;
  runId: string;
  projectId: string;
  agentInstanceId: string;
  instruction: string;
  triggerMessageId: string;
  signal: AbortSignal;
  workspaceRoot: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LOW_CONFIDENCE_THRESHOLD = 0.65;

function makePipelineCtx(ctx: KMExecContext, state: KMState) {
  return createPipelineContext(
    ctx.db,
    ctx.gateway,
    state.sourceFilePath,
    state.sourceId,
    state.scopeType,
    state.scopeId,
  );
}

// ─── Graph Nodes ─────────────────────────────────────────────────────────────

/**
 * Node 1: discoverSource — 解析指令，找到要处理的源文件
 */
async function discoverSource(state: KMState, config: any): Promise<Partial<KMState>> {
  const ctx = config?.configurable?.ctx as KMExecContext;
  const logger = getLogger();
  const fileRepo = new FileRepository(ctx.db);

  let sourceFileId = '';
  let sourceFilePath = '';
  let sourceId = '';
  let scopeType = 'project';
  let scopeId = ctx.projectId;

  // 1. 检查指令中是否包含文件引用
  const fileIdMatch = ctx.instruction.match(/file[Ii][Dd][:\s]*([a-f0-9]{24})/);
  if (fileIdMatch) {
    const fid = fileIdMatch[1]!;
    try {
      const file = fileRepo.getById(fid);
      if (file && file.status === 'ready') {
        sourceFileId = file.id;
        sourceFilePath = file.normalizedPath;
        logger?.info({ sourceFileId, sourceFilePath }, 'KM: 通过 fileId 发现源文件');
      }
    } catch {
      logger?.warn({ fileId: fid }, 'KM: 未找到 fileId 对应的文件');
    }
  }

  // 2. 检查最近 10 条消息中的附件
  if (!sourceFileId) {
    const recentAttachments = ctx.db.prepare(`
      SELECT ma.file_id as fileId, f.normalized_path as filePath
      FROM message_attachments ma
      JOIN messages m ON m.id = ma.message_id
      JOIN files f ON f.id = ma.file_id
      WHERE m.project_id = ? AND f.status = 'ready'
      ORDER BY m.created_at DESC
      LIMIT 10
    `).all(ctx.projectId) as Array<{ fileId: string; filePath: string }>;

    if (recentAttachments.length > 0) {
      sourceFileId = recentAttachments[0]!.fileId;
      sourceFilePath = recentAttachments[0]!.filePath;
      logger?.info({ sourceFileId, sourceFilePath }, 'KM: 通过最近消息附件发现源文件');
    }
  }

  // 3. 检查 scope
  const sharedMatch = ctx.instruction.match(/shared|共享|全局/);
  if (sharedMatch) {
    scopeType = 'shared';
    scopeId = 'shared';
  }

  // 4. 创建或查找 knowledge_source
  if (sourceFileId) {
    const existingSources = ctx.db.prepare(
      `SELECT id FROM knowledge_sources WHERE scope_type = ? AND scope_id = ? AND file_id = ?`,
    ).all(scopeType, scopeId, sourceFileId) as Array<{ id: string }>;

    if (existingSources.length > 0) {
      sourceId = existingSources[0]!.id;
    } else {
      sourceId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
      const now = new Date().toISOString();
      ctx.db.prepare(
        `INSERT INTO knowledge_sources (id, scope_type, scope_id, file_id, status, ingested_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      ).run(sourceId, scopeType, scopeId, sourceFileId, now);
    }
  }

  const result: Record<string, unknown> = {
    sourceFileId,
    sourceFilePath,
    sourceId,
    scopeType,
    scopeId,
  };

  if (!sourceFileId) {
    result.error = '未找到要处理的源文件。请在指令中指定文件 ID，或先上传文件。';
  }

  return result;
}

/**
 * Node 2: extractText — 抽取文本
 */
async function extractText(state: KMState, config: any): Promise<Partial<KMState>> {
  const ctx = config?.configurable?.ctx as KMExecContext;
  const logger = getLogger();

  if (state.error) return { error: state.error };

  if (!state.sourceFilePath || !existsSync(state.sourceFilePath)) {
    return { error: `源文件不存在: ${state.sourceFilePath}` };
  }

  const pipelineCtx = makePipelineCtx(ctx, state);
  await pipelineCtx.setJobStatus('running', 'parsing', 5);

  try {
    const buf = await pipelineCtx.readFile();
    const doc = await parseDocument(buf, pipelineCtx.fileExt, pipelineCtx.fileName);

    logger?.info({ textLength: doc.text.length, mimeType: doc.mimeType }, 'KM: 文本抽取完成');

    if (!doc.text || doc.text.trim().length < 10) {
      return { parsedText: '', mimeType: doc.mimeType, pipelineCompleted: true, error: '文档内容过短，跳过知识提取' };
    }

    return { parsedText: doc.text, mimeType: doc.mimeType };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error({ err }, 'KM: 文本抽取失败');
    return { error: message };
  }
}

/**
 * Node 3: normalizeAndChunk — 分块
 */
async function normalizeAndChunk(state: KMState, config: any): Promise<Partial<KMState>> {
  const ctx = config?.configurable?.ctx as KMExecContext;
  const logger = getLogger();

  if (state.error) return { error: state.error };
  if (!state.parsedText) return { error: '缺少解析文本，无法分块' };

  const pipelineCtx = makePipelineCtx(ctx, state);
  await pipelineCtx.setJobStatus('running', 'chunking', 15);

  try {
    const doc: ParsedDocument = {
      text: state.parsedText,
      mimeType: state.mimeType || 'text/plain',
      metadata: {},
    };
    const chunks = chunkDocument(doc);
    logger?.info({ total: chunks.length }, 'KM: 分块完成');

    // 去重保存
    let savedCount = 0;
    for (const chunk of chunks) {
      const exists = await pipelineCtx.chunkExistsByHash(chunk.contentHash);
      if (!exists) {
        await pipelineCtx.saveChunk(chunk);
        savedCount++;
      }
    }
    logger?.info({ saved: savedCount, deduped: chunks.length - savedCount }, 'KM: 分块保存完成');

    if (chunks.length === 0) {
      return { chunks: [], pipelineCompleted: true, error: '文档分块为空' };
    }

    return { chunks };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error({ err }, 'KM: 分块失败');
    return { error: message };
  }
}

/**
 * Node 4: extractEntitiesAndRelations — 实体/关系提取
 */
async function extractEntitiesAndRelations(state: KMState, config: any): Promise<Partial<KMState>> {
  const ctx = config?.configurable?.ctx as KMExecContext;
  const logger = getLogger();

  if (state.error) return { error: state.error };
  if (!state.chunks || state.chunks.length === 0) return { error: '缺少分块数据，无法提取' };

  const pipelineCtx = makePipelineCtx(ctx, state);
  await pipelineCtx.setJobStatus('running', 'extracting', 40);

  try {
    const graph = await pipelineCtx.llmExtract(state.chunks);
    logger?.info(
      { entities: graph.entities.length, relationships: graph.relationships.length },
      'KM: 图谱提取完成',
    );
    return { extractedGraph: graph };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error({ err }, 'KM: 图谱提取失败');
    return { extractedGraph: { entities: [], relationships: [] }, error: `图谱提取失败: ${message}` };
  }
}

/**
 * Node 5: validateSchema — 校验 schema（不再含 provenance，移到 Node 6a）
 * - 过滤置信度低于 0.65 的候选
 * - 低置信度写入 knowledge/review/pending.jsonl
 */
async function validateSchema(state: KMState, config: any): Promise<Partial<KMState>> {
  const ctx = config?.configurable?.ctx as KMExecContext;
  const logger = getLogger();

  if (state.error) return { error: state.error };
  if (!state.extractedGraph) return { error: '缺少提取结果，无法校验' };

  const { entities, relationships } = state.extractedGraph;

  // 按置信度过滤
  const validEntities: ExtractedEntity[] = [];
  const lowConfidenceEntities: ExtractedEntity[] = [];
  for (const e of entities) {
    if (e.confidence >= LOW_CONFIDENCE_THRESHOLD) {
      validEntities.push(e);
    } else {
      lowConfidenceEntities.push(e);
    }
  }

  const validRelationships: ExtractedRelationship[] = [];
  const lowConfidenceRelationships: ExtractedRelationship[] = [];
  for (const r of relationships) {
    if (r.confidence >= LOW_CONFIDENCE_THRESHOLD) {
      validRelationships.push(r);
    } else {
      lowConfidenceRelationships.push(r);
    }
  }

  // 写入低置信度候选到 DB pending_review 表
  const pipelineCtx = makePipelineCtx(ctx, state);
  if (lowConfidenceEntities.length > 0 || lowConfidenceRelationships.length > 0) {
    const reviewDir = join(ctx.workspaceRoot, 'knowledge', 'review');
    mkdirSync(reviewDir, { recursive: true });
    const pendingPath = join(reviewDir, 'pending.jsonl');
    const pendingLines: string[] = [];
    for (const e of lowConfidenceEntities) {
      const dataJson = JSON.stringify({ ...e, candidateType: 'entity' });
      pendingLines.push(JSON.stringify({ ...e, candidateType: 'entity', reason: 'low_confidence' }));
      try {
        pipelineCtx.addPendingReview?.(state.scopeType, state.scopeId, 'entity', dataJson, 'low_confidence');
      } catch { /* DB 写入失败不影响主流程 */ }
    }
    for (const r of lowConfidenceRelationships) {
      const dataJson = JSON.stringify({ ...r, candidateType: 'relationship' });
      pendingLines.push(JSON.stringify({ ...r, candidateType: 'relationship', reason: 'low_confidence' }));
      try {
        pipelineCtx.addPendingReview?.(state.scopeType, state.scopeId, 'relationship', dataJson, 'low_confidence');
      } catch { /* DB 写入失败不影响主流程 */ }
    }
    writeFileSync(pendingPath, pendingLines.join('\n') + '\n', { flag: 'a', encoding: 'utf-8' });
    logger?.info(
      { lowConfidenceEntities: lowConfidenceEntities.length, lowConfidenceRelationships: lowConfidenceRelationships.length },
      'KM: 低置信度候选已写入 DB 和 review/pending.jsonl',
    );
  }

  logger?.info(
    { validEntities: validEntities.length, validRelationships: validRelationships.length },
    'KM: 校验完成',
  );

  return { validatedEntities: validEntities, validatedRelationships: validRelationships };
}

/**
 * Node 6a: buildProvenance — 在 upsertGraph 之后创建来源记录
 * - 使用 upsert 后返回的 DB node/edge ID 作为 target_id
 * - 使用 chunk 的 locationJson 记录精确位置
 */
async function buildProvenance(state: KMState, config: any): Promise<Partial<KMState>> {
  const ctx = config?.configurable?.ctx as KMExecContext;
  const logger = getLogger();

  if (state.error) return { error: state.error };
  if (!state.chunks || state.chunks.length === 0) return {};

  const pipelineCtx = makePipelineCtx(ctx, state);

  // 从 DB 读取当前 scope 的所有节点/边（upsert 的结果）
  const nodes = ctx.db.prepare(
    `SELECT id, canonical_name, node_type FROM knowledge_nodes WHERE scope_type = ? AND scope_id = ?`,
  ).all(state.scopeType, state.scopeId) as Array<{ id: string; canonicalName: string; nodeType: string }>;

  const edges = ctx.db.prepare(
    `SELECT e.id, e.edge_type as edgeType, sn.canonical_name as sourceName, tn.canonical_name as targetName
     FROM knowledge_edges e
     JOIN knowledge_nodes sn ON sn.id = e.source_node_id
     JOIN knowledge_nodes tn ON tn.id = e.target_node_id
     WHERE e.scope_type = ? AND e.scope_id = ?`,
  ).all(state.scopeType, state.scopeId) as Array<{ id: string; edgeType: string; sourceName: string; targetName: string }>;

  if (nodes.length === 0) {
    logger?.info('KM: 无节点需要创建 provenance');
    return {};
  }

  // 为每个节点创建 provenance：找到包含该节点名称的 chunk
  let provenanceCount = 0;
  for (const node of nodes) {
    for (const chunk of state.chunks) {
      if (chunk.text.includes(node.canonicalName)) {
        try {
          const quoteHash = hashContent(chunk.text);
          pipelineCtx.createProvenance('node', node.id, pipelineCtx.sourceId, chunk.ordinal.toString(), chunk.locationJson, quoteHash);
          provenanceCount++;
        } catch (err) {
          logger?.warn({ err, nodeId: node.id }, 'KM: 节点 provenance 写入失败');
        }
      }
    }
  }

  // 为每条边创建 provenance
  for (const edge of edges) {
    for (const chunk of state.chunks) {
      if (chunk.text.includes(edge.sourceName) && chunk.text.includes(edge.targetName)) {
        try {
          const quoteHash = hashContent(chunk.text);
          pipelineCtx.createProvenance('edge', edge.id, pipelineCtx.sourceId, chunk.ordinal.toString(), chunk.locationJson, quoteHash);
          provenanceCount++;
        } catch (err) {
          logger?.warn({ err, edgeId: edge.id }, 'KM: 边 provenance 写入失败');
        }
      }
    }
  }

  logger?.info({ provenanceCount }, 'KM: provenance 创建完成');
  return {};
}

/**
 * Node 6: upsertGraph — 写入图谱
 */
async function upsertGraph(state: KMState, config: any): Promise<Partial<KMState>> {
  const ctx = config?.configurable?.ctx as KMExecContext;
  const logger = getLogger();

  if (state.error) return { error: state.error };
  if (!state.validatedEntities || state.validatedEntities.length === 0) {
    return { entityCount: 0, relationshipCount: 0, pipelineCompleted: true, error: '没有有效实体可写入' };
  }

  const pipelineCtx = makePipelineCtx(ctx, state);

  try {
    const nodeIdMap = new Map<string, string>();

    // Upsert entities
    for (const entity of state.validatedEntities) {
      try {
        const nodeId = await pipelineCtx.upsertNode(entity);
        nodeIdMap.set(entity.name, nodeId);
      } catch (err) {
        logger?.warn({ entity: entity.name, error: String(err) }, 'KM: 实体保存失败');
      }
    }

    // Upsert relationships
    let relationCount = 0;
    for (const rel of state.validatedRelationships) {
      const sourceId = nodeIdMap.get(rel.source);
      const targetId = nodeIdMap.get(rel.target);
      if (!sourceId || !targetId) {
        logger?.warn({ source: rel.source, target: rel.target }, 'KM: 跳过关系，找不到实体');
        continue;
      }
      try {
        await pipelineCtx.upsertEdge(rel, sourceId, targetId);
        relationCount++;
      } catch (err) {
        logger?.warn({ source: rel.source, target: rel.target, error: String(err) }, 'KM: 关系保存失败');
      }
    }

    logger?.info(
      { entities: nodeIdMap.size, relationships: relationCount },
      'KM: 图谱写入完成',
    );

    return { entityCount: nodeIdMap.size, relationshipCount: relationCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error({ err }, 'KM: 图谱写入失败');
    return { error: message };
  }
}

/**
 * Node 7: buildWikiPages — 生成 Wiki 页面
 */
async function buildWikiPages(state: KMState, config: any): Promise<Partial<KMState>> {
  const ctx = config?.configurable?.ctx as KMExecContext;
  const logger = getLogger();

  if (state.error) return { error: state.error };
  if (!state.validatedEntities || state.validatedEntities.length === 0) {
    return { wikiPageCount: 0 };
  }

  const pipelineCtx = makePipelineCtx(ctx, state);
  await pipelineCtx.setJobStatus('running', 'generating_wiki', 70);

  try {
    const wikiPages: GeneratedWikiPage[] = [];
    const wikiCount = Math.min(state.validatedEntities.length, 20);

    for (let i = 0; i < wikiCount; i++) {
      const entity = state.validatedEntities[i];
      if (!entity || entity.summary.length < 10) continue;

      // 构建关联实体
      const related = state.validatedRelationships
        .filter((r) => r.source === entity.name || r.target === entity.name)
        .map((r) => {
          const otherName = r.source === entity.name ? r.target : r.source;
          const otherEntity = state.validatedEntities!.find((e) => e.name === otherName);
          return {
            name: otherName,
            type: otherEntity?.type ?? 'unknown',
            summary: otherEntity?.summary ?? '',
            edgeType: r.type,
          };
        });

      // 构建来源引用
      const sourceRefs = (state.chunks || [])
        .filter((c) => c.text.includes(entity.name))
        .slice(0, 3)
        .map((c) => ({
          sourceId: pipelineCtx.sourceId,
          chunkId: c.ordinal.toString(),
        }));

      try {
        const wikiPage = await pipelineCtx.llmGenerateWiki(entity, related, sourceRefs);
        await pipelineCtx.upsertWikiPage(wikiPage);
        wikiPages.push(wikiPage);
        logger?.info({ title: wikiPage.title }, 'KM: Wiki 页面已生成');
      } catch (err) {
        logger?.warn({ entity: entity.name, error: String(err) }, 'KM: Wiki 页面生成失败');
      }

      const progress = 70 + Math.floor((i / wikiCount) * 25);
      await pipelineCtx.setJobStatus('running', 'generating_wiki', progress);
    }

    logger?.info({ wikiPages: wikiPages.length }, 'KM: Wiki 生成完成');
    return { wikiPages, wikiPageCount: wikiPages.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error({ err }, 'KM: Wiki 生成失败');
    return { error: message };
  }
}

/**
 * Node 8: materializeGraphFiles — 将图谱和 Wiki 写入工作区文件
 */
async function materializeGraphFiles(state: KMState, config: any): Promise<Partial<KMState>> {
  if (state.error) return { error: state.error };
  if (!state.pipelineCompleted && state.entityCount === 0) return {};

  const ctx = config?.configurable?.ctx as KMExecContext;
  const logger = getLogger();

  try {
    const graphDir = join(ctx.workspaceRoot, 'knowledge', 'graph');
    const wikiDir = join(ctx.workspaceRoot, 'knowledge', 'wiki');
    mkdirSync(graphDir, { recursive: true });
    mkdirSync(wikiDir, { recursive: true });

    // 导出图谱
    const nodes = ctx.db.prepare(
      `SELECT id, node_type as nodeType, canonical_name as canonicalName, summary, confidence
       FROM knowledge_nodes WHERE scope_type = ? AND scope_id = ?`,
    ).all(state.scopeType, state.scopeId) as Array<{
      id: string; nodeType: string; canonicalName: string; summary: string; confidence: number;
    }>;

    const edges = ctx.db.prepare(
      `SELECT e.id, e.source_node_id as sourceNodeId, e.target_node_id as targetNodeId,
              e.edge_type as edgeType, e.confidence,
              sn.canonical_name as sourceName, tn.canonical_name as targetName
       FROM knowledge_edges e
       JOIN knowledge_nodes sn ON sn.id = e.source_node_id
       JOIN knowledge_nodes tn ON tn.id = e.target_node_id
       WHERE e.scope_type = ? AND e.scope_id = ?`,
    ).all(state.scopeType, state.scopeId) as Array<{
      id: string; sourceNodeId: string; targetNodeId: string;
      edgeType: string; confidence: number; sourceName: string; targetName: string;
    }>;

    writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({ nodes, edges }, null, 2), 'utf-8');

    // 导出 Wiki 页面
    const wikiPages = ctx.db.prepare(
      `SELECT slug, title, body_md as bodyMd FROM wiki_pages WHERE scope_type = ? AND scope_id = ?`,
    ).all(state.scopeType, state.scopeId) as Array<{ slug: string; title: string; bodyMd: string }>;

    for (const page of wikiPages) {
      writeFileSync(join(wikiDir, `${page.slug}.md`), page.bodyMd, 'utf-8');
    }

    // 生成索引
    const indexMd = wikiPages.map((p) => `- [${p.title}](wiki/${p.slug}.md)`).join('\n');
    writeFileSync(join(graphDir, '..', 'README.md'), `# 知识图谱\n\n## Wiki 页面\n\n${indexMd}\n`, 'utf-8');

    logger?.info({ graphDir, wikiDir }, 'KM: 图谱文件已写入工作区');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn({ err }, 'KM: 工作区文件写入失败');
    return { error: message };
  }

  return {};
}

/**
 * Node 9: buildVisualizationProjection — 构建可视化投影
 * 生成前端可用的 D3/FORCE 图投影 JSON
 */
async function buildVisualizationProjection(state: KMState, config: any): Promise<Partial<KMState>> {
  if (state.error) return { error: state.error };

  const ctx = config?.configurable?.ctx as KMExecContext;
  const logger = getLogger();

  try {
    const nodes = ctx.db.prepare(
      `SELECT id, node_type as nodeType, canonical_name as canonicalName, summary, confidence
       FROM knowledge_nodes WHERE scope_type = ? AND scope_id = ?`,
    ).all(state.scopeType, state.scopeId) as Array<{
      id: string; nodeType: string; canonicalName: string; summary: string; confidence: number;
    }>;

    const edges = ctx.db.prepare(
      `SELECT e.id, e.source_node_id as sourceNodeId, e.target_node_id as targetNodeId,
              e.edge_type as edgeType, e.confidence
       FROM knowledge_edges e
       WHERE e.scope_type = ? AND e.scope_id = ?`,
    ).all(state.scopeType, state.scopeId) as Array<{
      id: string; sourceNodeId: string; targetNodeId: string; edgeType: string; confidence: number;
    }>;

    const projection = {
      type: 'force-graph',
      version: 1,
      scope: { type: state.scopeType, id: state.scopeId },
      nodes: nodes.map((n) => ({
        id: n.id,
        label: n.canonicalName,
        type: n.nodeType,
        summary: n.summary?.slice(0, 100),
        group: n.nodeType,
      })),
      links: edges.map((e) => ({
        source: e.sourceNodeId,
        target: e.targetNodeId,
        label: e.edgeType,
        confidence: e.confidence,
      })),
      metadata: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        generatedAt: new Date().toISOString(),
      },
    };

    const projectionJson = JSON.stringify(projection, null, 2);
    const projectionDir = join(ctx.workspaceRoot, 'knowledge', 'projection');
    mkdirSync(projectionDir, { recursive: true });
    writeFileSync(join(projectionDir, 'visualization-projection.json'), projectionJson, 'utf-8');

    logger?.info({ nodeCount: nodes.length, edgeCount: edges.length }, 'KM: 可视化投影已生成');

    return { visualizationProjection: projectionJson };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn({ err }, 'KM: 可视化投影生成失败');
    return { error: message };
  }
}

/**
 * Node 10: generateReport — 生成最终报告
 */
async function generateReport(state: KMState, _config: any): Promise<Partial<KMState>> {
  if (state.error && !state.pipelineCompleted) {
    const reportText = state.error.includes('内容过短')
      ? `## 知识入库完成\n\n**文件**: ${basename(state.sourceFilePath || '')}\n\n文档内容过短，跳过知识提取。`
      : `## 知识入库失败\n\n**错误**: ${state.error}\n\n请检查文件格式和路径后重试。`;
    return { report: reportText };
  }

  if (!state.pipelineCompleted && state.entityCount === 0 && !state.wikiPages?.length) {
    return { report: '知识入库未完成，请检查日志。' };
  }

  const fileName = basename(state.sourceFilePath || '');
  const reportText = `## 知识入库完成\n\n**文件**: ${fileName}\n\n### 统计\n- 实体: ${state.entityCount} 个\n- 关系: ${state.relationshipCount} 条\n- Wiki 页面: ${state.wikiPageCount} 个\n\n图谱和 Wiki 已写入工作区知识目录。`;

  return { report: reportText };
}

// ─── Graph Builder ───────────────────────────────────────────────────────────

let _compiledKMGraph: ReturnType<typeof buildKMGraph> | null = null;

/**
 * 根据 10.8 节规范构建 11 节点固定工作流：
 * discoverSource → extractText → normalizeAndChunk → extractEntitiesAndRelations
 * → validateSchema → upsertGraph → buildProvenance → buildWikiPages
 * → materializeGraphFiles → buildVisualizationProjection → generateReport
 *
 * provenance 必须放在 upsertGraph 之后，这样能使用 DB 分配的真实 node/edge ID
 */
function buildKMGraph() {
  const builder = new StateGraph(KnowledgeManagerState)
    .addNode('discoverSource', discoverSource as any)
    .addNode('extractText', extractText as any)
    .addNode('normalizeAndChunk', normalizeAndChunk as any)
    .addNode('extractEntitiesAndRelations', extractEntitiesAndRelations as any)
    .addNode('validateSchema', validateSchema as any)
    .addNode('upsertGraph', upsertGraph as any)
    .addNode('buildProvenance', buildProvenance as any)
    .addNode('buildWikiPages', buildWikiPages as any)
    .addNode('materializeGraphFiles', materializeGraphFiles as any)
    .addNode('buildVisualizationProjection', buildVisualizationProjection as any)
    .addNode('generateReport', generateReport as any)
    // 主链路：每个节点根据 error 状态路由到下一个节点或 generateReport
    .addEdge('__start__' as const, 'discoverSource')
    .addConditionalEdges('discoverSource', (s: KMState) => s.error ? 'generateReport' : 'extractText', ['extractText', 'generateReport'] as const)
    .addConditionalEdges('extractText', (s: KMState) => s.error ? 'generateReport' : 'normalizeAndChunk', ['normalizeAndChunk', 'generateReport'] as const)
    .addConditionalEdges('normalizeAndChunk', (s: KMState) => s.error ? 'generateReport' : 'extractEntitiesAndRelations', ['extractEntitiesAndRelations', 'generateReport'] as const)
    .addConditionalEdges('extractEntitiesAndRelations', (s: KMState) => s.error ? 'generateReport' : 'validateSchema', ['validateSchema', 'generateReport'] as const)
    .addConditionalEdges('validateSchema', (s: KMState) => s.error ? 'generateReport' : 'upsertGraph', ['upsertGraph', 'generateReport'] as const)
    .addConditionalEdges('upsertGraph', (s: KMState) => s.error ? 'generateReport' : 'buildProvenance', ['buildProvenance', 'generateReport'] as const)
    .addConditionalEdges('buildProvenance', (s: KMState) => s.error ? 'generateReport' : 'buildWikiPages', ['buildWikiPages', 'generateReport'] as const)
    .addConditionalEdges('buildWikiPages', (s: KMState) => s.error ? 'generateReport' : 'materializeGraphFiles', ['materializeGraphFiles', 'generateReport'] as const)
    .addConditionalEdges('materializeGraphFiles', (s: KMState) => s.error ? 'generateReport' : 'buildVisualizationProjection', ['buildVisualizationProjection', 'generateReport'] as const)
    .addConditionalEdges('buildVisualizationProjection', (s: KMState) => 'generateReport', ['generateReport'] as const)
    .addEdge('generateReport', END);

  return builder.compile();
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

export async function runKnowledgeManager(ctx: KMExecContext): Promise<string> {
  const logger = getLogger();

  if (!_compiledKMGraph) {
    _compiledKMGraph = buildKMGraph();
  }

  const initialState: KMState = {
    projectId: ctx.projectId,
    agentInstanceId: ctx.agentInstanceId,
    runId: ctx.runId,
    instruction: ctx.instruction,
    triggerMessageId: ctx.triggerMessageId,
    sourceFileId: '',
    sourceFilePath: '',
    sourceId: '',
    scopeType: 'project',
    scopeId: ctx.projectId,
    parsedText: '',
    mimeType: '',
    chunks: [],
    extractedGraph: null,
    validatedEntities: [],
    validatedRelationships: [],
    wikiPages: [],
    visualizationProjection: '',
    pipelineCompleted: false,
    entityCount: 0,
    relationshipCount: 0,
    wikiPageCount: 0,
    error: '',
    report: '',
  };

  const result = await _compiledKMGraph.invoke(initialState, {
    configurable: { ctx },
    signal: ctx.signal,
  });

  // 标记完成状态
  const knowledgeRepo = new KnowledgeRepository(ctx.db);
  if (result.error && !result.pipelineCompleted) {
    knowledgeRepo.setSourceStatus(ctx.projectId, 'error');
  } else {
    knowledgeRepo.setSourceStatus(ctx.projectId, 'ready');
  }

  logger?.info({ runId: ctx.runId, report: result.report?.slice(0, 100) }, 'KM: 知识管理智能体工作流完成');
  return result.report || '知识入库完成，但未生成报告。';
}