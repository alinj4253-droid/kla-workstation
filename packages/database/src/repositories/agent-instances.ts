import type Database from 'better-sqlite3';
import { BaseRepository } from './base.js';

export interface AgentInstanceRow {
  id: string;
  projectId: string;
  agentProfileId: string;
  definitionId: string | null;
  definitionVersion: string | null;
  role: string;
  runtimeMode: string;
  modelProfileId: string | null;
  cliConnectionId: string | null;
  identityRelPath: string | null;
  memoryRelPath: string | null;
  effectivePermissionsJson: string | null;
  ordinal: number;
  createdAt: string;
}

export class AgentInstanceRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  create(input: {
    id: string;
    projectId: string;
    agentProfileId: string;
    definitionId: string;
    definitionVersion: string;
    role: 'leader' | 'teammate';
    runtimeMode: 'native-model' | 'external-cli';
    identityRelPath?: string;
    memoryRelPath?: string;
    ordinal: number;
  }): void {
    const now = this.now();
    this.db.prepare(
      `INSERT INTO project_agent_instances
       (id, project_id, agent_profile_id, definition_id, definition_version, role, runtime_mode,
        identity_rel_path, memory_rel_path, ordinal, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id, input.projectId, input.agentProfileId,
      input.definitionId, input.definitionVersion, input.role, input.runtimeMode,
      input.identityRelPath ?? null, input.memoryRelPath ?? null,
      input.ordinal, now,
    );
  }

  listByProject(projectId: string): AgentInstanceRow[] {
    return this.db.prepare<[string], AgentInstanceRow>(
      `SELECT id, project_id as projectId, agent_profile_id as agentProfileId,
              definition_id as definitionId, definition_version as definitionVersion,
              role, runtime_mode as runtimeMode, model_profile_id as modelProfileId,
              cli_connection_id as cliConnectionId, identity_rel_path as identityRelPath,
              memory_rel_path as memoryRelPath, effective_permissions_json as effectivePermissionsJson,
              ordinal, created_at as createdAt
       FROM project_agent_instances
       WHERE project_id = ?
       ORDER BY ordinal ASC`,
    ).all(projectId) as AgentInstanceRow[];
  }

  getById(id: string): AgentInstanceRow | undefined {
    return this.db.prepare<[string], AgentInstanceRow | undefined>(
      `SELECT id, project_id as projectId, agent_profile_id as agentProfileId,
              definition_id as definitionId, definition_version as definitionVersion,
              role, runtime_mode as runtimeMode, model_profile_id as modelProfileId,
              cli_connection_id as cliConnectionId, identity_rel_path as identityRelPath,
              memory_rel_path as memoryRelPath, effective_permissions_json as effectivePermissionsJson,
              ordinal, created_at as createdAt
        FROM project_agent_instances WHERE id = ?`,
    ).get(id) as AgentInstanceRow | undefined;
  }
}
