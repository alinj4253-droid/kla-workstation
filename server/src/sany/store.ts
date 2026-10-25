import type { Pool, PoolClient } from 'pg';
import { SANY_SEED } from './seed-data.js';

export type SanyProjectRow = {
  id: string;
  owner_identity_id: string;
  name: string;
  org_name: string;
  planning_period: string;
  plan_year: string;
  deadline: Date | null;
  intent: string;
  status: string;
  output_generated: boolean;
  output_released: boolean;
  delivery_checks: Record<string, boolean>;
  decisions: Record<string, string>;
  conclusion: string;
};

const dateOnly = (value: Date | string | null): string | null => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
};

/** 每个身份维护一个进行中的规划项目；首次访问时创建并写入初始业务数据。 */
export async function ensureSanyProject(pool: Pool, identityId: string): Promise<SanyProjectRow> {
  const existing = await pool.query<SanyProjectRow>("SELECT * FROM sany_projects WHERE owner_identity_id=$1 AND status='active'", [identityId]);
  if (existing.rows[0]) return existing.rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<SanyProjectRow>(`INSERT INTO sany_projects
      (owner_identity_id, name, org_name, planning_period, plan_year, deadline, intent)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING
      RETURNING *`, [
      identityId,
      SANY_SEED.project.name,
      SANY_SEED.project.orgName,
      SANY_SEED.project.planningPeriod,
      SANY_SEED.project.planYear,
      SANY_SEED.project.deadline,
      SANY_SEED.project.intent,
    ]);
    const project = inserted.rows[0] ?? (await client.query<SanyProjectRow>("SELECT * FROM sany_projects WHERE owner_identity_id=$1 AND status='active'", [identityId])).rows[0];
    if (inserted.rows[0]) await seedProject(client, project.id, identityId);
    await client.query('COMMIT');
    return project;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedProject(client: PoolClient, projectId: string, ownerIdentityId: string): Promise<void> {
  for (const member of SANY_SEED.members) {
    await client.query(`INSERT INTO sany_members (project_id, emp_no, name, title, unit, role, color, joined_on, status, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (project_id, emp_no) DO NOTHING`, [
      projectId, member.empNo, member.name, member.title, member.unit, member.role, member.color, member.joinedOn, member.status, member.sortOrder,
    ]);
  }

  const taskIds = new Map<string, string>();
  for (const task of SANY_SEED.tasks) {
    const row = await client.query<{ id: string }>(`INSERT INTO sany_tasks
      (project_id, code, title, unit, owner_name, task_type, task_type_name, deadline, assigned_at, status, intent, requirements, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [
      projectId, task.code, task.title, task.unit, task.ownerName, task.taskType, task.taskTypeName, task.deadline, task.assignedAt,
      task.status, task.intent, JSON.stringify(task.requirements), task.sortOrder,
    ]);
    taskIds.set(task.code, row.rows[0].id);
  }

  await seedTaskAssignments(client, projectId, taskIds, ownerIdentityId);

  for (const doc of SANY_SEED.documents) {
    await client.query(`INSERT INTO sany_documents
      (project_id, task_id, scope, module_key, name, ext, size_label, color, page_count, claim_count, field_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
      projectId, doc.taskCode ? taskIds.get(doc.taskCode) ?? null : null, doc.scope, doc.moduleKey, doc.name, doc.ext, doc.sizeLabel,
      doc.color, doc.pageCount, doc.claimCount, doc.fieldCount,
    ]);
  }

  for (const field of SANY_SEED.fields) {
    await client.query(`INSERT INTO sany_fields
      (project_id, task_id, scope, module_key, field_key, label, field_type, ai_content, confidence, source, status, human_content, gap, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [
      projectId, field.taskCode ? taskIds.get(field.taskCode) ?? null : null, field.scope, field.moduleKey, field.fieldKey, field.label,
      field.fieldType, field.aiContent, field.confidence, field.source, field.status, field.humanContent, field.gap, field.sortOrder,
    ]);
  }

  for (const issue of SANY_SEED.issues) {
    await client.query(`INSERT INTO sany_issues (project_id, code, level, title, detail, owner_name, status, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (project_id, code) DO NOTHING`, [
      projectId, issue.code, issue.level, issue.title, issue.detail, issue.ownerName, issue.status, issue.sortOrder,
    ]);
  }

  for (const output of SANY_SEED.outputs) {
    const inserted = await client.query<{ id: string }>(`INSERT INTO sany_outputs (project_id, output_key, name, description, note, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [projectId, output.outputKey, output.name, output.description, output.note, output.sortOrder]);
    const outputId = inserted.rows[0].id;
    for (const version of output.versions) {
      await client.query(`INSERT INTO sany_output_versions
        (output_id, version_no, created_label, created_by, status, summary, changes, size_label, file_name, audit, page_names)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
        outputId, version.versionNo, version.createdLabel, version.createdBy, version.status, version.summary,
        version.changes, version.sizeLabel, version.fileName, version.audit, JSON.stringify(version.pageNames),
      ]);
    }
  }
}

function assignmentStatusFor(taskStatus: string): string {
  if (taskStatus === '已提交') return 'submitted';
  if (taskStatus === '已退回') return 'returned';
  if (taskStatus === '已通过' || taskStatus === '已收束') return 'accepted';
  if (taskStatus === '分析中' || taskStatus === '校验中' || taskStatus === '待补充') return 'in_progress';
  return 'assigned';
}

async function seedTaskAssignments(client: PoolClient, projectId: string, taskIds: Map<string, string>, ownerIdentityId: string): Promise<void> {
  for (const task of SANY_SEED.tasks) {
    const taskId = taskIds.get(task.code);
    if (!taskId) continue;
    const member = SANY_SEED.members.find(item => item.name === task.ownerName && item.unit === task.unit);
    if (!member) continue;
    const memberRow = await client.query<{ id: string; identity_id: string | null }>(
      'SELECT id, identity_id FROM sany_members WHERE project_id=$1 AND emp_no=$2', [projectId, member.empNo]);
    if (!memberRow.rows[0]) continue;
    await client.query(`INSERT INTO sany_task_assignments
      (project_id, task_id, member_id, assignee_identity_id, assigned_by_identity_id, status, individual_note, assigned_at)
      VALUES ($1,$2,$3,$4,$5,$6,'',$7) ON CONFLICT (task_id, member_id) DO NOTHING`, [
      projectId, taskId, memberRow.rows[0].id, memberRow.rows[0].identity_id, ownerIdentityId,
      assignmentStatusFor(task.status), task.assignedAt,
    ]);
  }
}

export async function readSanyBootstrap(pool: Pool, project: SanyProjectRow): Promise<Record<string, unknown>> {
  const [members, tasks, documents, fields, issues, outputs, versions, feedback, assignments] = await Promise.all([
    pool.query('SELECT * FROM sany_members WHERE project_id=$1 ORDER BY sort_order, joined_on, name', [project.id]),
    pool.query(`SELECT t.*,
        (SELECT count(*) FROM sany_documents d WHERE d.task_id=t.id)::int AS doc_count,
        (SELECT count(*) FROM sany_fields f WHERE f.task_id=t.id AND f.scope='unit' AND NOT f.removed)::int AS field_count,
        (SELECT count(*) FROM sany_fields f WHERE f.task_id=t.id AND f.scope='unit' AND NOT f.removed AND f.status IN ('accepted','edited','rejected'))::int AS verified_count,
        (SELECT count(*) FROM sany_fields f WHERE f.task_id=t.id AND f.scope='unit' AND NOT f.removed AND f.status='missing')::int AS gap_count,
        (SELECT count(*) FROM sany_task_submissions s WHERE s.task_id=t.id)::int AS submission_count,
        (SELECT s.submission_no FROM sany_task_submissions s WHERE s.task_id=t.id ORDER BY s.submission_no DESC LIMIT 1) AS latest_no,
        (SELECT s.status FROM sany_task_submissions s WHERE s.task_id=t.id ORDER BY s.submission_no DESC LIMIT 1) AS latest_status,
        (SELECT s.summary FROM sany_task_submissions s WHERE s.task_id=t.id ORDER BY s.submission_no DESC LIMIT 1) AS latest_summary,
        (SELECT s.submitted_at FROM sany_task_submissions s WHERE s.task_id=t.id ORDER BY s.submission_no DESC LIMIT 1) AS latest_submitted_at
      FROM sany_tasks t WHERE t.project_id=$1 ORDER BY t.sort_order, t.code`, [project.id]),
    pool.query('SELECT * FROM sany_documents WHERE project_id=$1 ORDER BY scope DESC, module_key, created_at', [project.id]),
    pool.query('SELECT * FROM sany_fields WHERE project_id=$1 ORDER BY scope DESC, module_key, sort_order, field_key', [project.id]),
    pool.query('SELECT * FROM sany_issues WHERE project_id=$1 ORDER BY sort_order, code', [project.id]),
    pool.query('SELECT * FROM sany_outputs WHERE project_id=$1 ORDER BY sort_order', [project.id]),
    pool.query('SELECT v.* FROM sany_output_versions v JOIN sany_outputs o ON o.id=v.output_id WHERE o.project_id=$1 ORDER BY v.version_no', [project.id]),
    pool.query('SELECT * FROM sany_feedback WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20', [project.id]),
    pool.query('SELECT a.* FROM sany_task_assignments a WHERE a.project_id=$1 ORDER BY a.task_id, a.member_id', [project.id]),
  ]);

  return {
    project: {
      id: project.id,
      name: project.name,
      orgName: project.org_name,
      planningPeriod: project.planning_period,
      planYear: project.plan_year,
      deadline: dateOnly(project.deadline),
      intent: project.intent,
      status: project.status,
      outputGenerated: project.output_generated,
      outputReleased: project.output_released,
      deliveryChecks: project.delivery_checks ?? {},
      decisions: project.decisions ?? {},
      conclusion: project.conclusion,
    },
    members: members.rows.map(row => ({
      id: row.id, empNo: row.emp_no, name: row.name, title: row.title, unit: row.unit,
      role: row.role, color: row.color, joined: dateOnly(row.joined_on), status: row.status,
    })),
    tasks: tasks.rows.map(row => ({
      id: row.id, code: row.code, title: row.title, unit: row.unit, owner: row.owner_name,
      type: row.task_type, typeName: row.task_type_name, deadline: dateOnly(row.deadline),
      assignedAt: dateOnly(row.assigned_at), status: row.status, intent: row.intent,
      requirements: row.requirements ?? [],
      docs: row.doc_count, prefill: row.field_count, verified: row.verified_count, gaps: row.gap_count,
      submissions: row.submission_count ?? 0,
      latestSubmission: row.latest_no
        ? { no: row.latest_no, status: row.latest_status, summary: row.latest_summary ?? '', submittedAt: dateOnly(row.latest_submitted_at) ?? '' }
        : null,
    })),
    documents: documents.rows.map(row => ({
      id: row.id, taskId: row.task_id, scope: row.scope, moduleKey: row.module_key,
      name: row.name, ext: row.ext, size: row.size_label, color: row.color,
      pages: row.page_count, claims: row.claim_count, fields: row.field_count,
      createdAt: row.created_at,
    })),
    fields: fields.rows.map(row => ({
      id: row.id, taskId: row.task_id, scope: row.scope, moduleKey: row.module_key,
      k: row.field_key, n: row.label, type: row.field_type, ai: row.ai_content,
      conf: row.confidence, src: row.source, status: row.status, human: row.human_content ?? undefined,
      gap: row.gap || undefined, removed: row.removed, removedReason: row.removed_reason ?? undefined,
      custom: row.is_custom,
    })),
    issues: issues.rows.map(row => ({
      id: row.id, code: row.code, level: row.level, title: row.title, detail: row.detail,
      owner: row.owner_name, status: row.status,
    })),
    outputs: outputs.rows.map(output => ({
      key: output.output_key, name: output.name, description: output.description, note: output.note,
      versions: versions.rows.filter(version => version.output_id === output.id).map(version => ({
        v: version.version_no, at: version.created_label, by: version.created_by, status: version.status,
        summary: version.summary, changes: version.changes, size: version.size_label,
        file: version.file_name, audit: version.audit ?? undefined, pageNames: version.page_names ?? [],
      })),
    })),
    feedback: feedback.rows.map(row => ({
      id: row.id, author: row.author_name, content: row.content, createdAt: row.created_at,
    })),
    assignments: assignments.rows.map(row => ({
      id: row.id, taskId: row.task_id, memberId: row.member_id,
      status: row.status, assigneeIdentityId: row.assignee_identity_id,
      individualNote: row.individual_note,
      assignedAt: dateOnly(row.assigned_at) ?? '',
      submittedAt: dateOnly(row.submitted_at),
      acceptedAt: dateOnly(row.accepted_at),
      closedAt: dateOnly(row.closed_at),
    })),
  };
}

export async function readSanyTaskWorkflow(pool: Pool, projectId: string, taskId: string): Promise<Record<string, unknown> | null> {
  const task = await pool.query('SELECT * FROM sany_tasks WHERE id=$1 AND project_id=$2', [taskId, projectId]);
  if (!task.rows[0]) return null;
  const [assignment, submissions, closures, events] = await Promise.all([
    pool.query('SELECT * FROM sany_task_assignments WHERE task_id=$1 AND project_id=$2 ORDER BY assigned_at LIMIT 1', [taskId, projectId]),
    pool.query('SELECT * FROM sany_task_submissions WHERE task_id=$1 AND project_id=$2 ORDER BY submission_no', [taskId, projectId]),
    pool.query('SELECT c.*, i.display_name AS actor_name FROM sany_task_closures c JOIN identities i ON i.id=c.actor_identity_id WHERE c.task_id=$1 AND c.project_id=$2 ORDER BY c.created_at', [taskId, projectId]),
    pool.query('SELECT e.*, i.display_name AS actor_name FROM sany_task_events e JOIN identities i ON i.id=e.actor_identity_id WHERE e.task_id=$1 AND e.project_id=$2 ORDER BY e.created_at', [taskId, projectId]),
  ]);
  return {
    task: {
      id: task.rows[0].id, code: task.rows[0].code, title: task.rows[0].title, unit: task.rows[0].unit,
      owner: task.rows[0].owner_name, type: task.rows[0].task_type, typeName: task.rows[0].task_type_name,
      deadline: dateOnly(task.rows[0].deadline), assignedAt: dateOnly(task.rows[0].assigned_at),
      status: task.rows[0].status, intent: task.rows[0].intent, requirements: task.rows[0].requirements ?? [],
    },
    assignment: assignment.rows[0]
      ? {
        id: assignment.rows[0].id, status: assignment.rows[0].status,
        assigneeIdentityId: assignment.rows[0].assignee_identity_id, individualNote: assignment.rows[0].individual_note,
        assignedAt: dateOnly(assignment.rows[0].assigned_at) ?? '',
        submittedAt: dateOnly(assignment.rows[0].submitted_at),
        acceptedAt: dateOnly(assignment.rows[0].accepted_at),
        closedAt: dateOnly(assignment.rows[0].closed_at),
      }
      : null,
    submissions: submissions.rows.map(row => ({
      id: row.id, no: row.submission_no, status: row.status, summary: row.summary,
      deliverables: row.deliverables ?? [], fieldSnapshot: row.field_snapshot ?? [],
      reviewerNote: row.reviewer_note ?? '',
      submittedAt: row.submitted_at, reviewedAt: row.reviewed_at,
    })),
    closures: closures.rows.map(row => ({
      id: row.id, action: row.action, note: row.note ?? '', actor: row.actor_name, createdAt: row.created_at,
    })),
    events: events.rows.map(row => ({
      id: row.id, eventType: row.event_type, fromStatus: row.from_status, toStatus: row.to_status,
      detail: row.detail ?? {}, actor: row.actor_name, createdAt: row.created_at,
    })),
  };
}
