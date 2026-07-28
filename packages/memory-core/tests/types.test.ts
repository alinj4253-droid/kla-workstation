import { describe, expect, it } from 'vitest';
import type { MemoryScope, MemoryRecord, MemoryRecordInput } from '../src/types';

describe('MemoryScope type', () => {
  it('accepts valid scope values', () => {
    const scopes: MemoryScope[] = ['short-term', 'long-term', 'session'];
    expect(scopes).toHaveLength(3);
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
      status: 'active',
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
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(record).toBeDefined();
  });
});

describe('MemoryRecordInput type', () => {
  it('accepts input for creating a memory record', () => {
    const input: MemoryRecordInput = {
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      scope: 'short-term',
      type: 'interaction',
      content: 'New memory content',
      confidence: 0.5,
      status: 'active',
      expiresAt: '2026-02-01T00:00:00Z',
    };
    expect(input.content).toBe('New memory content');
    expect(input.expiresAt).toBeDefined();
  });

  it('accepts input without optional fields', () => {
    const input: MemoryRecordInput = {
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      scope: 'short-term',
      type: 'interaction',
      content: 'Simple memory',
      confidence: undefined,
    };
    expect(input.content).toBe('Simple memory');
  });
});
