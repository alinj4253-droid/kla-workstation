import type { Pool } from 'pg';

export type PermissionAction = 'read' | 'write' | 'execute' | 'manage' | 'export';

export class PermissionDeniedError extends Error {
  constructor(public readonly action: PermissionAction) {
    super(`PERMISSION_DENIED:${action}`);
    this.name = 'PermissionDenied';
  }
}

// `manage` is the administrative superset of resource operations. Older
// enterprise roles were often provisioned with `manage` but without the newer
// granular `write` grant; treating it as an implication keeps those identities
// usable without weakening member-level permissions.
const effectivePermissionCodes = (action: PermissionAction): PermissionAction[] =>
  action === 'manage' ? ['manage'] : [action, 'manage'];

export async function hasPermission(pool: Pool, identityId: string, action: PermissionAction): Promise<boolean> {
  // Mock mode exposes the same policy through a small in-memory adapter. Keep
  // this check here so routes continue to use one authorization service in
  // both mock and PostgreSQL deployments.
  const mockPool = pool as Pool & { hasPermission?: (identityId: string, action: PermissionAction) => boolean | Promise<boolean> };
  if (typeof mockPool.hasPermission === 'function') return Boolean(await mockPool.hasPermission(identityId, action));
  const result = await pool.query(`SELECT 1
    FROM identity_roles ir
    JOIN identities i ON i.id=ir.identity_id
    JOIN role_permissions rp ON rp.role_id=ir.role_id
    JOIN permissions p ON p.id=rp.permission_id
    LEFT JOIN organizations o ON o.id=i.organization_id
    WHERE ir.identity_id=$1 AND i.status='active' AND (i.type='personal' OR o.status='active') AND p.code = ANY($2::text[])
    LIMIT 1`, [identityId, effectivePermissionCodes(action)]);
  if (result.rows[0]) return true;
  const identity = await pool.query("SELECT i.type FROM identities i LEFT JOIN organizations o ON o.id=i.organization_id WHERE i.id=$1 AND i.status='active' AND (i.type='personal' OR o.status='active')", [identityId]);
  // Personal identities remain usable by their owner; enterprise identities require an explicit role grant.
  return identity.rows[0]?.type === 'personal';
}

export async function requirePermission(pool: Pool, identityId: string, action: PermissionAction): Promise<void> {
  if (!(await hasPermission(pool, identityId, action))) throw new PermissionDeniedError(action);
}
