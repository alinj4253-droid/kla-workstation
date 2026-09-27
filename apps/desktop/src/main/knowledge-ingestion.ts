import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { FileRepository, KnowledgeRepository } from '@kunqing/database';
import { runIngestionPipeline } from '@kunqing/knowledge-core';
import { createPipelineContext } from './knowledge-pipeline-adapter';
import { materializeKnowledgeArtifacts } from './knowledge-artifacts';
import { getEnterpriseProjectRoot, getEnterpriseWorkspaceRoot, getProjectRoot } from './paths';
import type { ModelGateway } from './model-gateway';
import { reuseStandardizedDocument } from './knowledge-standardized';

export type KnowledgeIngestionResult = {
  fileId: string;
  sourceId: string | null;
  started: boolean;
};

const activeContentIngestions = new Map<string, Promise<void>>();

function isEnterpriseProjectScope(db: Database.Database, scopeType: 'project' | 'shared', scopeId: string): boolean {
  if (scopeType !== 'project') return false;
  try { return !!db.prepare('SELECT 1 FROM enterprise_projects WHERE id = ?').get(scopeId); } catch { return false; }
}

function sourceRoot(db: Database.Database, scopeType: 'project' | 'shared', scopeId: string): string {
  if (scopeType === 'shared') return resolve(getEnterpriseWorkspaceRoot(), 'original-files');
  if (isEnterpriseProjectScope(db, scopeType, scopeId)) return resolve(getEnterpriseProjectRoot(scopeId), 'original-files');
  return join(getProjectRoot(scopeId), 'original-files');
}

function resolveSourcePath(db: Database.Database, scopeType: 'project' | 'shared', scopeId: string, normalizedPath: string): string {
  const root = resolve(sourceRoot(db, scopeType, scopeId));
  const target = resolve(root, normalizedPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('源文件路径超出当前知识工作区');
  return target;
}

function remapSourceRefs(value: unknown, sourceId: string, chunkIds: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => remapSourceRefs(item, sourceId, chunkIds));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (key === 'sourceId' && typeof item === 'string') return [key, sourceId];
    if (key === 'chunkId' && typeof item === 'string') return [key, chunkIds.get(item) ?? item];
    return [key, remapSourceRefs(item, sourceId, chunkIds)];
  }));
}

async function reuseKnowledgeSource(
  db: Database.Database,
  reusableSourceId: string,
  targetSourceId: string,
  targetScopeType: 'project' | 'shared',
  targetScopeId: string,
): Promise<void> {
  const repo = new KnowledgeRepository(db);
  const reusable = repo.getSource(reusableSourceId);
  if (!reusable) throw new Error('可复用知识源不存在');
  const chunkIds = new Map<string, string>();

  db.transaction(() => {
    const profile = db.prepare(
      `SELECT summary, keywords_json as keywordsJson, tags_json as tagsJson, language, metadata_json as metadataJson
       FROM knowledge_document_profiles WHERE source_id = ?`,
    ).get(reusableSourceId) as { summary: string; keywordsJson: string; tagsJson: string; language: string; metadataJson: string | null } | undefined;
    if (profile) {
      repo.upsertDocumentProfile({
        sourceId: targetSourceId,
        summary: profile.summary,
        keywords: JSON.parse(profile.keywordsJson) as string[],
        tags: JSON.parse(profile.tagsJson) as string[],
        language: profile.language,
        ...(profile.metadataJson ? { metadataJson: profile.metadataJson } : {}),
      });
    }

    for (const chunk of repo.listChunks(reusableSourceId)) {
      const copied = repo.createChunk({
        sourceId: targetSourceId,
        ordinal: chunk.ordinal,
        text: chunk.text,
        contentHash: chunk.contentHash,
        ...(chunk.locationJson ? { locationJson: chunk.locationJson } : {}),
      });
      chunkIds.set(chunk.id, copied.id);
      const embedding = db.prepare(
        `SELECT model_id as modelId, vector_json as vectorJson FROM knowledge_chunk_embeddings WHERE chunk_id = ?`,
      ).get(chunk.id) as { modelId: string; vectorJson: string } | undefined;
      if (embedding) repo.upsertEmbedding({
        chunkId: copied.id,
        sourceId: targetSourceId,
        modelId: embedding.modelId,
        vector: JSON.parse(embedding.vectorJson) as number[],
      });
    }

    const nodeIds = new Map<string, string>();
    const ensureNode = (nodeId: string): string | null => {
      const mapped = nodeIds.get(nodeId);
      if (mapped) return mapped;
      const node = repo.getNode(nodeId);
      if (!node) return null;
      const copied = repo.upsertNode({
        scopeType: targetScopeType,
        scopeId: targetScopeId,
        nodeType: node.nodeType,
        canonicalName: node.canonicalName,
        ...(node.summary ? { summary: node.summary } : {}),
        ...(node.propertiesJson ? { propertiesJson: node.propertiesJson } : {}),
        confidence: node.confidence,
      });
      nodeIds.set(nodeId, copied.id);
      return copied.id;
    };
    const provenance = db.prepare(
      `SELECT target_type as targetType, target_id as targetId, chunk_id as chunkId,
              location_json as locationJson, quote_hash as quoteHash
       FROM knowledge_provenance WHERE source_id = ? ORDER BY created_at`,
    ).all(reusableSourceId) as Array<{ targetType: 'node' | 'edge' | 'wiki'; targetId: string; chunkId: string | null; locationJson: string | null; quoteHash: string | null }>;

    for (const item of provenance.filter((entry) => entry.targetType === 'node')) {
      const targetId = ensureNode(item.targetId);
      if (!targetId) continue;
      repo.createProvenance({
        targetType: 'node', targetId, sourceId: targetSourceId,
        ...(item.chunkId ? { chunkId: chunkIds.get(item.chunkId) ?? item.chunkId } : {}),
        ...(item.locationJson ? { locationJson: item.locationJson } : {}),
        ...(item.quoteHash ? { quoteHash: item.quoteHash } : {}),
      });
    }
    for (const item of provenance.filter((entry) => entry.targetType === 'edge')) {
      const edge = repo.getEdge(item.targetId);
      if (!edge) continue;
      const sourceNodeId = ensureNode(edge.sourceNodeId);
      const targetNodeId = ensureNode(edge.targetNodeId);
      if (!sourceNodeId || !targetNodeId) continue;
      const copied = repo.upsertEdge({
        scopeType: targetScopeType,
        scopeId: targetScopeId,
        sourceNodeId,
        targetNodeId,
        edgeType: edge.edgeType,
        ...(edge.propertiesJson ? { propertiesJson: edge.propertiesJson } : {}),
        confidence: edge.confidence,
      });
      repo.createProvenance({
        targetType: 'edge', targetId: copied.id, sourceId: targetSourceId,
        ...(item.chunkId ? { chunkId: chunkIds.get(item.chunkId) ?? item.chunkId } : {}),
        ...(item.locationJson ? { locationJson: item.locationJson } : {}),
        ...(item.quoteHash ? { quoteHash: item.quoteHash } : {}),
      });
    }

    const wikiRows = db.prepare(
      `SELECT slug, title, body_md as bodyMd, source_refs_json as sourceRefsJson
       FROM wiki_pages WHERE source_refs_json LIKE '%' || ? || '%'`,
    ).all(reusableSourceId) as Array<{ slug: string; title: string; bodyMd: string | null; sourceRefsJson: string | null }>;
    for (const page of wikiRows) {
      let sourceRefs: unknown = [];
      try { sourceRefs = JSON.parse(page.sourceRefsJson ?? '[]'); } catch { /* retain empty source list */ }
      const remapped = JSON.stringify(remapSourceRefs(sourceRefs, targetSourceId, chunkIds));
      const existing = db.prepare('SELECT id FROM wiki_pages WHERE scope_type = ? AND scope_id = ? AND slug = ?')
        .get(targetScopeType, targetScopeId, page.slug) as { id: string } | undefined;
      if (existing) {
        db.prepare('UPDATE wiki_pages SET title = ?, body_md = ?, source_refs_json = ?, updated_at = ? WHERE id = ?')
          .run(page.title, page.bodyMd, remapped, new Date().toISOString(), existing.id);
      } else {
        db.prepare(
          `INSERT INTO wiki_pages (id, scope_type, scope_id, slug, title, body_md, source_refs_json, updated_at)
           VALUES (lower(hex(randomblob(12))), ?, ?, ?, ?, ?, ?, ?)`,
        ).run(targetScopeType, targetScopeId, page.slug, page.title, page.bodyMd, remapped, new Date().toISOString());
      }
    }

    repo.updateSourceMetadata(targetSourceId, {
      ...(reusable.contentMd5 ? { contentMd5: reusable.contentMd5 } : {}),
      ...(reusable.parserId ? { parserId: reusable.parserId } : {}),
      ...(reusable.metadataJson ? { metadataJson: reusable.metadataJson } : {}),
    });
    repo.setSourceStatus(targetSourceId, 'ready');
    const job = repo.getLatestJobForSource(targetSourceId);
    if (job) repo.setJobStatus(job.id, 'completed', { stage: 'reused-md5', progress: 100 });
  })();

  await reuseStandardizedDocument({
    db,
    reusableSourceId,
    targetSourceId,
    targetScopeType,
    targetScopeId,
  });
  await materializeKnowledgeArtifacts(db, targetScopeType, targetScopeId);
}

/** Ensure the current file version has a source and a queued ingestion job. */
export function prepareKnowledgeIngestion(db: Database.Database, fileId: string): KnowledgeIngestionResult {
  const fileRepo = new FileRepository(db);
  const file = fileRepo.getById(fileId);
  if (!file || file.type !== 'file' || file.status === 'deleted' || !file.currentVersionId) {
    return { fileId, sourceId: null, started: false };
  }

  const knowledgeRepo = new KnowledgeRepository(db);
  let source = knowledgeRepo.getSourceByFileAndVersion(file.id, file.currentVersionId);
  if (source?.status === 'ready') return { fileId, sourceId: source.id, started: false };

  if (!source) {
    const version = fileRepo.getCurrentVersion(file.id);
    source = knowledgeRepo.createSource({
      scopeType: file.scopeType,
      scopeId: file.scopeId,
      fileId: file.id,
      versionId: file.currentVersionId,
      ...(version?.sha256 ? { sha256: version.sha256 } : {}),
    });
  } else if (source.status === 'error') {
    knowledgeRepo.setSourceStatus(source.id, 'pending');
  }

  const existingJob = knowledgeRepo.getLatestJobForSource(source.id);
  if (existingJob && existingJob.sourceId === source.id) {
    knowledgeRepo.setJobStatus(existingJob.id, 'queued');
  } else {
    knowledgeRepo.createJob({ scopeType: file.scopeType, scopeId: file.scopeId, sourceId: source.id });
  }
  return { fileId, sourceId: source.id, started: true };
}

/** Run one source synchronously when a retrieval needs fresh evidence. */
export async function ingestKnowledgeFile(
  db: Database.Database,
  gateway: ModelGateway | null,
  fileId: string,
): Promise<KnowledgeIngestionResult> {
  const prepared = prepareKnowledgeIngestion(db, fileId);
  if (!prepared.started || !prepared.sourceId || !gateway) return prepared;

  const file = new FileRepository(db).getById(fileId);
  if (!file || !file.currentVersionId) return prepared;
  const sourcePath = resolveSourcePath(db, file.scopeType, file.scopeId, file.normalizedPath);
  const knowledgeRepo = new KnowledgeRepository(db);
  const job = knowledgeRepo.getLatestJobForSource(prepared.sourceId);
  const fingerprints = await contentFingerprints(sourcePath);
  knowledgeRepo.updateSourceMetadata(prepared.sourceId, { contentMd5: fingerprints.md5 });

  const findReusableSource = (): { id: string } | undefined => db.prepare(
    `SELECT id FROM knowledge_sources
     WHERE content_md5 = ? AND status = 'ready' AND id != ?
     ORDER BY ingested_at DESC LIMIT 1`,
  ).get(fingerprints.md5, prepared.sourceId) as { id: string } | undefined;
  const reuse = async (): Promise<boolean> => {
    const reusable = findReusableSource();
    if (!reusable) return false;
    await reuseKnowledgeSource(db, reusable.id, prepared.sourceId!, file.scopeType, file.scopeId);
    return true;
  };
  if (await reuse()) return prepared;

  const active = activeContentIngestions.get(fingerprints.md5);
  if (active) {
    await active.catch(() => undefined);
    if (await reuse()) return prepared;
  }

  knowledgeRepo.setSourceStatus(prepared.sourceId, 'ingesting');
  if (job?.sourceId === prepared.sourceId) knowledgeRepo.setJobStatus(job.id, 'running', { stage: 'parsing', progress: 1 });

  const runPipeline = async (): Promise<void> => {
    const pipeline = createPipelineContext(db, gateway, sourcePath, prepared.sourceId!, file.scopeType, file.scopeId);
    await runIngestionPipeline(pipeline);
  };
  const pipelinePromise = runPipeline();
  activeContentIngestions.set(fingerprints.md5, pipelinePromise);
  try {
    await pipelinePromise;
    return prepared;
  } catch (error) {
    knowledgeRepo.setSourceStatus(prepared.sourceId, 'error');
    if (job?.sourceId === prepared.sourceId) knowledgeRepo.setJobStatus(job.id, 'failed', { errorCode: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    if (activeContentIngestions.get(fingerprints.md5) === pipelinePromise) activeContentIngestions.delete(fingerprints.md5);
  }
}

export async function contentFingerprints(filePath: string): Promise<{ sha256: string; md5: string; size: number }> {
  const buffer = await readFile(filePath);
  return {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    md5: createHash('md5').update(buffer).digest('hex'),
    size: buffer.byteLength,
  };
}
