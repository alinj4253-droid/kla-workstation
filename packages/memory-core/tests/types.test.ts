import { describe, expect, it } from 'vitest';
import type { MemoryScope, MemoryRecord, CreateMemoryInput } from '../src/types';

describe('MemoryScope type', () => {
  it('accepts valid scope values', () => {
    const scopes: MemoryScope[] = ['short-term', 'long-term'];
    expect(scopes).toHaveLength(2);
  });
});

describe('MemoryRecord type', () => {
  it('accepts a complete memory record', () => {
    const record: MemoryRecord = {
      id: 'mem-1',
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      scope: 'short-term',
      type: 'interaction',
      content: 'User asked about project status',
      confidence: 0.8,
      importance: 0.8, pinned: false, topicKey: null, sourceRefsJson: null, metadataJson: null,
      status: 'active',
      expiresAt: null, lastReinforcedAt: '2026-01-01T00:00:00Z', lastAccessedAt: null,
      accessCount: 0, consolidatedIntoId: null, supersedesId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(record.id).toBe('mem-1');
    expect(record.scope).toBe('short-term');
  });

  it('accepts record with optional fields omitted', () => {
    const record: MemoryRecord = {
      id: 'mem-2',
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      scope: 'long-term',
      type: 'knowledge',
      content: 'Important fact',
      confidence: 0.9,
      importance: 0.9, pinned: false, topicKey: null, sourceRefsJson: null, metadataJson: null,
      status: 'active',
      expiresAt: null, lastReinforcedAt: '2026-01-01T00:00:00Z', lastAccessedAt: null,
      accessCount: 0, consolidatedIntoId: null, supersedesId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(record).toBeDefined();
  });
});

describe('CreateMemoryInput type', () => {
  it('accepts input for creating a memory record', () => {
    const input: CreateMemoryInput = {
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      scope: 'short-term',
      type: 'interaction',
      content: 'New memory content',
      confidence: 0.5,
      expiresAt: '2026-02-01T00:00:00Z',
    };
    expect(input.content).toBe('New memory content');
    expect(input.expiresAt).toBeDefined();
  });

  it('accepts input without optional fields', () => {
    const input: CreateMemoryInput = {
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      scope: 'short-term',
      type: 'interaction',
      content: 'Simple memory',
    };
    expect(input.content).toBe('Simple memory');
  });
});
