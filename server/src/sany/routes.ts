import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { apiError } from '@kla-workstation/contracts';
import type { Identity } from '../repositories/types.js';
import { ensureSanyProject, readSanyBootstrap, type SanyProjectRow } from './store.js';

type Dependencies = {
  pool?: Pool;
  authorize(request: FastifyRequest, reply: FastifyReply, action: 'read' | 'write'): Promise<Identity | null>;
};

const uuid = z.string().uuid();
const moduleKey = z.enum(['review', 'market', 'biz', 'plan']);

function fail(reply: FastifyReply, request: FastifyRequest, status: number, code: Parameters<typeof apiError>[0], message: string) {
  return reply.code(status).send(apiError(code, message, { requestId: request.id }));
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
      owners: z.array(z.object({ name: z.string().trim().min(1), unit: z.string().trim().min(1) })).min(1),
      requirements: z.array(z.string().trim().min(1)).default([]),
    }).safeParse(request.body);
    if (!input.success) return fail(reply, request, 400, 'INVALID_ARGUMENT', input.error.issues[0]?.message ?? '派发参数无效');
    const project = await projectFor(identity);
    if (!project) return fail(reply, request, 503, 'UNAVAILABLE', '规划项目存储暂不可用');
    const created: string[] = [];
    const base = await deps.pool.query('SELECT count(*)::int AS n FROM sany_tasks WHERE project_id=$1', [project.id]);
    let sequence = base.rows[0].n;
    for (const owner of input.data.owners) {
      sequence += 1;
      const code = `R-${String(sequence).padStart(2, '0')}`;
      const row = await deps.pool.query(`INSERT INTO sany_tasks
        (project_id, code, title, unit, owner_name, task_type, task_type_name, deadline, status, intent, requirements, sort_order)
        VALUES ($1,$2,$3,$4,$5,'T-BG','成长型业务',$6,'待上传',$7,$8,$9)
        ON CONFLICT (project_id, code) DO NOTHING RETURNING id`, [
        project.id, code, input.data.title, owner.unit, owner.name, input.data.deadline,
        input.data.intent, JSON.stringify(input.data.requirements), sequence,
      ]);
      if (row.rows[0]) created.push(row.rows[0].id);
    }
    return reply.code(201).send({ ok: true, data: { created: created.length }, meta: { requestId: request.id } });
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
