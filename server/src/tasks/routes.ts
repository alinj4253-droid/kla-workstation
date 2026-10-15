import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { apiError, createTaskRequestSchema, taskDtoSchema, updateTaskRequestSchema } from '@kla-workstation/contracts';
import type { Identity } from '../repositories/types.js';

type Dependencies = {
  pool?: Pool;
  authorize(request: FastifyRequest, reply: FastifyReply, action: 'write'): Promise<Identity | null>;
};

/** A manual task belongs to the authorized identity; the request cannot supply its owner. */
export async function registerTaskRoutes(app: FastifyInstance, deps: Dependencies): Promise<void> {
  app.post('/api/v1/tasks', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity) return;
    if (!deps.pool) return reply.code(503).send(apiError('UNAVAILABLE', '任务存储暂不可用', { requestId: request.id }));
    const input = createTaskRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send(apiError('INVALID_ARGUMENT', input.error.issues[0]?.message ?? '任务参数无效', { requestId: request.id }));
    const key = z.string().uuid().safeParse(request.headers['idempotency-key']);
    if (!key.success) return reply.code(400).send(apiError('INVALID_ARGUMENT', '请提供有效的任务请求编号', { requestId: request.id }));
    try {
      // The unique primary key serializes simultaneous requests and persists across restarts.
      const inserted = await deps.pool.query(`INSERT INTO tasks (id, identity_id, title, status)
        VALUES ($1, $2, $3, 'pending') ON CONFLICT (id) DO NOTHING
        RETURNING id, title, status, result, created_at`, [key.data, identity.id, input.data.title]);
      const existing = inserted.rows[0] ?? (await deps.pool.query(
        'SELECT id, title, status, result, created_at FROM tasks WHERE id=$1 AND identity_id=$2',
        [key.data, identity.id],
      )).rows[0];
      if (!existing || existing.title !== input.data.title) return reply.code(409).send(apiError('IDEMPOTENCY_CONFLICT', '任务请求编号已被使用，请重新打开新建任务', { requestId: request.id }));
      const data = taskDtoSchema.parse({ ...existing, created_at: new Date(existing.created_at).toISOString() });
      return reply.code(inserted.rows.length ? 201 : 200).send({ ok: true, data, meta: { requestId: request.id } });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to create task');
      return reply.code(503).send(apiError('UNAVAILABLE', '任务保存失败，请稍后重试', { requestId: request.id }));
    }
  });

  app.patch('/api/v1/tasks/:taskId', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity) return;
    if (!deps.pool) return reply.code(503).send(apiError('UNAVAILABLE', '任务存储暂不可用', { requestId: request.id }));
    const id = z.string().uuid().safeParse((request.params as { taskId: string }).taskId);
    const input = updateTaskRequestSchema.safeParse(request.body);
    if (!id.success || !input.success) return reply.code(400).send(apiError('INVALID_ARGUMENT', '任务编号或状态无效', { requestId: request.id }));
    try {
      const updated = (await deps.pool.query(`UPDATE tasks SET status=$3
        WHERE id=$1 AND identity_id=$2 AND status IN ('pending', 'completed')
        RETURNING id, title, status, result, created_at`, [id.data, identity.id, input.data.status])).rows[0];
      if (!updated) {
        const ownTask = (await deps.pool.query('SELECT id, status FROM tasks WHERE id=$1 AND identity_id=$2', [id.data, identity.id])).rows[0];
        return reply.code(ownTask ? 409 : 404).send(apiError(ownTask ? 'CONFLICT' : 'NOT_FOUND', ownTask ? '该任务正在执行或已结束，不能修改待办状态' : '任务不存在或无权操作', { requestId: request.id }));
      }
      return { ok: true, data: taskDtoSchema.parse({ ...updated, created_at: new Date(updated.created_at).toISOString() }), meta: { requestId: request.id } };
    } catch (error) {
      request.log.error({ err: error }, 'Failed to update task');
      return reply.code(503).send(apiError('UNAVAILABLE', '任务状态保存失败，请稍后重试', { requestId: request.id }));
    }
  });

  app.delete('/api/v1/tasks/:taskId', async (request, reply) => {
    const identity = await deps.authorize(request, reply, 'write');
    if (!identity) return;
    if (!deps.pool) return reply.code(503).send(apiError('UNAVAILABLE', '任务存储暂不可用', { requestId: request.id }));
    const id = z.string().uuid().safeParse((request.params as { taskId: string }).taskId);
    if (!id.success) return reply.code(400).send(apiError('INVALID_ARGUMENT', '任务编号无效', { requestId: request.id }));
    try {
      // Deleting an already removed task is successful; a retry never touches another identity.
      await deps.pool.query('DELETE FROM tasks WHERE id=$1 AND identity_id=$2', [id.data, identity.id]);
      return { ok: true, data: { id: id.data }, meta: { requestId: request.id } };
    } catch (error) {
      request.log.error({ err: error }, 'Failed to delete task');
      return reply.code(503).send(apiError('UNAVAILABLE', '任务删除失败，请稍后重试', { requestId: request.id }));
    }
  });

}
