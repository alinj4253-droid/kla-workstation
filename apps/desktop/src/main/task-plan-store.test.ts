import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskPlanStore } from './task-plan-store';

describe('TaskPlanStore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE task_plans (
        id TEXT PRIMARY KEY, project_id TEXT, root_run_id TEXT UNIQUE, trigger_message_id TEXT,
        resolved_goal TEXT, complexity TEXT, status TEXT, revision INTEGER,
        completion_criteria_json TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE task_nodes (
        id TEXT PRIMARY KEY, plan_id TEXT, node_key TEXT, ordinal INTEGER, title TEXT, objective TEXT,
        inputs_json TEXT, expected_result TEXT, completion_criteria_json TEXT, depends_on_json TEXT,
        execution_mode TEXT, assigned_agent_id TEXT, status TEXT, attempt INTEGER DEFAULT 0,
        result_message_id TEXT, artifact_refs_json TEXT DEFAULT '[]', created_at TEXT, updated_at TEXT,
        UNIQUE(plan_id, node_key)
      );
    `);
  });

  afterEach(() => db.close());

  it('keeps repeated business node keys isolated by plan', () => {
    const store = new TaskPlanStore(db);
    const save = (runId: string) => store.save({
      projectId: 'group-1', rootRunId: runId, triggerMessageId: `message-${runId}`,
      resolvedGoal: '完成复杂任务', complexity: 'complex', completionCriteria: ['完成交付'],
      nodes: [{ id: 'stage-1', title: '取得输入', objective: '取得输入', completionCriteria: ['输入有效'], dependsOn: [] }],
    });
    save('run-1');
    save('run-2');
    expect((db.prepare('SELECT COUNT(*) AS count FROM task_nodes').get() as { count: number }).count).toBe(2);
    store.updateNode('run-1', 'stage-1', { status: 'completed' });
    const statuses = db.prepare('SELECT tp.root_run_id AS runId, tn.status FROM task_nodes tn JOIN task_plans tp ON tp.id = tn.plan_id ORDER BY tp.root_run_id').all() as Array<{ runId: string; status: string }>;
    expect(statuses).toEqual([{ runId: 'run-1', status: 'completed' }, { runId: 'run-2', status: 'ready' }]);
  });
});
