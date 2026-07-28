import type { MemoryRecord, CreateMemoryInput, UpdateMemoryInput, MemoryScope, MemoryStatus } from './types.js';

export interface IMemoryRepository {
  list(
    projectId: string,
    agentInstanceId: string,
    scope?: MemoryScope,
    status?: MemoryStatus,
  ): MemoryRecord[];

  get(id: string): MemoryRecord | null;

  create(input: CreateMemoryInput): MemoryRecord;

  update(id: string, changes: UpdateMemoryInput): void;

  remove(id: string): void;

  expireAll(agentInstanceId: string): void;
}
