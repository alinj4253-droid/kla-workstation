import { describe, expect, it } from 'vitest';
import type { IMemoryRepository } from '../src/repository';
import type { MemoryRecord } from '../src/types';

const makeRecord = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'mem-1',
  projectId: 'proj-1',
  agentInstanceId: 'agent-1',
  scope: 'short-term',
  type: 'interaction',
  content: 'test',
  confidence: 0.5,
  importance: 0.5,
  pinned: false,
  topicKey: null,
  sourceRefsJson: null,
  metadataJson: null,
  status: 'active',
  expiresAt: null,
  lastReinforcedAt: '2026-01-01T00:00:00Z',
  lastAccessedAt: null,
  accessCount: 0,
  consolidatedIntoId: null,
  supersedesId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('IMemoryRepository interface', () => {
  it('can be implemented with all required methods', () => {
    const repo: IMemoryRepository = {
      list() { return []; },
      get() { return null; },
      create(input) { return makeRecord({ content: input.content }); },
      update() {},
      markAccessed() {},
      remove() {},
      expireAll() {},
    };

    expect(repo.list('proj-1', 'agent-1')).toEqual([]);
    expect(repo.get('mem-1')).toBeNull();
    const created = repo.create({
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      scope: 'short-term',
      type: 'interaction',
      content: 'Hello',
    });
    expect(created.content).toBe('Hello');
    expect(() => repo.update('mem-1', { content: 'Updated' })).not.toThrow();
    expect(() => repo.remove('mem-1')).not.toThrow();
    expect(() => repo.expireAll('agent-1')).not.toThrow();
  });

  it('list filters by scope and status', () => {
    const records: MemoryRecord[] = [
      makeRecord({ id: 'm1', scope: 'short-term', status: 'active' }),
      makeRecord({ id: 'm2', scope: 'long-term', status: 'active' }),
      makeRecord({ id: 'm3', scope: 'short-term', status: 'expired' }),
    ];

    const repo: IMemoryRepository = {
      list(_projectId, _agentInstanceId, scope, status) {
        return records.filter((r) =>
          (!scope || r.scope === scope) && (!status || r.status === status),
        );
      },
      get(id) { return records.find((r) => r.id === id) ?? null; },
      create(input) { return makeRecord({ content: input.content, scope: input.scope }); },
      update() {},
      markAccessed() {},
      remove() {},
      expireAll() {},
    };

    expect(repo.list('proj-1', 'agent-1', 'short-term')).toHaveLength(2);
    expect(repo.list('proj-1', 'agent-1', 'short-term', 'active')).toHaveLength(1);
    expect(repo.list('proj-1', 'agent-1', 'long-term')).toHaveLength(1);
    expect(repo.list('proj-1', 'agent-1', 'short-term', 'expired')).toHaveLength(1);
  });

  it('get returns null for non-existent record', () => {
    const repo: IMemoryRepository = {
      list() { return []; },
      get() { return null; },
      create(input) { return makeRecord({ content: input.content }); },
      update() {},
      markAccessed() {},
      remove() {},
      expireAll() {},
    };
    expect(repo.get('non-existent')).toBeNull();
  });

  it('get returns record by id', () => {
    const record = makeRecord({ id: 'existing-id' });
    const repo: IMemoryRepository = {
      list() { return [record]; },
      get(id) { return id === 'existing-id' ? record : null; },
      create(input) { return makeRecord({ content: input.content }); },
      update() {},
      markAccessed() {},
      remove() {},
      expireAll() {},
    };
    expect(repo.get('existing-id')?.content).toBe('test');
  });
});
