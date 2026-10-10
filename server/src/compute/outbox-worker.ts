// Outbox Worker：轮询 outbox_events，处理建号/停用/余额同步事件
// 使用 FOR UPDATE SKIP LOCKED 支持多实例并发消费。

import type { ComputeRepository, QueryClient } from './compute-repository.js';
import type { ProvisioningService } from './provisioning-service.js';

export class OutboxWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly repo: ComputeRepository,
    private readonly provisioning: ProvisioningService,
    private readonly intervalMs: number = 5000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick(); // 立即执行一次
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.running;
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.processEvents().finally(() => { this.running = null; });
  }

  private async processEvents(): Promise<void> {
    try {
      const client = await this.repo.pool.connect();
      try {
        const events = await this.repo.claimPendingOutbox(client as unknown as QueryClient, 10);
        for (const event of events) {
          try {
            await this.handleEvent(event);
            await this.repo.completeOutbox(event.id, client as unknown as QueryClient);
          } catch (error) {
            await this.repo.failOutbox(event.id, error instanceof Error ? error.message : String(error), client as unknown as QueryClient);
          }
        }
      } finally {
        client.release();
      }
    } catch {
      // 连接失败等，下次重试
    }
  }

  private async handleEvent(event: { eventType: string; payload: Record<string, unknown> }): Promise<void> {
    switch (event.eventType) {
      case 'provision_identity_compute': {
        const payload = event.payload as { identityId: string; identityType: 'personal' | 'enterprise'; displayName: string; userEmail?: string | null; role?: 'personal' | 'admin' | 'member' };
        await this.provisioning.provisionIdentity(payload);
        break;
      }
      case 'disable_identity_compute': {
        const payload = event.payload as { identityId: string };
        await this.provisioning.disableIdentity(payload.identityId);
        break;
      }
      case 'sync_balance_to_sub2api':
        // 历史事件类型保留；实际发放和企业划转在 QuotaService 内同步。
        break;
      default:
        break;
    }
  }
}
