import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BaseRepository } from './base';

export interface MemoryRecordRow {
  id: string;
  projectId: string;
  agentInstanceId: string;
  scope: 'short-term' | 'long-term';
  type: string;
  content: string;
  confidence: number;
  sourceRefsJson: string | null;
  status: 'active' | 'expired' | 'deleted';
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const COLS = 'id, project_id as projectId, agent_instance_id as agentInstanceId, scope, type, content, confidence, source_refs_json as sourceRefsJson, status, expires_at as expiresAt, created_at as createdAt, updated_at as updatedAt';

export class MemoryRepository extends BaseRepository {
  constructor(db: Database.Database) { super(db); }

  list(projectId: string, agentInstanceId: string, scope?: string, status?: string): MemoryRecordRow[] {
    const clauses = ['project_id = ?', 'agent_instance_id = ?'];
    const params: unknown[] = [projectId, agentInstanceId];
    if (scope) { clauses.push('scope = ?'); params.push(scope); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    return this.db.prepare(`SELECT ${COLS} FROM memory_records WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`).all(...params) as MemoryRecordRow[];
  }

  get(id: string): MemoryRecordRow | null {
    const row = this.db.prepare(`SELECT ${COLS} FROM memory_records WHERE id = ?`).get(id) as MemoryRecordRow | undefined;
    return row ?? null;
  }

  create(input: {
    projectId: string; agentInstanceId: string; scope: 'short-term' | 'long-term';
    type: string; content: string; confidence?: number; sourceRefsJson?: string;
    expiresAt?: string;
  }): MemoryRecordRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    this.db.prepare(
      `INSERT INTO memory_records (id, project_id, agent_instance_id, scope, type, content, confidence, source_refs_json, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(id, input.projectId, input.agentInstanceId, input.scope, input.type, input.content, input.confidence ?? 1, input.sourceRefsJson ?? null, input.expiresAt ?? null, now, now);
    return this.get(id)!;
  }

  update(id: string, changes: { content?: string; confidence?: number; status?: 'active' | 'expired' | 'deleted' }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (changes.content !== undefined) { sets.push('content = ?'); params.push(changes.content); }
    if (changes.confidence !== undefined) { sets.push('confidence = ?'); params.push(changes.confidence); }
    if (changes.status !== undefined) { sets.push('status = ?'); params.push(changes.status); }
    if (sets.length === 0) return;
    const now = this.now();
    sets.push('updated_at = ?');
    params.push(now, id);
    this.db.prepare(`UPDATE memory_records SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  remove(id: string): void {
    this.db.prepare("UPDATE memory_records SET status = 'deleted', updated_at = ? WHERE id = ?").run(this.now(), id);
  }

  expireAll(agentInstanceId: string): void {
    const now = this.now();
    this.db.prepare(
      "UPDATE memory_records SET status = 'expired', updated_at = ? WHERE agent_instance_id = ? AND scope = 'short-term' AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
    ).run(now, agentInstanceId, now);
  }
}
