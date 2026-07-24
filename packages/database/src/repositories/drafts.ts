import type Database from 'better-sqlite3';
import { BaseRepository } from './base.js';

export interface DraftRow {
  scope: string;
  scopeId: string;
  contentJson: string | null;
  updatedAt: string;
}

export class DraftRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  get(scope: string, scopeId: string): DraftRow {
    const row = this.db.prepare<[string, string], DraftRow | undefined>(
      'SELECT scope, scope_id as scopeId, content_json as contentJson, updated_at as updatedAt FROM drafts WHERE scope = ? AND scope_id = ?',
    ).get(scope, scopeId) as DraftRow | undefined;
    return row ?? { scope, scopeId, contentJson: null, updatedAt: this.now() };
  }

  upsert(scope: string, scopeId: string, contentJson: string): DraftRow {
    const now = this.now();
    this.db.prepare(
      `INSERT INTO drafts (scope, scope_id, content_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, scope_id) DO UPDATE SET content_json = excluded.content_json, updated_at = excluded.updated_at`,
    ).run(scope, scopeId, contentJson, now);
    return { scope, scopeId, contentJson, updatedAt: now };
  }
}
