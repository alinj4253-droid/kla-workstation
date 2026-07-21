import type Database from 'better-sqlite3';
import { BaseRepository } from './base';
import { notFound } from '../errors';

export interface AgentProfileRow {
  id: string;
  name: string;
  definitionId: string;
  definitionVersion: string;
  runtimeMode: string;
  enabled: boolean;
  isSystemDefault: boolean;
}

export class AgentProfileRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  getById(id: string): AgentProfileRow {
    const row = this.db.prepare<[string], AgentProfileRow | undefined>(
      `SELECT id, name, definition_id as definitionId, definition_version as definitionVersion,
              runtime_mode as runtimeMode, enabled, is_system_default as isSystemDefault
        FROM agent_profiles WHERE id = ?`,
    ).get(id) as AgentProfileRow | undefined;
    if (!row) throw notFound('AgentProfile', id);
    return row;
  }

  listByEnabled(): AgentProfileRow[] {
    return this.db.prepare<[], AgentProfileRow>(
      `SELECT id, name, definition_id as definitionId, definition_version as definitionVersion,
              runtime_mode as runtimeMode, enabled, is_system_default as isSystemDefault
       FROM agent_profiles WHERE enabled = 1 ORDER BY name`,
    ).all() as AgentProfileRow[];
  }

  getSystemDefaultLeader(): AgentProfileRow | undefined {
    return this.db.prepare<[], AgentProfileRow | undefined>(
      `SELECT id, name, definition_id as definitionId, definition_version as definitionVersion,
              runtime_mode as runtimeMode, enabled, is_system_default as isSystemDefault
       FROM agent_profiles WHERE is_system_default = 1 AND runtime_mode = 'native-model'
       LIMIT 1`,
    ).get() as AgentProfileRow | undefined;
  }
}
