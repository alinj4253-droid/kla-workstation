import { describe, expect, it } from 'vitest';
import { MemoryManager, memoryTimeScore, rankMemories } from '../src/manager';
import type { IMemoryRepository } from '../src/repository';
import type { MemoryRecord, CreateMemoryInput } from '../src/types';

function createMockRepo(): IMemoryRepository {
  let nextId = 1;
  const records: MemoryRecord[] = [];
  return {
    list(_projectId, _agentInstanceId, scope, status) {
      return records.filter((r) =>
        (!scope || r.scope === scope) && (!status || r.status === status),
      );
    },
    get(id) { return records.find((r) => r.id === id) ?? null; },
    create(input: CreateMemoryInput): MemoryRecord {
      const id = `mem-${nextId++}`;
      const now = new Date().toISOString();
      const record: MemoryRecord = {
        id,
        projectId: input.projectId,
        agentInstanceId: input.agentInstanceId,
        scope: input.scope,
        type: input.type,
        content: input.content,
        confidence: input.confidence ?? 0.5,
        importance: input.importance ?? 0.5,
        pinned: input.pinned ?? false,
        topicKey: input.topicKey ?? null,
        sourceRefsJson: input.sourceRefsJson ?? null,
        metadataJson: input.metadataJson ?? null,
        status: 'active',
        expiresAt: input.expiresAt ?? null,
        lastReinforcedAt: input.lastReinforcedAt ?? now,
        lastAccessedAt: null,
        accessCount: 0,
        consolidatedIntoId: input.consolidatedIntoId ?? null,
        supersedesId: input.supersedesId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      records.push(record);
      return record;
    },
    update(id, changes) {
      const r = records.find((r) => r.id === id);
      if (r) Object.assign(r, changes, { updatedAt: new Date().toISOString() });
    },
    markAccessed(ids, at) {
      for (const record of records.filter((item) => ids.includes(item.id))) {
        record.lastAccessedAt = at;
        record.accessCount += 1;
      }
    },
    remove(id) {
      const idx = records.findIndex((r) => r.id === id);
      if (idx >= 0) records.splice(idx, 1);
    },
    expireAll(agentInstanceId) {
      for (const r of records) {
        if (r.agentInstanceId === agentInstanceId) {
          (r as MemoryRecord).status = 'expired';
        }
      }
    },
  };
}

describe('MemoryManager', () => {
  it('creates a short-term memory record', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);

    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'User asked about X', 0.7);

    const records = repo.list('proj-1', 'agent-1', 'short-term');
    expect(records).toHaveLength(1);
    expect(records[0]!.content).toBe('User asked about X');
    expect(records[0]!.confidence).toBe(0.7);
  });

  it('storeShortTerm uses default confidence 0.5', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);

    const record = manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'Default');
    expect(record.confidence).toBe(0.5);
  });

  it('consolidateShortTerm returns 0 when under threshold', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);

    for (let i = 0; i < 3; i++) {
      manager.storeShortTerm('proj-1', 'agent-1', 'interaction', `Memory ${i}`, 0.5);
    }

    expect(manager.consolidateShortTerm('proj-1', 'agent-1')).toBe(0);
  });

  it('consolidateShortTerm merges records when threshold exceeded', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);

    for (let i = 0; i < 12; i++) {
      manager.storeShortTerm('proj-1', 'agent-1', 'interaction', `Memory ${i}`, 0.5);
    }

    const count = manager.consolidateShortTerm('proj-1', 'agent-1');
    expect(count).toBeGreaterThan(0);

    const active = repo.list('proj-1', 'agent-1', 'short-term', 'active');
    expect(active.length).toBeLessThan(12);
  });

  it('extractLongTerm extracts high-confidence records', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);

    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'Low confidence', 0.3);
    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'High confidence', 0.8);

    const count = manager.extractLongTerm('proj-1', 'agent-1');

    const longTerm = repo.list('proj-1', 'agent-1', 'long-term');
    expect(longTerm).toHaveLength(1);
    expect(longTerm[0]!.content).toBe('High confidence');
    expect(count).toBe(1);
  });

  it('requires confidence to be strictly greater than 0.6 for long-term extraction', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);
    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'Boundary', 0.6);
    expect(manager.extractLongTerm('proj-1', 'agent-1')).toBe(0);
  });

  it('extractLongTerm skips duplicates', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);

    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'Important', 0.9);
    manager.extractLongTerm('proj-1', 'agent-1');
    manager.extractLongTerm('proj-1', 'agent-1');

    const longTerm = repo.list('proj-1', 'agent-1', 'long-term');
    expect(longTerm).toHaveLength(1);
  });

  it('recallRelevant returns content matching query', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);

    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'Project deadline is Friday', 0.7);
    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'Budget review next week', 0.6);

    const results = manager.recallRelevant('deadline Friday', 'proj-1', 'agent-1');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r: string) => r.includes('deadline'))).toBe(true);
  });

  it('recallRelevant returns empty for non-matching query', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);

    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'Project deadline', 0.7);
    expect(manager.recallRelevant('vacation', 'proj-1', 'agent-1')).toHaveLength(0);
  });

  it('buildMemoryContext returns formatted string with memories', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);

    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'User prefers Chinese', 0.9);
    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'Project v2 due next month', 0.7);

    const context = manager.buildMemoryContext('proj-1', 'agent-1');
    expect(context).toContain('User prefers Chinese');
    expect(context).toContain('Project v2 due next month');
  });

  it('buildMemoryContext returns empty string when no memories', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);
    expect(manager.buildMemoryContext('proj-1', 'agent-1')).toBe('');
  });

  it('expireAll marks all records for an agent as expired', () => {
    const repo = createMockRepo();
    const manager = new MemoryManager(repo);

    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'Memory 1', 0.5);
    manager.storeShortTerm('proj-1', 'agent-1', 'interaction', 'Memory 2', 0.5);

    manager.expireAll('agent-1');

    expect(repo.list('proj-1', 'agent-1', 'short-term', 'active')).toHaveLength(0);
  });

  it('applies 72-hour and 30-day half-lives while pinned memories do not decay', () => {
    const base = repoRecord({ lastReinforcedAt: '2026-01-01T00:00:00Z' });
    expect(memoryTimeScore(base, new Date('2026-01-04T00:00:00Z'))).toBeCloseTo(0.5, 5);
    expect(memoryTimeScore({ ...base, scope: 'long-term' }, new Date('2026-01-31T00:00:00Z'))).toBeCloseTo(0.5, 5);
    expect(memoryTimeScore({ ...base, pinned: true }, new Date('2036-01-01T00:00:00Z'))).toBe(1);
  });

  it('filters stale irrelevant memories but keeps pinned explicit rules', () => {
    const now = new Date('2026-08-04T00:00:00Z');
    const stale = repoRecord({ id: 'stale', content: 'unrelated old task', lastReinforcedAt: '2025-01-01T00:00:00Z' });
    const pinned = repoRecord({ id: 'pinned', scope: 'long-term', type: 'project-constraint', content: 'always local', pinned: true, lastReinforcedAt: '2025-01-01T00:00:00Z' });
    const ranked = rankMemories('new topic', [stale, pinned], { now });
    expect(ranked.map((item) => item.record.id)).toEqual(['pinned']);
  });
});

function repoRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'memory', projectId: 'proj-1', agentInstanceId: 'agent-1', scope: 'short-term', type: 'task-episode',
    content: 'memory', confidence: 0.8, importance: 0.8, pinned: false, topicKey: null,
    sourceRefsJson: null, metadataJson: null, status: 'active', expiresAt: null,
    lastReinforcedAt: '2026-01-01T00:00:00Z', lastAccessedAt: null, accessCount: 0,
    consolidatedIntoId: null, supersedesId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
