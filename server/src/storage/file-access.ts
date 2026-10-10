import type { Pool, PoolClient } from 'pg';
import { canAccessConversation } from '../auth/resource-scope.js';

export async function accessibleFile(pool: Pool | PoolClient, identityId: string, fileId: string) {
  const row = (await pool.query('SELECT f.*,w.identity_id AS workspace_identity_id FROM files f LEFT JOIN workspaces w ON w.id=f.workspace_id WHERE f.id=$1', [fileId])).rows[0];
  if (!row) return null;
  if (row.conversation_id) return await canAccessConversation(pool as Pool, identityId, row.conversation_id) ? row : null;
  return (row.identity_id ?? row.workspace_identity_id) === identityId ? row : null;
}

export function fileView(row: Record<string, any>) {
  return { id: row.id, workspaceId: row.workspace_id, conversationId: row.conversation_id ?? null,
    name: row.name, storageKey: row.storage_key, checksum: row.checksum, contentType: row.content_type,
    sizeBytes: Number(row.size_bytes), status: row.status, contentUrl: `/api/v1/files/${row.id}/content`,
    createdAt: new Date(row.created_at).toISOString() };
}

/** Validate every reference before storing a message; clients cannot grant file access. */
export async function messageFileReferences(pool: Pool, identityId: string, conversationId: string, fileIds: string[]) {
  const files = [];
  for (const fileId of fileIds) {
    const file = await accessibleFile(pool, identityId, fileId);
    if (!file || file.conversation_id !== conversationId || file.status !== 'uploaded') throw new Error('FILE_SCOPE_DENIED');
    files.push({ id: file.id, name: file.name, contentType: file.content_type, sizeBytes: Number(file.size_bytes) });
  }
  return files;
}

export async function uploadScope(pool: Pool | PoolClient, identityId: string, row: Record<string, any>) {
  if (row.conversation_id) return canAccessConversation(pool as Pool, identityId, row.conversation_id);
  return Boolean((await pool.query('SELECT id FROM workspaces WHERE id=$1 AND identity_id=$2', [row.workspace_id, identityId])).rows[0]);
}
