import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BaseRepository } from './base.js';

export interface MessageRow {
  id: string;
  projectId: string;
  senderType: string;
  senderId: string;
  kind: string;
  contentJson: string;
  status: string;
  replyToId: string | null;
  createdAt: string;
}

export interface MessagePage {
  messages: MessageRow[];
  hasMore: boolean;
}

export class MessageRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  listByProject(projectId: string, before?: string, limit = 50): MessagePage {
    const sql = `SELECT id, project_id as projectId, sender_type as senderType, sender_id as senderId,
                        kind, content_json as contentJson, status, reply_to_id as replyToId, created_at as createdAt
                 FROM messages
                 WHERE project_id = ?${before ? ' AND created_at < ?' : ''}
                 ORDER BY created_at DESC
                 LIMIT ?`;
    const params: unknown[] = [projectId];
    if (before) params.push(before);
    params.push(limit);
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as MessageRow[];
    return { messages: rows.reverse(), hasMore: rows.length === limit };
  }

  createUserMessage(projectId: string, contentJson: string, id?: string, replyToId?: string | null): { id: string; status: string; createdAt: string; created: boolean; replyToId: string | null } {
    const msgId = id ?? randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    const inserted = this.db.prepare(
      `INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, reply_to_id, created_at, updated_at)
       VALUES (?, ?, 'user', 'local-user', 'text', ?, 'sent', ?, ?, ?)`,
    ).run(msgId, projectId, contentJson, replyToId ?? null, now, now);
    // Some lightweight test adapters do not return better-sqlite3's RunResult.
    // A missing result means the adapter accepted the write.
    const created = inserted?.changes !== 0;
    if (!created) {
      const existing = this.db.prepare(
        'SELECT status, reply_to_id as replyToId, created_at as createdAt FROM messages WHERE id = ?',
      ).get(msgId) as { status: string; replyToId: string | null; createdAt: string } | undefined;
      if (existing) return { id: msgId, status: existing.status, createdAt: existing.createdAt, created: false, replyToId: existing.replyToId };
    }
    return { id: msgId, status: 'sent', createdAt: now, created, replyToId: replyToId ?? null };
  }

  createArtifactMessage(projectId: string, filePath: string, fileId: string, versionId: string, senderId = 'file-watcher'): { id: string; status: string; createdAt: string } {
    const msgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    const contentJson = JSON.stringify({ schemaVersion: 1, text: filePath, fileId, versionId });
    this.db.prepare(
      `INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at)
       VALUES (?, ?, 'agent', ?, 'artifact', ?, 'sent', ?, ?)`,
    ).run(msgId, projectId, senderId, contentJson, now, now);
    this.db.prepare(
      `INSERT INTO message_attachments (message_id, file_id, version_id, ordinal) VALUES (?, ?, ?, 0)`,
    ).run(msgId, fileId, versionId);
    return { id: msgId, status: 'sent', createdAt: now };
  }
}
