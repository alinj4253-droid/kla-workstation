import type { Database } from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  KnowledgeRepository,
  WikiRepository,
} from '@kunqing/database';
import type {
  PipelineContext,
  Chunk,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractedGraph,
  GeneratedWikiPage,
  KnowledgeDocumentProfile,
} from '@kunqing/knowledge-core';
import { embedTextLocally, LOCAL_EMBEDDING_MODEL, slugify } from '@kunqing/knowledge-core';
import { buildGraphExtractionPrompt, buildWikiGenerationPrompt } from '@kunqing/knowledge-core';
import { ModelGateway } from './model-gateway';
import { getLogger } from './logger';
import { LocalOcrService } from './local-ocr';
import { materializeKnowledgeArtifacts } from './knowledge-artifacts';
import { isBuiltinToolEnabled } from './builtin-tool-catalog';

/**
 * 基础文本提取：不依赖 LLM，从文件名和文本块中提取实体和关系。
 * 当 LLM 不可用（未配置模型）时作为 fallback，确保图谱和 Wiki 至少有一些数据。
 */
function basicExtract(fileName: string, chunks: Chunk[]): ExtractedGraph {
  const entities: ExtractedEntity[] = [];
  const relationships: ExtractedRelationship[] = [];

  // 1. 文件本身作为根实体
  const fileEntityName = `文件: ${fileName}`;
  entities.push({
    name: fileEntityName,
    type: 'Document',
    summary: `来自文件 ${fileName} 的知识提取`,
    properties: { sourceFile: fileName },
    confidence: 1.0,
  });

  // 2. 从文本块中提取高频有意义的词作为关键词实体
  const wordFreq = new Map<string, number>();
  const stopWords = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
    '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
    '自己', '这', '他', '她', '它', '们', '那', '些', '为', '与', '及', '但', '而',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'into',
    'and', 'or', 'but', 'not', 'so', 'if', 'then', 'than', 'too', 'very',
  ]);

  for (const chunk of chunks) {
    // 按非字母数字字符分割（对中文按字符分割）
    const words = chunk.text.split(/[^a-zA-Z\u4e00-\u9fff]+/).filter(Boolean);
    for (const word of words) {
      if (word.length < 2 || stopWords.has(word.toLowerCase())) continue;
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
    }
  }

  // 取前 10 个高频词作为实体
  const topWords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  for (const [word, freq] of topWords) {
    const entityName = word.length > 30 ? word.slice(0, 30) + '…' : word;
    entities.push({
      name: entityName,
      type: freq > 5 ? '核心概念' : '相关概念',
      summary: `文档中出现 ${freq} 次的概念`,
      properties: { frequency: String(freq) },
      confidence: Math.min(0.5 + freq * 0.05, 0.9),
    });

    relationships.push({
      source: fileEntityName,
      target: entityName,
      type: '涉及',
      properties: { frequency: String(freq) },
      confidence: Math.min(0.5 + freq * 0.05, 0.9),
    });
  }

  // 3. 如果文件内容很少，至少保证有一个实体
  if (entities.length === 0) {
    entities.push({
      name: fileEntityName,
      type: 'Document',
      summary: `来自文件 ${fileName} 的知识提取`,
      properties: { sourceFile: fileName },
      confidence: 1.0,
    });
  }

  return { entities, relationships };
}

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
  const fileName = basename(filePath);
  const fileExt = extname(filePath).replace(/^\./, '');
  const ocr = new LocalOcrService();

  const ctx: PipelineContext = {
    sourceId,
    scopeType,
    scopeId,
    filePath,
    fileName,
    fileExt,
    fileSize: 0,

    async readFile(): Promise<Buffer> {
      if (!isBuiltinToolEnabled(db, 'tool.document-parser')) {
        throw new Error('本地文档解析器已停用');
      }
      const buf = await readFile(filePath);
      ctx.fileSize = buf.length;
      knowledgeRepo.updateSourceMetadata(sourceId, { contentMd5: createHash('md5').update(buf).digest('hex') });
      return buf;
    },

    async ocrExtract(targetPath: string): Promise<string> {
      if (!isBuiltinToolEnabled(db, 'tool.paddle-ocr')) {
        throw new Error('PaddleOCR 本地模型包未启用或尚未安装');
      }
      return ocr.extract(targetPath);
    },

    async saveChunk(chunk: Chunk): Promise<void> {
      const data: { sourceId: string; ordinal: number; text: string; locationJson?: string; contentHash: string } = {
        sourceId,
        ordinal: chunk.ordinal,
        text: chunk.text,
        contentHash: chunk.contentHash,
      };
      if (chunk.locationJson !== undefined) data.locationJson = chunk.locationJson;
      const saved = knowledgeRepo.createChunk(data);
      chunk.id = saved.id;
      if (isBuiltinToolEnabled(db, 'tool.local-embedding') && isBuiltinToolEnabled(db, 'tool.sqlite-vector-index')) {
        knowledgeRepo.upsertEmbedding({
          chunkId: saved.id,
          sourceId,
          modelId: LOCAL_EMBEDDING_MODEL.id,
          vector: embedTextLocally(chunk.text),
        });
      }
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

    async upsertEdge(rel: ExtractedRelationship, sourceNodeId: string, targetNodeId: string): Promise<string> {
      return knowledgeRepo.upsertEdge({
        scopeType,
        scopeId,
        sourceNodeId,
        targetNodeId,
        edgeType: rel.type,
        propertiesJson: JSON.stringify(rel.properties),
        confidence: rel.confidence,
      }).id;
    },

    async saveDocumentProfile(profile: KnowledgeDocumentProfile, metadata): Promise<void> {
      knowledgeRepo.upsertDocumentProfile({
        sourceId,
        summary: profile.summary,
        keywords: profile.keywords,
        tags: profile.tags,
        language: profile.language,
        metadataJson: JSON.stringify(metadata),
      });
      knowledgeRepo.updateSourceMetadata(sourceId, {
        parserId: typeof metadata.parserId === 'string' ? metadata.parserId : 'unknown',
        metadataJson: JSON.stringify(metadata),
      });
    },

    async analyzeDocument(text: string, fallback: KnowledgeDocumentProfile): Promise<KnowledgeDocumentProfile> {
      const prompt = `请把文档整理成知识入库元数据，只返回 JSON：\n{"summary":"语义摘要，最多400字","keywords":["关键词"],"tags":["标签"],"language":"zh|en|mixed|unknown"}\n\n文档：\n${text.slice(0, 30_000)}`;
      try {
        const response = await gateway.generateText('fast', [{ role: 'user', content: prompt }]);
        const json = response.text.match(/\{[\s\S]*\}/)?.[0];
        if (!json) return fallback;
        const parsed = JSON.parse(json) as Partial<KnowledgeDocumentProfile>;
        return {
          summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim().slice(0, 800) : fallback.summary,
          keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((item): item is string => typeof item === 'string').slice(0, 24) : fallback.keywords,
          tags: Array.isArray(parsed.tags) ? parsed.tags.filter((item): item is string => typeof item === 'string').slice(0, 16) : fallback.tags,
          language: ['zh', 'en', 'mixed', 'unknown'].includes(parsed.language ?? '') ? parsed.language! : fallback.language,
        };
      } catch {
        return fallback;
      }
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
        const jsonMatch = response.text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          getLogger().warn('LLM 返回的内容中没有找到 JSON');
          return basicExtract(ctx.fileName, chunks);
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
        getLogger().warn({ err }, '图谱提取 LLM 调用失败，使用基础文本提取');
        return basicExtract(ctx.fileName, chunks);
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
          bodyMd: bodyMd.text,
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
      const job = knowledgeRepo.getLatestJobForSource(sourceId);
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
      if (status === 'ready') {
        const source = knowledgeRepo.getSource(sourceId);
        if (source) knowledgeRepo.removeObsoleteSourcesForFile(source.fileId, sourceId);
        if (isBuiltinToolEnabled(db, 'tool.knowledge-assets')) {
          await materializeKnowledgeArtifacts(db, scopeType, scopeId);
        }
      }
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
