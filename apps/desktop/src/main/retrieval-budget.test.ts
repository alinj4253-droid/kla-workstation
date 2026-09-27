// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { AgentRunRepository, AgentRunRow } from '@kunqing/database';
import {
  areWebSearchQueriesEquivalent,
  reserveRetrievalBudget,
  retrievalBudgetForDelegatedNode,
} from './retrieval-budget';

function run(id: string, agentInstanceId: string, parentRunId: string | null): AgentRunRow {
  return {
    id,
    projectId: 'project-1',
    triggerMessageId: 'message-1',
    parentRunId,
    agentInstanceId,
    requestedByType: 'agent',
    requestedById: 'requester',
    instruction: 'task',
    status: 'running',
    attempt: 1,
    modelProfileSnapshotJson: null,
    startedAt: null,
    finishedAt: null,
    resultMessageId: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-08-26T00:00:00.000Z',
  };
}

describe('delegated node retrieval budget', () => {
  it('uses the fixed collaboration-mode limits', () => {
    expect(retrievalBudgetForDelegatedNode('fast')).toBe(1);
    expect(retrievalBudgetForDelegatedNode('balanced')).toBe(3);
    expect(retrievalBudgetForDelegatedNode('expert')).toBe(8);
  });

  it('shares one allowance across steps, dependencies and parallel children', () => {
    const orchestrator = run('run-orchestrator', 'agent-orchestrator', null);
    const delegatedNode = run('run-node', 'agent-researcher', orchestrator.id);
    const parallelChild = run('run-parallel', 'agent-researcher', delegatedNode.id);
    const dependencyChild = run('run-dependency', 'agent-knowledge', delegatedNode.id);
    const chains: Record<string, AgentRunRow[]> = {
      [delegatedNode.id]: [delegatedNode, orchestrator],
      [parallelChild.id]: [parallelChild, delegatedNode, orchestrator],
      [dependencyChild.id]: [dependencyChild, delegatedNode, orchestrator],
    };
    const events: Array<{ runId: string; type: string; payloadJson: string }> = [];
    const repository = {
      getAncestorChain: (runId: string) => chains[runId] ?? [],
      listEvents: (runId: string) => events
        .filter((event) => event.runId === runId)
        .map((event, index) => ({ id: String(index), runId, seq: index + 1, type: event.type, payloadJson: event.payloadJson, createdAt: '' })),
      addEvent: (runId: string, type: string, payload: unknown) => {
        events.push({ runId, type, payloadJson: JSON.stringify(payload) });
        return {};
      },
    } as unknown as AgentRunRepository;
    const db = {
      prepare: () => ({
        get: (agentInstanceId: string) => ({
          definitionId: agentInstanceId === 'agent-orchestrator' ? 'builtin.orchestrator' : 'builtin.researcher',
        }),
      }),
    } as unknown as Database.Database;

    expect(reserveRetrievalBudget(db, repository, delegatedNode.id, 'balanced', 'web', '市场规模').status).toBe('reserved');
    expect(reserveRetrievalBudget(db, repository, parallelChild.id, 'balanced', 'web', '竞争格局').status).toBe('reserved');
    expect(reserveRetrievalBudget(db, repository, dependencyChild.id, 'balanced', 'knowledge', '内部制度').status).toBe('reserved');
    expect(reserveRetrievalBudget(db, repository, delegatedNode.id, 'balanced', 'web', '政策趋势').status).toBe('exhausted');
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.runId === delegatedNode.id)).toBe(true);
  });

  it('does not spend another slot on an equivalent query', () => {
    expect(areWebSearchQueriesEquivalent('2026 上海 今日天气', '上海今日天气 2026')).toBe(true);
  });
});
