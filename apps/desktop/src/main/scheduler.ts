import type Database from 'better-sqlite3';
import { AgentRunRepository } from '@kunqing/database';
import { getLogger } from './logger';
import { AGENT_TASK_TIMEOUT_MS } from './agent-runtime-limits';
import { resolveRuntimeLimits } from './runtime-limits';

// 允许 leader + 最多 9 个群聊成员及少量链式协作同时运行，避免父任务等待子任务时占满执行槽。
// 可通过 settings(runtime.maxConcurrentRuns) 调整，默认 12。
const NON_TERMINAL_STATUSES = ['queued', 'starting', 'running'] as const;

export type QueuedRun = {
  runId: string;
  projectId: string;
  agentInstanceId: string;
  instruction: string;
  triggerMessageId: string;
  /** 子分身 Run 可与同一主智能体的其他分身并行执行。 */
  parallel?: boolean;
  /** enqueue 时从 agent_runs 行提取的链路元数据快照：executor 热路径直接复用，避免逐事件回查。 */
  chainMeta?: {
    requestedByType: string;
    requestedById: string;
    parentRunId?: string;
    createdAt?: string;
  };
};

/** 队列内部条目：附带用户触发标记，用于出队优先级。 */
type PendingRun = QueuedRun & {
  /** requested_by_type = 'user' 的 Run 出队优先于智能体委派任务。 */
  userInitiated: boolean;
};

export class Scheduler {
  private runRepo: AgentRunRepository;
  private running = new Set<string>();
  /** runId -> 正在执行的 Run 元数据（内存索引，热路径不再回查 SQL）。 */
  private runningRuns = new Map<string, PendingRun>();
  private perInstanceQueue = new Map<string, PendingRun[]>();
  /** 全部队列中的 runId 集合，入队查重 O(1)。 */
  private queuedRunIds = new Set<string>();
  private activeCount = 0;
  private onRun: (run: QueuedRun, signal: AbortSignal) => Promise<void>;
  private controllers = new Map<string, AbortController>();
  private timedOutRuns = new Set<string>();
  private maxConcurrent: number;
  private taskTimeoutMs: number;

  constructor(
    private db: Database.Database,
    executor: (run: QueuedRun, signal: AbortSignal) => Promise<void>,
  ) {
    this.runRepo = new AgentRunRepository(db);
    this.onRun = executor;
    const limits = resolveRuntimeLimits(db);
    this.maxConcurrent = limits.maxConcurrentRuns;
    this.taskTimeoutMs = limits.agentTaskTimeoutMs;
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

  /**
   * 将 Run 加入调度队列。
   * 返回是否真正入队：重复入队、Run 状态非 queued 或元数据查询失败时静默丢弃并返回 false，
   * 调用方（如 resume 恢复路径）可据此回滚状态，避免留下无人推进的幻影 running。
   */
  enqueue(run: QueuedRun): boolean {
    if (this.running.has(run.runId)) return false;
    if (this.queuedRunIds.has(run.runId)) return false;
    let userInitiated = false;
    let chainMeta: QueuedRun['chainMeta'];
    try {
      const row = this.runRepo.getById(run.runId);
      if (row.status !== 'queued') return false;
      userInitiated = row.requestedByType === 'user';
      // 复用本次 getById 的行数据：executor 侧的链路元数据查询全部免查库。
      chainMeta = {
        requestedByType: row.requestedByType,
        requestedById: row.requestedById,
        ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
        createdAt: row.createdAt,
      };
    } catch {
      return false;
    }
    const q = this.perInstanceQueue.get(run.agentInstanceId) ?? [];
    q.push({ ...run, userInitiated, chainMeta });
    this.queuedRunIds.add(run.runId);
    this.perInstanceQueue.set(run.agentInstanceId, q);
    this.tick();
    return true;
  }

  cancelRun(runId: string): boolean {
    for (const [instanceId, queue] of this.perInstanceQueue) {
      const queuedRun = queue.find((run) => run.runId === runId);
      if (!queuedRun) continue;
      this.perInstanceQueue.set(instanceId, queue.filter((run) => run.runId !== runId));
      this.queuedRunIds.delete(runId);
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
      const remaining: PendingRun[] = [];
      for (const r of queue) {
        if (r.projectId === projectId) {
          toCancel.push(r.runId);
          this.queuedRunIds.delete(r.runId);
        }
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
    while (this.activeCount < this.maxConcurrent) {
      const next = this.dequeueNext();
      if (!next) break;
      this.activeCount++;
      this.running.add(next.runId);
      this.runningRuns.set(next.runId, next);
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
        controller.abort(new Error('智能体任务已达到执行上限'));
      }, this.taskTimeoutMs);
      timeout.unref();
      this.onRun(next, controller.signal)
        .then(() => {
          const current = this.runRepo.getById(runId);
          if (!['awaiting_user', 'failed', 'cancelled', 'interrupted'].includes(current.status)) {
            this.runRepo.setStatus(runId, 'completed');
          }
          if (current.status !== 'awaiting_user') this.runRepo.addEvent(runId, 'run.completed', {});
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
          try { this.completeResumedAncestors(runId); } catch { /* continuation metadata may be unavailable during recovery */ }
          clearTimeout(timeout);
          this.timedOutRuns.delete(runId);
          this.activeCount--;
          this.running.delete(runId);
          this.runningRuns.delete(runId);
          this.controllers.delete(runId);
          this.tick();
        });
    }
  }

  private completeResumedAncestors(completedRunId: string): void {
    let childId = completedRunId;
    for (let depth = 0; depth < 12; depth += 1) {
      const child = this.runRepo.getById(childId);
      if (!child.parentRunId || !['completed', 'failed', 'cancelled', 'interrupted'].includes(child.status)) return;
      const resumedFromUser = this.runRepo.listEvents(child.id).some((event) => event.type === 'run.resumed-from-user');
      if (!resumedFromUser) return;
      const parent = this.runRepo.getById(child.parentRunId);
      if (child.resultMessageId) this.runRepo.setResultMessage(parent.id, child.resultMessageId);
      this.runRepo.setStatus(parent.id, child.status, {
        ...(child.errorCode ? { errorCode: child.errorCode } : {}),
        ...(child.errorMessage ? { errorMessage: child.errorMessage } : {}),
      });
      this.runRepo.addEvent(parent.id, 'run.user-continuation-completed', {
        continuationRunId: child.id,
        status: child.status,
        resultMessageId: child.resultMessageId,
      });
      childId = parent.id;
    }
  }

  private dequeueNext(): PendingRun | null {
    // 用户直接触发的任务优先出队；智能体委派/链式任务随后。
    for (const preferUser of [true, false]) {
      for (const [instanceId, queue] of this.perInstanceQueue) {
        if (queue.length === 0) continue;
        const candidate = queue[0];
        if (!candidate || candidate.userInitiated !== preferUser) continue;
        if (this.instanceHasRunning(instanceId, candidate)) continue;
        queue.shift();
        this.queuedRunIds.delete(candidate.runId);
        return candidate;
      }
    }
    return null;
  }

  private instanceHasRunning(instanceId: string, candidate?: QueuedRun): boolean {
    // 分身只共享角色、技能和工作区，不共享同一个执行槽位。
    // 普通 Run 仍保持每个实例串行，避免同一主智能体的多个主任务互相覆盖上下文。
    if (candidate?.parallel) return false;
    // 内存索引判断实例占用，替代逐个回查 agent_runs 表。
    for (const run of this.runningRuns.values()) {
      if (run.agentInstanceId === instanceId) return true;
    }
    return false;
  }
}
