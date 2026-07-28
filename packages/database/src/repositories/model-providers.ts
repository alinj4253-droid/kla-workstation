import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BaseRepository } from './base.js';
import { notFound } from '../errors.js';

export interface ModelProviderRow {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  authType: string;
  secretRef: string | null;
  configJson: string | null;
  status: string;
  lastCheckedAt: string | null;
}

const COLS = 'id, name, type, base_url as baseUrl, auth_type as authType, secret_ref as secretRef, config_json as configJson, status, last_checked_at as lastCheckedAt';

export class ModelProviderRepository extends BaseRepository {
  constructor(db: Database.Database) { super(db); }

  list(): ModelProviderRow[] {
    return this.db.prepare(`SELECT ${COLS} FROM model_providers ORDER BY name`).all() as ModelProviderRow[];
  }

  getById(id: string): ModelProviderRow {
    const row = this.db.prepare(`SELECT ${COLS} FROM model_providers WHERE id = ?`).get(id) as ModelProviderRow | undefined;
    if (!row) throw notFound('ModelProvider', id);
    return row;
  }

  create(input: { name: string; type: string; baseUrl?: string; authType?: string; secretRef?: string; configJson?: string }): ModelProviderRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    this.db.prepare(
      `INSERT INTO model_providers (id, name, type, base_url, auth_type, secret_ref, config_json, status, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', null)`,
    ).run(id, input.name, input.type, input.baseUrl ?? null, input.authType ?? 'api-key', input.secretRef ?? null, input.configJson ?? null);
    return this.getById(id);
  }

  update(id: string, changes: { name?: string; type?: string; baseUrl?: string | null; authType?: string; configJson?: string | null; status?: string; lastCheckedAt?: string; secretRef?: string }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (changes.name !== undefined) { sets.push('name = ?'); params.push(changes.name); }
    if (changes.type !== undefined) { sets.push('type = ?'); params.push(changes.type); }
    if (changes.baseUrl !== undefined) { sets.push('base_url = ?'); params.push(changes.baseUrl); }
    if (changes.authType !== undefined) { sets.push('auth_type = ?'); params.push(changes.authType); }
    if (changes.configJson !== undefined) { sets.push('config_json = ?'); params.push(changes.configJson); }
    if (changes.status !== undefined) { sets.push('status = ?'); params.push(changes.status); }
    if (changes.lastCheckedAt !== undefined) { sets.push('last_checked_at = ?'); params.push(changes.lastCheckedAt); }
    if (changes.secretRef !== undefined) { sets.push('secret_ref = ?'); params.push(changes.secretRef); }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE model_providers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM model_providers WHERE id = ?').run(id);
  }
}
