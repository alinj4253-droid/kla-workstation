import type { MemoryRecord, CreateMemoryInput, UpdateMemoryInput, MemoryScope, MemoryStatus } from './types.js';

export interface MemoryListOptions {
  /** 只返回最新的 N 条，控制召回候选池规模。 */
  limit?: number;
  /** 只返回置顶记忆（用户显式“记住”的规则）。 */
  pinnedOnly?: boolean;
  /** 只返回指定类型：写入路径按 SQL 过滤，避免全量物化后再筛选。 */
  type?: string;
  /** 只返回指定主题键的记录。 */
  topicKey?: string;
}

export interface IMemoryRepository {
  list(
    projectId: string,
    agentInstanceId: string,
    scope?: MemoryScope,
    status?: MemoryStatus,
    options?: MemoryListOptions,
  ): MemoryRecord[];

  get(id: string): MemoryRecord | null;

  create(input: CreateMemoryInput): MemoryRecord;

  update(id: string, changes: UpdateMemoryInput): void;

  markAccessed(ids: string[], at: string): void;

  remove(id: string): void;

  expireAll(agentInstanceId: string): void;
}
