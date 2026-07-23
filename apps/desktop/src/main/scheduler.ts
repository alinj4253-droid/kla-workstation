import type Database from 'better-sqlite3';
import { AgentRunRepository } from '@kunqing/database';
import { getLogger } from './logger';

const MAX_CONCURRENT = 4;
const NON_TERMINAL_STATUSES = ['queued', 'starting', 'running'] as const;

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

  /**
   * 启动时恢复：查找所有非终态 Run，标记为 interrupted
   * 对应 AC-CHAT-03：关闭并重启应用后，未完成 Run 被标记 interrupted
   */
  recoverInterruptedRuns(): number {
    const logger = getLogger();
    const activeRuns = this.runRepo.listActiveRuns();
    let count = 0;

    for (const run of activeRuns) {
      try {
        this.runRepo.setStatus(run.id, 'interrupted');
        this.runRepo.addEvent(run.id, 'run.interrupted', {
          reason: '应用重启',
          previousStatus: run.status,
          recoveredAt: new Date().toISOString(),
        });
        count++;
        logger?.info({ runId: run.id, previousStatus: run.status }, 'Scheduler: 启动恢复 - Run 已标记为 interrupted');
      } catch (err) {
        logger?.warn({ err, runId: run.id }, 'Scheduler: 启动恢复失败');
      }
    }

    if (count > 0) {
      logger?.info({ count }, 'Scheduler: 启动恢复完成');
    }
    return count;
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
      this.runRepo.addEvent(runId, 'run.cancelled', { reason: '项目取消', projectId });
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
              this.runRepo.addEvent(runId, 'run.cancelled', { reason: '项目取消（运行中）', projectId });
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
      this.runRepo.addEvent(next.runId, 'run.started', {
        agentInstanceId: next.agentInstanceId,
        projectId: next.projectId,
        instruction: next.instruction.slice(0, 200),
      });

      const controller = new AbortController();
      this.controllers.set(next.runId, controller);

      const runId = next.runId;
      this.onRun(next, controller.signal)
        .then(() => {
          this.runRepo.addEvent(runId, 'run.completed', {});
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') {
            this.runRepo.setStatus(runId, 'cancelled');
            this.runRepo.addEvent(runId, 'run.cancelled', { reason: '用户取消或项目取消' });
            return;
          }
          getLogger()?.warn({ err, runId }, 'Scheduler: agent run failed');
          this.runRepo.setStatus(runId, 'failed', { errorCode: 'RUNTIME_ERROR', errorMessage: err instanceof Error ? err.message : String(err) });
          this.runRepo.addEvent(runId, 'run.failed', {
            errorCode: 'RUNTIME_ERROR',
            errorMessage: err instanceof Error ? err.message : String(err),
          });
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
