import type Database from 'better-sqlite3';
import type { AgentRunRepository } from '@kunqing/database';
import type { CollaborationMode } from './collaboration-mode';

export type RetrievalKind = 'web' | 'knowledge';

export type RetrievalBudgetUsage = {
  total: number;
  web: number;
  knowledge: number;
  queries: Record<RetrievalKind, string[]>;
};

export type RetrievalReservation = {
  status: 'reserved' | 'duplicate' | 'exhausted';
  ownerRunId: string;
  usage: RetrievalBudgetUsage;
  budget: number;
};

const RETRIEVAL_BUDGET_EVENT = 'retrieval.budget-consumed';

export function retrievalBudgetForDelegatedNode(mode: CollaborationMode = 'expert'): number {
  if (mode === 'fast') return 1;
  if (mode === 'balanced') return 3;
  return 8;
}

function normalizedSearchQuery(query: string): string {
  return query.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function areWebSearchQueriesEquivalent(left: string, right: string): boolean {
  const a = normalizedSearchQuery(left);
  const b = normalizedSearchQuery(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.82) return true;
  const aChars = new Set(a);
  const bChars = new Set(b);
  const intersection = [...aChars].filter((char) => bChars.has(char)).length;
  const union = new Set([...aChars, ...bChars]).size;
  return union > 0 && intersection / union >= 0.86;
}

function isOrchestratorInstance(db: Database.Database, agentInstanceId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT ap.definition_id as definitionId
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = ?`,
    ).get(agentInstanceId) as { definitionId: string } | undefined;
    return row?.definitionId === 'builtin.orchestrator';
  } catch {
    return false;
  }
}

/**
 * The first specialist Run below an orchestrator owns the allowance. All of
 * its steps, retries, dependency handoffs and parallel children share it.
 */
export function resolveRetrievalBudgetOwnerRunId(
  db: Database.Database,
  runRepo: AgentRunRepository,
  runId: string,
): string {
  const chain = runRepo.getAncestorChain(runId);
  for (let index = 0; index < chain.length - 1; index++) {
    const parent = chain[index + 1]!;
    if (isOrchestratorInstance(db, parent.agentInstanceId)) return chain[index]!.id;
  }
  return chain.at(-1)?.id ?? runId;
}

export function readRetrievalBudgetUsage(
  runRepo: AgentRunRepository,
  ownerRunId: string,
): RetrievalBudgetUsage {
  const usage: RetrievalBudgetUsage = {
    total: 0,
    web: 0,
    knowledge: 0,
    queries: { web: [], knowledge: [] },
  };
  for (const event of runRepo.listEvents(ownerRunId)) {
    if (event.type !== RETRIEVAL_BUDGET_EVENT || !event.payloadJson) continue;
    try {
      const payload = JSON.parse(event.payloadJson) as { kind?: unknown; query?: unknown };
      if (payload.kind !== 'web' && payload.kind !== 'knowledge') continue;
      usage.total += 1;
      usage[payload.kind] += 1;
      if (typeof payload.query === 'string' && payload.query.trim()) {
        usage.queries[payload.kind].push(payload.query.trim());
      }
    } catch { /* ignore malformed historical events */ }
  }
  return usage;
}

export function reserveRetrievalBudget(
  db: Database.Database,
  runRepo: AgentRunRepository,
  runId: string,
  mode: CollaborationMode,
  kind: RetrievalKind,
  query: string,
): RetrievalReservation {
  const ownerRunId = resolveRetrievalBudgetOwnerRunId(db, runRepo, runId);
  const budget = retrievalBudgetForDelegatedNode(mode);
  const usage = readRetrievalBudgetUsage(runRepo, ownerRunId);
  const normalizedQuery = query.trim();
  if (normalizedQuery && usage.queries[kind].some((previous) => areWebSearchQueriesEquivalent(previous, normalizedQuery))) {
    return { status: 'duplicate', ownerRunId, usage, budget };
  }
  if (usage.total >= budget) return { status: 'exhausted', ownerRunId, usage, budget };

  runRepo.addEvent(ownerRunId, RETRIEVAL_BUDGET_EVENT, {
    sourceRunId: runId,
    kind,
    query: normalizedQuery.slice(0, 1_000),
    mode,
    ordinal: usage.total + 1,
    budget,
  });
  const nextUsage: RetrievalBudgetUsage = {
    total: usage.total + 1,
    web: usage.web + (kind === 'web' ? 1 : 0),
    knowledge: usage.knowledge + (kind === 'knowledge' ? 1 : 0),
    queries: {
      web: [...usage.queries.web, ...(kind === 'web' && normalizedQuery ? [normalizedQuery] : [])],
      knowledge: [...usage.queries.knowledge, ...(kind === 'knowledge' && normalizedQuery ? [normalizedQuery] : [])],
    },
  };
  return { status: 'reserved', ownerRunId, usage: nextUsage, budget };
}
