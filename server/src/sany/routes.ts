import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { apiError } from '@kla-workstation/contracts';
import type { Identity } from '../repositories/types.js';
import { ensureSanyProject, readSanyBootstrap, readSanyTaskWorkflow, type SanyProjectRow } from './store.js';

type Dependencies = {
  pool?: Pool;
  authorize(request: FastifyRequest, reply: FastifyReply, action: 'read' | 'write'): Promise<Identity | null>;
};

const uuid = z.string().uuid();
const moduleKey = z.enum(['review', 'market', 'biz', 'plan']);
const closureAction = z.enum(['returned', 'accepted', 'closed', 'reminded']);

function fail(reply: FastifyReply, request: FastifyRequest, status: number, code: Parameters<typeof apiError>[0], message: string) {
  return reply.code(status).send(apiError(code, message, { requestId: request.id }));
}

/** 管理员身份校验：项目归属身份（规划项目创建者）或项目内 admin 成员。 */
async function isSanyAdmin(pool: Pool, project: SanyProjectRow, identity: Identity): Promise<boolean> {
  if (identity.id === project.owner_identity_id) return true;
  const member = await pool.query("SELECT 1 FROM sany_members WHERE project_id=$1 AND identity_id=$2 AND role='admin'", [project.id, identity.id]);
  return member.rows.length > 0;
}

/** 任务事件流水：记录每一次状态变更，供收束历史回溯。 */
async function writeTaskEvent(pool: { query: Pool['query'] }, projectId: string, taskId: string, assignmentId: string | null, identity: Identity, eventType: string, fromStatus: string | null, toStatus: string | null, detail: Record<string, unknown>): Promise<void> {
  await pool.query(`INSERT INTO sany_task_events (project_id, task_id, assignment_id, actor_identity_id, event_type, from_status, to_status, detail)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    projectId, taskId, assignmentId, identity.id, eventType, fromStatus, toStatus, JSON.stringify(detail),
  ]);
}

export async function registerSanyRoutes(app: FastifyInstance, deps: Dependencies): Promise<void> {
  const projectFor = async (identity: Identity): Promise<SanyProjectRow | null> => {
    if (!deps.pool) return null;
    return ensureSanyProject(deps.pool, identity.id);
  };

  app.get('/api/v1/sany/bootstrap', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'read');
    if (!identity) return;
    const project = await projectFor(identity);
    if (!project || !deps.pool) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    return reply.send({ ok: true, data: await readSanyBootstrap(deps.pool, project), meta: { requestId: request.id } });
  });

  app.post('/api/v1/sany/members', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const input = z.object({
      empNo: z.string().trim().min(1),
      name: z.string().trim().min(1),
      title: z.string().trim().default(''),
      unit: z.string().trim().default(''),
      role: z.enum(['admin', 'owner']).default('owner'),
    }).safeParse(request.body);
    if (!input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', input.error.issues[0]?.message ?? '成员信息不完整');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    try {
      const result = await deps.pool.query(`INSERT INTO sany_members (project_id, emp_no, name, title, unit, role, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(max(sort_order),0)+1 FROM sany_members WHERE project_id=$1))
        ON CONFLICT (project_id, emp_no) DO NOTHING
        RETURNING id, emp_no, name, title, unit, role, color, joined_on, status`, [
        project.id, input.data.empNo, input.data.name, input.data.title, input.data.unit, input.data.role,
      ]);
      if (!result.rows[0]) return fail(reply, request, 409, 'CONFLICT', '该成员已在项目中');
      const row = result.rows[0];
      return reply.code(201).send({ ok: true, data: {
        id: row.id, empNo: row.emp_no, name: row.name, title: row.title, unit: row.unit,
        role: row.role, color: row.color, joined: new Date(row.joined_on).toISOString().slice(0, 10), status: row.status,
      }, meta: { requestId: request.id } });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to add sany member');
      return fail(reply, request, 503, 'UNAVAILABLE', '成员保存失败，请稍后重试');
    }
  });

  app.delete('/api/v1/sany/members/:memberId', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const id = uuid.safeParse((request.params as { memberId: string }).memberId);
    if (!id.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', '成员编号无效');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    const target = await deps.pool.query('SELECT role FROM sany_members WHERE id=$1 AND project_id=$2', [id.data, project.id]);
    if (!target.rows[0]) return fail(reply, request, 404, 'NOT_FOUND', '成员不存在或已移出');
    if (target.rows[0].role === 'admin') {
      const admins = await deps.pool.query("SELECT count(*)::int AS n FROM sany_members WHERE project_id=$1 AND role='admin'", [project.id]);
      if (admins.rows[0].n <= 1) return fail(reply, request, 409, 'CONFLICT', '不能移出唯一的管理员');
    }
    await deps.pool.query('DELETE FROM sany_members WHERE id=$1 AND project_id=$2', [id.data, project.id]);
    return reply.send({ ok: true, data: null, meta: { requestId: request.id } });
  });

  app.post('/api/v1/sany/documents', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const input = z.object({
      scope: z.enum(['company', 'unit']),
      moduleKey,
      taskId: uuid.nullish(),
      name: z.string().trim().min(1),
      ext: z.string().trim().min(1),
      size: z.string().trim().default(''),
      color: z.string().trim().default('#3a4a63'),
      pages: z.number().int().min(0).default(0),
      claims: z.number().int().min(0).default(0),
      fields: z.number().int().min(0).default(0),
    }).safeParse(request.body);
    if (!input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', input.error.issues[0]?.message ?? '材料信息不完整');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    if (input.data.taskId) {
      const task = await deps.pool.query('SELECT id FROM sany_tasks WHERE id=$1 AND project_id=$2', [input.data.taskId, project.id]);
      if (!task.rows[0]) return fail(reply, request, 404, 'NOT_FOUND', '任务不存在');
    }
    const result = await deps.pool.query(`INSERT INTO sany_documents
      (project_id, task_id, scope, module_key, name, ext, size_label, color, page_count, claim_count, field_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id, task_id, scope, module_key, name, ext, size_label, color, page_count, claim_count, field_count, created_at`, [
      project.id, input.data.taskId ?? null, input.data.scope, input.data.moduleKey, input.data.name, input.data.ext,
      input.data.size, input.data.color, input.data.pages, input.data.claims, input.data.fields,
    ]);
    const row = result.rows[0];
    return reply.code(201).send({ ok: true, data: {
      id: row.id, taskId: row.task_id, scope: row.scope, moduleKey: row.module_key, name: row.name, ext: row.ext,
      size: row.size_label, color: row.color, pages: row.page_count, claims: row.claim_count, fields: row.field_count, createdAt: row.created_at,
    }, meta: { requestId: request.id } });
  });

  app.delete('/api/v1/sany/documents/:documentId', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const id = uuid.safeParse((request.params as { documentId: string }).documentId);
    if (!id.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', '材料编号无效');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    const deleted = await deps.pool.query('DELETE FROM sany_documents WHERE id=$1 AND project_id=$2 RETURNING id', [id.data, project.id]);
    if (!deleted.rows[0]) return fail(reply, request, 404, 'NOT_FOUND', '材料不存在');
    return reply.send({ ok: true, data: null, meta: { requestId: request.id } });
  });

  app.post('/api/v1/sany/fields', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const input = z.object({
      scope: z.enum(['company', 'unit']),
      moduleKey,
      taskId: uuid.nullish(),
      label: z.string().trim().min(1),
      type: z.enum(['num', 'text', 'table']).default('text'),
      ai: z.string().default(''),
      human: z.string().nullish(),
    }).safeParse(request.body);
    if (!input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', input.error.issues[0]?.message ?? '字段信息不完整');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    const result = await deps.pool.query(`INSERT INTO sany_fields
      (project_id, task_id, scope, module_key, field_key, label, field_type, ai_content, confidence, source, status, human_content, is_custom, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'',$9,$10,true,
        (SELECT COALESCE(max(sort_order),0)+1 FROM sany_fields WHERE project_id=$1 AND scope=$3 AND module_key=$4))
      RETURNING *`, [
      project.id, input.data.taskId ?? null, input.data.scope, input.data.moduleKey,
      `custom-${Date.now().toString(36)}`, input.data.label, input.data.type, input.data.ai,
      input.data.human ? 'edited' : 'pending', input.data.human ?? null,
    ]);
    const row = result.rows[0];
    return reply.code(201).send({ ok: true, data: {
      id: row.id, taskId: row.task_id, scope: row.scope, moduleKey: row.module_key, k: row.field_key, n: row.label, type: row.field_type,
      ai: row.ai_content, conf: row.confidence, src: row.source, status: row.status, human: row.human_content ?? undefined,
      gap: row.gap || undefined, removed: row.removed, custom: row.is_custom,
    }, meta: { requestId: request.id } });
  });

  app.patch('/api/v1/sany/fields/:fieldId', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const id = uuid.safeParse((request.params as { fieldId: string }).fieldId);
    const input = z.object({
      status: z.enum(['pending', 'accepted', 'edited', 'rejected', 'missing']).optional(),
      humanContent: z.string().nullable().optional(),
      removed: z.boolean().optional(),
      removedReason: z.string().nullable().optional(),
    }).safeParse(request.body);
    if (!id.success || !input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', '字段更新参数无效');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    const hasHuman = Object.prototype.hasOwnProperty.call(input.data, 'humanContent');
    const hasReason = Object.prototype.hasOwnProperty.call(input.data, 'removedReason');
    const result = await deps.pool.query(`UPDATE sany_fields SET
        status=COALESCE($3,status),
        human_content=CASE WHEN $4::boolean THEN $5 ELSE human_content END,
        removed=COALESCE($6,removed),
        removed_reason=CASE WHEN $7::boolean THEN $8 ELSE removed_reason END,
        updated_at=now()
      WHERE id=$1 AND project_id=$2 RETURNING *`, [
      id.data, project.id, input.data.status ?? null, hasHuman, input.data.humanContent ?? null,
      input.data.removed ?? null, hasReason, input.data.removedReason ?? null,
    ]);
    if (!result.rows[0]) return fail(reply, request, 404, 'NOT_FOUND', '字段不存在');
    const row = result.rows[0];
    return reply.send({ ok: true, data: {
      id: row.id, taskId: row.task_id, scope: row.scope, moduleKey: row.module_key, k: row.field_key, n: row.label, type: row.field_type,
      ai: row.ai_content, conf: row.confidence, src: row.source, status: row.status, human: row.human_content ?? undefined,
      gap: row.gap || undefined, removed: row.removed, removedReason: row.removed_reason ?? undefined, custom: row.is_custom,
    }, meta: { requestId: request.id } });
  });

  app.post('/api/v1/sany/tasks', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const input = z.object({
      title: z.string().trim().min(1),
      intent: z.string().trim().default(''),
      deadline: z.string().trim().min(1),
      planningPeriod: z.string().trim().default(''),
      owners: z.array(z.object({ name: z.string().trim().min(1), unit: z.string().trim().min(1), note: z.string().trim().default('') })).min(1),
      requirements: z.array(z.string().trim().min(1)).default([]),
    }).safeParse(request.body);
    if (!input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', input.error.issues[0]?.message ?? '派发参数无效');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    if (!await isSanyAdmin(deps.pool, project, identity)) return fail(reply, request, 403, 'FORBIDDEN', '仅管理员可以派发任务');
    const base = await deps.pool.query('SELECT count(*)::int AS n FROM sany_tasks WHERE project_id=$1', [project.id]);
    let sequence = base.rows[0].n;
    const created: string[] = [];
    for (const owner of input.data.owners) {
      sequence += 1;
      const code = `R-${String(sequence).padStart(2, '0')}`;
      const member = await deps.pool.query<{ id: string; identity_id: string | null }>(
        'SELECT id, identity_id FROM sany_members WHERE project_id=$1 AND name=$2 AND unit=$3 AND role=$4', [project.id, owner.name, owner.unit, 'owner']);
      if (!member.rows[0]) return fail(reply, request, 400, 'INVALID_ARGUMENT', `负责人 ${owner.name}（${owner.unit}）不在组织成员中`);
      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');
        const taskRow = await client.query<{ id: string }>(`INSERT INTO sany_tasks
          (project_id, code, title, unit, owner_name, task_type, task_type_name, deadline, assigned_at, status, intent, requirements, sort_order, planning_period, assigned_by_identity_id, individual_note)
          VALUES ($1,$2,$3,$4,$5,'T-BG','成长型业务',$6,current_date,'待上传',$7,$8,$9,$10,$11,$12)
          ON CONFLICT (project_id, code) DO NOTHING RETURNING id`, [
          project.id, code, input.data.title, owner.unit, owner.name, input.data.deadline,
          input.data.intent, JSON.stringify(input.data.requirements), sequence, input.data.planningPeriod,
          identity.id, owner.note,
        ]);
        if (!taskRow.rows[0]) { await client.query('ROLLBACK'); continue; }
        const taskId = taskRow.rows[0].id;
        const assignment = await client.query<{ id: string }>(`INSERT INTO sany_task_assignments
          (project_id, task_id, member_id, assignee_identity_id, assigned_by_identity_id, status, individual_note)
          VALUES ($1,$2,$3,$4,$5,'assigned',$6) RETURNING id`, [
          project.id, taskId, member.rows[0].id, member.rows[0].identity_id, identity.id, owner.note,
        ]);
        await writeTaskEvent(client, project.id, taskId, assignment.rows[0].id, identity, 'assigned', null, '待上传', {
          code, owner: owner.name, unit: owner.unit, requirements: input.data.requirements,
        });
        await client.query('COMMIT');
        created.push(taskId);
      } catch (error) {
        await client.query('ROLLBACK');
        request.log.error({ err: error }, 'Failed to create sany task');
        return fail(reply, request, 503, 'UNAVAILABLE', '任务派发失败，请稍后重试');
      } finally {
        client.release();
      }
    }
    return reply.code(201).send({ ok: true, data: { created: created.length }, meta: { requestId: request.id } });
  });

  app.get('/api/v1/sany/tasks/:taskId/workflow', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'read');
    if (!identity || !deps.pool) return;
    const taskId = uuid.safeParse((request.params as { taskId: string }).taskId);
    if (!taskId.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', '任务编号无效');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    const workflow = await readSanyTaskWorkflow(deps.pool, project.id, taskId.data);
    if (!workflow) return fail(reply, request, 404, 'NOT_FOUND', '任务不存在');
    return reply.send({ ok: true, data: workflow, meta: { requestId: request.id } });
  });

  app.post('/api/v1/sany/tasks/:taskId/submissions', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const taskId = uuid.safeParse((request.params as { taskId: string }).taskId);
    const input = z.object({
      summary: z.string().trim().min(1),
      deliverables: z.array(z.object({ name: z.string().trim().min(1), kind: z.string().trim().default('') })).default([]),
      note: z.string().trim().default(''),
    }).safeParse(request.body);
    if (!taskId.success || !input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', '提交参数无效');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    const task = await deps.pool.query<{ id: string; status: string }>('SELECT id, status FROM sany_tasks WHERE id=$1 AND project_id=$2', [taskId.data, project.id]);
    if (!task.rows[0]) return fail(reply, request, 404, 'NOT_FOUND', '任务不存在');
    const assignment = await deps.pool.query<{ id: string; assignee_identity_id: string | null }>(
      'SELECT id, assignee_identity_id FROM sany_task_assignments WHERE task_id=$1 AND project_id=$2 ORDER BY assigned_at LIMIT 1', [taskId.data, project.id]);
    if (!assignment.rows[0]) return fail(reply, request, 409, 'CONFLICT', '该任务尚未派发到具体负责人');
    if (task.rows[0].status === '已收束') return fail(reply, request, 409, 'CONFLICT', '任务已收束，不能再次提交');
    const assigneeLinked = assignment.rows[0].assignee_identity_id !== null;
    if (assigneeLinked && assignment.rows[0].assignee_identity_id !== identity.id
      && !await isSanyAdmin(deps.pool, project, identity)) {
      return fail(reply, request, 403, 'FORBIDDEN', '只有任务负责人可以提交成果');
    }
    const fieldSnapshot = await deps.pool.query<{ total: number; accepted: number; edited: number; rejected: number; missing: number; pending: number }>(
      `SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status IN ('accepted','edited'))::int AS accepted,
        count(*) FILTER (WHERE status = 'edited')::int AS edited,
        count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        count(*) FILTER (WHERE status = 'missing')::int AS missing,
        count(*) FILTER (WHERE status = 'pending')::int AS pending
      FROM sany_fields WHERE task_id=$1 AND scope='unit' AND NOT removed`, [taskId.data]);
    const next = await deps.pool.query<{ v: number }>('SELECT COALESCE(max(submission_no),0)+1 AS v FROM sany_task_submissions WHERE task_id=$1', [taskId.data]);
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query(`INSERT INTO sany_task_submissions
        (project_id, task_id, assignment_id, submission_no, submitted_by_identity_id, status, summary, deliverables, material_ids, output_refs, field_snapshot, reviewer_note)
        VALUES ($1,$2,$3,$4,$5,'submitted',$6,$7,'[]'::jsonb,'[]'::jsonb,$8,$9) RETURNING *`, [
        project.id, taskId.data, assignment.rows[0].id, next.rows[0].v, identity.id,
        input.data.summary, JSON.stringify(input.data.deliverables), JSON.stringify(fieldSnapshot.rows[0]), input.data.note,
      ]);
      await client.query("UPDATE sany_task_assignments SET status='submitted', submitted_at=now() WHERE id=$1", [assignment.rows[0].id]);
      await client.query("UPDATE sany_tasks SET status='已提交', closed_at=NULL, updated_at=now() WHERE id=$1", [taskId.data]);
      await writeTaskEvent(client, project.id, taskId.data, assignment.rows[0].id, identity, 'submitted', task.rows[0].status, '已提交', {
        submissionNo: next.rows[0].v, summary: input.data.summary, deliverables: input.data.deliverables,
      });
      await client.query('COMMIT');
      const created = row.rows[0];
      return reply.code(201).send({ ok: true, data: {
        id: created.id, no: created.submission_no, status: created.status, summary: created.summary,
        deliverables: created.deliverables ?? [], fieldSnapshot: created.field_snapshot ?? [],
        reviewerNote: created.reviewer_note ?? '', submittedAt: created.submitted_at,
      }, meta: { requestId: request.id } });
    } catch (error) {
      await client.query('ROLLBACK');
      request.log.error({ err: error }, 'Failed to create sany task submission');
      return fail(reply, request, 503, 'UNAVAILABLE', '成果提交失败，请稍后重试');
    } finally {
      client.release();
    }
  });

  app.post('/api/v1/sany/tasks/:taskId/closures', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const taskId = uuid.safeParse((request.params as { taskId: string }).taskId);
    const input = z.object({ action: closureAction, note: z.string().trim().default('') }).safeParse(request.body);
    if (!taskId.success || !input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', '收束参数无效');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    if (!await isSanyAdmin(deps.pool, project, identity)) return fail(reply, request, 403, 'FORBIDDEN', '仅管理员可以处理任务收束');
    const task = await deps.pool.query<{ id: string; status: string }>('SELECT id, status FROM sany_tasks WHERE id=$1 AND project_id=$2', [taskId.data, project.id]);
    if (!task.rows[0]) return fail(reply, request, 404, 'NOT_FOUND', '任务不存在');
    const assignment = await deps.pool.query<{ id: string }>(
      'SELECT id FROM sany_task_assignments WHERE task_id=$1 AND project_id=$2 ORDER BY assigned_at LIMIT 1', [taskId.data, project.id]);
    if (!assignment.rows[0]) return fail(reply, request, 409, 'CONFLICT', '该任务尚未派发到具体负责人');
    const latest = await deps.pool.query<{ id: string; submission_no: number; status: string }>(
      'SELECT id, submission_no, status FROM sany_task_submissions WHERE task_id=$1 AND project_id=$2 ORDER BY submission_no DESC LIMIT 1', [taskId.data, project.id]);
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const fromStatus = task.rows[0].status;
      let toStatus = fromStatus;
      if (input.data.action === 'reminded') {
        await client.query(`INSERT INTO sany_task_closures (project_id, task_id, actor_identity_id, action, note)
          VALUES ($1,$2,$3,'reminded',$4)`, [project.id, taskId.data, identity.id, input.data.note]);
        await writeTaskEvent(client, project.id, taskId.data, assignment.rows[0].id, identity, 'reminded', fromStatus, toStatus, { note: input.data.note });
      } else if (input.data.action === 'returned') {
        if (!latest.rows[0]) { await client.query('ROLLBACK'); return fail(reply, request, 409, 'CONFLICT', '没有可退回的成果提交'); }
        await client.query(`UPDATE sany_task_submissions SET status='returned', reviewed_at=now(), reviewer_note=$3 WHERE id=$1 AND project_id=$2`, [latest.rows[0].id, project.id, input.data.note]);
        await client.query("UPDATE sany_task_assignments SET status='returned' WHERE id=$1", [assignment.rows[0].id]);
        await client.query("UPDATE sany_tasks SET status='校验中', closed_at=NULL, updated_at=now() WHERE id=$1", [taskId.data]);
        await client.query(`INSERT INTO sany_task_closures (project_id, task_id, submission_id, actor_identity_id, action, note)
          VALUES ($1,$2,$3,$4,'returned',$5)`, [project.id, taskId.data, latest.rows[0].id, identity.id, input.data.note]);
        toStatus = '校验中';
        await writeTaskEvent(client, project.id, taskId.data, assignment.rows[0].id, identity, 'returned', fromStatus, toStatus, {
          submissionNo: latest.rows[0].submission_no, note: input.data.note,
        });
      } else if (input.data.action === 'accepted') {
        if (!latest.rows[0] || (latest.rows[0].status !== 'submitted' && latest.rows[0].status !== 'returned')) {
          await client.query('ROLLBACK'); return fail(reply, request, 409, 'CONFLICT', '当前没有待审核的成果提交');
        }
        await client.query(`UPDATE sany_task_submissions SET status='accepted', reviewed_at=now(), reviewer_note=$3 WHERE id=$1 AND project_id=$2`, [latest.rows[0].id, project.id, input.data.note]);
        await client.query("UPDATE sany_task_assignments SET status='accepted', accepted_at=now() WHERE id=$1", [assignment.rows[0].id]);
        await client.query("UPDATE sany_tasks SET status='已通过', updated_at=now() WHERE id=$1", [taskId.data]);
        await client.query(`INSERT INTO sany_task_closures (project_id, task_id, submission_id, actor_identity_id, action, note)
          VALUES ($1,$2,$3,$4,'accepted',$5)`, [project.id, taskId.data, latest.rows[0].id, identity.id, input.data.note]);
        toStatus = '已通过';
        await writeTaskEvent(client, project.id, taskId.data, assignment.rows[0].id, identity, 'accepted', fromStatus, toStatus, {
          submissionNo: latest.rows[0].submission_no, note: input.data.note,
        });
      } else {
        if (!latest.rows[0] || latest.rows[0].status !== 'accepted') {
          await client.query('ROLLBACK'); return fail(reply, request, 409, 'CONFLICT', '需先通过成果审核才能收束');
        }
        await client.query(`UPDATE sany_task_submissions SET status='closed' WHERE id=$1 AND project_id=$2`, [latest.rows[0].id, project.id]);
        await client.query("UPDATE sany_task_assignments SET status='closed', closed_at=now() WHERE id=$1", [assignment.rows[0].id]);
        await client.query("UPDATE sany_tasks SET status='已收束', closed_at=now(), updated_at=now() WHERE id=$1", [taskId.data]);
        await client.query(`INSERT INTO sany_task_closures (project_id, task_id, submission_id, actor_identity_id, action, note)
          VALUES ($1,$2,$3,$4,'closed',$5)`, [project.id, taskId.data, latest.rows[0].id, identity.id, input.data.note]);
        toStatus = '已收束';
        await writeTaskEvent(client, project.id, taskId.data, assignment.rows[0].id, identity, 'closed', fromStatus, toStatus, {
          submissionNo: latest.rows[0].submission_no, note: input.data.note,
        });
      }
      await client.query('COMMIT');
      const closure = await deps.pool.query(`SELECT c.id, c.action, c.note, c.created_at FROM sany_task_closures c
        WHERE c.task_id=$1 AND c.project_id=$2 ORDER BY c.created_at DESC LIMIT 1`, [taskId.data, project.id]);
      return reply.send({ ok: true, data: {
        id: closure.rows[0].id, action: closure.rows[0].action, note: closure.rows[0].note ?? '',
        taskStatus: toStatus, createdAt: closure.rows[0].created_at,
      }, meta: { requestId: request.id } });
    } catch (error) {
      await client.query('ROLLBACK');
      request.log.error({ err: error }, 'Failed to close sany task');
      return fail(reply, request, 503, 'UNAVAILABLE', '收束处理失败，请稍后重试');
    } finally {
      client.release();
    }
  });

  app.patch('/api/v1/sany/issues/:issueId', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const id = uuid.safeParse((request.params as { issueId: string }).issueId);
    const input = z.object({ status: z.string().trim().min(1) }).safeParse(request.body);
    if (!id.success || !input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', '冲突更新参数无效');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    const result = await deps.pool.query('UPDATE sany_issues SET status=$3 WHERE id=$1 AND project_id=$2 RETURNING id, code, status', [id.data, project.id, input.data.status]);
    if (!result.rows[0]) return fail(reply, request, 404, 'NOT_FOUND', '冲突项不存在');
    return reply.send({ ok: true, data: result.rows[0], meta: { requestId: request.id } });
  });

  app.patch('/api/v1/sany/project', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const input = z.object({
      conclusion: z.string().optional(),
      decisions: z.record(z.string()).optional(),
      outputGenerated: z.boolean().optional(),
      outputReleased: z.boolean().optional(),
      deliveryChecks: z.record(z.boolean()).optional(),
    }).safeParse(request.body);
    if (!input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', '项目更新参数无效');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    const result = await deps.pool.query(`UPDATE sany_projects SET
        conclusion=COALESCE($2,conclusion),
        decisions=COALESCE($3,decisions),
        output_generated=COALESCE($4,output_generated),
        output_released=COALESCE($5,output_released),
        delivery_checks=COALESCE($6,delivery_checks),
        updated_at=now()
      WHERE id=$1 RETURNING output_generated, output_released, delivery_checks, decisions, conclusion`, [
      project.id, input.data.conclusion ?? null,
      input.data.decisions ? JSON.stringify(input.data.decisions) : null,
      input.data.outputGenerated ?? null,
      input.data.outputReleased ?? null,
      input.data.deliveryChecks ? JSON.stringify(input.data.deliveryChecks) : null,
    ]);
    return reply.send({ ok: true, data: result.rows[0], meta: { requestId: request.id } });
  });

  app.post('/api/v1/sany/feedback', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const input = z.object({ content: z.string().trim().min(1) }).safeParse(request.body);
    if (!input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', '反馈内容不能为空');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    const result = await deps.pool.query('INSERT INTO sany_feedback (project_id, author_name, content) VALUES ($1,$2,$3) RETURNING id, author_name, content, created_at', [
      project.id, identity.displayName, input.data.content,
    ]);
    const row = result.rows[0];
    return reply.code(201).send({ ok: true, data: {
      id: row.id, author: row.author_name, content: row.content, createdAt: row.created_at,
    }, meta: { requestId: request.id } });
  });

  app.post('/api/v1/sany/outputs/:outputKey/versions', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity || !deps.pool) return;
    const key = z.enum(['doc', 'ppt', 'diag', 'package']).safeParse((request.params as { outputKey: string }).outputKey);
    const input = z.object({
      summary: z.string().trim().min(1),
      changes: z.string().trim().default(''),
      size: z.string().trim().default(''),
      file: z.string().trim().min(1),
      status: z.string().trim().default('待审核'),
    }).safeParse(request.body);
    if (!key.success || !input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', '版本参数无效');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    const output = await deps.pool.query('SELECT id FROM sany_outputs WHERE project_id=$1 AND output_key=$2', [project.id, key.data]);
    if (!output.rows[0]) return fail(reply, request, 404, 'NOT_FOUND', '产出物不存在');
    const next = await deps.pool.query('SELECT COALESCE(max(version_no),0)+1 AS v FROM sany_output_versions WHERE output_id=$1', [output.rows[0].id]);
    const createdLabel = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const result = await deps.pool.query(`INSERT INTO sany_output_versions
      (output_id, version_no, created_label, created_by, status, summary, changes, size_label, file_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [
      output.rows[0].id, next.rows[0].v, createdLabel, identity.displayName, input.data.status,
      input.data.summary, input.data.changes, input.data.size, input.data.file,
    ]);
    const row = result.rows[0];
    return reply.code(201).send({ ok: true, data: {
      v: row.version_no, at: row.created_label, by: row.created_by, status: row.status, summary: row.summary,
      changes: row.changes, size: row.size_label, file: row.file_name, pageNames: row.page_names ?? [],
    }, meta: { requestId: request.id } });
  });
}
