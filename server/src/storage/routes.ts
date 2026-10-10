import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createUploadSessionRequestSchema } from '@kla-workstation/contracts';
import type { Identity } from '../repositories/types.js';
import type { ObjectStore } from './object-store.js';
import { accessibleFile, fileView, uploadScope } from './file-access.js';

type Dependencies = {
  pool?: Pool; objectStore?: ObjectStore; maxBytes?: number;
  authorize(request: FastifyRequest, reply: FastifyReply, action: 'read' | 'write'): Promise<Identity | null>;
};

/** Uploaded objects become shared only through server-validated conversation membership. */
export async function registerFileRoutes(app: FastifyInstance, deps: Dependencies) {
  const maxBytes = deps.maxBytes ?? 100 * 1024 * 1024;
  if (!app.hasContentTypeParser('application/octet-stream')) app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  async function context(request: FastifyRequest, reply: FastifyReply, action: 'read' | 'write') {
    const identity = await deps.authorize(request, reply, action);
    if (!identity) return null;
    if (!deps.pool || !deps.objectStore) { reply.code(503).send({ ok: false, error: { code: 'FILE_STORAGE_UNAVAILABLE', message: '文件存储服务未配置' } }); return null; }
    return { identity, pool: deps.pool, store: deps.objectStore };
  }
  const fail = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ ok: false, error: { code, message } });
  const uuid = z.string().uuid();

  app.get('/api/v1/files', async (request, reply) => {
    const s = await context(request, reply, 'read'); if (!s) return;
    const q = z.object({ workspaceId: uuid.optional(), conversationId: uuid.optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    if (q.conversationId && !(await uploadScope(s.pool, s.identity.id, { conversation_id: q.conversationId }))) return fail(reply, 404, 'NOT_FOUND', '群聊不存在或无权访问');
    const rows = (await s.pool.query(`SELECT f.* FROM files f LEFT JOIN workspaces w ON w.id=f.workspace_id
      WHERE ($2::uuid IS NULL OR f.workspace_id=$2) AND ($3::uuid IS NULL OR f.conversation_id=$3)
        AND ($4::text IS NULL OR f.status=$4) AND
        (f.conversation_id IS NOT NULL AND EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=f.conversation_id AND cm.identity_id=$1)
          OR f.conversation_id IS NULL AND COALESCE(f.identity_id,w.identity_id)=$1)
      ORDER BY f.created_at DESC LIMIT $5`, [s.identity.id, q.workspaceId ?? null, q.conversationId ?? null, q.status ?? null, q.limit])).rows;
    const visible = [];
    for (const row of rows) if (await accessibleFile(s.pool, s.identity.id, row.id)) visible.push(fileView(row));
    return { ok: true, data: visible };
  });
  app.get('/api/v1/files/:fileId', async (request, reply) => {
    const s = await context(request, reply, 'read'); if (!s) return;
    const row = await accessibleFile(s.pool, s.identity.id, uuid.parse((request.params as { fileId: string }).fileId));
    if (!row) return fail(reply, 404, 'FILE_NOT_FOUND', '文件不存在或无权访问');
    return { ok: true, data: fileView(row) };
  });
  app.post('/api/v1/files/upload-sessions', async (request, reply) => {
    const s = await context(request, reply, 'write'); if (!s) return;
    const parsed = createUploadSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'INVALID_ARGUMENT', parsed.error.issues[0]?.message ?? '上传参数无效');
    const b = parsed.data;
    if (!(await uploadScope(s.pool, s.identity.id, { workspace_id: b.workspaceId, conversation_id: b.conversationId }))) return fail(reply, 403, 'FORBIDDEN', '无权上传到该群聊或工作区');
    if ((b.sizeBytes ?? 0) > maxBytes) return fail(reply, 413, 'FILE_TOO_LARGE', `文件不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
    const row = (await s.pool.query(`INSERT INTO upload_sessions(identity_id,workspace_id,conversation_id,file_name,content_type,size_bytes,checksum)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [s.identity.id, b.workspaceId ?? null, b.conversationId ?? null, b.fileName, b.contentType || 'application/octet-stream', b.sizeBytes ?? 0, b.checksum ?? null])).rows[0];
    const key = `uploads/${s.identity.id}/${row.id}/content`;
    await s.pool.query('UPDATE upload_sessions SET storage_key=$2 WHERE id=$1', [row.id, key]);
    return reply.code(201).send({ ok: true, data: { ...row, storageKey: key, expires_at: new Date(row.expires_at).toISOString(), uploadUrl: `/api/v1/files/upload-sessions/${row.id}/content`, completeUrl: `/api/v1/files/upload-sessions/${row.id}/complete`, mode: 'server-object-storage' } });
  });
  // Row locks serialize PUT/complete retries. A completed object is immutable.
  for (const operation of ['content', 'complete'] as const) app.route({
    method: operation === 'content' ? 'PUT' : 'POST', url: `/api/v1/files/upload-sessions/:sessionId/${operation}`, bodyLimit: maxBytes,
    handler: async (request, reply) => {
      const s = await context(request, reply, 'write'); if (!s) return;
      const client = await s.pool.connect();
      let committed = false;
      try {
        await client.query('BEGIN');
        const row = (await client.query('SELECT *, expires_at <= now() AS expired FROM upload_sessions WHERE id=$1 AND identity_id=$2 FOR UPDATE', [uuid.parse((request.params as { sessionId: string }).sessionId), s.identity.id])).rows[0];
        if (!row || !(await uploadScope(client, s.identity.id, row))) return fail(reply, 404, 'UPLOAD_SESSION_NOT_FOUND', '上传会话不存在或无权访问');
        if (operation === 'complete' && row.status === 'completed' && row.file_id) {
          const file = await accessibleFile(client, s.identity.id, row.file_id);
          if (!file) return fail(reply, 404, 'FILE_NOT_FOUND', '已完成的文件不可用');
          await client.query('COMMIT'); committed = true; return { ok: true, data: fileView(file) };
        }
        // Session creation and expiry use the same database clock, including when hosts drift.
        if (row.expired) return fail(reply, 410, 'UPLOAD_SESSION_EXPIRED', '上传会话已过期，请重新上传');
        if (!['created', 'uploaded'].includes(row.status)) return fail(reply, 409, 'UPLOAD_SESSION_CLOSED', '上传会话已关闭');
        if (operation === 'content') {
          if (!Buffer.isBuffer(request.body)) return fail(reply, 400, 'INVALID_CONTENT', '请使用 application/octet-stream 上传文件内容');
          const bytes = request.body;
          if (bytes.length > maxBytes) return fail(reply, 413, 'FILE_TOO_LARGE', '文件超过上传限制');
          if (bytes.length !== Number(row.size_bytes)) return fail(reply, 409, 'UPLOAD_SIZE_MISMATCH', '文件大小校验失败');
          if (row.checksum && createHash('sha256').update(bytes).digest('hex') !== row.checksum) return fail(reply, 409, 'UPLOAD_CHECKSUM_MISMATCH', '文件校验和不匹配');
          await s.store.put(row.storage_key, bytes);
          await client.query("UPDATE upload_sessions SET status='uploaded' WHERE id=$1", [row.id]);
          await client.query('COMMIT'); committed = true; return { ok: true, data: { sessionId: row.id, status: 'uploaded', sizeBytes: bytes.length } };
        }
        if (row.status !== 'uploaded') return fail(reply, 409, 'UPLOAD_NOT_READY', '请先上传文件内容');
        const bytes = await s.store.get(row.storage_key);
        if (!bytes) return fail(reply, 409, 'UPLOAD_NOT_READY', '上传的文件内容不可用');
        const checksum = createHash('sha256').update(bytes).digest('hex');
        if (bytes.length !== Number(row.size_bytes) || (row.checksum && row.checksum !== checksum)) return fail(reply, 409, 'UPLOAD_CHECKSUM_MISMATCH', '上传内容完整性校验失败');
        const file = (await client.query(`INSERT INTO files(identity_id,workspace_id,conversation_id,name,storage_key,checksum,content_type,size_bytes,status,uploaded_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'uploaded',now(),now()) RETURNING *`, [s.identity.id, row.workspace_id, row.conversation_id, row.file_name, row.storage_key, checksum, row.content_type, bytes.length])).rows[0];
        await client.query("UPDATE upload_sessions SET status='completed',file_id=$2 WHERE id=$1", [row.id, file.id]);
        await client.query('COMMIT'); committed = true; return reply.code(201).send({ ok: true, data: fileView(file) });
      } finally { try { if (!committed) await client.query('ROLLBACK'); } finally { client.release(); } }
    },
  });
  app.get('/api/v1/files/:fileId/content', async (request, reply) => {
    const s = await context(request, reply, 'read'); if (!s) return;
    const row = await accessibleFile(s.pool, s.identity.id, uuid.parse((request.params as { fileId: string }).fileId));
    if (!row) return fail(reply, 404, 'FILE_NOT_FOUND', '文件不存在或无权访问');
    const bytes = await s.store.get(row.storage_key);
    if (!bytes) return fail(reply, 404, 'FILE_OBJECT_NOT_FOUND', '文件对象不可用');
    return reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`).type(row.content_type || 'application/octet-stream').send(bytes);
  });
}
