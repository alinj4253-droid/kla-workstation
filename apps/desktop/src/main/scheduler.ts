import type Database from 'better-sqlite3';
import { AgentRunRepository } from '@kunqing/database';
import { getLogger } from './logger';

const MAX_CONCURRENT = 4;

export type QueuedRun = {
  runId: string;
  projectId: string;
  agentInstanceId: string;
  instruction: string;
  triggerMessageId: string;
};

export class Scheduler {
  private runRepo: AgentRunRepository;
  private running = new Set<string>();
  private perInstanceQueue = new Map<string, QueuedRun[]>();
  private activeCount = 0;
  private onRun: (run: QueuedRun, signal: AbortSignal) => Promise<void>;
  private controllers = new Map<string, AbortController>();

  constructor(
    private db: Database.Database,
    executor: (run: QueuedRun, signal: AbortSignal) => Promise<void>,
  ) {
    this.runRepo = new AgentRunRepository(db);
    this.onRun = executor;
  }

  enqueue(run: QueuedRun): void {
    const q = this.perInstanceQueue.get(run.agentInstanceId) ?? [];
    q.push(run);
    this.perInstanceQueue.set(run.agentInstanceId, q);
    this.tick();
  }

  cancelProject(projectId: string): void {
    const toCancel: string[] = [];
    for (const [instanceId, queue] of this.perInstanceQueue) {
      const remaining: QueuedRun[] = [];
      for (const r of queue) {
        if (r.projectId === projectId) toCancel.push(r.runId);
        else remaining.push(r);
      }
      this.perInstanceQueue.set(instanceId, remaining);
    }

    for (const runId of toCancel) {
      this.runRepo.setStatus(runId, 'cancelled');
    }

    for (const [runId, controller] of this.controllers) {
      if (!controller.signal.aborted) {
        const run = this.running.has(runId);
        if (run) {
          try {
            const row = this.runRepo.getById(runId);
            if (row.projectId === projectId) {
              controller.abort();
              this.runRepo.setStatus(runId, 'cancelled');
            }
          } catch { /* ignore */ }
        }
      }
    }
  }

  private tick(): void {
    while (this.activeCount < MAX_CONCURRENT) {
      const next = this.dequeueNext();
      if (!next) break;
      this.activeCount++;
      this.running.add(next.runId);
      this.runRepo.setStatus(next.runId, 'running');

      const controller = new AbortController();
      this.controllers.set(next.runId, controller);

      const runId = next.runId;
      this.onRun(next, controller.signal)
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') {
            this.runRepo.setStatus(runId, 'cancelled');
            return;
          }
          getLogger()?.warn({ err, runId }, 'Scheduler: agent run failed');
          this.runRepo.setStatus(runId, 'failed', { errorCode: 'RUNTIME_ERROR', errorMessage: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          this.activeCount--;
          this.running.delete(runId);
          this.controllers.delete(runId);
          this.tick();
        });
    }
  }

  private dequeueNext(): QueuedRun | null {
    for (const [instanceId, queue] of this.perInstanceQueue) {
      if (queue.length > 0 && !this.instanceHasRunning(instanceId)) {
        return queue.shift()!;
      }
    }
    return null;
  }

  private instanceHasRunning(instanceId: string): boolean {
    const activeRunIds = Array.from(this.running);
    return activeRunIds.some((rid) => {
      try {
        const run = this.runRepo.getById(rid);
        return run.agentInstanceId === instanceId && ['queued', 'starting', 'running'].includes(run.status);
      } catch {
        return false;
      }
    });
  }
}
