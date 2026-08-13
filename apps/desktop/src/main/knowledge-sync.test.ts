// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => process.cwd()), getAppPath: vi.fn(() => process.cwd()) },
}));
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRepository, KnowledgeRepository } from '@kunqing/database';
import { setStudioRoot } from './paths';
import {
  recoverInterruptedKnowledgeIngestions,
  refreshKnowledgeBeforeSearch,
  syncKnowledgeSources,
} from './knowledge-sync';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, parent_id TEXT,
      type TEXT NOT NULL, name TEXT NOT NULL, normalized_path TEXT NOT NULL, mime_type TEXT,
      current_version_id TEXT, origin TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE UNIQUE INDEX idx_files_scope_path ON files(scope_type, scope_id, normalized_path);
    CREATE TABLE file_versions (
      id TEXT PRIMARY KEY, file_id TEXT NOT NULL, version_no INTEGER NOT NULL, storage_rel_path TEXT NOT NULL,
      size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_by_type TEXT NOT NULL, created_by_id TEXT NOT NULL,
      run_id TEXT, change_note TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_sources (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, file_id TEXT NOT NULL,
      version_id TEXT, sha256 TEXT, content_md5 TEXT, parser_id TEXT, metadata_json TEXT,
      status TEXT NOT NULL, ingested_at TEXT
    );
    CREATE TABLE knowledge_ingestion_jobs (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, source_id TEXT NOT NULL,
      status TEXT NOT NULL, stage TEXT, progress INTEGER, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('knowledge source synchronization', () => {
  let db: Database.Database;
  let studioRoot: string;
  let originalRoot: string;

  beforeEach(async () => {
    db = createDb();
    studioRoot = await mkdtemp(join(tmpdir(), 'kunqing-knowledge-sync-'));
    setStudioRoot(studioRoot);
    originalRoot = join(studioRoot, 'group-chats', 'project-1-workspace', 'original-files');
    await mkdir(originalRoot, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    setStudioRoot('');
    await rm(studioRoot, { recursive: true, force: true });
  });

  it('tracks new and changed originals, preserves generated files, and deactivates every removed source', async () => {
    const fileRepo = new FileRepository(db);
    const knowledgeRepo = new KnowledgeRepository(db);
    const artifact = fileRepo.create({
      scopeType: 'project', scopeId: 'project-1', type: 'file', name: 'report.html',
      normalizedPath: 'outputs/report.html', origin: 'artifact',
    });
    await writeFile(join(originalRoot, 'brief.txt'), 'version one', 'utf8');

    const first = await syncKnowledgeSources(db, { scopeType: 'project', scopeId: 'project-1' });
    expect(first.changedFileIds).toHaveLength(1);
    const original = fileRepo.getByPath('project', 'project-1', 'brief.txt');
    expect(original?.currentVersionId).toBeTruthy();
    const firstVersionId = original!.currentVersionId!;

    const sourceOne = knowledgeRepo.createSource({
      scopeType: 'project', scopeId: 'project-1', fileId: original!.id, versionId: firstVersionId,
    });
    const sourceTwo = knowledgeRepo.createSource({
      scopeType: 'project', scopeId: 'project-1', fileId: original!.id, versionId: firstVersionId,
    });
    knowledgeRepo.setSourceStatus(sourceOne.id, 'ready');
    knowledgeRepo.setSourceStatus(sourceTwo.id, 'ready');

    const unchanged = await syncKnowledgeSources(db, { scopeType: 'project', scopeId: 'project-1' });
    expect(unchanged.changedFileIds).toHaveLength(0);
    await writeFile(join(originalRoot, 'brief.txt'), 'version two', 'utf8');
    const changed = await syncKnowledgeSources(db, { scopeType: 'project', scopeId: 'project-1' });
    expect(changed.changedFileIds).toEqual([original!.id]);
    expect(fileRepo.listVersions(original!.id)).toHaveLength(2);

    await rm(join(originalRoot, 'brief.txt'));
    const removed = await syncKnowledgeSources(db, { scopeType: 'project', scopeId: 'project-1' });
    expect(removed.deletedFileIds).toEqual([original!.id]);
    expect(fileRepo.getById(original!.id)?.status).toBe('deleted');
    expect(knowledgeRepo.listSources('project', 'project-1').map((source) => source.status)).toEqual(['error', 'error']);
    expect(fileRepo.getById(artifact.id)?.status).toBe('ready');

    await writeFile(join(originalRoot, 'brief.txt'), 'version two', 'utf8');
    const restored = await refreshKnowledgeBeforeSearch(db, null, 'project-1');
    expect(restored.changedFileIds).toEqual([original!.id]);
    expect(fileRepo.getById(original!.id)?.status).toBe('ready');
  });

  it('checks both the current group and shared originals before retrieval', async () => {
    const sharedRoot = join(studioRoot, 'shared-knowledge', 'original-files');
    await mkdir(sharedRoot, { recursive: true });
    await Promise.all([
      writeFile(join(originalRoot, 'group.txt'), 'group evidence', 'utf8'),
      writeFile(join(sharedRoot, 'shared.txt'), 'shared evidence', 'utf8'),
    ]);

    const result = await refreshKnowledgeBeforeSearch(db, null, 'project-1');
    expect(result.changedFileIds).toHaveLength(2);
    expect(new FileRepository(db).getByPath('shared', 'shared-knowledge', 'shared.txt')).not.toBeNull();
  });

  it('ingests an uploaded file that has a current version but no knowledge source', async () => {
    const fileRepo = new FileRepository(db);
    const content = 'uploaded evidence';
    await writeFile(join(originalRoot, 'uploaded-after-registration.txt'), content, 'utf8');

    // Mirror the upload flow: file/version rows exist, while ingestion has
    // not started yet and therefore no knowledge_sources row exists.
    const file = fileRepo.create({
      scopeType: 'project', scopeId: 'project-1', type: 'file',
      name: 'uploaded-after-registration.txt',
      normalizedPath: 'uploaded-after-registration.txt', origin: 'upload',
    });
    fileRepo.createVersion({
      fileId: file.id, storageRelPath: 'original-files/uploaded-after-registration.txt',
      size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
      createdByType: 'user', createdById: 'user',
      changeNote: 'upload',
    });

    const refreshed = await refreshKnowledgeBeforeSearch(db, null, 'project-1');
    expect(refreshed.changedFileIds).toContain(file.id);
  });

  it('does not retry an unchanged incomplete source during retrieval but allows explicit processing', async () => {
    await writeFile(join(originalRoot, 'retry.txt'), 'retry evidence', 'utf8');
    await syncKnowledgeSources(db, { scopeType: 'project', scopeId: 'project-1' });
    const file = new FileRepository(db).getByPath('project', 'project-1', 'retry.txt')!;
    const repo = new KnowledgeRepository(db);
    const source = repo.createSource({
      scopeType: 'project', scopeId: 'project-1', fileId: file.id, versionId: file.currentVersionId!,
    });
    repo.setSourceStatus(source.id, 'ingesting');
    const job = repo.createJob({ scopeType: 'project', scopeId: 'project-1', sourceId: source.id });
    repo.setJobStatus(job.id, 'running', { stage: 'parsing', progress: 5 });

    const deferred = await refreshKnowledgeBeforeSearch(db, null, 'project-1');
    expect(deferred.changedFileIds).toEqual([]);

    const explicit = await syncKnowledgeSources(db, { scopeType: 'project', scopeId: 'project-1' });
    expect(explicit.changedFileIds).toEqual([file.id]);
  });

  it('marks orphaned ingestion jobs as interrupted without deleting existing knowledge', async () => {
    await writeFile(join(originalRoot, 'orphaned.txt'), 'existing evidence', 'utf8');
    await syncKnowledgeSources(db, { scopeType: 'project', scopeId: 'project-1' });
    const file = new FileRepository(db).getByPath('project', 'project-1', 'orphaned.txt')!;
    const repo = new KnowledgeRepository(db);
    const source = repo.createSource({
      scopeType: 'project', scopeId: 'project-1', fileId: file.id, versionId: file.currentVersionId!,
    });
    repo.setSourceStatus(source.id, 'ingesting');
    const job = repo.createJob({ scopeType: 'project', scopeId: 'project-1', sourceId: source.id });
    repo.setJobStatus(job.id, 'running', { stage: 'parsing', progress: 5 });

    expect(recoverInterruptedKnowledgeIngestions(db)).toBe(1);
    expect(repo.getSource(source.id)?.status).toBe('error');
    expect(repo.getLatestJobForSource(source.id)).toMatchObject({
      status: 'failed', stage: 'interrupted', errorCode: 'APP_RESTARTED',
    });
    expect(new FileRepository(db).getById(file.id)?.status).toBe('ready');
  });
});
