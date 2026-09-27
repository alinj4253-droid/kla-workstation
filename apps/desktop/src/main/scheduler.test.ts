// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Scheduler } from './scheduler';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_instance_id TEXT NOT NULL,
      requested_by_type TEXT NOT NULL,
      requested_by_id TEXT,
      instruction TEXT,
      parent_run_id TEXT,
      trigger_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt INTEGER NOT NULL DEFAULT 1,
      model_profile_snapshot_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      result_message_id TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_runs_instance ON agent_runs(agent_instance_id);
    CREATE INDEX idx_runs_project ON agent_runs(project_id);

    CREATE TABLE agent_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(id)
    );
    CREATE INDEX idx_events_run ON agent_run_events(run_id);
  `);
  return db;
}

function createRunInDb(db: Database.Database, overrides: { id: string; projectId: string; agentInstanceId: string; instruction?: string; triggerMessageId?: string }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_runs (id, project_id, agent_instance_id, requested_by_type, requested_by_id, instruction, trigger_message_id, status, attempt, created_at)
     VALUES (?, ?, ?, 'user', 'local-user', ?, ?, 'queued', 1, ?)`,
  ).run(overrides.id, overrides.projectId, overrides.agentInstanceId, overrides.instruction ?? '', overrides.triggerMessageId ?? '', now);
}

function makeRun(overrides?: Record<string, string>) {
  return {
    runId: overrides?.runId ?? 'run-1',
    projectId: overrides?.projectId ?? 'proj-1',
    agentInstanceId: overrides?.agentInstanceId ?? 'agent-1',
    instruction: overrides?.instruction ?? 'test instruction',
    triggerMessageId: overrides?.triggerMessageId ?? 'msg-1',
  };
}

describe('Scheduler', () => {
  let db: Database.Database;
  let executor: ReturnType<typeof vi.fn>;
  let scheduler: Scheduler;

  beforeEach(() => {
    db = createDb();
    executor = vi.fn().mockResolvedValue(undefined);
    scheduler = new Scheduler(db, executor as never);
  });

  it('enqueues a run and executes it', async () => {
    createRunInDb(db, { id: 'run-1', projectId: 'proj-1', agentInstanceId: 'agent-1' });
    scheduler.enqueue(makeRun());
    await new Promise((r) => setTimeout(r, 50));
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1' }),
      expect.any(Object),
    );
  });

  it('sets run status to running before execution', async () => {
    createRunInDb(db, { id: 'run-1', projectId: 'proj-1', agentInstanceId: 'agent-1' });
    executor.mockImplementation(() => new Promise((r) => setTimeout(r, 100)));
    scheduler.enqueue(makeRun());
    await new Promise((r) => setTimeout(r, 20));
    const row = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get('run-1') as { status: string };
    expect(row.status).toBe('running');
  });

  it('respects per-instance serial execution', async () => {
    const order: string[] = [];
    executor.mockImplementation(async (run: { runId: string }) => {
      order.push(run.runId);
      await new Promise((r) => setTimeout(r, 10));
    });

    createRunInDb(db, { id: 'run-1', projectId: 'proj-1', agentInstanceId: 'agent-1' });
    createRunInDb(db, { id: 'run-2', projectId: 'proj-1', agentInstanceId: 'agent-1' });
    createRunInDb(db, { id: 'run-3', projectId: 'proj-1', agentInstanceId: 'agent-1' });

    scheduler.enqueue(makeRun({ runId: 'run-1', agentInstanceId: 'agent-1' }));
    scheduler.enqueue(makeRun({ runId: 'run-2', agentInstanceId: 'agent-1' }));
    scheduler.enqueue(makeRun({ runId: 'run-3', agentInstanceId: 'agent-1' }));

    await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual(['run-1', 'run-2', 'run-3']);
  });

  it('runs different instances in parallel', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    executor.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
    });

    createRunInDb(db, { id: 'run-1', projectId: 'proj-1', agentInstanceId: 'agent-1' });
    createRunInDb(db, { id: 'run-2', projectId: 'proj-1', agentInstanceId: 'agent-2' });
    createRunInDb(db, { id: 'run-3', projectId: 'proj-1', agentInstanceId: 'agent-3' });

    scheduler.enqueue(makeRun({ runId: 'run-1', agentInstanceId: 'agent-1' }));
    scheduler.enqueue(makeRun({ runId: 'run-2', agentInstanceId: 'agent-2' }));
    scheduler.enqueue(makeRun({ runId: 'run-3', agentInstanceId: 'agent-3' }));

    await new Promise((r) => setTimeout(r, 100));
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it('cancels all runs for a project', async () => {
    executor.mockImplementation(() => new Promise((r) => setTimeout(r, 200)));

    createRunInDb(db, { id: 'run-1', projectId: 'proj-1', agentInstanceId: 'agent-1' });
    createRunInDb(db, { id: 'run-2', projectId: 'proj-1', agentInstanceId: 'agent-2' });
    createRunInDb(db, { id: 'run-3', projectId: 'proj-2', agentInstanceId: 'agent-1' });

    scheduler.enqueue(makeRun({ runId: 'run-1', projectId: 'proj-1' }));
    scheduler.enqueue(makeRun({ runId: 'run-2', projectId: 'proj-1' }));
    scheduler.enqueue(makeRun({ runId: 'run-3', projectId: 'proj-2' }));

    scheduler.cancelProject('proj-1');
    await new Promise((r) => setTimeout(r, 50));

    const status1 = (db.prepare('SELECT status FROM agent_runs WHERE id = ?').get('run-1') as { status: string }).status;
    const status2 = (db.prepare('SELECT status FROM agent_runs WHERE id = ?').get('run-2') as { status: string }).status;
    const status3 = (db.prepare('SELECT status FROM agent_runs WHERE id = ?').get('run-3') as { status: string }).status;

    expect(status1).toBe('cancelled');
    expect(status2).toBe('cancelled');
    expect(status3).toBe('queued');
  });

  it('passes abort signal to executor', async () => {
    executor.mockImplementation(async (_run: unknown, signal: AbortSignal) => {
      await new Promise((_r) => setTimeout(_r, 100));
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    });

    createRunInDb(db, { id: 'run-1', projectId: 'proj-1', agentInstanceId: 'agent-1' });
    scheduler.enqueue(makeRun({ runId: 'run-1', projectId: 'proj-1' }));
    scheduler.cancelProject('proj-1');
    await new Promise((r) => setTimeout(r, 30));

    expect(executor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ aborted: expect.any(Boolean) }),
    );
  });

  it('respects MAX_CONCURRENT limit', async () => {
    let running = 0;
    let peak = 0;

    executor.mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 100));
      running--;
    });

    for (let i = 0; i < 10; i++) {
      const id = `run-${i}`;
      const agentId = `agent-${i}`;
      createRunInDb(db, { id, projectId: 'proj-1', agentInstanceId: agentId });
      scheduler.enqueue(makeRun({ runId: id, agentInstanceId: agentId }));
    }

    await new Promise((r) => setTimeout(r, 50));
    expect(peak).toBeLessThanOrEqual(12);
  });

  it('handles executor errors gracefully', async () => {
    executor.mockRejectedValue(new Error('executor failed'));
    createRunInDb(db, { id: 'run-1', projectId: 'proj-1', agentInstanceId: 'agent-1' });
    scheduler.enqueue(makeRun());

    await new Promise((r) => setTimeout(r, 100));
    const row = db.prepare('SELECT status, error_code, error_message FROM agent_runs WHERE id = ?').get('run-1') as { status: string; error_code: string | null; error_message: string | null };
    expect(row.error_code).toBe('RUNTIME_ERROR');
    expect(row.error_message).toContain('executor failed');
  });

  it('ignores duplicate enqueue calls for the same run', async () => {
    createRunInDb(db, { id: 'run-1', projectId: 'proj-1', agentInstanceId: 'agent-1' });
    executor.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 30)));
    scheduler.enqueue(makeRun());
    scheduler.enqueue(makeRun());
    scheduler.enqueue(makeRun());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('completes the original waiting run only after its user continuation returns', async () => {
    createRunInDb(db, { id: 'waiting-run', projectId: 'proj-1', agentInstanceId: 'agent-1' });
    createRunInDb(db, { id: 'continuation-run', projectId: 'proj-1', agentInstanceId: 'agent-1' });
    db.prepare("UPDATE agent_runs SET status = 'running', result_message_id = 'question-message' WHERE id = 'waiting-run'").run();
    db.prepare("UPDATE agent_runs SET parent_run_id = 'waiting-run' WHERE id = 'continuation-run'").run();
    db.prepare("INSERT INTO agent_run_events VALUES ('resume-event', 'continuation-run', 1, 'run.resumed-from-user', '{}', ?)").run(new Date().toISOString());
    executor.mockImplementation(async (run: { runId: string }) => {
      db.prepare('UPDATE agent_runs SET result_message_id = ? WHERE id = ?').run('final-answer-message', run.runId);
    });

    scheduler.enqueue(makeRun({ runId: 'continuation-run', agentInstanceId: 'agent-1' }));
    await new Promise((resolve) => setTimeout(resolve, 60));

    const waiting = db.prepare('SELECT status, result_message_id as resultMessageId FROM agent_runs WHERE id = ?').get('waiting-run') as { status: string; resultMessageId: string | null };
    expect(waiting).toEqual({ status: 'completed', resultMessageId: 'final-answer-message' });
  });

  it('enqueue 时把链路元数据快照透传给 executor（chainMeta）', async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_runs (id, project_id, agent_instance_id, requested_by_type, requested_by_id, instruction, parent_run_id, trigger_message_id, status, attempt, created_at)
       VALUES ('run-delegated', 'proj-1', 'agent-2', 'agent', 'agent-parent', '子任务', 'run-parent', 'msg-9', 'queued', 1, ?)`,
    ).run(now);
    createRunInDb(db, { id: 'run-user', projectId: 'proj-1', agentInstanceId: 'agent-1' });

    scheduler.enqueue(makeRun({ runId: 'run-user', agentInstanceId: 'agent-1' }));
    scheduler.enqueue(makeRun({ runId: 'run-delegated', agentInstanceId: 'agent-2', triggerMessageId: 'msg-9' }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    const userRun = (executor.mock.calls[0]?.[0] as { chainMeta?: Record<string, unknown> }).chainMeta;
    expect(userRun).toMatchObject({ requestedByType: 'user', requestedById: 'local-user' });
    expect(userRun).not.toHaveProperty('parentRunId');

    const delegatedRun = (executor.mock.calls[1]?.[0] as { chainMeta?: Record<string, unknown> }).chainMeta;
    expect(delegatedRun).toEqual({
      requestedByType: 'agent',
      requestedById: 'agent-parent',
      parentRunId: 'run-parent',
      createdAt: now,
    });
  });

  it('allows a task to run for four hours before timing it out', async () => {
    vi.useFakeTimers();
    try {
      executor.mockImplementation((_run: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      createRunInDb(db, { id: 'run-timeout', projectId: 'proj-1', agentInstanceId: 'agent-timeout' });
      scheduler.enqueue(makeRun({ runId: 'run-timeout', agentInstanceId: 'agent-timeout' }));

      await vi.advanceTimersByTimeAsync((4 * 60 * 60 * 1_000) - 1);
      expect((db.prepare('SELECT status FROM agent_runs WHERE id = ?').get('run-timeout') as { status: string }).status).toBe('running');

      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTicks();
      const row = db.prepare('SELECT status, error_code FROM agent_runs WHERE id = ?').get('run-timeout') as { status: string; error_code: string | null };
      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('RUN_TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });
});
