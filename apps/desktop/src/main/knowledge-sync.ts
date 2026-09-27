import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { FileRepository, KnowledgeRepository } from '@kunqing/database';
import type { ModelGateway } from './model-gateway';
import { resolveAssociatedEnterpriseProjectId } from './enterprise-project-workspace';
import { getEnterpriseProjectRoot, getEnterpriseWorkspaceRoot, getProjectRoot } from './paths';
import { contentFingerprints, ingestKnowledgeFile } from './knowledge-ingestion';

export type KnowledgeWorkspaceType = 'group' | 'enterprise-project' | 'enterprise';
export type KnowledgeSyncScope = {
  scopeType: 'project' | 'shared';
  scopeId: string;
  workspaceType?: KnowledgeWorkspaceType;
};
export type KnowledgeSyncResult = { changedFileIds: string[]; deletedFileIds: string[]; failedFileIds: string[] };
export type KnowledgeSyncOptions = {
  retryIncompleteSources?: boolean;
  retrySourceStatuses?: Array<'pending' | 'error'>;
  maxConcurrency?: number;
};
export type KnowledgeSyncObserver = {
  onChangesDetected?: (scope: KnowledgeSyncScope, change: KnowledgeSyncResult) => void | Promise<void>;
};

export type BackgroundKnowledgeSyncStatus = {
  scopeType: KnowledgeSyncScope['scopeType'];
  scopeId: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  error?: string;
};

const backgroundKnowledgeSyncs = new Map<string, BackgroundKnowledgeSyncStatus>();

function backgroundSyncKey(scope: KnowledgeSyncScope): string {
  return `${scope.workspaceType ?? scope.scopeType}:${scope.scopeId}`;
}

function emptySyncResult(): KnowledgeSyncResult {
  return { changedFileIds: [], deletedFileIds: [], failedFileIds: [] };
}

export function getBackgroundKnowledgeSyncStatus(scope: KnowledgeSyncScope): BackgroundKnowledgeSyncStatus {
  return backgroundKnowledgeSyncs.get(backgroundSyncKey(scope)) ?? {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    status: 'idle',
    totalFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
  };
}

export function isBackgroundKnowledgeSyncRunning(scope: KnowledgeSyncScope): boolean {
  return getBackgroundKnowledgeSyncStatus(scope).status === 'running';
}

export function startBackgroundKnowledgeSync(
  db: Database.Database,
  gateway: ModelGateway | null,
  scope: KnowledgeSyncScope,
): BackgroundKnowledgeSyncStatus {
  const key = backgroundSyncKey(scope);
  const current = backgroundKnowledgeSyncs.get(key);
  if (current?.status === 'running') return current;

  const state: BackgroundKnowledgeSyncStatus = {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    status: gateway ? 'running' : 'failed',
    startedAt: new Date().toISOString(),
    ...(!gateway ? { finishedAt: new Date().toISOString(), error: '尚未配置可用于知识处理的模型' } : {}),
    totalFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
  };
  backgroundKnowledgeSyncs.set(key, state);
  if (!gateway) return state;

  void syncKnowledgeSources(db, scope, gateway, {
    onChangesDetected: (_changedScope, change) => {
      state.totalFiles = change.changedFileIds.length + change.deletedFileIds.length;
    },
  }, { retryIncompleteSources: true, retrySourceStatuses: ['pending', 'error'], maxConcurrency: 2 }).then((result) => {
    state.status = result.failedFileIds.length > 0 ? 'failed' : 'completed';
    state.finishedAt = new Date().toISOString();
    state.totalFiles = Math.max(state.totalFiles, result.changedFileIds.length + result.deletedFileIds.length);
    state.failedFiles = result.failedFileIds.length;
    state.completedFiles = Math.max(0, result.changedFileIds.length - result.failedFileIds.length) + result.deletedFileIds.length;
    if (result.failedFileIds.length > 0) state.error = `${result.failedFileIds.length} 个文件知识化失败`;
  }).catch((error: unknown) => {
    state.status = 'failed';
    state.finishedAt = new Date().toISOString();
    state.error = error instanceof Error ? error.message : String(error);
  });
  return state;
}

export function getKnowledgeProcessingCoverage(db: Database.Database, projectId: string): {
  processingFileCount: number;
  backgroundRunning: boolean;
} {
  const scopes = resolveKnowledgeScopesForGroup(db, projectId);
  const runningStates = scopes.map((scope) => getBackgroundKnowledgeSyncStatus(scope))
    .filter((state) => state.status === 'running');
  let databaseCount = 0;
  try {
    const where = scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
    const params = scopes.flatMap((scope) => [scope.scopeType, scope.scopeId]);
    databaseCount = (db.prepare(
      `SELECT COUNT(DISTINCT file_id) AS count
       FROM knowledge_sources
       WHERE status IN ('pending', 'ingesting')
         AND (${where})`,
    ).get(...params) as { count: number }).count;
  } catch {
    databaseCount = 0;
  }
  const mapCount = runningStates.reduce((total, state) => total + Math.max(0, state.totalFiles - state.completedFiles), 0);
  return {
    processingFileCount: Math.max(databaseCount, mapCount),
    backgroundRunning: runningStates.length > 0,
  };
}

export function recoverInterruptedKnowledgeIngestions(db: Database.Database): number {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT source_id as sourceId
       FROM knowledge_ingestion_jobs
       WHERE status = 'running'`,
    ).all() as Array<{ sourceId: string }>;
    if (rows.length === 0) return 0;

    const now = new Date().toISOString();
    const sourceIds = rows.map((row) => row.sourceId);
    const placeholders = sourceIds.map(() => '?').join(', ');
    db.transaction(() => {
      db.prepare(
        `UPDATE knowledge_ingestion_jobs
         SET status = 'failed', stage = 'interrupted', error_code = 'APP_RESTARTED', updated_at = ?
         WHERE status = 'running'`,
      ).run(now);
      db.prepare(
        `UPDATE knowledge_sources
         SET status = 'error', ingested_at = NULL
         WHERE status = 'ingesting' AND id IN (${placeholders})`,
      ).run(...sourceIds);
    })();
    return rows.length;
  } catch {
    return 0;
  }
}

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

function workspaceTypeFor(db: Database.Database, scope: KnowledgeSyncScope): KnowledgeWorkspaceType {
  if (scope.workspaceType) return scope.workspaceType;
  if (scope.scopeType === 'shared') return 'enterprise';
  try {
    const project = db.prepare('SELECT 1 FROM enterprise_projects WHERE id = ?').get(scope.scopeId);
    if (project) return 'enterprise-project';
  } catch { /* databases created before project workspaces */ }
  return 'group';
}

function originalRoot(db: Database.Database, scope: KnowledgeSyncScope): string {
  const workspaceType = workspaceTypeFor(db, scope);
  if (workspaceType === 'enterprise') return join(getEnterpriseWorkspaceRoot(), 'original-files');
  if (workspaceType === 'enterprise-project') return join(getEnterpriseProjectRoot(scope.scopeId), 'original-files');
  return join(getProjectRoot(scope.scopeId), 'original-files');
}

export function resolveKnowledgeScopesForGroup(db: Database.Database, groupId: string): KnowledgeSyncScope[] {
  const scopes: KnowledgeSyncScope[] = [
    { scopeType: 'project', scopeId: groupId, workspaceType: 'group' },
  ];
  const enterpriseProjectId = resolveAssociatedEnterpriseProjectId(db, 'group', groupId);
  if (enterpriseProjectId) {
    scopes.push({ scopeType: 'project', scopeId: enterpriseProjectId, workspaceType: 'enterprise-project' });
  }
  scopes.push({ scopeType: 'shared', scopeId: 'shared-knowledge', workspaceType: 'enterprise' });
  return scopes;
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
  const root = originalRoot(db, scope);
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
    const restored = file.status === 'deleted';
    if (restored) fileRepo.markReady(file.id);
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
    if (restored) {
      changedFileIds.push(file.id);
      continue;
    }

    const source = knowledgeRepo.getSourceByFileAndVersion(file.id, current.id);
    const retryIncompleteSource = options?.retryIncompleteSources ?? true;
    const retrySourceStatuses = options?.retrySourceStatuses
      ?? (retryIncompleteSource ? ['pending', 'error'] : ['pending']);
    // A file can already be registered by the upload path before its first
    // knowledge_source is created. Missing sources are always a real ingest
    // gap; retryIncompleteSources only controls retries of an existing
    // non-ready source during a retrieval refresh.
    if (!source || retrySourceStatuses.includes(source.status as 'pending' | 'error')) changedFileIds.push(file.id);
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
  const retrievalOptions: KnowledgeSyncOptions = {
    retryIncompleteSources: false,
    retrySourceStatuses: ['pending'],
    maxConcurrency: 2,
  };
  const scopes = resolveKnowledgeScopesForGroup(db, projectId);
  // A user-triggered background sync deliberately does not block chat retrieval.
  // The search path reads only ready sources and leaves the running scope alone.
  const results: KnowledgeSyncResult[] = [];
  for (const scope of scopes) {
    results.push(isBackgroundKnowledgeSyncRunning(scope)
      ? emptySyncResult()
      : await syncKnowledgeSources(db, scope, gateway, observer, retrievalOptions));
  }
  return {
    changedFileIds: [...new Set(results.flatMap((result) => result.changedFileIds))],
    deletedFileIds: [...new Set(results.flatMap((result) => result.deletedFileIds))],
    failedFileIds: [...new Set(results.flatMap((result) => result.failedFileIds))],
  };
}
