import type Database from 'better-sqlite3';
import { MemoryRepository } from '@kunqing/database';
import { MemoryManager as CoreMemoryManager } from '@kunqing/memory-core';
import type { IMemoryRepository, MemoryRecord, CreateMemoryInput, UpdateMemoryInput, MemoryScope, MemoryStatus } from '@kunqing/memory-core';

class DatabaseMemoryRepository implements IMemoryRepository {
  private repo: MemoryRepository;

  constructor(db: Database.Database) {
    this.repo = new MemoryRepository(db);
  }

  list(projectId: string, agentInstanceId: string, scope?: MemoryScope, status?: MemoryStatus): MemoryRecord[] {
    return this.repo.list(projectId, agentInstanceId, scope, status) as MemoryRecord[];
  }

  get(id: string): MemoryRecord | null {
    return this.repo.get(id) as MemoryRecord | null;
  }

  create(input: CreateMemoryInput): MemoryRecord {
    const opts: Record<string, unknown> = {
      projectId: input.projectId,
      agentInstanceId: input.agentInstanceId,
      scope: input.scope,
      type: input.type,
      content: input.content,
    };
    if (input.confidence !== undefined) opts.confidence = input.confidence;
    if (input.sourceRefsJson !== undefined) opts.sourceRefsJson = input.sourceRefsJson;
    if (input.expiresAt !== undefined) opts.expiresAt = input.expiresAt;
    return this.repo.create(opts as any) as MemoryRecord;
  }

  update(id: string, changes: UpdateMemoryInput): void {
    this.repo.update(id, changes as any);
  }

  remove(id: string): void {
    this.repo.remove(id);
  }

  expireAll(agentInstanceId: string): void {
    this.repo.expireAll(agentInstanceId);
  }
}

export class MemoryManager extends CoreMemoryManager {
  constructor(db: Database.Database) {
    super(new DatabaseMemoryRepository(db));
  }
}
