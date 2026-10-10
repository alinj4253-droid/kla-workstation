import type { Pool } from 'pg';
import { z } from 'zod';
import type { LibraryEntry } from '@kla-workstation/contracts/knowledge';
import { hasPermission } from './permission-service.js';
import { resolveKnowledgeLibraryScope, type KnowledgeResourceScope } from './resource-scope.js';

export const libraryInputSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(80),
  description: z.string().max(500), collection: z.string().trim().min(1).max(200),
  scope: z.enum(['company', 'project', 'personal']), projectId: z.string().uuid().optional(),
});
export const libraryUpdateSchema = libraryInputSchema.pick({ id: true, name: true, description: true });

type LibraryRow = {
  id: string; name: string; description: string; collection: string;
  scope: 'company' | 'project' | 'personal'; organization_id: string | null;
  project_id: string | null; owner_identity_id: string | null;
  updated_at: Date | string; status: string;
};

function publicEntry(row: LibraryRow): LibraryEntry {
  return { id: row.id, name: row.name, description: row.description, collection: row.collection,
    scope: row.scope, projectId: row.project_id, organizationId: row.organization_id,
    personalIdentityId: row.owner_identity_id, updatedAt: new Date(row.updated_at).toISOString() };
}

async function access(pool: Pool, identityId: string, row: LibraryRow, action: 'read' | 'write'): Promise<KnowledgeResourceScope | null> {
  if (row.status !== 'active') return null;
  if (action === 'write' && !(await hasPermission(pool, identityId, 'write'))) return null;
  if (action === 'write' && row.scope === 'company' && !(await hasPermission(pool, identityId, 'manage'))) return null;
  const actual = await resolveKnowledgeLibraryScope(pool, identityId, { scope: row.scope, projectId: row.project_id }, action);
  return actual && actual.organizationId === row.organization_id && actual.projectId === row.project_id
    && actual.personalIdentityId === row.owner_identity_id ? actual : null;
}

export async function getAccessibleLibrary(pool: Pool, identityId: string, id: string, action: 'read' | 'write') {
  const row = (await pool.query<LibraryRow>('SELECT * FROM knowledge_bases WHERE id=$1', [id])).rows[0];
  if (!row) return null;
  const scope = await access(pool, identityId, row, action);
  return scope ? { entry: publicEntry(row), scope } : null;
}

export async function listAccessibleLibraries(pool: Pool, identityId: string): Promise<LibraryEntry[]> {
  const rows = (await pool.query<LibraryRow>(`SELECT k.* FROM knowledge_bases k
    JOIN identities i ON i.id=$1 AND i.status='active'
    LEFT JOIN organizations o ON o.id=i.organization_id
    WHERE k.status='active' AND (i.type='personal' OR o.status='active') AND
      (k.owner_identity_id=i.id OR (i.type='enterprise' AND k.scope='company' AND k.organization_id=i.organization_id)
      OR (k.scope='project' AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=k.project_id AND pm.identity_id=i.id)))
    ORDER BY k.updated_at DESC`, [identityId])).rows;
  const visible = await Promise.all(rows.map(async row => await access(pool, identityId, row, 'read')
    ? { ...publicEntry(row), canWrite: Boolean(await access(pool, identityId, row, 'write')) } : null));
  return visible.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

export async function createLibrary(pool: Pool, identityId: string, input: z.infer<typeof libraryInputSchema>) {
  const scope = await resolveKnowledgeLibraryScope(pool, identityId, input, 'write');
  if (!scope || (input.scope === 'company' && !(await hasPermission(pool, identityId, 'manage')))) return null;
  const row = (await pool.query<LibraryRow>(`INSERT INTO knowledge_bases
    (id,name,description,collection,scope,organization_id,project_id,owner_identity_id,created_by_identity_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [input.id, input.name, input.description, input.collection, input.scope,
    scope.organizationId, scope.projectId, scope.personalIdentityId, identityId])).rows[0]!;
  return publicEntry(row);
}

export async function updateLibrary(pool: Pool, identityId: string, input: z.infer<typeof libraryUpdateSchema>) {
  if (!(await getAccessibleLibrary(pool, identityId, input.id, 'write'))) return null;
  const row = (await pool.query<LibraryRow>(`UPDATE knowledge_bases SET name=$2,description=$3,updated_at=now()
    WHERE id=$1 AND status='active' RETURNING *`, [input.id, input.name, input.description])).rows[0];
  return row ? publicEntry(row) : null;
}

export async function disableLibrary(pool: Pool, identityId: string, id: string): Promise<boolean> {
  if (!(await getAccessibleLibrary(pool, identityId, id, 'write'))) return false;
  const row = await pool.query(`UPDATE knowledge_bases SET status='disabled',updated_at=now()
    WHERE id=$1 AND status='active' RETURNING id`, [id]);
  return Boolean(row.rows[0]);
}
