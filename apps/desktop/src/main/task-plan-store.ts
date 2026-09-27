import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type PersistedTaskPlanInput = {
  projectId: string;
  rootRunId: string;
  triggerMessageId: string;
  resolvedGoal: string;
  complexity: 'simple' | 'complex' | 'missing-input';
  status?: 'planned' | 'running' | 'waiting-user' | 'completed' | 'failed' | 'cancelled';
  completionCriteria: string[];
  nodes: Array<{
    id: string;
    title: string;
    objective: string;
    inputs?: string[];
    expectedResult?: string;
    completionCriteria: string[];
    dependsOn: string[];
    executionMode?: 'serial' | 'parallel' | 'wait-user';
    assignedAgentId?: string;
    status?: 'pending' | 'ready' | 'assigned' | 'running' | 'waiting-user' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  }>;
};

export class TaskPlanStore {
  constructor(private readonly db: Database.Database) {}

  save(input: PersistedTaskPlanInput): string {
    const existing = this.db.prepare('SELECT id, revision FROM task_plans WHERE root_run_id = ?').get(input.rootRunId) as { id: string; revision: number } | undefined;
    const planId = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO task_plans (id, project_id, root_run_id, trigger_message_id, resolved_goal, complexity, status, revision, completion_criteria_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(root_run_id) DO UPDATE SET resolved_goal=excluded.resolved_goal, complexity=excluded.complexity,
           status=excluded.status, revision=task_plans.revision + 1,
           completion_criteria_json=excluded.completion_criteria_json, updated_at=excluded.updated_at`,
      ).run(planId, input.projectId, input.rootRunId, input.triggerMessageId, input.resolvedGoal, input.complexity,
        input.status ?? (input.complexity === 'missing-input' ? 'waiting-user' : 'planned'), existing?.revision ?? 1,
        JSON.stringify(input.completionCriteria), now, now);
      this.db.prepare('DELETE FROM task_nodes WHERE plan_id = ?').run(planId);
      const insert = this.db.prepare(
        `INSERT INTO task_nodes (id, plan_id, node_key, ordinal, title, objective, inputs_json, expected_result,
          completion_criteria_json, depends_on_json, execution_mode, assigned_agent_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      input.nodes.forEach((node, ordinal) => insert.run(
        randomUUID(), planId, node.id || `node-${ordinal + 1}`, ordinal, node.title, node.objective, JSON.stringify(node.inputs ?? []),
        node.expectedResult ?? '', JSON.stringify(node.completionCriteria), JSON.stringify(node.dependsOn),
        node.executionMode ?? 'serial', node.assignedAgentId ?? null, node.status ?? (node.dependsOn.length ? 'pending' : 'ready'), now, now,
      ));
    })();
    return planId;
  }

  updateNode(rootRunId: string, nodeId: string, patch: { status: string; assignedAgentId?: string; resultMessageId?: string; artifacts?: unknown[] }): void {
    const plan = this.db.prepare('SELECT id FROM task_plans WHERE root_run_id = ?').get(rootRunId) as { id: string } | undefined;
    if (!plan) return;
    this.db.prepare(
      `UPDATE task_nodes SET status = ?, assigned_agent_id = COALESCE(?, assigned_agent_id),
       result_message_id = COALESCE(?, result_message_id), artifact_refs_json = COALESCE(?, artifact_refs_json),
       attempt = CASE WHEN ? IN ('assigned','running') THEN attempt + 1 ELSE attempt END, updated_at = ?
       WHERE plan_id = ? AND node_key = ?`,
    ).run(patch.status, patch.assignedAgentId ?? null, patch.resultMessageId ?? null,
      patch.artifacts ? JSON.stringify(patch.artifacts) : null, patch.status, new Date().toISOString(), plan.id, nodeId);
  }

  setStatus(rootRunId: string, status: 'planned' | 'running' | 'waiting-user' | 'completed' | 'failed' | 'cancelled'): void {
    this.db.prepare('UPDATE task_plans SET status = ?, updated_at = ? WHERE root_run_id = ?')
      .run(status, new Date().toISOString(), rootRunId);
  }
}
