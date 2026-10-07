import type { Pool } from 'pg';

export type PermissionAction = 'read' | 'write' | 'execute' | 'manage' | 'export';

export async function hasPermission(pool: Pool, identityId: string, action: PermissionAction): Promise<boolean> {
  const result = await pool.query(`SELECT 1
    FROM identity_roles ir
    JOIN identities i ON i.id=ir.identity_id
    JOIN role_permissions rp ON rp.role_id=ir.role_id
    JOIN permissions p ON p.id=rp.permission_id
    LEFT JOIN organizations o ON o.id=i.organization_id
    WHERE ir.identity_id=$1 AND i.status='active' AND (i.type='personal' OR o.status='active') AND p.code=$2
    LIMIT 1`, [identityId, action]);
  if (result.rows[0]) return true;
  const identity = await pool.query("SELECT i.type FROM identities i LEFT JOIN organizations o ON o.id=i.organization_id WHERE i.id=$1 AND i.status='active' AND (i.type='personal' OR o.status='active')", [identityId]);
  // Personal identities remain usable by their owner; enterprise identities require an explicit role grant.
  return identity.rows[0]?.type === 'personal';
}

export async function requirePermission(pool: Pool, identityId: string, action: PermissionAction): Promise<void> {
  if (!(await hasPermission(pool, identityId, action))) { const error = new Error(`PERMISSION_DENIED:${action}`); error.name = 'PermissionDenied'; throw error; }
}
