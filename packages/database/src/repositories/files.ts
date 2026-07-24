import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BaseRepository } from './base.js';

export interface FileRow {
  id: string;
  scopeType: 'project' | 'shared';
  scopeId: string;
  parentId: string | null;
  type: 'file' | 'directory';
  name: string;
  normalizedPath: string;
  mimeType: string | null;
  currentVersionId: string | null;
  origin: 'upload' | 'artifact' | 'imported';
  status: 'staging' | 'ready' | 'deleted' | 'error';
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FileVersionRow {
  id: string;
  fileId: string;
  versionNo: number;
  storageRelPath: string;
  size: number;
  sha256: string;
  createdByType: 'user' | 'agent' | 'system';
  createdById: string;
  runId: string | null;
  changeNote: string | null;
  createdAt: string;
}

export interface FileEntry {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  fileId?: string;
  currentVersionId?: string;
  mimeType?: string;
  sha256?: string;
}

const FILE_COLUMNS = 'id, scope_type as scopeType, scope_id as scopeId, parent_id as parentId, type, name, normalized_path as normalizedPath, mime_type as mimeType, current_version_id as currentVersionId, origin, status, created_at as createdAt, updated_at as updatedAt, deleted_at as deletedAt';

export class FileRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  getByPath(scopeType: 'project' | 'shared', scopeId: string, normalizedPath: string): FileRow | null {
    const row = this.db.prepare(
      `SELECT ${FILE_COLUMNS} FROM files WHERE scope_type = ? AND scope_id = ? AND normalized_path = ?`,
    ).get(scopeType, scopeId, normalizedPath) as FileRow | undefined;
    return row ?? null;
  }

  getById(id: string): FileRow | null {
    const row = this.db.prepare(
      `SELECT ${FILE_COLUMNS} FROM files WHERE id = ?`,
    ).get(id) as FileRow | undefined;
    return row ?? null;
  }

  listByParent(scopeType: 'project' | 'shared', scopeId: string, parentPath: string): FileEntry[] {
    const rows = this.db.prepare(
      `SELECT ${FILE_COLUMNS} FROM files WHERE scope_type = ? AND scope_id = ? AND status = 'ready' AND parent_id IS NOT DISTINCT FROM ? ORDER BY type = 'directory' DESC, updated_at DESC`,
    ).all(scopeType, scopeId, parentPath || null) as FileRow[];

    return rows.map((r) => {
      const entry: FileEntry = {
        name: r.name,
        relativePath: r.normalizedPath,
        kind: r.type,
        size: 0,
        modifiedAt: r.updatedAt,
        fileId: r.id,
      };
      if (r.currentVersionId) entry.currentVersionId = r.currentVersionId;
      if (r.mimeType) entry.mimeType = r.mimeType;
      return entry;
    });
  }

  listByScope(scopeType: 'project' | 'shared', scopeId: string): FileRow[] {
    return this.db.prepare(
      `SELECT ${FILE_COLUMNS} FROM files WHERE scope_type = ? AND scope_id = ? AND status = 'ready' ORDER BY type = 'directory' DESC, updated_at DESC`,
    ).all(scopeType, scopeId) as FileRow[];
  }

  create(input: {
    scopeType: 'project' | 'shared';
    scopeId: string;
    parentId?: string | null;
    type: 'file' | 'directory';
    name: string;
    normalizedPath: string;
    mimeType?: string;
    origin?: 'upload' | 'artifact' | 'imported';
  }): FileRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    this.db.prepare(
      `INSERT INTO files (id, scope_type, scope_id, parent_id, type, name, normalized_path, mime_type, origin, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    ).run(
      id,
      input.scopeType,
      input.scopeId,
      input.parentId ?? null,
      input.type,
      input.name,
      input.normalizedPath,
      input.mimeType ?? null,
      input.origin ?? 'upload',
      now,
      now,
    );
    return this.getById(id)!;
  }

  update(id: string, changes: { name?: string; normalizedPath?: string; mimeType?: string; status?: 'staging' | 'ready' | 'deleted' | 'error'; currentVersionId?: string | null; parentId?: string | null }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (changes.name !== undefined) { sets.push('name = ?'); params.push(changes.name); }
    if (changes.normalizedPath !== undefined) { sets.push('normalized_path = ?'); params.push(changes.normalizedPath); }
    if (changes.mimeType !== undefined) { sets.push('mime_type = ?'); params.push(changes.mimeType); }
    if (changes.status !== undefined) { sets.push('status = ?'); params.push(changes.status); }
    if (changes.currentVersionId !== undefined) { sets.push('current_version_id = ?'); params.push(changes.currentVersionId); }
    if (changes.parentId !== undefined) { sets.push('parent_id = ?'); params.push(changes.parentId); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(this.now(), id);
    this.db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  softDelete(id: string): void {
    const now = this.now();
    this.db.prepare("UPDATE files SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  }

  markReady(id: string): void {
    const now = this.now();
    this.db.prepare("UPDATE files SET status = 'ready', updated_at = ? WHERE id = ?").run(now, id);
  }

  getCurrentVersion(fileId: string): FileVersionRow | null {
    const row = this.db.prepare(
      `SELECT fv.id, fv.file_id as fileId, fv.version_no as versionNo, fv.storage_rel_path as storageRelPath, fv.size, fv.sha256, fv.created_by_type as createdByType, fv.created_by_id as createdById, fv.run_id as runId, fv.change_note as changeNote, fv.created_at as createdAt
       FROM file_versions fv JOIN files f ON f.id = fv.file_id
       WHERE fv.file_id = ? AND fv.id = f.current_version_id`,
    ).get(fileId) as FileVersionRow | undefined;
    return row ?? null;
  }

  listVersions(fileId: string): FileVersionRow[] {
    return this.db.prepare(
      `SELECT id, file_id as fileId, version_no as versionNo, storage_rel_path as storageRelPath, size, sha256, created_by_type as createdByType, created_by_id as createdById, run_id as runId, change_note as changeNote, created_at as createdAt
       FROM file_versions WHERE file_id = ? ORDER BY version_no DESC`,
    ).all(fileId) as FileVersionRow[];
  }

  createVersion(input: {
    fileId: string;
    storageRelPath: string;
    size: number;
    sha256: string;
    createdByType: 'user' | 'agent' | 'system';
    createdById: string;
    runId?: string;
    changeNote?: string;
  }): FileVersionRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    const maxVersion = this.db.prepare(
      'SELECT MAX(version_no) as mv FROM file_versions WHERE file_id = ?',
    ).get(input.fileId) as { mv: number | null };
    const versionNo = (maxVersion?.mv ?? 0) + 1;

    this.db.prepare(
      `INSERT INTO file_versions (id, file_id, version_no, storage_rel_path, size, sha256, created_by_type, created_by_id, run_id, change_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.fileId, versionNo, input.storageRelPath, input.size, input.sha256, input.createdByType, input.createdById, input.runId ?? null, input.changeNote ?? null, now);

    this.db.prepare('UPDATE files SET current_version_id = ?, updated_at = ? WHERE id = ?').run(id, now, input.fileId);
    return this.getVersion(id)!;
  }

  getVersion(id: string): FileVersionRow | null {
    const row = this.db.prepare(
      `SELECT id, file_id as fileId, version_no as versionNo, storage_rel_path as storageRelPath, size, sha256, created_by_type as createdByType, created_by_id as createdById, run_id as runId, change_note as changeNote, created_at as createdAt
       FROM file_versions WHERE id = ?`,
    ).get(id) as FileVersionRow | undefined;
    return row ?? null;
  }

  existsByPath(scopeType: 'project' | 'shared', scopeId: string, normalizedPath: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM files WHERE scope_type = ? AND scope_id = ? AND normalized_path = ? AND status = ?',
    ).get(scopeType, scopeId, normalizedPath, 'ready') as Record<string, unknown> | undefined;
    return !!row;
  }
}
