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

  createUserMessage(projectId: string, contentJson: string, id?: string): { id: string; status: string; createdAt: string } {
    const msgId = id ?? randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    this.db.prepare(
      `INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at)
       VALUES (?, ?, 'user', 'local-user', 'text', ?, 'sent', ?, ?)`,
    ).run(msgId, projectId, contentJson, now, now);
    return { id: msgId, status: 'sent', createdAt: now };
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
