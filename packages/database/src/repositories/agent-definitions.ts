import type Database from 'better-sqlite3';
import { BaseRepository } from './base';
import { notFound } from '../errors';

export interface AgentDefinitionRow {
  id: string;
  version: string;
  kind: string;
  manifestRelPath: string;
  checksum: string;
  frameworkEntry: string | null;
  maxPermissionsJson: string | null;
  modelRequirementsJson: string | null;
  isBuiltin: boolean;
  installedAt: string;
}

const COLS = 'id, version, kind, manifest_rel_path as manifestRelPath, checksum, framework_entry as frameworkEntry, max_permissions_json as maxPermissionsJson, model_requirements_json as modelRequirementsJson, is_builtin as isBuiltin, installed_at as installedAt';

export class AgentDefinitionRepository extends BaseRepository {
  constructor(db: Database.Database) { super(db); }

  list(): AgentDefinitionRow[] {
    return this.db.prepare(`SELECT ${COLS} FROM agent_definitions ORDER BY id`).all() as AgentDefinitionRow[];
  }

  getById(id: string, version?: string): AgentDefinitionRow {
    const row = version
      ? this.db.prepare(`SELECT ${COLS} FROM agent_definitions WHERE id = ? AND version = ?`).get(id, version) as AgentDefinitionRow | undefined
      : this.db.prepare(`SELECT ${COLS} FROM agent_definitions WHERE id = ? ORDER BY version DESC`).get(id) as AgentDefinitionRow | undefined;
    if (!row) throw notFound('AgentDefinition', id);
    return row;
  }

  create(input: { id: string; version?: string; kind?: string; manifestRelPath?: string; checksum?: string; frameworkEntry?: string | null; isBuiltin?: boolean }): AgentDefinitionRow {
    const now = this.now();
    this.db.prepare(
      `INSERT INTO agent_definitions (id, version, kind, manifest_rel_path, checksum, framework_entry, max_permissions_json, model_requirements_json, is_builtin, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id, input.version ?? '1.0.0', input.kind ?? 'builtin', input.manifestRelPath ?? '',
      input.checksum ?? '', input.frameworkEntry ?? null, null, null, input.isBuiltin ? 1 : 0, now,
    );
    return this.getById(input.id);
  }
}
