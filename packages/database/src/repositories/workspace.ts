import type Database from 'better-sqlite3';
import { BaseRepository } from './base.js';

export class WorkspaceRegistryRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  getCurrent(): { workspaceId: string; rootPathHash: string; schemaVersion: number } | undefined {
    return this.db.prepare<[], {
      workspaceId: string;
      rootPathHash: string;
      schemaVersion: number;
    } | undefined>(
      'SELECT workspace_id as workspaceId, root_path_hash as rootPathHash, schema_version as schemaVersion FROM workspace_registry LIMIT 1',
    ).get() as { workspaceId: string; rootPathHash: string; schemaVersion: number } | undefined;
  }

  upsert(workspaceId: string, rootPathHash: string, schemaVersion = 1): void {
    const now = this.now();
    this.db.prepare(
      `INSERT INTO workspace_registry (workspace_id, root_path_hash, schema_version, created_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET root_path_hash = excluded.root_path_hash, schema_version = excluded.schema_version, last_opened_at = excluded.last_opened_at`,
    ).run(workspaceId, rootPathHash, schemaVersion, now, now);
  }
}
