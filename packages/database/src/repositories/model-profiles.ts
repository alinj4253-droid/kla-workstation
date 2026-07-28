import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BaseRepository } from './base.js';
import { notFound } from '../errors.js';

export interface ModelProfileRow {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  modelSlot: string | null;
  parametersJson: string | null;
  declaredCapabilitiesJson: string | null;
  verifiedCapabilitiesJson: string | null;
  capabilityTestedAt: string | null;
  enabled: boolean;
}

const COLS = 'id, name, provider_id as providerId, model_id as modelId, model_slot as modelSlot, parameters_json as parametersJson, declared_capabilities_json as declaredCapabilitiesJson, verified_capabilities_json as verifiedCapabilitiesJson, capability_tested_at as capabilityTestedAt, enabled';

export class ModelProfileRepository extends BaseRepository {
  constructor(db: Database.Database) { super(db); }

  list(): ModelProfileRow[] {
    return this.db.prepare(`SELECT ${COLS} FROM model_profiles ORDER BY name`).all() as ModelProfileRow[];
  }

  getById(id: string): ModelProfileRow {
    const row = this.db.prepare(`SELECT ${COLS} FROM model_profiles WHERE id = ?`).get(id) as ModelProfileRow | undefined;
    if (!row) throw notFound('ModelProfile', id);
    return row;
  }

  create(input: { name: string; providerId: string; modelId: string; modelSlot?: string; parametersJson?: string; declaredCapabilitiesJson?: string }): ModelProfileRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    this.db.prepare(
      `INSERT INTO model_profiles (id, name, provider_id, model_id, model_slot, parameters_json, declared_capabilities_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(id, input.name, input.providerId, input.modelId, input.modelSlot ?? null, input.parametersJson ?? null, input.declaredCapabilitiesJson ?? null);
    return this.getById(id);
  }

  update(id: string, changes: { name?: string; providerId?: string; modelId?: string; modelSlot?: string | null }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (changes.name !== undefined) { sets.push('name = ?'); params.push(changes.name); }
    if (changes.providerId !== undefined) { sets.push('provider_id = ?'); params.push(changes.providerId); }
    if (changes.modelId !== undefined) { sets.push('model_id = ?'); params.push(changes.modelId); }
    if (changes.modelSlot !== undefined) { sets.push('model_slot = ?'); params.push(changes.modelSlot); }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE model_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  updateVerification(id: string, capabilities: string[], testedAt: string): void {
    this.db.prepare(
      'UPDATE model_profiles SET verified_capabilities_json = ?, capability_tested_at = ? WHERE id = ?',
    ).run(JSON.stringify(capabilities), testedAt, id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE model_profiles SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM model_profiles WHERE id = ?').run(id);
  }
}
