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
    expect(peak).toBeLessThanOrEqual(4);
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
});
