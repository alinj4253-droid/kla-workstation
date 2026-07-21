import type Database from 'better-sqlite3';
import { BaseRepository } from './base';

export interface WikiPageRow {
  id: string;
  scopeType: string;
  scopeId: string;
  slug: string;
  title: string;
  bodyMd: string | null;
  sourceRefsJson: string | null;
  updatedAt: string;
}

const COLS = 'id, scope_type as scopeType, scope_id as scopeId, slug, title, body_md as bodyMd, source_refs_json as sourceRefsJson, updated_at as updatedAt';

export class WikiRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  list(scopeType: string, scopeId: string): WikiPageRow[] {
    return this.db.prepare(
      `SELECT ${COLS} FROM wiki_pages WHERE scope_type = ? AND scope_id = ? ORDER BY slug`,
    ).all(scopeType, scopeId) as WikiPageRow[];
  }

  getBySlug(scopeType: string, scopeId: string, slug: string): WikiPageRow | null {
    const row = this.db.prepare(
      `SELECT ${COLS} FROM wiki_pages WHERE scope_type = ? AND scope_id = ? AND slug = ?`,
    ).get(scopeType, scopeId, slug) as WikiPageRow | undefined;
    return row ?? null;
  }

  getById(id: string): WikiPageRow | null {
    const row = this.db.prepare(
      `SELECT ${COLS} FROM wiki_pages WHERE id = ?`,
    ).get(id) as WikiPageRow | undefined;
    return row ?? null;
  }
}
