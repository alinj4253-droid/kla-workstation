import type { PipelineContext, Chunk, ExtractedEntity, ExtractedGraph, GeneratedWikiPage } from './types.js';
import { hashContent, slugify } from './types.js';
import { parseDocument } from './parsers/index.js';
import { chunkDocument } from './chunker.js';
import { buildGraphExtractionPrompt, buildWikiGenerationPrompt } from './prompts.js';
import { analyzeDocumentLocally } from './analysis.js';

/**
 * Execute the full knowledge ingestion pipeline for a single file.
 *
 * Stages:
 * 1. parsing   - Parse the file into raw text
 * 2. chunking  - Split text into overlapping chunks
 * 3. extracting - Extract entities and relationships using LLM
 * 4. generating_wiki - Generate wiki pages from the knowledge graph
 * 5. completed
 */
export async function runIngestionPipeline(ctx: PipelineContext): Promise<void> {
  try {
    // ── Stage 1: Parsing ──
    await ctx.setJobStatus('running', 'parsing', 5);
    ctx.log('开始解析文档', { fileName: ctx.fileName });

    const buf = await ctx.readFile();
    const doc = await parseDocument(buf, ctx.fileExt, ctx.fileName);
    if (doc.metadata.requiresOcr && ctx.ocrExtract) {
      const ocrText = await ctx.ocrExtract(ctx.filePath);
      if (ocrText.trim()) doc.text = ocrText.trim();
    }

    ctx.log('文档解析完成', {
      fileName: ctx.fileName,
      textLength: doc.text.length,
      mimeType: doc.mimeType,
    });

    if (!doc.text || doc.text.trim().length < 10) {
      await ctx.setJobStatus('completed', 'completed', 100);
      await ctx.setSourceStatus('ready');
      ctx.log('文档内容过短，跳过知识提取');
      return;
    }

    const localProfile = analyzeDocumentLocally(doc.text, ctx.fileName);
    const profile = ctx.analyzeDocument
      ? await ctx.analyzeDocument(doc.text, localProfile).catch(() => localProfile)
      : localProfile;
    await ctx.saveDocumentProfile?.(profile, doc.metadata);

    // ── Stage 2: Chunking ──
    await ctx.setJobStatus('running', 'chunking', 15);
    ctx.log('开始文本分块');

    const chunks = chunkDocument(doc);
    ctx.log(`文本分块完成: ${chunks.length} 个块`);

    // Deduplicate and save chunks
    let savedCount = 0;
    for (const chunk of chunks) {
      const exists = await ctx.chunkExistsByHash(chunk.contentHash);
      if (!exists) {
        await ctx.saveChunk(chunk);
        savedCount++;
      }
    }
    ctx.log(`保存了 ${savedCount} 个新块 (${chunks.length - savedCount} 个重复)`);

    if (chunks.length === 0) {
      await ctx.setJobStatus('completed', 'completed', 100);
      await ctx.setSourceStatus('ready');
      return;
    }

    // ── Stage 3: Graph Extraction ──
    await ctx.setJobStatus('running', 'extracting', 40);
    ctx.log('开始知识图谱提取');

    let graph: ExtractedGraph;
    try {
      graph = await ctx.llmExtract(chunks);
    } catch (err) {
      ctx.log('图谱提取失败，可能是 LLM 不可用', { error: String(err) });
      await ctx.setJobStatus('completed', 'completed', 100);
      await ctx.setSourceStatus('ready');
      return;
    }

    ctx.log(`图谱提取完成: ${graph.entities.length} 个实体, ${graph.relationships.length} 个关系`);

    // Upsert entities
    const nodeIdMap = new Map<string, string>();
    for (const entity of graph.entities) {
      try {
        const nodeId = await ctx.upsertNode(entity);
        nodeIdMap.set(entity.name, nodeId);
      } catch (err) {
        ctx.log('实体保存失败', { entity: entity.name, error: String(err) });
      }
    }

    // Upsert relationships
    for (const rel of graph.relationships) {
      const sourceId = nodeIdMap.get(rel.source);
      const targetId = nodeIdMap.get(rel.target);
      if (!sourceId || !targetId) {
        ctx.log('跳过关系: 找不到源或目标实体', { source: rel.source, target: rel.target });
        continue;
      }
      try {
        const edgeId = await ctx.upsertEdge(rel, sourceId, targetId);
        const evidence = chunks.find((chunk) => chunk.text.includes(rel.source) && chunk.text.includes(rel.target));
        if (evidence) {
          await ctx.createProvenance('edge', edgeId, ctx.sourceId, evidence.id ?? evidence.ordinal.toString(), evidence.locationJson, hashContent(evidence.text));
        }
      } catch (err) {
        ctx.log('关系保存失败', { source: rel.source, target: rel.target, error: String(err) });
      }
    }

    // 使用 upsert 后的真实 node ID 创建 provenance
    let provenanceCount = 0;
    for (const [entityName, nodeId] of nodeIdMap) {
      for (const chunk of chunks) {
        if (chunk.text.includes(entityName)) {
          try {
            const quoteHash = hashContent(chunk.text);
            await ctx.createProvenance('node', nodeId, ctx.sourceId, chunk.id ?? chunk.ordinal.toString(), chunk.locationJson, quoteHash);
            provenanceCount++;
          } catch (err) {
            ctx.log('provenance 写入失败', { nodeId, error: String(err) });
          }
        }
      }
    }

    // ── Stage 4: Wiki Generation ──
    await ctx.setJobStatus('running', 'generating_wiki', 70);
    ctx.log('开始生成 Wiki 页面');

    const wikiCount = Math.min(graph.entities.length, 20); // Limit wiki pages
    for (let i = 0; i < wikiCount; i++) {
      const entity = graph.entities[i];
      if (!entity || entity.summary.length < 10) continue;

      // Build related entities
      const related = graph.relationships
        .filter((r) => r.source === entity.name || r.target === entity.name)
        .map((r) => {
          const otherName = r.source === entity.name ? r.target : r.source;
          const otherEntity = graph.entities.find((e) => e.name === otherName);
          return {
            name: otherName,
            type: otherEntity?.type ?? 'unknown',
            summary: otherEntity?.summary ?? '',
            edgeType: r.type,
          };
        });

      // Build source refs
      const sourceRefs = chunks
        .filter((c) => c.text.includes(entity.name))
        .slice(0, 3)
        .map((c) => ({
          sourceId: ctx.sourceId,
          chunkId: c.id ?? c.ordinal.toString(),
          chunkText: c.text,
        }));

      try {
        const wikiPage = await ctx.llmGenerateWiki(entity, related, sourceRefs);
        await ctx.upsertWikiPage(wikiPage);
        ctx.log('Wiki 页面已生成', { title: wikiPage.title });
      } catch (err) {
        ctx.log('Wiki 页面生成失败', { entity: entity.name, error: String(err) });
      }

      // Update progress
      const progress = 70 + Math.floor((i / wikiCount) * 25);
      await ctx.setJobStatus('running', 'generating_wiki', progress);
    }

    // ── Complete ──
    await ctx.setJobStatus('completed', 'completed', 100);
    await ctx.setSourceStatus('ready');
    ctx.log('知识入库完成', { fileName: ctx.fileName });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log('知识入库流水线失败', { error: message });
    await ctx.setJobStatus('failed', 'failed', 0, 'PIPELINE_ERROR');
    await ctx.setSourceStatus('error');
    // The caller must be able to distinguish a failed source from a successful
    // ingestion. Keep the source/job state persisted above, then surface the
    // original error so retrieval can report and retry it.
    throw err;
  }
}
