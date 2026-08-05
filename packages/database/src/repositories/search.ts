import type Database from 'better-sqlite3';
import { BaseRepository } from './base.js';

export interface SearchHit {
  kind: 'project' | 'message' | 'knowledge';
  id: string;
  title: string;
  snippet: string;
  score: number;
  projectId?: string;
  scopeType?: 'project' | 'shared';
  scopeId?: string;
}

export class SearchRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  search(query: string, limit = 20): SearchHit[] {
    const sanitized = query.replace(/['"]/g, '').trim();
    if (!sanitized) return [];
    const ftsQuery = sanitized.split(/\s+/).map((w) => `"${w}"*`).join(' OR ');
    const results: SearchHit[] = [];

    const projects = this.db.prepare(
      `SELECT p.id, p.name, p.summary, rank
       FROM project_fts
       JOIN projects p ON p.id = project_fts.id
       WHERE project_fts MATCH ? AND p.status != 'archived'
       ORDER BY rank
       LIMIT ?`,
    ).all(ftsQuery, limit) as Array<{ id: string; name: string; summary: string | null; rank: number }>;

    for (const p of projects) {
      results.push({
        kind: 'project',
        id: p.id,
        title: p.name,
        snippet: p.summary ?? '',
        score: p.rank,
      });
    }

    const messages = this.db.prepare(
      `SELECT m.id, m.project_id, snippet(message_fts, 2, '<b>', '</b>', '…', 30) as snippet, rank
       FROM message_fts
       JOIN messages m ON m.id = message_fts.id
       JOIN projects p ON p.id = m.project_id
       WHERE message_fts MATCH ? AND p.status != 'archived'
       ORDER BY rank
       LIMIT ?`,
    ).all(ftsQuery, limit) as Array<{ id: string; project_id: string; snippet: string; rank: number }>;

    for (const m of messages) {
      results.push({
        kind: 'message',
        id: m.id,
        title: `消息 (${m.project_id.slice(0, 8)}…)`,
        snippet: m.snippet.replace(/<[^>]+>/g, ''),
        score: m.rank,
        projectId: m.project_id,
      });
    }

    const chunks = this.db.prepare(
      `SELECT c.id, s.scope_type as scope_type, s.scope_id as scope_id,
              snippet(knowledge_chunk_fts, 1, '<b>', '</b>', '…', 30) as snippet, rank
       FROM knowledge_chunk_fts
       JOIN knowledge_chunks c ON c.id = knowledge_chunk_fts.id
       LEFT JOIN knowledge_sources s ON s.id = c.source_id
       WHERE knowledge_chunk_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    ).all(ftsQuery, limit) as Array<{ id: string; scope_type: 'project' | 'shared' | null; scope_id: string | null; snippet: string; rank: number }>;

    for (const c of chunks) {
      results.push({
        kind: 'knowledge',
        id: c.id,
        title: '知识片段',
        snippet: c.snippet.replace(/<[^>]+>/g, ''),
        score: c.rank,
        ...(c.scope_type ? { scopeType: c.scope_type } : {}),
        ...(c.scope_id ? { scopeId: c.scope_id } : {}),
      });
    }

    return results.sort((a, b) => a.score - b.score).slice(0, limit);
  }
}
