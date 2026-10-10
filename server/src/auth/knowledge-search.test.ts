import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { scopedSearchInputSchema, searchScopedKnowledge } from './knowledge-search.js';

const identityId = '10000000-0000-4000-8000-000000000001';
const organizationId = '20000000-0000-4000-8000-000000000002';
const projectId = '30000000-0000-4000-8000-000000000003';
const companyId = '40000000-0000-4000-8000-000000000004';
const projectLibraryId = '50000000-0000-4000-8000-000000000005';
const personalId = '60000000-0000-4000-8000-000000000006';
const base = { name: '库', description: '', collection: 'shared', updated_at: new Date(), status: 'active' };
const company = { ...base, id: companyId, scope: 'company', organization_id: organizationId, project_id: null, personal_identity_id: null };
const project = { ...base, id: projectLibraryId, scope: 'project', organization_id: organizationId, project_id: projectId, personal_identity_id: null };

function poolForEnterprise(): Pool {
  return {
    hasPermission: () => true,
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM conversations c')) return { rows: [{ organization_id: organizationId, project_id: projectId, type: 'enterprise' }] };
      if (sql.includes('SELECT k.* FROM knowledge_library_scopes')) return { rows: [company, project] };
      if (sql.includes('SELECT i.type,i.organization_id')) return { rows: [{ type: 'enterprise', organization_id: organizationId }] };
      if (sql.includes('SELECT p.organization_id FROM projects')) return { rows: [{ organization_id: organizationId }] };
      return { rows: [] };
    }),
  } as unknown as Pool;
}

describe('scoped knowledge search', () => {
  it('requires exactly one trusted library or conversation context', () => {
    expect(scopedSearchInputSchema.safeParse({ query: 'test' }).success).toBe(false);
    expect(scopedSearchInputSchema.safeParse({ query: 'test', knowledgeBaseId: companyId, conversationId: projectId }).success).toBe(false);
  });

  it('resolves an enterprise conversation without a personal identity scope', async () => {
    const transport = vi.fn(async (collection: string) => ({ query: '验收', mode: 'hybrid', collection,
      permission_filtered: true, hits: [{ doc_id: 'doc', knowledge_base_id: projectLibraryId, collection,
        rank: 1, title: '项目资料', content: '验收规则', score: 0.9 }] }));
    const result = await searchScopedKnowledge(poolForEnterprise(), identityId,
      scopedSearchInputSchema.parse({ query: '验收', conversationId: projectId }), transport);
    expect(result.hits).toHaveLength(1);
    expect(transport).toHaveBeenCalledWith('shared', expect.objectContaining({ organization_id: organizationId,
      project_id: projectId, personal_identity_id: null, knowledge_base_ids: [companyId, projectLibraryId] }));
  });

  it('rejects missing prefilter proof and hits from another library', async () => {
    const input = scopedSearchInputSchema.parse({ query: '验收', conversationId: projectId });
    const response = { query: '验收', mode: 'hybrid', collection: 'shared', permission_filtered: true,
      hits: [{ doc_id: 'doc', knowledge_base_id: personalId, collection: 'shared', rank: 1,
        title: '私有资料', content: 'secret', score: 0.9 }] };
    await expect(searchScopedKnowledge(poolForEnterprise(), identityId, input, async () => ({ ...response, permission_filtered: undefined })))
      .rejects.toThrow('KNOWLEDGE_SCOPE_PROTOCOL');
    await expect(searchScopedKnowledge(poolForEnterprise(), identityId, input, async () => response))
      .rejects.toThrow('KNOWLEDGE_SCOPE_PROTOCOL');
  });
});
