import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { FileRepository, KnowledgeRepository } from '@kunqing/database';
import type { ModelGateway } from './model-gateway';
import { getProjectRoot, getStudioRoot } from './paths';
import { contentFingerprints, ingestKnowledgeFile } from './knowledge-ingestion';

export type KnowledgeSyncScope = { scopeType: 'project' | 'shared'; scopeId: string };
export type KnowledgeSyncResult = { changedFileIds: string[]; deletedFileIds: string[]; failedFileIds: string[] };
export type KnowledgeSyncOptions = { deferRecentFailures?: boolean; maxConcurrency?: number };
export type KnowledgeSyncObserver = {
  onChangesDetected?: (scope: KnowledgeSyncScope, change: KnowledgeSyncResult) => void | Promise<void>;
};

function deactivateSourcesForFile(db: Database.Database, fileId: string): void {
  db.prepare(
    "UPDATE knowledge_sources SET status = 'error', ingested_at = NULL WHERE file_id = ? AND status != 'error'",
  ).run(fileId);
}

function hasFilePathIndex(db: Database.Database): boolean {
  try {
    const columns = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    return columns.some((column) => column.name === 'normalized_path')
      && columns.some((column) => column.name === 'scope_type')
      && columns.some((column) => column.name === 'scope_id');
  } catch {
    return false;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.endsWith('~')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  await visit(root);
  return result;
}

function originalRoot(scope: KnowledgeSyncScope): string {
  return scope.scopeType === 'shared'
    ? join(getStudioRoot(), 'shared-knowledge', 'original-files')
    : join(getProjectRoot(scope.scopeId), 'original-files');
}

/**
 * Reconcile the local original-files directory with the file/version index.
 * This is deliberately called by retrieval, rather than by a background watcher.
 */
export async function syncKnowledgeSources(
  db: Database.Database,
  scope: KnowledgeSyncScope,
  gateway: ModelGateway | null = null,
  observer?: KnowledgeSyncObserver,
  options?: KnowledgeSyncOptions,
): Promise<KnowledgeSyncResult> {
  // Retrieval tests and older local databases may not yet have the file index
  // columns. They contain no source paths to reconcile, so leave them intact
  // and let the normal search return an empty result instead of failing.
  if (!hasFilePathIndex(db)) return { changedFileIds: [], deletedFileIds: [], failedFileIds: [] };

  const fileRepo = new FileRepository(db);
  const knowledgeRepo = new KnowledgeRepository(db);
  const root = originalRoot(scope);
  const physicalPaths = await listFiles(root);
  const physicalRelPaths = new Set(physicalPaths.map((path) => relative(root, path).replaceAll('\\', '/')));
  const changedFileIds: string[] = [];

  for (const filePath of physicalPaths) {
    const normalizedPath = relative(root, filePath).replaceAll('\\', '/');
    const fingerprints = await contentFingerprints(filePath);
    let file = fileRepo.getByPath(scope.scopeType, scope.scopeId, normalizedPath);
    if (!file) {
      file = fileRepo.create({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        parentId: normalizedPath.includes('/') ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/')) : null,
        type: 'file',
        name: normalizedPath.split('/').pop() ?? normalizedPath,
        normalizedPath,
        mimeType: '',
        origin: 'upload',
      });
      fileRepo.createVersion({
        fileId: file.id,
        storageRelPath: join('.runtime', 'versions', fingerprints.sha256.slice(0, 16)),
        size: fingerprints.size,
        sha256: fingerprints.sha256,
        createdByType: 'system',
        createdById: 'knowledge-sync',
        changeNote: 'sync-before-retrieval',
      });
      changedFileIds.push(file.id);
      continue;
    }

    const current = fileRepo.getCurrentVersion(file.id);
    if (file.status === 'deleted') fileRepo.markReady(file.id);
    if (!current || current.sha256 !== fingerprints.sha256) {
      fileRepo.createVersion({
        fileId: file.id,
        storageRelPath: join('.runtime', 'versions', fingerprints.sha256.slice(0, 16)),
        size: fingerprints.size,
        sha256: fingerprints.sha256,
        createdByType: 'system',
        createdById: 'knowledge-sync',
        changeNote: 'sync-before-retrieval',
      });
      changedFileIds.push(file.id);
      continue;
    }

    const source = knowledgeRepo.getSourceByFileAndVersion(file.id, current.id);
    let deferRetry = false;
    if (source && options?.deferRecentFailures && (source.status === 'error' || source.status === 'ingesting')) {
      try {
        const job = knowledgeRepo.getLatestJobForSource(source.id);
        const updatedAt = Date.parse(job?.updatedAt ?? '');
        const delay = source.status === 'ingesting' ? 4 * 60 * 60_000 : 30 * 60_000;
        deferRetry = Number.isFinite(updatedAt) && Date.now() - updatedAt < delay;
      } catch {
        // Legacy test databases may not have the jobs table; retry as before.
      }
    }
    if ((!source || source.status !== 'ready') && !deferRetry) changedFileIds.push(file.id);
    if (source && source.contentMd5 !== fingerprints.md5) knowledgeRepo.updateSourceMetadata(source.id, { contentMd5: fingerprints.md5 });
  }

  const deletedFileIds: string[] = [];
  const indexedFiles = db.prepare(
    `SELECT DISTINCT f.id, f.normalized_path as normalizedPath FROM files f
     JOIN knowledge_sources s ON s.file_id = f.id
     WHERE f.scope_type = ? AND f.scope_id = ? AND f.type = 'file' AND f.status != 'deleted'`,
  ).all(scope.scopeType, scope.scopeId) as Array<{ id: string; normalizedPath: string }>;
  for (const file of indexedFiles) {
    if (physicalRelPaths.has(file.normalizedPath)) continue;
    fileRepo.softDelete(file.id);
    deactivateSourcesForFile(db, file.id);
    deletedFileIds.push(file.id);
  }

  const uniqueChangedFileIds = [...new Set(changedFileIds)];
  const change = { changedFileIds: uniqueChangedFileIds, deletedFileIds, failedFileIds: [] };
  if (uniqueChangedFileIds.length > 0 || deletedFileIds.length > 0) {
    await observer?.onChangesDetected?.(scope, change);
  }

  const failedFileIds: string[] = [];
  if (gateway) {
    let cursor = 0;
    const concurrency = Math.max(1, Math.min(options?.maxConcurrency ?? 2, uniqueChangedFileIds.length || 1));
    const worker = async (): Promise<void> => {
      while (cursor < uniqueChangedFileIds.length) {
        const fileId = uniqueChangedFileIds[cursor++]!;
        try { await ingestKnowledgeFile(db, gateway, fileId); } catch { failedFileIds.push(fileId); }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }
  return { changedFileIds: uniqueChangedFileIds, deletedFileIds, failedFileIds };
}

export async function refreshKnowledgeBeforeSearch(
  db: Database.Database,
  gateway: ModelGateway | null,
  projectId: string,
  observer?: KnowledgeSyncObserver,
): Promise<KnowledgeSyncResult> {
  const retrievalOptions: KnowledgeSyncOptions = { deferRecentFailures: true, maxConcurrency: 2 };
  const project = await syncKnowledgeSources(db, { scopeType: 'project', scopeId: projectId }, gateway, observer, retrievalOptions);
  const shared = await syncKnowledgeSources(db, { scopeType: 'shared', scopeId: 'shared-knowledge' }, gateway, observer, retrievalOptions);
  return {
    changedFileIds: [...new Set([...project.changedFileIds, ...shared.changedFileIds])],
    deletedFileIds: [...new Set([...project.deletedFileIds, ...shared.deletedFileIds])],
    failedFileIds: [...new Set([...project.failedFileIds, ...shared.failedFileIds])],
  };
}
