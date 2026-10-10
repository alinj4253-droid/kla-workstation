import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { resolveKnowledgeLibraryScope } from './resource-scope.js';

const identityId = '10000000-0000-4000-8000-000000000001';
const organizationId = '20000000-0000-4000-8000-000000000002';
const projectId = '30000000-0000-4000-8000-000000000003';

function pool(type: 'personal' | 'enterprise', projectRole: 'member' | 'manager' | null = null): Pool {
  return { query: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM identities i')) return { rows: [{ type, organization_id: type === 'enterprise' ? organizationId : null }] };
    if (sql.includes('FROM projects p')) return { rows: projectRole && (params[2] === 'read' || projectRole === 'manager')
      ? [{ organization_id: type === 'enterprise' ? organizationId : null }] : [] };
    return { rows: [] };
  }) } as unknown as Pool;
}

describe('knowledge library scope', () => {
  it('uses the active personal identity ID and never the account ID', async () => {
    expect(await resolveKnowledgeLibraryScope(pool('personal'), identityId, { scope: 'personal' }, 'write'))
      .toEqual({ organizationId: null, projectId: null, personalIdentityId: identityId });
    expect(await resolveKnowledgeLibraryScope(pool('enterprise'), identityId, { scope: 'personal' }, 'write')).toBeNull();
  });

  it('requires a project manager for writes and clears personal identity for project files', async () => {
    expect(await resolveKnowledgeLibraryScope(pool('enterprise', 'member'), identityId,
      { scope: 'project', projectId }, 'write')).toBeNull();
    expect(await resolveKnowledgeLibraryScope(pool('enterprise', 'manager'), identityId,
      { scope: 'project', projectId }, 'write'))
      .toEqual({ organizationId, projectId, personalIdentityId: null });
  });
});
