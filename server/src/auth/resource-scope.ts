import type { Pool } from 'pg';

export type KnowledgeAccessScope = {
  identityId: string;
  personalIdentityId: string;
  organizationId: string | null;
  projectIds: string[];
};

export async function canManageProject(pool: Pool, identityId: string, projectId: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM project_members pm
    JOIN projects p ON p.id=pm.project_id
    JOIN identities i ON i.id=pm.identity_id AND i.status='active'
    WHERE pm.project_id=$1 AND pm.identity_id=$2 AND pm.role IN ('owner','manager')
      AND (p.organization_id IS NULL AND i.type='personal' AND p.owner_identity_id=i.id
        OR p.organization_id=i.organization_id AND i.type='enterprise') LIMIT 1`, [projectId, identityId]);
  return Boolean(result.rows[0]);
}

export async function canAccessConversation(pool: Pool, identityId: string, conversationId: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM conversation_members cm
    JOIN conversations c ON c.id=cm.conversation_id AND c.project_id=cm.project_id
    JOIN project_members pm ON pm.project_id=cm.project_id AND pm.identity_id=cm.identity_id
    JOIN projects p ON p.id=cm.project_id
    JOIN identities i ON i.id=cm.identity_id AND i.status='active'
    WHERE cm.conversation_id=$1 AND cm.identity_id=$2
      AND (p.organization_id IS NULL AND i.type='personal' AND p.owner_identity_id=i.id
        OR p.organization_id=i.organization_id AND i.type='enterprise') LIMIT 1`, [conversationId, identityId]);
  return Boolean(result.rows[0]);
}

// This is the server-authoritative scope to attach to future search, upload and preview calls.
// A project is included only while this identity belongs to at least one of its group chats.
export async function resolveKnowledgeAccessScope(pool: Pool, identityId: string): Promise<KnowledgeAccessScope | null> {
  const identity = await pool.query<{ id: string; type: string; organization_id: string | null }>(`SELECT i.id,i.type,i.organization_id FROM identities i
    LEFT JOIN organizations o ON o.id=i.organization_id
    WHERE i.id=$1 AND i.status='active' AND (i.type='personal' OR o.status='active')`, [identityId]);
  const row = identity.rows[0];
  if (!row) return null;
  const projects = await pool.query<{ project_id: string }>(`SELECT DISTINCT p.id AS project_id FROM project_members pm
    JOIN projects p ON p.id=pm.project_id
    JOIN conversation_members cm ON cm.project_id=p.id AND cm.identity_id=pm.identity_id
    WHERE pm.identity_id=$1 AND
      (p.organization_id IS NULL AND $2='personal' AND p.owner_identity_id=$1
        OR p.organization_id=$3::uuid AND $2='enterprise')
    ORDER BY project_id`, [identityId, row.type, row.organization_id]);
  return {
    identityId: row.id,
    personalIdentityId: row.id,
    organizationId: row.type === 'enterprise' ? row.organization_id : null,
    projectIds: projects.rows.map(item => item.project_id),
  };
}
