// 用量同步 Worker：定时从 Sub2API 拉取增量用量，去重后写入 compute_usage。
// 去重哈希 = sha256(id:userId:timestamp)。

import { createHash } from 'node:crypto';
import type { ComputeRepository } from './compute-repository.js';
import type { Sub2ApiClient } from './sub2api-client.js';

export class UsageSyncWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastSyncAt: string | null = null;

  constructor(
    private readonly repo: ComputeRepository,
    private readonly sub2api: Sub2ApiClient,
    private readonly intervalMs: number = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const since = this.lastSyncAt ?? new Date(Date.now() - this.intervalMs * 2).toISOString();
      const until = new Date().toISOString();

      // 遍历所有已绑定的 identity，拉取 Sub2API 用量
      const { rows } = await this.repo.pool.query(
        "SELECT identity_id, sub2api_user_id FROM compute_bindings WHERE sub2api_status IN ('ready','user_created','default_key_created','balance_granted')",
      );
      for (const row of rows) {
        try {
          const usageItems = await this.sub2api.listUsage(row.sub2api_user_id, since, until);
          for (const item of usageItems) {
            const dedupeHash = createHash('sha256').update(`${item.id}:${item.userId}:${item.timestamp}`).digest('hex');
            await this.repo.upsertUsage({
              identityId: row.identity_id as string,
              ledgerId: null,
              sub2apiUsageId: item.id,
              model: item.model,
              amountUsd: item.amountUsd,
              promptTokens: item.promptTokens,
              completionTokens: item.completionTokens,
              metadata: {},
              dedupeHash,
              recordedAt: item.timestamp,
            });
          }
        } catch {
          // 单个用户失败不影响其他用户
        }
      }
      this.lastSyncAt = until;
    } catch {
      // 下次重试
    } finally {
      this.running = false;
    }
  }
}
