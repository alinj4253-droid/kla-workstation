import type { ComputeRepository } from './compute-repository.js';
import type { Sub2ApiClient } from './sub2api-client.js';
import type { QuotaService } from './quota-service.js';

type BindingRow = { identity_id: string; sub2api_user_id: string; key_id: string | null; sub2api_key_id: string | null };

export class UsageSyncWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cutoverAt: string | null = null;

  constructor(
    private readonly repo: ComputeRepository,
    private readonly sub2api: Sub2ApiClient,
    private readonly quota: QuotaService,
    private readonly intervalMs: number = 5_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async getCutoverAt(): Promise<string> {
    if (this.cutoverAt) return this.cutoverAt;
    const { rows } = await this.repo.pool.query<{ started_at: Date }>(
      'INSERT INTO compute_billing_cutover (id) VALUES (true) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id RETURNING started_at',
    );
    this.cutoverAt = rows[0].started_at.toISOString();
    return this.cutoverAt;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const since = await this.getCutoverAt();
      const { rows } = await this.repo.pool.query<BindingRow>(
        `SELECT b.identity_id, b.sub2api_user_id, k.id AS key_id, k.sub2api_key_id
         FROM compute_bindings b LEFT JOIN compute_keys k ON k.identity_id = b.identity_id
         WHERE b.sub2api_status IN ('ready','user_created','default_key_created','balance_granted')`,
      );
      const byUser = new Map<string, BindingRow[]>();
      for (const row of rows) byUser.set(row.sub2api_user_id, [...(byUser.get(row.sub2api_user_id) ?? []), row]);
      for (const [userId, bindings] of byUser) {
        try {
          const usageItems = await this.sub2api.listUsage(userId, since);
          for (const item of usageItems.reverse()) {
            const match = bindings.find(row => row.sub2api_key_id === item.apiKeyId)
              ?? (new Set(bindings.map(row => row.identity_id)).size === 1 ? bindings[0] : null);
            if (!match) continue;
            await this.quota.recordUpstreamUsage(match.identity_id, item, match.key_id);
          }
        } catch (error) {
          await this.repo.insertSyncLog({ syncType: 'usage', status: 'error',
            message: `Sub2API 用户 ${userId} 用量同步失败：${error instanceof Error ? error.message : String(error)}` });
        }
      }
    } catch (error) {
      await this.repo.insertSyncLog({ syncType: 'usage', status: 'error',
        message: `用量同步失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.running = false;
    }
  }
}
