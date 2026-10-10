import type { Pool } from 'pg';

export type KnowledgeAccessScope = {
  identityId: string;
  personalIdentityId: string | null;
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
    personalIdentityId: row.type === 'personal' ? row.id : null,
    organizationId: row.type === 'enterprise' ? row.organization_id : null,
    projectIds: projects.rows.map(item => item.project_id),
  };
}

export type KnowledgeResourceScope = {
  organizationId: string | null;
  projectId: string | null;
  personalIdentityId: string | null;
};

export async function resolveKnowledgeLibraryScope(
  pool: Pool,
  identityId: string,
  input: { scope: 'company' | 'project' | 'personal'; projectId?: string | null },
  action: 'read' | 'write',
): Promise<KnowledgeResourceScope | null> {
  const identity = await pool.query<{ type: string; organization_id: string | null }>(`SELECT i.type,i.organization_id FROM identities i
    LEFT JOIN organizations o ON o.id=i.organization_id
    WHERE i.id=$1 AND i.status='active' AND (i.type='personal' OR o.status='active')`, [identityId]);
  const row = identity.rows[0];
  if (!row) return null;
  if (input.scope === 'personal') return row.type === 'personal'
    ? { organizationId: null, projectId: null, personalIdentityId: identityId } : null;
  if (input.scope === 'company') return row.type === 'enterprise' && row.organization_id
    ? { organizationId: row.organization_id, projectId: null, personalIdentityId: null } : null;
  if (!input.projectId) return null;
  const project = await pool.query<{ organization_id: string | null }>(`SELECT p.organization_id FROM projects p
    JOIN project_members pm ON pm.project_id=p.id AND pm.identity_id=$2
    WHERE p.id=$1 AND ($3='read' OR pm.role IN ('owner','manager'))
      AND (p.organization_id IS NULL AND $4='personal' AND p.owner_identity_id=$2
        OR p.organization_id=$5::uuid AND $4='enterprise')`,
  [input.projectId, identityId, action, row.type, row.organization_id]);
  if (!project.rows[0]) return null;
  return { organizationId: project.rows[0].organization_id, projectId: input.projectId, personalIdentityId: null };
}

export async function resolveConversationKnowledgeScope(pool: Pool, identityId: string, conversationId: string): Promise<KnowledgeResourceScope | null> {
  const result = await pool.query<{ organization_id: string | null; project_id: string; type: string }>(`SELECT p.organization_id,c.project_id,i.type
    FROM conversations c JOIN projects p ON p.id=c.project_id
    JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.project_id=p.id AND cm.identity_id=$2
    JOIN project_members pm ON pm.project_id=p.id AND pm.identity_id=$2
    JOIN identities i ON i.id=$2 AND i.status='active'
    LEFT JOIN organizations o ON o.id=i.organization_id
    WHERE c.id=$1 AND (p.organization_id IS NULL AND i.type='personal' AND p.owner_identity_id=i.id
      OR p.organization_id=i.organization_id AND i.type='enterprise' AND o.status='active')`,
  [conversationId, identityId]);
  const row = result.rows[0];
  return row ? { organizationId: row.organization_id, projectId: row.project_id,
    personalIdentityId: row.type === 'personal' ? identityId : null } : null;
}
