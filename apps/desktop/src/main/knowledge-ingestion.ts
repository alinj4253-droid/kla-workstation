import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { FileRepository, KnowledgeRepository } from '@kunqing/database';
import { runIngestionPipeline } from '@kunqing/knowledge-core';
import { createPipelineContext } from './knowledge-pipeline-adapter';
import { getProjectRoot, getStudioRoot } from './paths';
import type { ModelGateway } from './model-gateway';

export type KnowledgeIngestionResult = {
  fileId: string;
  sourceId: string | null;
  started: boolean;
};

function sourceRoot(scopeType: 'project' | 'shared', scopeId: string): string {
  return scopeType === 'shared'
    ? join(getStudioRoot(), 'shared-knowledge', 'original-files')
    : join(getProjectRoot(scopeId), 'original-files');
}

function resolveSourcePath(scopeType: 'project' | 'shared', scopeId: string, normalizedPath: string): string {
  const root = resolve(sourceRoot(scopeType, scopeId));
  const target = resolve(root, normalizedPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('源文件路径超出当前知识工作区');
  return target;
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
  const sourcePath = resolveSourcePath(file.scopeType, file.scopeId, file.normalizedPath);
  const knowledgeRepo = new KnowledgeRepository(db);
  const job = knowledgeRepo.getLatestJobForSource(prepared.sourceId);
  knowledgeRepo.setSourceStatus(prepared.sourceId, 'ingesting');
  if (job?.sourceId === prepared.sourceId) knowledgeRepo.setJobStatus(job.id, 'running', { stage: 'parsing', progress: 1 });

  try {
    const pipeline = createPipelineContext(db, gateway, sourcePath, prepared.sourceId, file.scopeType, file.scopeId);
    await runIngestionPipeline(pipeline);
    return prepared;
  } catch (error) {
    knowledgeRepo.setSourceStatus(prepared.sourceId, 'error');
    if (job?.sourceId === prepared.sourceId) knowledgeRepo.setJobStatus(job.id, 'failed', { errorCode: error instanceof Error ? error.message : String(error) });
    throw error;
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
