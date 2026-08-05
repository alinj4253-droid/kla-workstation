import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BaseRepository } from './base.js';

export interface MemoryRecordRow {
  id: string;
  projectId: string;
  agentInstanceId: string;
  scope: 'short-term' | 'long-term';
  type: string;
  content: string;
  confidence: number;
  importance: number;
  pinned: boolean;
  topicKey: string | null;
  sourceRefsJson: string | null;
  metadataJson: string | null;
  status: 'active' | 'expired' | 'deleted' | 'consolidated' | 'superseded';
  expiresAt: string | null;
  lastReinforcedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  consolidatedIntoId: string | null;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
}

const COLS = `id, project_id as projectId, agent_instance_id as agentInstanceId, scope, type, content,
  confidence, importance, pinned, topic_key as topicKey, source_refs_json as sourceRefsJson,
  metadata_json as metadataJson, status, expires_at as expiresAt, last_reinforced_at as lastReinforcedAt,
  last_accessed_at as lastAccessedAt, access_count as accessCount,
  consolidated_into_id as consolidatedIntoId, supersedes_id as supersedesId,
  created_at as createdAt, updated_at as updatedAt`;

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
    importance?: number; pinned?: boolean; topicKey?: string; metadataJson?: string;
    expiresAt?: string; lastReinforcedAt?: string; consolidatedIntoId?: string; supersedesId?: string;
  }): MemoryRecordRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    this.db.prepare(
      `INSERT INTO memory_records (
        id, project_id, agent_instance_id, scope, type, content, confidence, importance, pinned,
        topic_key, source_refs_json, metadata_json, status, expires_at, last_reinforced_at,
        last_accessed_at, access_count, consolidated_into_id, supersedes_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, 0, ?, ?, ?, ?)`,
    ).run(
      id, input.projectId, input.agentInstanceId, input.scope, input.type, input.content,
      input.confidence ?? 1, input.importance ?? 0.5, input.pinned ? 1 : 0,
      input.topicKey ?? null, input.sourceRefsJson ?? null, input.metadataJson ?? null,
      input.expiresAt ?? null, input.lastReinforcedAt ?? now,
      input.consolidatedIntoId ?? null, input.supersedesId ?? null, now, now,
    );
    return this.get(id)!;
  }

  update(id: string, changes: {
    content?: string; confidence?: number; importance?: number; pinned?: boolean; topicKey?: string | null;
    sourceRefsJson?: string | null; metadataJson?: string | null;
    status?: 'active' | 'expired' | 'deleted' | 'consolidated' | 'superseded';
    expiresAt?: string | null; lastReinforcedAt?: string; lastAccessedAt?: string | null; accessCount?: number;
    consolidatedIntoId?: string | null; supersedesId?: string | null;
  }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (changes.content !== undefined) { sets.push('content = ?'); params.push(changes.content); }
    if (changes.confidence !== undefined) { sets.push('confidence = ?'); params.push(changes.confidence); }
    if (changes.importance !== undefined) { sets.push('importance = ?'); params.push(changes.importance); }
    if (changes.pinned !== undefined) { sets.push('pinned = ?'); params.push(changes.pinned ? 1 : 0); }
    if (changes.topicKey !== undefined) { sets.push('topic_key = ?'); params.push(changes.topicKey); }
    if (changes.sourceRefsJson !== undefined) { sets.push('source_refs_json = ?'); params.push(changes.sourceRefsJson); }
    if (changes.metadataJson !== undefined) { sets.push('metadata_json = ?'); params.push(changes.metadataJson); }
    if (changes.status !== undefined) { sets.push('status = ?'); params.push(changes.status); }
    if (changes.expiresAt !== undefined) { sets.push('expires_at = ?'); params.push(changes.expiresAt); }
    if (changes.lastReinforcedAt !== undefined) { sets.push('last_reinforced_at = ?'); params.push(changes.lastReinforcedAt); }
    if (changes.lastAccessedAt !== undefined) { sets.push('last_accessed_at = ?'); params.push(changes.lastAccessedAt); }
    if (changes.accessCount !== undefined) { sets.push('access_count = ?'); params.push(changes.accessCount); }
    if (changes.consolidatedIntoId !== undefined) { sets.push('consolidated_into_id = ?'); params.push(changes.consolidatedIntoId); }
    if (changes.supersedesId !== undefined) { sets.push('supersedes_id = ?'); params.push(changes.supersedesId); }
    if (sets.length === 0) return;
    const now = this.now();
    sets.push('updated_at = ?');
    params.push(now, id);
    this.db.prepare(`UPDATE memory_records SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  markAccessed(ids: string[], at: string): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE memory_records SET last_accessed_at = ?, access_count = access_count + 1 WHERE id IN (${placeholders})`,
    ).run(at, ...ids);
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
