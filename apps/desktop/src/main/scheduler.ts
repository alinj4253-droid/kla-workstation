import type Database from 'better-sqlite3';
import { AgentRunRepository } from '@kunqing/database';
import { getLogger } from './logger';
import { AGENT_TASK_TIMEOUT_MS } from './agent-runtime-limits';

// 允许 leader + 最多 9 个群聊成员及少量链式协作同时运行，避免父任务等待子任务时占满执行槽。
const MAX_CONCURRENT = 12;
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
  private timedOutRuns = new Set<string>();

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

  cancelRun(runId: string): boolean {
    for (const [instanceId, queue] of this.perInstanceQueue) {
      const queuedRun = queue.find((run) => run.runId === runId);
      if (!queuedRun) continue;
      this.perInstanceQueue.set(instanceId, queue.filter((run) => run.runId !== runId));
      this.runRepo.setStatus(runId, 'cancelled');
      this.runRepo.addEvent(runId, 'run.cancelled', { reason: '用户取消' });
      return true;
    }

    const controller = this.controllers.get(runId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    this.runRepo.setStatus(runId, 'cancelled');
    this.runRepo.addEvent(runId, 'run.cancelled', { reason: '用户取消（运行中）' });
    return true;
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
      const timeout = setTimeout(() => {
        this.timedOutRuns.add(runId);
        controller.abort(new Error('智能体任务已达到 4 小时执行上限'));
      }, AGENT_TASK_TIMEOUT_MS);
      timeout.unref();
      this.onRun(next, controller.signal)
        .then(() => {
          const current = this.runRepo.getById(runId);
          if (!['failed', 'cancelled', 'interrupted'].includes(current.status)) {
            this.runRepo.setStatus(runId, 'completed');
          }
          this.runRepo.addEvent(runId, 'run.completed', {});
        })
        .catch((err: unknown) => {
          if (this.timedOutRuns.has(runId)) {
            this.runRepo.setStatus(runId, 'failed', { errorCode: 'RUN_TIMEOUT', errorMessage: '智能体任务在 4 小时内未完成' });
            this.runRepo.addEvent(runId, 'run.failed', { errorCode: 'RUN_TIMEOUT', errorMessage: '智能体任务在 4 小时内未完成' });
            return;
          }
          if (err instanceof DOMException && err.name === 'AbortError') {
            this.runRepo.setStatus(runId, 'cancelled');
            this.runRepo.addEvent(runId, 'run.cancelled', { reason: '用户取消或项目取消' });
            return;
          }
          this.runRepo.setStatus(runId, 'failed', { errorCode: 'RUNTIME_ERROR', errorMessage: err instanceof Error ? err.message : String(err) });
          this.runRepo.addEvent(runId, 'run.failed', {
            errorCode: 'RUNTIME_ERROR',
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          try { getLogger()?.warn({ err, runId }, 'Scheduler: agent run failed'); } catch { /* logger may be unavailable in tests */ }
        })
        .finally(() => {
          clearTimeout(timeout);
          this.timedOutRuns.delete(runId);
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
