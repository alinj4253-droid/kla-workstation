import type { Pool, PoolClient } from 'pg';
import { SANY_SEED } from './seed-data.js';

export type SanyProjectRow = {
  id: string;
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
    if (inserted.rows[0]) await seedProject(client, project.id);
    await client.query('COMMIT');
    return project;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedProject(client: PoolClient, projectId: string): Promise<void> {
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

export async function readSanyBootstrap(pool: Pool, project: SanyProjectRow): Promise<Record<string, unknown>> {
  const [members, tasks, documents, fields, issues, outputs, versions, feedback] = await Promise.all([
    pool.query('SELECT * FROM sany_members WHERE project_id=$1 ORDER BY sort_order, joined_on, name', [project.id]),
    pool.query(`SELECT t.*,
        (SELECT count(*) FROM sany_documents d WHERE d.task_id=t.id)::int AS doc_count,
        (SELECT count(*) FROM sany_fields f WHERE f.task_id=t.id AND f.scope='unit' AND NOT f.removed)::int AS field_count,
        (SELECT count(*) FROM sany_fields f WHERE f.task_id=t.id AND f.scope='unit' AND NOT f.removed AND f.status IN ('accepted','edited','rejected'))::int AS verified_count,
        (SELECT count(*) FROM sany_fields f WHERE f.task_id=t.id AND f.scope='unit' AND NOT f.removed AND f.status='missing')::int AS gap_count
      FROM sany_tasks t WHERE t.project_id=$1 ORDER BY t.sort_order, t.code`, [project.id]),
    pool.query('SELECT * FROM sany_documents WHERE project_id=$1 ORDER BY scope DESC, module_key, created_at', [project.id]),
    pool.query('SELECT * FROM sany_fields WHERE project_id=$1 ORDER BY scope DESC, module_key, sort_order, field_key', [project.id]),
    pool.query('SELECT * FROM sany_issues WHERE project_id=$1 ORDER BY sort_order, code', [project.id]),
    pool.query('SELECT * FROM sany_outputs WHERE project_id=$1 ORDER BY sort_order', [project.id]),
    pool.query('SELECT v.* FROM sany_output_versions v JOIN sany_outputs o ON o.id=v.output_id WHERE o.project_id=$1 ORDER BY v.version_no', [project.id]),
    pool.query('SELECT * FROM sany_feedback WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20', [project.id]),
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
  };
}
