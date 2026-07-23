import type { Database } from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  KnowledgeRepository,
  WikiRepository,
  FileRepository,
} from '@kunqing/database';
import type {
  PipelineContext,
  Chunk,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractedGraph,
  GeneratedWikiPage,
} from '@kunqing/knowledge-core';
import { hashContent, slugify } from '@kunqing/knowledge-core';
import { buildGraphExtractionPrompt, buildWikiGenerationPrompt } from '@kunqing/knowledge-core';
import { ModelGateway } from './model-gateway';
import type { ModelSlot } from './model-gateway';
import { getLogger } from './logger';

export function createPipelineContext(
  db: Database,
  gateway: ModelGateway,
  filePath: string,
  sourceId: string,
  scopeType: string,
  scopeId: string,
): PipelineContext {
  const knowledgeRepo = new KnowledgeRepository(db);
  const wikiRepo = new WikiRepository(db);
  const fileRepo = new FileRepository(db);
  const fileName = basename(filePath);
  const fileExt = extname(filePath).replace(/^\./, '');

  const ctx: PipelineContext = {
    sourceId,
    scopeType,
    scopeId,
    filePath,
    fileName,
    fileExt,
    fileSize: 0,

    async readFile(): Promise<Buffer> {
      const buf = await readFile(filePath);
      ctx.fileSize = buf.length;
      return buf;
    },

    async saveChunk(chunk: Chunk): Promise<void> {
      const data: { sourceId: string; ordinal: number; text: string; locationJson?: string; contentHash: string } = {
        sourceId,
        ordinal: chunk.ordinal,
        text: chunk.text,
        contentHash: chunk.contentHash,
      };
      if (chunk.locationJson !== undefined) data.locationJson = chunk.locationJson;
      knowledgeRepo.createChunk(data);
    },

    async chunkExistsByHash(contentHash: string): Promise<boolean> {
      return knowledgeRepo.chunkExistsByHash(sourceId, contentHash);
    },

    async upsertNode(entity: ExtractedEntity): Promise<string> {
      const node = knowledgeRepo.upsertNode({
        scopeType,
        scopeId,
        nodeType: entity.type,
        canonicalName: entity.name,
        summary: entity.summary,
        propertiesJson: JSON.stringify(entity.properties),
        confidence: entity.confidence,
      });
      return node.id;
    },

    async upsertEdge(rel: ExtractedRelationship, sourceNodeId: string, targetNodeId: string): Promise<void> {
      knowledgeRepo.upsertEdge({
        scopeType,
        scopeId,
        sourceNodeId,
        targetNodeId,
        edgeType: rel.type,
        propertiesJson: JSON.stringify(rel.properties),
        confidence: rel.confidence,
      });
    },

    async createProvenance(
      targetType: string,
      targetId: string,
      sourceId: string,
      chunkId: string,
      locationJson?: string,
      quoteHash?: string,
    ): Promise<void> {
      const prov: { targetType: string; targetId: string; sourceId: string; chunkId: string; locationJson?: string; quoteHash?: string } = {
        targetType,
        targetId,
        sourceId,
        chunkId,
      };
      if (locationJson !== undefined) prov.locationJson = locationJson;
      if (quoteHash !== undefined) prov.quoteHash = quoteHash;
      knowledgeRepo.createProvenance(prov);
    },

    addPendingReview(scopeType: string, scopeId: string, candidateType: string, dataJson: string, reason: string): void {
      knowledgeRepo.addPendingReview({ scopeType, scopeId, candidateType, dataJson, reason });
    },

    async upsertWikiPage(page: GeneratedWikiPage): Promise<void> {
      const existing = wikiRepo.getBySlug(scopeType, scopeId, page.slug);
      if (existing) {
        db.prepare(
          'UPDATE wiki_pages SET title = ?, body_md = ?, source_refs_json = ?, updated_at = ? WHERE id = ?',
        ).run(
          page.title,
          page.bodyMd,
          JSON.stringify(page.sourceRefs),
          new Date().toISOString(),
          existing.id,
        );
      } else {
        const { randomUUID } = await import('node:crypto');
        const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
        db.prepare(
          'INSERT INTO wiki_pages (id, scope_type, scope_id, slug, title, body_md, source_refs_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          id,
          scopeType,
          scopeId,
          page.slug,
          page.title,
          page.bodyMd,
          JSON.stringify(page.sourceRefs),
          new Date().toISOString(),
        );
      }
    },

    async llmExtract(chunks: Chunk[]): Promise<ExtractedGraph> {
      const prompt = buildGraphExtractionPrompt(
        chunks.map((c) => ({ ordinal: c.ordinal, text: c.text })),
      );

      try {
        const response = await gateway.generateText('reasoning', [
          { role: 'user', content: prompt },
        ]);

        // Try to extract JSON from the response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          getLogger().warn('LLM 返回的内容中没有找到 JSON');
          return { entities: [], relationships: [] };
        }

        const parsed = JSON.parse(jsonMatch[0]) as ExtractedGraph;
        return {
          entities: (parsed.entities || []).map((e: ExtractedEntity) => ({
            ...e,
            confidence: e.confidence ?? 0.8,
            properties: e.properties ?? {},
          })),
          relationships: (parsed.relationships || []).map((r: ExtractedRelationship) => ({
            ...r,
            confidence: r.confidence ?? 0.7,
            properties: r.properties ?? {},
          })),
        };
      } catch (err) {
        getLogger().warn({ err }, '图谱提取 LLM 调用失败');
        return { entities: [], relationships: [] };
      }
    },

    async llmGenerateWiki(
      entity: ExtractedEntity,
      related: Array<{ name: string; type: string; summary: string; edgeType: string }>,
      sourceRefs: Array<{ sourceId: string; chunkId: string }>,
    ): Promise<GeneratedWikiPage> {
      const chunksWithText = sourceRefs.map((ref) => {
        const chunk = knowledgeRepo.getChunk(ref.chunkId);
        return { ...ref, chunkText: chunk?.text ?? '' };
      });

      const prompt = buildWikiGenerationPrompt(entity, related, chunksWithText);

      try {
        const bodyMd = await gateway.generateText('fast', [
          { role: 'user', content: prompt },
        ]);

        return {
          slug: slugify(entity.name),
          title: entity.name,
          bodyMd,
          sourceRefs: sourceRefs.map((s) => ({ sourceId: s.sourceId, chunkId: s.chunkId })),
        };
      } catch (err) {
        // Fallback: generate a simple wiki page without LLM
        getLogger().warn({ err, entity: entity.name }, 'Wiki 生成 LLM 调用失败，使用基础模板');
        return generateFallbackWiki(entity, related, sourceRefs);
      }
    },

    async setJobStatus(
      status: string,
      stage?: string,
      progress?: number,
      errorCode?: string,
    ): Promise<void> {
      const job = knowledgeRepo.getJob(sourceId);
      if (job) {
        const opts: { stage?: string; progress?: number; errorCode?: string } = {};
        if (stage !== undefined) opts.stage = stage;
        if (progress !== undefined) opts.progress = progress;
        if (errorCode !== undefined) opts.errorCode = errorCode;
        knowledgeRepo.setJobStatus(
          job.id,
          status as 'queued' | 'running' | 'completed' | 'failed',
          opts,
        );
      }
    },

    async setSourceStatus(status: 'ready' | 'error'): Promise<void> {
      knowledgeRepo.setSourceStatus(sourceId, status);
    },

    log(message: string, data?: Record<string, unknown>): void {
      getLogger().info({ ...data, sourceId, fileName }, `[KnowledgePipeline] ${message}`);
    },
  };

  return ctx;
}

function generateFallbackWiki(
  entity: ExtractedEntity,
  related: Array<{ name: string; type: string; summary: string; edgeType: string }>,
  sourceRefs: Array<{ sourceId: string; chunkId: string }>,
): GeneratedWikiPage {
  const relatedMd = related.length > 0
    ? related.map((r) => `- **${r.name}** (${r.type}): ${r.summary} [关系: ${r.edgeType}]`).join('\n')
    : '无关联实体';

  const bodyMd = `# ${entity.name}

## 概述

${entity.summary}

## 属性

${Object.entries(entity.properties).length > 0
    ? Object.entries(entity.properties).map(([k, v]) => `- **${k}**: ${v}`).join('\n')
    : '无额外属性'}

## 关联关系

${relatedMd}

## 来源

${sourceRefs.map((s, i) => `- [来源 ${i + 1}](来源:${s.sourceId})`).join('\n')}
`;

  return {
    slug: slugify(entity.name),
    title: entity.name,
    bodyMd,
    sourceRefs: sourceRefs.map((s) => ({ sourceId: s.sourceId, chunkId: s.chunkId })),
  };
}