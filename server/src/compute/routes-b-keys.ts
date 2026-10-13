// 算力模块路由（B 侧 §7.2）：API Key 管理
// - 完整 secret 只在创建响应出现一次，服务端不落库；列表/详情永不包含 secret（§7.2、§12）。
// - 默认 Key 不可删除，只能停用后重新生成（§7.2、§9.2）。
// - 上游只同步 name / group_id / status；quota / rpm / ipAllowList / expiresAt 为 KLA 侧元数据（0011 列）。

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ComputeKey as ComputeKeyDto, ComputeKeyList, CreateComputeKeyResponse, ErrorCode, UpdateComputeKeyRequest } from '@kla-workstation/contracts';
import type { AccountRepository } from '../repositories/types.js';
import { COMPUTE_READY_STATES, type ComputeBinding, type ComputeKey } from './types.js';
import type { ComputeRepository } from './compute-repository.js';
import type { Sub2ApiClient } from './sub2api-client.js';
import { resolveManagedPassword } from './encryption.js';
import { COMPUTE_PERMISSION, errorBody, requireIdentity, requirePermission } from './permissions.js';
import { createPointsConverter } from './points.js';

export type ComputeKeyRouteDeps = {
  accounts: AccountRepository;
  computeRepo: ComputeRepository;
  sub2api: Sub2ApiClient;
  /** 来自 COMPUTE_SECRET_ENCRYPTION_KEY；为空时托管密码按明文处理（与 A 侧建号逻辑一致） */
  encryptionKey: string;
  /** 未指定分组时使用的默认 Sub2API 分组 */
  defaultGroupId: string;
};

/** 领域对象 → 契约 DTO；secret 永不在此出现。 */
export function toKeyDto(key: ComputeKey, todayUsagePoints: number): ComputeKeyDto {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    groupId: key.groupId,
    isDefault: key.isDefault,
    status: key.status,
    quotaPoints: key.quotaUsd === null ? null : createPointsConverter().fromUsd(key.quotaUsd),
    rpm: key.rpm,
    ipAllowList: key.ipAllowList,
    expiresAt: key.expiresAt,
    createdAt: key.createdAt,
    lastSyncedAt: key.lastSyncedAt,
    todayUsagePoints,
  };
}

type FieldError = { ok: false; message: string };

function optionalPositiveNumber(value: unknown, field: string): { ok: true; value: number | undefined } | FieldError {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return { ok: false, message: `${field} 必须是大于 0 的数字` };
  return { ok: true, value: num };
}

function optionalIsoDate(value: unknown, field: string): { ok: true; value: string | undefined } | FieldError {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return { ok: false, message: `${field} 必须是 RFC 3339 时间` };
  return { ok: true, value: new Date(value).toISOString() };
}

function optionalIpList(value: unknown): { ok: true; value: string[] | undefined } | FieldError {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    return { ok: false, message: 'ipAllowList 必须是不超过 64 项的非空字符串数组' };
  }
  return { ok: true, value: value.map((item) => (item as string).trim()) };
}

/** 上游模型未进入本地目录时，用模型 id 生成稳定可读的名称（否则下拉只显示 gpt-5.6-luna 这类原始 id）。 */
function fallbackModelName(modelId: string): string {
  const label = modelId.split('/').at(-1) ?? modelId;
  return label
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export async function registerComputeKeyRoutes(app: FastifyInstance, deps: ComputeKeyRouteDeps): Promise<void> {
  const pool = deps.computeRepo.pool;

  /** 取该身份托管账号的用户面 JWT（§5.1）。 */
  const resolveUserJwt = async (
    identityId: string,
  ): Promise<{ ok: true; jwt: string; binding: ComputeBinding } | { ok: false; code: ErrorCode; message: string }> => {
    const binding = await deps.computeRepo.getBinding(identityId);
    if (!binding) return { ok: false, code: 'CONFLICT', message: '算力账号尚未初始化，请先重试初始化' };
    if (!COMPUTE_READY_STATES.has(binding.status)) return { ok: false, code: 'CONFLICT', message: `算力账号未就绪（${binding.status}）` };
    const password = resolveManagedPassword(binding.managedPassword, deps.encryptionKey);
    if (!password) return { ok: false, code: 'CONFLICT', message: '当前身份的托管凭据无法解密，请恢复原 COMPUTE_SECRET_ENCRYPTION_KEY 或由管理员重置上游账号凭据' };
    try {
      const jwt = await deps.sub2api.getUserJwt(binding.sub2apiUserId, binding.sub2apiUsername, password);
      return { ok: true, jwt, binding };
    } catch (error) {
      return { ok: false, code: 'UNAVAILABLE', message: error instanceof Error ? error.message : 'Sub2API 不可用' };
    }
  };

  const upstreamFailure = (reply: FastifyReply, code: ErrorCode, message: string, requestId?: string) =>
    reply.code(code === 'UNAVAILABLE' ? 503 : 409).send(errorBody(code, message, requestId));

  // §7.2 列表：仅当前身份的 Key；含今日用量；不返回 secret。
  app.get('/api/v1/compute/keys', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    if (!(await requirePermission(pool, ctx.identity, COMPUTE_PERMISSION.keyView, request, reply, '无权查看 API Key'))) return;
    const [keys, todayUsage] = await Promise.all([
      deps.computeRepo.listKeys(ctx.identity.id),
      deps.computeRepo.sumTodayUsageByKey(ctx.identity.id),
    ]);
    const data: ComputeKeyList = { items: keys.map((key) => toKeyDto(key, todayUsage.get(key.id) ?? 0)) };
    return reply.send({ ok: true, data });
  });

  app.get('/api/v1/compute/keys/:keyId/models', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    if (!(await requirePermission(pool, ctx.identity, COMPUTE_PERMISSION.modelUse, request, reply, '无权使用模型'))) return;
    const { keyId } = request.params as { keyId: string };
    const key = await deps.computeRepo.getKey(keyId, ctx.identity.id);
    if (!key || key.status !== 'active') return reply.code(404).send(errorBody('NOT_FOUND', '当前身份没有此可用 Key', request.id));
    const resolved = await resolveUserJwt(ctx.identity.id);
    if (!resolved.ok) return upstreamFailure(reply, resolved.code, resolved.message, request.id);
    try {
      const secret = await deps.sub2api.resolveApiKeySecret(resolved.jwt, key.sub2apiKeyId);
      if (!secret) return upstreamFailure(reply, 'UNAVAILABLE', '无法读取该 Key 的上游凭据', request.id);
      // 与模型广场同一口径：上游 /v1/models 是地面真相，本地 models 目录只补充展示名称，不做交集过滤
      const ids = await deps.sub2api.listModels(secret);
      const catalog = await pool.query<{id:string;name:string}>('SELECT id,name FROM models WHERE id=ANY($1::text[])', [ids]);
      const nameById = new Map(catalog.rows.map((row) => [row.id, row.name]));
      const data = ids.map((id) => ({ id, name: nameById.get(id) ?? fallbackModelName(id) }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return reply.send({ ok: true, data });
    } catch (error) {
      return upstreamFailure(reply, 'UNAVAILABLE', error instanceof Error ? error.message : '获取 Key 可用模型失败', request.id);
    }
  });

  // §7.2 创建：完整 secret 只在此响应出现一次。
  app.post('/api/v1/compute/keys', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    if (!(await requirePermission(pool, ctx.identity, COMPUTE_PERMISSION.keyCreate, request, reply, '无权创建 API Key'))) return;
    const body = (request.body ?? {}) as { name?: unknown; groupId?: unknown; expiresAt?: unknown; quota?: unknown; rpm?: unknown; ipAllowList?: unknown };
    if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.trim().length > 64) {
      return reply.code(400).send(errorBody('INVALID_ARGUMENT', 'name 为必填项且不超过 64 个字符', request.id));
    }
    const quota = optionalPositiveNumber(body.quota, 'quota');
    if (!quota.ok) return reply.code(400).send(errorBody('INVALID_ARGUMENT', quota.message, request.id));
    const rpm = optionalPositiveNumber(body.rpm, 'rpm');
    if (!rpm.ok) return reply.code(400).send(errorBody('INVALID_ARGUMENT', rpm.message, request.id));
    const expiresAt = optionalIsoDate(body.expiresAt, 'expiresAt');
    if (!expiresAt.ok) return reply.code(400).send(errorBody('INVALID_ARGUMENT', expiresAt.message, request.id));
    const ipAllowList = optionalIpList(body.ipAllowList);
    if (!ipAllowList.ok) return reply.code(400).send(errorBody('INVALID_ARGUMENT', ipAllowList.message, request.id));

    const resolved = await resolveUserJwt(ctx.identity.id);
    if (!resolved.ok) return upstreamFailure(reply, resolved.code, resolved.message, request.id);

    const groupId = typeof body.groupId === 'string' && body.groupId.trim() !== '' ? body.groupId.trim() : deps.defaultGroupId;
    let upstream;
    try {
      upstream = await deps.sub2api.createApiKey(resolved.jwt, body.name.trim(), groupId, {
        quota: quota.value === undefined ? undefined : createPointsConverter().toUsd(quota.value),
        rpm: rpm.value,
        ipAllowList: ipAllowList.value,
        expiresAt: expiresAt.value,
      });
    } catch (error) {
      return upstreamFailure(reply, 'UNAVAILABLE', error instanceof Error ? error.message : 'Sub2API 建 Key 失败', request.id);
    }

    const key = await deps.computeRepo.createKey({
      identityId: ctx.identity.id,
      sub2apiKeyId: upstream.id,
      keyPrefix: upstream.keyPrefix,
      keyFingerprint: upstream.keyFingerprint,
      name: body.name.trim(),
      groupId: groupId || null,
      quota: quota.value === undefined ? null : createPointsConverter().toUsd(quota.value),
      rpm: rpm.value ?? null,
      ipAllowList: ipAllowList.value ?? [],
      expiresAt: expiresAt.value ?? null,
      createdBy: ctx.identity.id,
    });
    const data: CreateComputeKeyResponse = {
      key: toKeyDto(key, 0),
      ...(upstream.secret ? { secret: upstream.secret } : {}),
    };
    return reply.code(201).send({ ok: true, data });
  });

  // §7.2 修改：KLA 为元数据权威；名称尽力同步到上游，失败不影响主结果。
  app.patch('/api/v1/compute/keys/:keyId', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    if (!(await requirePermission(pool, ctx.identity, COMPUTE_PERMISSION.keyUpdate, request, reply, '无权修改 API Key'))) return;
    const { keyId } = request.params as { keyId: string };
    const existing = await deps.computeRepo.getKey(keyId, ctx.identity.id);
    if (!existing) return reply.code(404).send(errorBody('NOT_FOUND', 'API Key 不存在或无权访问', request.id));
    if (existing.status === 'deleted') return reply.code(409).send(errorBody('CONFLICT', '已删除的 Key 不能修改', request.id));
    const body = (request.body ?? {}) as UpdateComputeKeyRequest & { name?: unknown };
    const patch: { name?: string; quota?: number | null; rpm?: number | null; ipAllowList?: string[]; expiresAt?: string | null } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.trim().length > 64) {
        return reply.code(400).send(errorBody('INVALID_ARGUMENT', 'name 不超过 64 个字符', request.id));
      }
      patch.name = body.name.trim();
    }
    if (body.quota !== undefined) {
      if (body.quota === null) patch.quota = null;
      else {
        const parsed = optionalPositiveNumber(body.quota, 'quota');
        if (!parsed.ok) return reply.code(400).send(errorBody('INVALID_ARGUMENT', parsed.message, request.id));
        patch.quota = parsed.value === undefined ? null : createPointsConverter().toUsd(parsed.value);
      }
    }
    if (body.rpm !== undefined) {
      if (body.rpm === null) patch.rpm = null;
      else {
        const parsed = optionalPositiveNumber(body.rpm, 'rpm');
        if (!parsed.ok) return reply.code(400).send(errorBody('INVALID_ARGUMENT', parsed.message, request.id));
        patch.rpm = parsed.value ?? null;
      }
    }
    if (body.ipAllowList !== undefined) {
      const parsed = optionalIpList(body.ipAllowList);
      if (!parsed.ok) return reply.code(400).send(errorBody('INVALID_ARGUMENT', parsed.message, request.id));
      patch.ipAllowList = parsed.value ?? [];
    }
    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null) patch.expiresAt = null;
      else {
        const parsed = optionalIsoDate(body.expiresAt, 'expiresAt');
        if (!parsed.ok) return reply.code(400).send(errorBody('INVALID_ARGUMENT', parsed.message, request.id));
        patch.expiresAt = parsed.value ?? null;
      }
    }

    const updated = await deps.computeRepo.updateKeyMetadata(keyId, ctx.identity.id, patch);
    if (!updated) return reply.code(404).send(errorBody('NOT_FOUND', 'API Key 不存在或无权访问', request.id));
    if (Object.keys(patch).length > 0) {
      // 元数据同步为尽力而为：KLA 已落库，上游失败不阻断（§6.2：改配额/状态/限速）
      try {
        const resolved = await resolveUserJwt(ctx.identity.id);
        if (resolved.ok) await deps.sub2api.updateApiKey(resolved.jwt, existing.sub2apiKeyId, patch);
      } catch {
        // 上游改名失败不影响 KLA 元数据结果
      }
    }
    return reply.send({ ok: true, data: toKeyDto(updated, 0) });
  });

  // §7.2 停用
  app.post('/api/v1/compute/keys/:keyId/disable', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    if (!(await requirePermission(pool, ctx.identity, COMPUTE_PERMISSION.keyDisable, request, reply, '无权停用 API Key'))) return;
    const { keyId } = request.params as { keyId: string };
    const existing = await deps.computeRepo.getKey(keyId, ctx.identity.id);
    if (!existing) return reply.code(404).send(errorBody('NOT_FOUND', 'API Key 不存在或无权访问', request.id));
    if (existing.status === 'deleted') return reply.code(409).send(errorBody('CONFLICT', '已删除的 Key 不能停用', request.id));
    if (existing.status === 'disabled') return reply.send({ ok: true, data: toKeyDto(existing, 0) });

    const resolved = await resolveUserJwt(ctx.identity.id);
    if (!resolved.ok) return upstreamFailure(reply, resolved.code, resolved.message, request.id);
    try {
      await deps.sub2api.disableApiKey(resolved.jwt, existing.sub2apiKeyId);
    } catch (error) {
      return upstreamFailure(reply, 'UNAVAILABLE', error instanceof Error ? error.message : 'Sub2API 停用 Key 失败', request.id);
    }
    const updated = await deps.computeRepo.setKeyStatus(keyId, ctx.identity.id, 'disabled');
    return reply.send({ ok: true, data: toKeyDto(updated ?? existing, 0) });
  });

  // §7.2 删除：默认 Key 不可删除（只能停用后重新生成）
  app.delete('/api/v1/compute/keys/:keyId', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    if (!(await requirePermission(pool, ctx.identity, COMPUTE_PERMISSION.keyDisable, request, reply, '无权删除 API Key'))) return;
    const { keyId } = request.params as { keyId: string };
    const existing = await deps.computeRepo.getKey(keyId, ctx.identity.id);
    if (!existing) return reply.code(404).send(errorBody('NOT_FOUND', 'API Key 不存在或无权访问', request.id));
    if (existing.isDefault) {
      return reply.code(409).send(errorBody('CONFLICT', '默认 Key 不可删除，请先停用后重新生成', request.id));
    }
    if (existing.status === 'deleted') return reply.send({ ok: true, data: toKeyDto(existing, 0) });

    const resolved = await resolveUserJwt(ctx.identity.id);
    if (!resolved.ok) return upstreamFailure(reply, resolved.code, resolved.message, request.id);
    try {
      await deps.sub2api.deleteApiKey(resolved.jwt, existing.sub2apiKeyId);
    } catch (error) {
      return upstreamFailure(reply, 'UNAVAILABLE', error instanceof Error ? error.message : 'Sub2API 删除 Key 失败', request.id);
    }
    const updated = await deps.computeRepo.setKeyStatus(keyId, ctx.identity.id, 'deleted');
    return reply.send({ ok: true, data: toKeyDto(updated ?? existing, 0) });
  });
}
