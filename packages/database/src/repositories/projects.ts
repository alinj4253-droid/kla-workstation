import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BaseRepository } from './base';
import { conflict, notFound } from '../errors';

export interface ProjectRow {
  id: string;
  name: string;
  status: string;
  summary: string | null;
  lastActiveAt: string;
  createdAt: string;
  sharedKnowledgeEnabled: boolean;
}

export class ProjectRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  list(status?: string, limit = 50, offset = 0): ProjectRow[] {
    const sql = `SELECT id, name, status, summary, last_active_at as lastActiveAt, created_at as createdAt, shared_knowledge_enabled as sharedKnowledgeEnabled
                 FROM projects
                 ${status ? 'WHERE status = ?' : ''}
                 ORDER BY last_active_at DESC
                 LIMIT ? OFFSET ?`;
    const params: unknown[] = [];
    if (status) params.push(status);
    params.push(limit, offset);
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as ProjectRow[];
  }

  getById(id: string): ProjectRow {
    const row = this.db.prepare<[string], ProjectRow | undefined>(
      `SELECT id, name, status, summary, last_active_at as lastActiveAt, created_at as createdAt, shared_knowledge_enabled as sharedKnowledgeEnabled
       FROM projects WHERE id = ?`,
    ).get(id) as ProjectRow | undefined;
    if (!row) throw notFound('Project', id);
    return row;
  }

  create(name: string, id?: string): { id: string; status: string; createdAt: string } {
    const projectId = id ?? randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    try {
      this.db.prepare(
        `INSERT INTO projects (id, name, status, summary, created_at, updated_at, last_active_at)
         VALUES (?, ?, 'active', '', ?, ?, ?)`,
      ).run(projectId, name, now, now, now);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT') {
        throw conflict('Project', `id ${projectId} already exists`);
      }
      throw err;
    }
    return { id: projectId, status: 'active', createdAt: now };
  }

  updateLastActive(id: string): void {
    this.db.prepare('UPDATE projects SET last_active_at = ?, updated_at = ? WHERE id = ?')
      .run(this.now(), this.now(), id);
  }

  rename(id: string, name: string): void {
    this.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, this.now(), id);
  }

  archive(id: string): void {
    const now = this.now();
    this.db.prepare(`UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, id);
  }

  restore(id: string): void {
    this.db.prepare(`UPDATE projects SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?`)
      .run(this.now(), id);
  }

  setSharedKnowledgeEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE projects SET shared_knowledge_enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, this.now(), id);
  }
}
