import type { Pool } from 'pg';
import { z } from 'zod';
import { getAccessibleLibrary, listAccessibleLibraries } from './knowledge-libraries.js';
import { resolveConversationKnowledgeScope, type KnowledgeResourceScope } from './resource-scope.js';

export const scopedSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(10000), mode: z.enum(['hybrid', 'vector', 'keyword']).default('hybrid'),
  topK: z.number().int().min(1).max(20).default(5),
  expand: z.number().int().min(0).max(2).default(0), foldAdjacent: z.boolean().default(true),
  knowledgeBaseId: z.string().uuid().optional(), conversationId: z.string().uuid().optional(),
}).refine(input => Boolean(input.knowledgeBaseId) !== Boolean(input.conversationId), 'Specify one search context');

export async function resolveSearchTargets(pool: Pool, identityId: string, input: Pick<z.infer<typeof scopedSearchInputSchema>, 'knowledgeBaseId' | 'conversationId'>) {
  let scope: KnowledgeResourceScope;
  let libraries;
  if (input.knowledgeBaseId) {
    const library = await getAccessibleLibrary(pool, identityId, input.knowledgeBaseId, 'read');
    if (!library) return null;
    scope = library.scope;
    libraries = [library.entry];
  } else {
    const conversation = await resolveConversationKnowledgeScope(pool, identityId, input.conversationId!);
    if (!conversation) return null;
    scope = conversation;
    const visible = await listAccessibleLibraries(pool, identityId);
    libraries = visible.filter(library => library.scope === 'company'
      ? Boolean(scope.organizationId && library.organizationId === scope.organizationId)
      : library.scope === 'project' ? library.projectId === scope.projectId
        : Boolean(scope.personalIdentityId && library.personalIdentityId === scope.personalIdentityId));
  }
  return { scope, libraries };
}

const hitSchema = z.object({ doc_id: z.string().min(1), knowledge_base_id: z.string().uuid(),
  collection: z.string(), rank: z.number().int().positive(), title: z.string(), content: z.string(), score: z.number().finite(),
  source: z.string().nullish(), slice_index: z.number().int().nonnegative().nullish() }).passthrough();
const responseSchema = z.object({ query: z.string(), collection: z.string(), mode: z.string(),
  permission_filtered: z.literal(true), hits: z.array(hitSchema) });

export async function searchScopedKnowledge(
  pool: Pool, identityId: string, input: z.infer<typeof scopedSearchInputSchema>,
  transport: (collection: string, payload: Record<string, unknown>) => Promise<unknown>,
) {
  const targets = await resolveSearchTargets(pool, identityId, input);
  if (!targets) throw new Error('KNOWLEDGE_SCOPE_DENIED');
  const grouped = new Map<string, string[]>();
  for (const library of targets.libraries) grouped.set(library.collection, [...(grouped.get(library.collection) ?? []), library.id]);
  const ranked: Array<z.infer<typeof hitSchema> & { rankScore: number }> = [];
  for (const [collection, ids] of grouped) {
    const raw = await transport(collection, { query: input.query, collection, mode: input.mode, top_k: input.topK,
      expand: input.expand, fold_adjacent: input.foldAdjacent,
      organization_id: targets.scope.organizationId, project_id: targets.scope.projectId,
      personal_identity_id: targets.scope.personalIdentityId, knowledge_base_ids: ids });
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.query !== input.query || parsed.data.collection !== collection || parsed.data.mode !== input.mode
      || parsed.data.hits.some(hit => !ids.includes(hit.knowledge_base_id) || hit.collection !== collection)) {
      throw new Error('KNOWLEDGE_SCOPE_PROTOCOL');
    }
    ranked.push(...parsed.data.hits.map(hit => ({ ...hit, rankScore: 1 / (60 + hit.rank) })));
  }
  ranked.sort((a, b) => b.rankScore - a.rankScore);
  return { query: input.query, mode: input.mode, collection: targets.libraries.length === 1 ? targets.libraries[0]!.collection : '',
    hits: ranked.slice(0, input.topK).map((hit, index) => { const { rankScore: _score, ...rest } = hit; return { ...rest, rank: index + 1 }; }) };
}
