import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputeRepository } from './compute-repository.js';
import type { ProvisioningService } from './provisioning-service.js';
import type { QuotaService } from './quota-service.js';
import type { Sub2ApiClient } from './sub2api-client.js';
import { OutboxWorker } from './outbox-worker.js';
import { UsageSyncWorker } from './usage-sync-worker.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); });

describe('compute worker shutdown', () => {
  it('drains usage synchronization and its error log before the database closes', async () => {
    vi.useFakeTimers();
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ started_at: new Date() }] })
      .mockResolvedValue({ rows: [{ identity_id: 'identity', sub2api_user_id: 'upstream', key_id: null, sub2api_key_id: null }] });
    const repo = { pool: { query }, insertSyncLog: vi.fn(async () => { events.push('error logged'); }) };
    const sub2api = { listUsage: vi.fn(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('upstream unavailable');
    }) };
    const worker = new UsageSyncWorker(repo as unknown as ComputeRepository,
      sub2api as unknown as Sub2ApiClient, {} as QuotaService, 100);
    worker.start();
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(200);
      expect(sub2api.listUsage).toHaveBeenCalledTimes(1);
      let stopped = false;
      const shutdown = worker.stop().then(() => { stopped = true; events.push('database closed'); });
      await vi.advanceTimersByTimeAsync(200);
      expect(stopped).toBe(false);
      expect(sub2api.listUsage).toHaveBeenCalledTimes(1);
      release.resolve();
      await shutdown;
      expect(events).toEqual(['error logged', 'database closed']);
      expect(repo.insertSyncLog).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(sub2api.listUsage).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); await worker.stop(); }
  });

  it('finishes an outbox event and releases its client before shutdown completes', async () => {
    vi.useFakeTimers();
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    const client = { release: vi.fn(() => { events.push('client released'); }) };
    const repo = {
      pool: { connect: vi.fn(async () => client) },
      claimPendingOutbox: vi.fn(async () => [{ id: 'event', eventType: 'provision_identity_compute', payload: { identityId: 'identity' } }]),
      completeOutbox: vi.fn(async () => { events.push('event completed'); }),
      failOutbox: vi.fn(),
    };
    const provisioning = { provisionIdentity: vi.fn(async () => { entered.resolve(); await release.promise; }) };
    const worker = new OutboxWorker(repo as unknown as ComputeRepository,
      provisioning as unknown as ProvisioningService, 100);
    worker.start();
    try {
      await entered.promise;
      let stopped = false;
      const shutdown = worker.stop().then(() => { stopped = true; events.push('database closed'); });
      await vi.advanceTimersByTimeAsync(200);
      expect(stopped).toBe(false);
      expect(client.release).not.toHaveBeenCalled();
      release.resolve();
      await shutdown;
      expect(events).toEqual(['event completed', 'client released', 'database closed']);
      expect(repo.failOutbox).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(repo.pool.connect).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); await worker.stop(); }
  });
});
