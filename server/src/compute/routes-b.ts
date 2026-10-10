// 算力模块路由（B 侧）：模型广场（§7.3）+ 用量查询（§7.4）
// 与 A 侧 server/src/compute/routes.ts（§7.5/§7.6）分开注册，避免路由重名与重复挂载。
// 表结构以 A 侧 0010_compute_sub2api.sql 为基准，B 侧增量列见 0011_extend_compute_schema.sql。

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ComputeModel,
  ComputeModelList,
  ComputeModelStatus,
  ComputeUsageRecord,
  ComputeUsageSummary,
  PagedData,
} from '@kla-workstation/contracts';
import type { AccountRepository, Identity } from '../repositories/types.js';
import type { ComputeRepository } from './compute-repository.js';
import type { Sub2ApiAdminGroup, Sub2ApiClient } from './sub2api-client.js';
import { COMPUTE_PERMISSION, errorBody, hasPermission, requireIdentity } from './permissions.js';
import { resolveManagedPassword } from './encryption.js';
import { COMPUTE_READY_STATES } from './types.js';
import { createPointsConverter } from './points.js';

export type ComputeRouteBDeps = {
  accounts: AccountRepository;
  computeRepo: ComputeRepository;
  /** Sub2API 客户端：模型清单实时按当前身份的 Key 从上游拉取，分组关系不落库 */
  sub2api: Sub2ApiClient;
  /** 托管密码解密密钥（与 provisioning/gateway 保持一致） */
  encryptionKey: string;
};

const PAGE_SIZE_MAX = 100;
const EXPORT_ROW_LIMIT = 10000;

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

// ---------------------------------------------------------------------------
// 纯函数：行 → 契约 DTO，便于脱离数据库单测
// ---------------------------------------------------------------------------

export type ComputeModelRow = {
  id: string;
  name: string;
  provider: string;
  capabilities: unknown;
  enabled: boolean;
  input_price_per_mtok_usd: string | number | null;
  output_price_per_mtok_usd: string | number | null;
  available_groups: unknown;
};

/** §7.3：只读映射，不暴露 base_url、上游 Key 等任何供应商配置。 */
export function mapComputeModel(row: ComputeModelRow): ComputeModel {
  const capabilities = (row.capabilities && typeof row.capabilities === 'object' ? row.capabilities : {}) as Record<string, unknown>;
  const context = typeof capabilities.context === 'number' ? capabilities.context : null;
  const status: ComputeModelStatus = row.enabled ? 'active' : 'disabled';
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    capabilities: {
      vision: capabilities.vision === true,
      reasoning: capabilities.thinking === true,
      tools: capabilities.tools === true,
      streaming: capabilities.streaming === true,
    },
    contextWindow: context,
    inputPricePerMillionTokensPoints: row.input_price_per_mtok_usd === null ? null : createPointsConverter().fromUsd(Number(row.input_price_per_mtok_usd)),
    outputPricePerMillionTokensPoints: row.output_price_per_mtok_usd === null ? null : createPointsConverter().fromUsd(Number(row.output_price_per_mtok_usd)),
    available: row.enabled === true,
    availableGroups: Array.isArray(row.available_groups) ? row.available_groups.filter((group): group is string => typeof group === 'string') : [],
    status,
  };
}

/** 对齐 A 侧 compute_usage 列：model / prompt_tokens / completion_tokens / amount_usd / recorded_at。 */
export type ComputeUsageRow = {
  id: string;
  identity_id: string;
  model: string | null;
  key_id: string | null;
  key_prefix: string | null;
  project_id: string | null;
  conversation_id: string | null;
  task_id: string | null;
  prompt_tokens: string | number | null;
  completion_tokens: string | number | null;
  latency_ms: number | null;
  status: string;
  amount_usd: string | number | null;
  amount_points?: string | number | null;
  recorded_at: Date | string;
};

export function mapUsageRecord(row: ComputeUsageRow): ComputeUsageRecord {
  const inputTokens = toNumber(row.prompt_tokens) ?? 0;
  const outputTokens = toNumber(row.completion_tokens) ?? 0;
  return {
    id: row.id,
    identityId: row.identity_id,
    modelId: row.model,
    keyId: row.key_id,
    keyPrefix: row.key_prefix,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    requestCount: 1,
    latencyMs: row.latency_ms,
    status: row.status,
    costPoints: toNumber(row.amount_points) ?? 0,
    usageAt: new Date(row.recorded_at).toISOString(),
  };
}

const CSV_HEADERS = ['时间', '模型', 'Key前缀', '项目', '输入Token', '输出Token', '总Token', '状态', '耗时ms', '费用算力点'];

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** §7.4：导出由服务端生成，带 BOM 便于 Excel 正确识别中文。 */
export function buildUsageCsv(records: ComputeUsageRecord[]): string {
  const lines = [CSV_HEADERS.join(',')];
  for (const record of records) {
    lines.push(
      [
        record.usageAt,
        record.modelId ?? '',
        record.keyPrefix ?? '',
        record.projectId ?? '',
        record.inputTokens,
        record.outputTokens,
        record.totalTokens,
        record.status,
        record.latencyMs ?? '',
        record.costPoints,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// 查询参数解析（M0 类型级最小接入，不引入运行时契约依赖）
// ---------------------------------------------------------------------------

export type UsageFilter = {
  from: string | null;
  to: string | null;
  modelId: string | null;
  keyId: string | null;
  projectId: string | null;
};

export type ParsedUsageQuery = {
  filter: UsageFilter;
  scope: 'self' | 'organization';
  page: number;
  pageSize: number;
};

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

function asIsoDateTime(value: unknown): string | null | false {
  const text = asString(value);
  if (text === undefined) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : false;
}

function asUuid(value: unknown): string | null | false {
  const text = asString(value);
  if (text === undefined) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ? text : false;
}

function asPageNumber(value: unknown, fallback: number): number | false {
  const text = asString(value);
  if (text === undefined) return fallback;
  const num = Number(text);
  return Number.isInteger(num) && num >= 1 ? num : false;
}

export function parseUsageQuery(query: Record<string, unknown>): { ok: true; value: ParsedUsageQuery } | { ok: false; message: string } {
  const from = asIsoDateTime(query.from);
  if (from === false) return { ok: false, message: 'from 必须是 RFC 3339 时间' };
  const to = asIsoDateTime(query.to);
  if (to === false) return { ok: false, message: 'to 必须是 RFC 3339 时间' };
  const keyId = asUuid(query.keyId);
  if (keyId === false) return { ok: false, message: 'keyId 必须是合法 UUID' };
  const projectId = asUuid(query.projectId);
  if (projectId === false) return { ok: false, message: 'projectId 必须是合法 UUID' };
  const scopeRaw = asString(query.scope) ?? 'self';
  if (scopeRaw !== 'self' && scopeRaw !== 'organization') return { ok: false, message: 'scope 仅支持 self 或 organization' };
  const page = asPageNumber(query.page, 1);
  if (page === false) return { ok: false, message: 'page 必须是不小于 1 的整数' };
  const pageSizeRaw = asPageNumber(query.pageSize, 20);
  if (pageSizeRaw === false) return { ok: false, message: 'pageSize 必须是不小于 1 的整数' };
  return {
    ok: true,
    value: {
      filter: { from, to, modelId: asString(query.modelId) ?? null, keyId, projectId },
      scope: scopeRaw,
      page,
      pageSize: Math.min(pageSizeRaw, PAGE_SIZE_MAX),
    },
  };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export async function registerComputeRoutesB(app: FastifyInstance, deps: ComputeRouteBDeps): Promise<void> {
  const pool = () => deps.computeRepo.pool;

  const resolveScope = async (
    identity: Identity,
    scope: 'self' | 'organization',
  ): Promise<{ ok: true; clause: string; value: string } | { ok: false; message: string }> => {
    if (scope === 'self') return { ok: true, clause: 'u.identity_id = $1', value: identity.id };
    if (!identity.organizationId) return { ok: false, message: '当前身份不属于任何企业，无法查看成员汇总用量' };
    if (!(await hasPermission(pool(), identity.id, COMPUTE_PERMISSION.organizationUsageView))) {
      return { ok: false, message: '无权查看企业成员汇总用量' };
    }
    // 优先用 Gateway 写入的 organization_id，缺失时回退到身份的所属企业
    return { ok: true, clause: 'COALESCE(u.organization_id, i.organization_id) = $1', value: identity.organizationId };
  };

  // §7.3 模型广场：只读，不提供任何模型编辑或上游 Key 填写能力。
  // 目录仅用于给上游模型补充展示元数据（能力/价格），不作为可调用集合的来源。
  const MODEL_SELECT = `SELECT m.id, m.name, m.provider, m.capabilities, m.enabled,
              p.input_price_per_mtok_usd, p.output_price_per_mtok_usd, p.available_groups
       FROM models m
       LEFT JOIN compute_model_pricing p ON p.model_id = m.id`;

  /** 上游模型 id 前缀 → 供应商的启发式映射（目录未收录时兜底展示用）。 */
  function guessProvider(modelId: string): string {
    const id = modelId.toLowerCase();
    if (/^(gpt|o[1345](-|$)|codex|chatgpt)/.test(id)) return 'openai';
    if (/^claude/.test(id)) return 'anthropic';
    if (/^(glm|cogview|cogvideo|charglm|emohaa)/.test(id)) return 'zhipu';
    if (/^deepseek/.test(id)) return 'deepseek';
    if (/^(qwen|qwq|qvq)/.test(id)) return 'qwen';
    if (/^(gemini|gemma)/.test(id)) return 'google';
    if (/^(moonshot|kimi)/.test(id)) return 'moonshot';
    if (/^doubao/.test(id)) return 'volcengine';
    if (/^(minimax|abab)/.test(id)) return 'minimax';
    return 'sub2api';
  }

  /** 模型清单缓存（按身份，60 秒）：避免每次打开模型广场都实时请求上游。 */
  const modelListCache = new Map<string, { items: ComputeModel[]; expiresAt: number }>();
  const MODEL_LIST_CACHE_TTL_MS = 60_000;

  /** §7.3（实时版·仅真实可调用）：模型清单全部来自 Sub2API 平台，本地数据库不参与分组/模型判定——
   *  1) 身份名下活跃 Key 实时调网关 /v1/models，返回的即该 Key 所在分组真实可调用的模型（地面真相）；
   *  2) 白名单勾选清单、分组配置等仅供参考，不用于展示（未启用限制或无 Key 的分组无法证实可调用）；
   *  3) 本地 models 目录只按名称补充能力/价格等展示元数据。 */
  const loadIdentityModels = async (
    identityId: string,
    reply: FastifyReply,
  ): Promise<ComputeModel[] | null> => {
    const binding = await deps.computeRepo.getBinding(identityId);
    if (!binding || !COMPUTE_READY_STATES.has(binding.status)) return [];
    const password = resolveManagedPassword(binding.managedPassword, deps.encryptionKey);
    if (!password) {
      reply.code(409).send(errorBody('CONFLICT', '当前身份的托管凭据无法解密（COMPUTE_SECRET_ENCRYPTION_KEY 与开通时不一致），请联系管理员重置上游账号凭据'));
      return null;
    }
    let jwt: string;
    try {
      jwt = await deps.sub2api.getUserJwt(binding.sub2apiUserId, binding.sub2apiUsername, password);
    } catch (error) {
      reply.code(503).send(errorBody('UNAVAILABLE', error instanceof Error ? `算力网关暂时不可用：${error.message}` : '算力网关暂时不可用'));
      return null;
    }

    const userGroups: Sub2ApiAdminGroup[] = await deps.sub2api.adminListGroups().catch(() => []);
    const groupNameById = new Map(userGroups.map((group) => [group.id, group.name]));

    const modelGroups = new Map<string, Set<string>>();
    const addModel = (modelId: string, groupName: string) => {
      const bucket = modelGroups.get(modelId) ?? new Set<string>();
      bucket.add(groupName);
      modelGroups.set(modelId, bucket);
    };

    // 仅收录身份名下活跃 Key 实测可调用的模型（Key 的分组归属以上游管理端为准，缺失时回退本地记录）
    const keys = (await deps.computeRepo.listKeys(identityId)).filter(
      (key) => key.status === 'active' && Boolean(key.sub2apiKeyId),
    );
    let upstreamKeys: Array<{ id: string; groupId: string | null; groupName: string | null }> = [];
    try {
      upstreamKeys = await deps.sub2api.adminListUserKeys(binding.sub2apiUserId);
    } catch {
      upstreamKeys = [];
    }
    const upstreamKeyById = new Map(upstreamKeys.map((key) => [key.id, key]));
    try {
      for (const key of keys) {
        const secret = await deps.sub2api.resolveApiKeySecret(jwt, key.sub2apiKeyId);
        if (!secret) continue;
        const upstreamKey = upstreamKeyById.get(key.sub2apiKeyId);
        const groupId = upstreamKey?.groupId ?? key.groupId;
        const groupName =
          (groupId != null ? groupNameById.get(String(groupId)) : undefined) ??
          upstreamKey?.groupName ??
          (groupId != null ? `分组 ${groupId}` : '默认分组');
        for (const modelId of await deps.sub2api.listModels(secret)) addModel(modelId, groupName);
      }
    } catch (error) {
      reply.code(503).send(errorBody('UNAVAILABLE', error instanceof Error ? `获取可调用模型失败：${error.message}` : '获取可调用模型失败'));
      return null;
    }

    // 本地目录仅补充展示元数据（能力/价格），不决定展示与否；每个模型标注其来源分组
    const catalog = await pool().query<ComputeModelRow>(`${MODEL_SELECT} WHERE m.enabled = true`);
    const byName = new Map<string, ComputeModelRow>();
    for (const row of catalog.rows) {
      byName.set(row.name.toLowerCase(), row);
      byName.set(row.id.toLowerCase(), row);
    }
    return [...modelGroups.keys()].sort().map((modelId) => {
      const sourceGroups = [...(modelGroups.get(modelId) ?? [])];
      const normalized = modelId.toLowerCase();
      const row = byName.get(normalized) ?? byName.get(normalized.replace(/[\s_]+/g, '-'));
      if (row) return { ...mapComputeModel(row), availableGroups: sourceGroups };
      return mapComputeModel({
        id: modelId,
        name: modelId,
        provider: guessProvider(modelId),
        capabilities: {},
        enabled: true,
        input_price_per_mtok_usd: null,
        output_price_per_mtok_usd: null,
        available_groups: sourceGroups,
      });
    });
  };

  const loadIdentityModelsCached = async (
    identityId: string,
    reply: FastifyReply,
  ): Promise<ComputeModel[] | null> => {
    const cached = modelListCache.get(identityId);
    if (cached && cached.expiresAt > Date.now()) return cached.items;
    const items = await loadIdentityModels(identityId, reply);
    if (items) modelListCache.set(identityId, { items, expiresAt: Date.now() + MODEL_LIST_CACHE_TTL_MS });
    return items;
  };

  app.get('/api/v1/compute/models', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    const items = await loadIdentityModelsCached(ctx.identity.id, reply);
    if (!items) return;
    return reply.send({ ok: true, data: { items } as ComputeModelList });
  });

  app.get('/api/v1/compute/models/:modelId', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    const items = await loadIdentityModelsCached(ctx.identity.id, reply);
    if (!items) return;
    const { modelId } = request.params as { modelId: string };
    const model = items.find((item) => item.id === modelId);
    if (!model) return reply.code(404).send(errorBody('NOT_FOUND', '模型不存在或当前身份不可调用', request.id));
    return reply.send({ ok: true, data: model });
  });

  // §7.4：FROM/JOIN 与 WHERE 复用；$1 为作用域（子句经白名单构造，非用户输入）。
  const USAGE_FROM = `FROM compute_usage u
       LEFT JOIN compute_keys k ON k.id = u.key_id
       LEFT JOIN identities i ON i.id = u.identity_id`;
  const usageFilter = (scopeClause: string): string =>
    `${scopeClause}
     AND ($2::timestamptz IS NULL OR u.recorded_at >= $2)
     AND ($3::timestamptz IS NULL OR u.recorded_at <= $3)
     AND ($4::text IS NULL OR u.model = $4)
     AND ($5::uuid IS NULL OR u.key_id = $5)
     AND ($6::uuid IS NULL OR u.project_id = $6)`;
  const filterParams = (scopeValue: string, filter: UsageFilter): Array<string | null> => [
    scopeValue,
    filter.from,
    filter.to,
    filter.modelId,
    filter.keyId,
    filter.projectId,
  ];
  const USAGE_COLUMNS = `u.id, u.identity_id, u.model, u.key_id, k.key_prefix, u.project_id, u.conversation_id, u.task_id,
              u.prompt_tokens, u.completion_tokens, u.latency_ms, u.status, u.amount_usd, u.amount_points, u.recorded_at`;

  app.get('/api/v1/compute/usage', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    const parsed = parseUsageQuery(request.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(400).send(errorBody('INVALID_ARGUMENT', parsed.message, request.id));
    const { filter, scope, page, pageSize } = parsed.value;
    const scoped = await resolveScope(ctx.identity, scope);
    if (!scoped.ok) return reply.code(403).send(errorBody('FORBIDDEN', scoped.message, request.id));

    const where = usageFilter(scoped.clause);
    const params = filterParams(scoped.value, filter);
    const rawPool = pool();
    const [rows, total] = await Promise.all([
      rawPool.query<ComputeUsageRow>(
        `SELECT ${USAGE_COLUMNS} ${USAGE_FROM} WHERE ${where} ORDER BY u.recorded_at DESC LIMIT $7 OFFSET $8`,
        [...params, pageSize, (page - 1) * pageSize],
      ),
      rawPool.query<{ total: number }>(`SELECT count(*)::int AS total ${USAGE_FROM} WHERE ${where}`, params),
    ]);
    const data: PagedData<ComputeUsageRecord> = {
      items: rows.rows.map(mapUsageRecord),
      page: { page, pageSize, total: total.rows[0]?.total ?? 0 },
    };
    return reply.send({ ok: true, data });
  });

  app.get('/api/v1/compute/usage/summary', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    const parsed = parseUsageQuery(request.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(400).send(errorBody('INVALID_ARGUMENT', parsed.message, request.id));
    const { filter, scope } = parsed.value;
    const scoped = await resolveScope(ctx.identity, scope);
    if (!scoped.ok) return reply.code(403).send(errorBody('FORBIDDEN', scoped.message, request.id));

    const where = usageFilter(scoped.clause);
    const params = filterParams(scoped.value, filter);
    const rawPool = pool();
    type TotalsRow = {
      request_count: number;
      prompt_tokens: string | null;
      completion_tokens: string | null;
      amount_points: string | number | null;
      success_count: number;
      failure_count: number;
      avg_latency_ms: string | number | null;
    };
    const [totals, byModel, byDay] = await Promise.all([
      rawPool.query<TotalsRow>(
        `SELECT COUNT(*)::int AS request_count,
                COALESCE(SUM(u.prompt_tokens),0)::bigint AS prompt_tokens,
                COALESCE(SUM(u.completion_tokens),0)::bigint AS completion_tokens,
                COALESCE(SUM(u.amount_points),0) AS amount_points,
                COUNT(*) FILTER (WHERE u.status = 'success')::int AS success_count,
                COUNT(*) FILTER (WHERE u.status <> 'success')::int AS failure_count,
                AVG(u.latency_ms) AS avg_latency_ms
         ${USAGE_FROM} WHERE ${where}`,
        params,
      ),
      rawPool.query<{ key: string; request_count: number; total_tokens: string | null; cost_points: string | number | null }>(
        `SELECT COALESCE(u.model, '未标注') AS key, COUNT(*)::int AS request_count,
                COALESCE(SUM(COALESCE(u.prompt_tokens,0) + COALESCE(u.completion_tokens,0)),0)::bigint AS total_tokens,
                COALESCE(SUM(u.amount_points),0) AS cost_points
         ${USAGE_FROM} WHERE ${where} GROUP BY 1 ORDER BY cost_points DESC`,
        params,
      ),
      rawPool.query<{ key: string; request_count: number; total_tokens: string | null; cost_points: string | number | null }>(
        `SELECT to_char(date_trunc('day', u.recorded_at), 'YYYY-MM-DD') AS key, COUNT(*)::int AS request_count,
                COALESCE(SUM(COALESCE(u.prompt_tokens,0) + COALESCE(u.completion_tokens,0)),0)::bigint AS total_tokens,
                COALESCE(SUM(u.amount_points),0) AS cost_points
         ${USAGE_FROM} WHERE ${where} GROUP BY 1 ORDER BY 1`,
        params,
      ),
    ]);
    const bucket = (row: { key: string; request_count: number; total_tokens: string | null; cost_points: string | number | null }) => ({
      key: row.key,
      requestCount: row.request_count,
      totalTokens: toNumber(row.total_tokens) ?? 0,
      costPoints: toNumber(row.cost_points) ?? 0,
    });
    const row = totals.rows[0];
    const inputTokens = toNumber(row?.prompt_tokens) ?? 0;
    const outputTokens = toNumber(row?.completion_tokens) ?? 0;
    const data: ComputeUsageSummary = {
      from: filter.from,
      to: filter.to,
      requestCount: row?.request_count ?? 0,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costPoints: toNumber(row?.amount_points) ?? 0,
      successCount: row?.success_count ?? 0,
      failureCount: row?.failure_count ?? 0,
      avgLatencyMs: toNumber(row?.avg_latency_ms),
      byModel: byModel.rows.map(bucket),
      byDay: byDay.rows.map(bucket),
    };
    return reply.send({ ok: true, data });
  });

  app.get('/api/v1/compute/usage/export', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireIdentity(deps.accounts, request, reply);
    if (!ctx) return;
    const parsed = parseUsageQuery(request.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(400).send(errorBody('INVALID_ARGUMENT', parsed.message, request.id));
    const { filter, scope } = parsed.value;
    const scoped = await resolveScope(ctx.identity, scope);
    if (!scoped.ok) return reply.code(403).send(errorBody('FORBIDDEN', scoped.message, request.id));

    const result = await pool().query<ComputeUsageRow>(
      `SELECT ${USAGE_COLUMNS} ${USAGE_FROM} WHERE ${usageFilter(scoped.clause)} ORDER BY u.recorded_at DESC LIMIT $7`,
      [...filterParams(scoped.value, filter), EXPORT_ROW_LIMIT],
    );
    return reply
      .header('content-disposition', 'attachment; filename="compute-usage.csv"')
      .type('text/csv; charset=utf-8')
      .send(buildUsageCsv(result.rows.map(mapUsageRecord)));
  });
}
