import type Database from 'better-sqlite3';

export type CollaborationMode = 'fast' | 'balanced' | 'expert';

export function normalizeCollaborationMode(value: unknown): CollaborationMode {
  return value === 'fast' || value === 'balanced' ? value : 'expert';
}

/**
 * Every descendant run keeps the root user message as trigger_message_id, so
 * the collaboration policy can be inherited without duplicating it on runs.
 */
export function resolveCollaborationMode(
  db: Database.Database,
  triggerMessageId: string,
): CollaborationMode {
  if (!triggerMessageId) return 'expert';
  const row = db.prepare(
    'SELECT content_json as contentJson FROM messages WHERE id = ?',
  ).get(triggerMessageId) as { contentJson: string } | undefined;
  if (!row) return 'expert';
  try {
    const content = JSON.parse(row.contentJson) as { collaborationMode?: unknown };
    return normalizeCollaborationMode(content.collaborationMode);
  } catch {
    return 'expert';
  }
}
