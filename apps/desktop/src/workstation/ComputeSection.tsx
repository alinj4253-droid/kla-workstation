// 算力模块（§9）：仪表盘 / API 密钥 / 使用记录 / 模型广场
// - 数据全部来自服务端 API，不使用任何预览值或虚拟余额
// - 完整 Secret 只在创建弹窗出现一次，且不写入 localStorage/URL/日志（§9.2、§12）
// - 身份切换后清空并重新加载，禁止复用上一身份缓存（§12）
// - 版式与文案对齐《鲲擎2.0 交互演示版》，计价单位为算力点（§4.2）

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Check, Clock3, Copy, CreditCard, Database, Download, FileText, Gauge, KeyRound, Layers, Pencil, Plus, RefreshCw, Search, Send, Trash2, Undo2, Users, Wallet } from 'lucide-react';
import type { ComputeKey, ComputeLedgerEntry, ComputeModel, ComputeOrgMember, ComputeOrgOverview, ComputeSummary, ComputeUsageBucket, ComputeUsageRecord, ComputeUsageSummary } from '@kla-workstation/contracts';
import { computeApi } from '../api/compute';
import { klaApi } from '../api/client';
import { apiErrorMessage, Badge, formatTime, formatTokens, formatPoints, Panel } from './ui';

export type ComputeView = 'dashboard' | 'keys' | 'usage' | 'market' | 'members';

type Props = {
  view: ComputeView;
  onNotify: (message: string) => void;
  onBalance: (availablePoints: number | null) => void;
  /** 上报当前身份是否具备企业管理员能力（用于决定侧栏是否展示「成员管理」） */
  onAdminCapability: (canManage: boolean) => void;
  /** 身份切换后由外层递增，强制清空并重新加载（§12） */
  reloadKey: number;
  projects: Array<{ id: string; name: string }>;
};

const PROVISION_LABELS: Record<string, string> = {
  pending: '待初始化', provisioning: '初始化中', user_created: '已建号', balance_granted: '已发放额度',
  default_key_created: '已建默认 Key', ready: '就绪', disabled: '身份已禁用', failed: '初始化失败', retrying: '重试中', dead_letter: '重试已耗尽',
};
const HEALTH_LABELS: Record<string, string> = { healthy: '正常', degraded: '降级', unavailable: '不可用', unknown: '未知' };
const KEY_STATUS_LABELS: Record<string, string> = { active: '活跃', disabled: '已停用', expired: '已过期', deleted: '已删除' };
const LEDGER_LABELS: Record<string, string> = { grant: '发放', allocate: '分配', reclaim: '回收', reserve: '预扣', commit: '扣减', release: '释放', recharge: '充值' };

const RANGE_OPTIONS = [
  { id: '24h', label: '近24小时', hours: 24 },
  { id: '7d', label: '近7天', hours: 24 * 7 },
  { id: '30d', label: '近30天', hours: 24 * 30 },
] as const;
type RangeId = (typeof RANGE_OPTIONS)[number]['id'];

const CATEGORY_OPTIONS = [
  { id: 'all', label: '全部模型' },
  { id: 'reasoning', label: '深度推理' },
  { id: 'vision', label: '视觉多模态' },
  { id: 'tools', label: '工具调用' },
  { id: 'streaming', label: '流式输出' },
] as const;
type CategoryId = (typeof CATEGORY_OPTIONS)[number]['id'];

/** 把时间范围换算为 usage 接口的 from（统一由服务端归集，前端不做统计口径换算）。 */
function rangeFrom(id: RangeId): string {
  const hours = RANGE_OPTIONS.find((item) => item.id === id)?.hours ?? 24;
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** 演示稿版式的 KPI 卡：k（图标 + 标签）/ v（数值）/ d（说明）。 */
function Metric({ icon, label, value, desc, accent = false }: { icon: React.ReactNode; label: string; value: string; desc?: React.ReactNode; accent?: boolean }) {
  return <div className={`ws-stat${accent ? ' is-accent' : ''}`}><span className="ws-stat-k">{icon}{label}</span><strong>{value}</strong>{desc && <span className="ws-stat-d">{desc}</span>}</div>;
}

/** 用真实的按天汇总绘制趋势柱；无数据时说明原因而不是画假曲线。 */
function TrendBars({ buckets }: { buckets: ComputeUsageBucket[] }) {
  if (buckets.length === 0) return <div className="ws-empty">所选范围内没有按天的用量记录</div>;
  const max = Math.max(...buckets.map((bucket) => bucket.totalTokens), 1);
  return <div className="ws-trend">{buckets.map((bucket) => (
    <div className="ws-trend-col" key={bucket.key} title={`${bucket.key} · 请求 ${bucket.requestCount} 次 · Token ${bucket.totalTokens} · ${formatPoints(bucket.costPoints)}`}>
      <i style={{ height: `${Math.max(2, Math.round((bucket.totalTokens / max) * 100))}%` }} />
      <small>{bucket.key.slice(5)}</small>
    </div>
  ))}</div>;
}

/** 只读比率条：把某个口径的占比画出来，宽度即真实占比。 */
function RatioBar({ value, total }: { value: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return <div className="ws-bar"><i style={{ width: `${percent}%` }} /></div>;
}

export function ComputeSection({ view, onNotify, onBalance, onAdminCapability, reloadKey, projects }: Props): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<ComputeSummary | null>(null);
  const [keys, setKeys] = useState<ComputeKey[]>([]);
  const [models, setModels] = useState<ComputeModel[]>([]);
  const [usageSummary, setUsageSummary] = useState<ComputeUsageSummary | null>(null);
  const [usageRows, setUsageRows] = useState<ComputeUsageRecord[]>([]);
  const [usageTotal, setUsageTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<'self' | 'organization'>('self');
  const [range, setRange] = useState<RangeId>('24h');
  const [recordsToken, setRecordsToken] = useState(0);
  const [filters, setFilters] = useState({ from: '', to: '', modelId: '', keyId: '', projectId: '' });
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [marketSort, setMarketSort] = useState<'price' | 'name'>('price');
  const [marketCategory, setMarketCategory] = useState<CategoryId>('all');
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyForm, setKeyForm] = useState({ name: '', groupId: '', quota: '', rpm: '', expiresAt: '' });
  const [editKey, setEditKey] = useState<ComputeKey | null>(null);
  const [editForm, setEditForm] = useState({ name: '', quota: '', rpm: '', expiresAt: '' });
  const [createdSecret, setCreatedSecret] = useState<{ name: string; secret: string | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // ---- §7.5 企业额度管理（企业管理员）----
  const [orgOverview, setOrgOverview] = useState<ComputeOrgOverview | null>(null);
  const [orgToken, setOrgToken] = useState(0);
  const [allocTarget, setAllocTarget] = useState<ComputeOrgMember | null>(null);
  const [allocMode, setAllocMode] = useState<'allocate' | 'reclaim'>('allocate');
  const [allocAmount, setAllocAmount] = useState('');
  const [allocSubmitting, setAllocSubmitting] = useState(false);

  // 时间窗口只随「范围选择」或「自定义起始时间」变化，避免每次渲染重算 Date.now() 导致重复请求。
  const effectiveFrom = useMemo(() => (filters.from ? new Date(filters.from).toISOString() : rangeFrom(range)), [filters.from, range]);
  const effectiveTo = useMemo(() => (filters.to ? new Date(filters.to).toISOString() : undefined), [filters.to]);

  /** 身份解析 + 全量刷新：身份变化时先清空，杜绝跨身份缓存。 */
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    const identities = await klaApi.request<Array<{ id: string; isDefault: boolean; status: string }>>('/v1/me/identities');
    const active = identities.ok ? (identities.data.find((item) => item.isDefault && item.status === 'active') ?? identities.data.find((item) => item.status === 'active')) : undefined;
    void active;
    setSummary(null);
    setKeys([]);
    setModels([]);
    setUsageRows([]);
    setUsageSummary(null);
    setOrgOverview(null);
    const [summaryResult, keysResult, modelsResult, usageResult] = await Promise.all([
      computeApi.summary(),
      computeApi.keys(),
      computeApi.models(),
      computeApi.usageSummary({ scope, from: effectiveFrom, ...(effectiveTo ? { to: effectiveTo } : {}) }),
    ]);
    if (summaryResult.ok) {
      setSummary(summaryResult.data);
      onBalance(summaryResult.data.available);
      onAdminCapability(summaryResult.data.permissions.canViewOrganizationUsage);
    } else {
      setError(apiErrorMessage(summaryResult));
      onBalance(null);
      onAdminCapability(false);
    }
    if (keysResult.ok) setKeys(keysResult.data.items);
    if (modelsResult.ok) setModels(modelsResult.data.items);
    if (usageResult.ok) setUsageSummary(usageResult.data);
    setLoading(false);
  }, [scope, effectiveFrom, effectiveTo, onBalance, onAdminCapability]);

  useEffect(() => { void refresh(); }, [refresh, reloadKey]);

  useEffect(() => {
    void (async () => {
      const result = await computeApi.usage({
        page,
        pageSize: 20,
        scope,
        from: effectiveFrom,
        ...(effectiveTo ? { to: effectiveTo } : {}),
        ...(filters.modelId ? { modelId: filters.modelId } : {}),
        ...(filters.keyId ? { keyId: filters.keyId } : {}),
        ...(filters.projectId ? { projectId: filters.projectId } : {}),
      });
      if (result.ok) {
        setUsageRows(result.data.items);
        setUsageTotal(result.data.page.total);
      }
    })();
  }, [page, scope, effectiveFrom, effectiveTo, recordsToken, filters.modelId, filters.keyId, filters.projectId]);

  // §7.5：仅企业管理员进入「成员管理」时加载企业总览（池聚合 + 成员 + 流水 + 邀请码，一次取齐）。
  const organizationId = summary?.organizationId ?? null;
  const canManageMembers = summary?.permissions.canViewOrganizationUsage ?? false;
  useEffect(() => {
    if (view !== 'members' || !organizationId || !canManageMembers) return;
    void (async () => {
      const result = await computeApi.orgOverview(organizationId);
      if (result.ok) setOrgOverview(result.data);
      else onNotify(apiErrorMessage(result));
    })();
  }, [view, organizationId, canManageMembers, reloadKey, orgToken, onNotify]);

  const openAllocation = (member: ComputeOrgMember, mode: 'allocate' | 'reclaim') => {
    setAllocTarget(member);
    setAllocMode(mode);
    setAllocAmount('');
  };

  const submitAllocation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId || !allocTarget) return;
    const amount = Number(allocAmount);
    if (!Number.isFinite(amount) || amount <= 0) { onNotify('请输入大于 0 的积分数'); return; }
    setAllocSubmitting(true);
    // 回收接口路径中的 :id 仅用于回显归属，传成员 identityId 占位。
    const result = allocMode === 'allocate'
      ? await computeApi.allocate(organizationId, { identityId: allocTarget.identityId, amount })
      : await computeApi.reclaim(organizationId, allocTarget.identityId, { identityId: allocTarget.identityId, amount });
    setAllocSubmitting(false);
    if (!result.ok) { onNotify(apiErrorMessage(result)); return; }
    const target = allocTarget.displayName;
    setAllocTarget(null);
    setAllocAmount('');
    const verb = allocMode === 'allocate' ? '分配' : '回收';
    onNotify(result.data.sub2apiSynced === false
      ? `已${verb} ${formatPoints(amount)}（KLA 台账已记账，Sub2API 余额等待对账同步）`
      : `已向 ${target} ${verb} ${formatPoints(amount)}`);
    setOrgToken((token) => token + 1);
  };

  const copyInviteCode = async () => {
    if (!orgOverview?.inviteCode) return;
    await navigator.clipboard?.writeText(orgOverview.inviteCode);
    onNotify('企业邀请码已复制');
  };

  const retryProvision = async () => {
    const result = await computeApi.retryProvision();
    if (!result.ok) { onNotify(apiErrorMessage(result)); return; }
    onNotify(result.data.accepted ? '已提交初始化重试' : '算力账号已就绪，无需重试');
    await refresh();
  };

  const createKey = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    const result = await computeApi.createKey({
      name: keyForm.name.trim(),
      ...(keyForm.groupId.trim() ? { groupId: keyForm.groupId.trim() } : {}),
      ...(keyForm.quota.trim() ? { quota: Number(keyForm.quota) } : {}),
      ...(keyForm.rpm.trim() ? { rpm: Number(keyForm.rpm) } : {}),
      ...(keyForm.expiresAt ? { expiresAt: new Date(keyForm.expiresAt).toISOString() } : {}),
    });
    setSubmitting(false);
    if (!result.ok) { onNotify(apiErrorMessage(result)); return; }
    setShowKeyForm(false);
    setCreatedSecret({ name: result.data.key.name, secret: result.data.secret ?? null });
    setKeyForm({ name: '', groupId: '', quota: '', rpm: '', expiresAt: '' });
    await refresh();
  };

  const openEdit = (key: ComputeKey) => {
    setEditKey(key);
    setEditForm({
      name: key.name,
      quota: key.quotaPoints != null ? String(key.quotaPoints) : '',
      rpm: key.rpm != null ? String(key.rpm) : '',
      expiresAt: key.expiresAt ? key.expiresAt.slice(0, 16) : '',
    });
  };

  const submitEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editKey) return;
    setSubmitting(true);
    const result = await computeApi.updateKey(editKey.id, {
      name: editForm.name.trim(),
      quota: editForm.quota.trim() ? Number(editForm.quota) : null,
      rpm: editForm.rpm.trim() ? Number(editForm.rpm) : null,
      expiresAt: editForm.expiresAt ? new Date(editForm.expiresAt).toISOString() : null,
    });
    setSubmitting(false);
    if (!result.ok) { onNotify(apiErrorMessage(result)); return; }
    setEditKey(null);
    onNotify(`已更新 ${editForm.name.trim()}`);
    await refresh();
  };

  const disableKey = async (key: ComputeKey) => {
    const result = await computeApi.disableKey(key.id);
    onNotify(result.ok ? `已停用 ${key.name}` : apiErrorMessage(result));
    if (result.ok) await refresh();
  };

  const deleteKey = async (key: ComputeKey) => {
    const result = await computeApi.deleteKey(key.id);
    onNotify(result.ok ? `已删除 ${key.name}` : apiErrorMessage(result));
    if (result.ok) await refresh();
  };

  /** 复制调用示例；示例中不含完整密钥，只提示调用方自行填回。 */
  const copyExample = async (key: ComputeKey) => {
    const snippet = `curl -X POST "$KLA_GATEWAY/api/v1/chat/completions" \\\n  -H "Authorization: Bearer <${key.name} 的完整密钥>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"<model-id>","messages":[{"role":"user","content":"你好"}]}'`;
    await navigator.clipboard?.writeText(snippet);
    onNotify('调用示例已复制到剪贴板');
  };

  const exportUsage = async () => {
    const result = await computeApi.exportUsage({ scope, from: effectiveFrom, ...(effectiveTo ? { to: effectiveTo } : {}) });
    if (!result.ok) { onNotify(result.message); return; }
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'compute-usage.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const modelById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const filteredModels = useMemo(
    () => models.filter((model) => `${model.name}${model.id}${model.provider}`.toLowerCase().includes(query.toLowerCase())),
    [models, query],
  );
  const filteredKeys = useMemo(() => keys.filter((key) => {
    if (!key.name.toLowerCase().includes(query.toLowerCase()) && !key.keyPrefix.toLowerCase().includes(query.toLowerCase())) return false;
    if (groupFilter && (key.groupId ?? '') !== groupFilter) return false;
    if (statusFilter && key.status !== statusFilter) return false;
    return true;
  }), [keys, query, groupFilter, statusFilter]);
  const groupOptions = useMemo(() => [...new Set(keys.map((key) => key.groupId).filter((value): value is string => Boolean(value)))], [keys]);
  const sortedModels = useMemo(() => {
    const matched = filteredModels.filter((model) => marketCategory === 'all' || model.capabilities[marketCategory]);
    return [...matched].sort((a, b) => marketSort === 'name'
      ? a.name.localeCompare(b.name)
      : (a.inputPricePerMillionTokensPoints ?? Number.POSITIVE_INFINITY) - (b.inputPricePerMillionTokensPoints ?? Number.POSITIVE_INFINITY));
  }, [filteredModels, marketCategory, marketSort]);

  /** 按 byModel 的真实用量，把平台维度聚合出来（平台取模型目录里的 provider）。 */
  const providerSplit = useMemo(() => {
    const grouped = new Map<string, { requestCount: number; totalTokens: number; costPoints: number }>();
    for (const bucket of usageSummary?.byModel ?? []) {
      const provider = modelById.get(bucket.key)?.provider ?? '未标注';
      const prev = grouped.get(provider) ?? { requestCount: 0, totalTokens: 0, costPoints: 0 };
      grouped.set(provider, {
        requestCount: prev.requestCount + bucket.requestCount,
        totalTokens: prev.totalTokens + bucket.totalTokens,
        costPoints: prev.costPoints + bucket.costPoints,
      });
    }
    return [...grouped.entries()].map(([provider, value]) => ({ provider, ...value })).sort((a, b) => b.costPoints - a.costPoints);
  }, [usageSummary, modelById]);

  const periodLabel = range === '24h' ? '今日' : '所选范围';
  const activeKeyCount = keys.filter((key) => key.status === 'active').length;
  const disabledKeyCount = keys.filter((key) => key.status === 'disabled').length;
  const totalQuota = summary ? summary.available + summary.used + summary.reserved : 0;
  const usedRatio = totalQuota > 0 && summary ? Math.min(100, Math.round((summary.used / totalQuota) * 100)) : 0;
  const costShare = summary && totalQuota > 0 && usageSummary ? (usageSummary.costPoints / totalQuota) * 100 : null;
  const successRate = usageSummary && usageSummary.requestCount > 0
    ? `${((usageSummary.successCount / usageSummary.requestCount) * 100).toFixed(1)}%`
    : '—';
  const avgTokensPerRequest = usageSummary && usageSummary.requestCount > 0 ? usageSummary.totalTokens / usageSummary.requestCount : null;
  const topModelTokens = usageSummary?.byModel[0]?.totalTokens ?? 0;
  /** 企业池口径：总额 = 管理员持有（未分发）+ 成员持有（已分发）；分发/回收不改变总额。 */
  const orgPool = orgOverview?.pool ?? null;
  const orgMembers = orgOverview?.members ?? [];
  const orgLedger = orgOverview?.recentLedger ?? [];

  if (loading && !summary) {
    return <div className="ws-empty"><RefreshCw size={26} /><strong>正在加载算力数据…</strong><small>已按当前身份重新计算，不复用上一次缓存</small></div>;
  }

  const rangeSelect = (
    <select aria-label="时间范围" value={range} onChange={(event) => { setRange(event.target.value as RangeId); setPage(1); }}>
      {RANGE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  );

  return <>
    {error && <div className="ws-empty"><RefreshCw size={26} /><strong>{error}</strong><small>请稍后重试或联系管理员</small><button className="ws-text-button" onClick={() => void refresh()}>重新加载</button></div>}

    {view === 'dashboard' && summary && <>
      <div className="ws-page-heading">
        <div><h1>仪表盘</h1><p>网关节点运行正常 ｜ 汇总余额、API 密钥、请求量与 Token 消耗，实时反映算力平台的资源占用与费用支出。</p></div>
        <div className="ws-inline">
          {summary.provisionState !== 'ready' && <button className="ws-ghost" onClick={() => void retryProvision()}>重试初始化</button>}
          <button className="ws-ghost" onClick={() => void refresh()}><RefreshCw size={14} /> 刷新</button>
        </div>
      </div>

      <div className="ws-inline" style={{ marginBottom: 12 }}>
        <Badge tone={summary.provisionState === 'ready' ? 'green' : 'orange'}>初始化：{PROVISION_LABELS[summary.provisionState] ?? summary.provisionState}</Badge>
        <Badge tone={summary.sub2apiHealth === 'healthy' ? 'green' : summary.sub2apiHealth === 'unavailable' ? 'muted' : 'orange'}>Sub2API：{HEALTH_LABELS[summary.sub2apiHealth] ?? summary.sub2apiHealth}</Badge>
        <span className="ws-muted">当前身份：{summary.identityType === 'personal' ? '个人身份' : '企业身份'}</span>
      </div>

      <Panel title="统计范围" subtitle="费用按网关实际结算价计入；用量由网关在每次调用返回后回写，切换范围后所有卡片同源刷新。">
        <div className="ws-tool-row">
          <span className="ws-muted">时间范围:</span>
          {rangeSelect}
          <span className="ws-muted">粒度:</span>
          <span className="ws-muted">按天（服务端聚合）</span>
          <span className="ws-muted">聚合维度:</span>
          <span className="ws-muted">按模型 / 按平台</span>
        </div>
      </Panel>

      <div className="ws-stats four">
        <Metric accent icon={<Wallet />} label="余额" value={formatPoints(summary.balance)} desc={`可用 ${formatPoints(summary.available)} ｜ 预扣 ${formatPoints(summary.reserved)}`} />
        <Metric icon={<KeyRound />} label="API 密钥" value={`${keys.length}`} desc={`● ${activeKeyCount} 启用 ｜ ${disabledKeyCount} 已停用`} />
        <Metric icon={<Send />} label={`${periodLabel}请求`} value={`${usageSummary?.requestCount ?? 0}`} desc={`成功 ${usageSummary?.successCount ?? 0} ｜ 失败 ${usageSummary?.failureCount ?? 0}`} />
        <Metric icon={<CreditCard />} label={`${periodLabel}消费`} value={formatPoints(usageSummary?.costPoints)} desc={costShare == null ? '暂无额度基线' : `约占总额度 ${costShare.toFixed(2)}%`} />
      </div>

      <div className="ws-stats two">
        <Metric icon={<Database />} label={`${periodLabel} Token`} value={formatTokens(usageSummary?.totalTokens)}
          desc={`输入 ${formatTokens(usageSummary?.inputTokens)} / 输出 ${formatTokens(usageSummary?.outputTokens)} / 缓存 —— ｜ 缓存口径由上游返回，网关暂未采集`} />
        <Metric icon={<Activity />} label="响应表现" value={usageSummary?.avgLatencyMs != null ? `${Math.round(usageSummary.avgLatencyMs)}ms` : '—'}
          desc={`成功率 ${successRate} ｜ 单次平均 ${avgTokensPerRequest != null ? formatTokens(Math.round(avgTokensPerRequest)) : '—'} Token`} />
      </div>

      <Panel title="性能指标" subtitle="平台侧计量探针提供 RPM / TPM 速率，网关侧暂未接入该口径，以下仅展示可核实的响应指标。">
        <div className="ws-stats three" style={{ marginBottom: 0 }}>
          <Metric icon={<Gauge />} label="请求速率" value="—" desc="每分钟请求数（RPM），等待平台探针接入" />
          <Metric icon={<Gauge />} label="Token 速率" value="—" desc="每分钟 Token 数（TPM），等待平台探针接入" />
          <Metric icon={<Clock3 />} label="平均响应" value={usageSummary?.avgLatencyMs != null ? `${Math.round(usageSummary.avgLatencyMs)}ms` : '—'} desc={`${periodLabel}端到端平均时延，含排队与生成`} />
        </div>
      </Panel>

      <div className="ws-cols-3-2">
        <Panel title="Token 使用趋势" subtitle="按天统计的输入与输出 Token，堆叠柱越高代表当天消耗越集中；缓存口径暂未采集。">
          <TrendBars buckets={usageSummary?.byDay ?? []} />
          <div className="ws-inline" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <Badge>输入 {formatTokens(usageSummary?.inputTokens)}</Badge>
            <Badge tone="green">输出 {formatTokens(usageSummary?.outputTokens)}</Badge>
            <span className="ws-muted">缓存 ——</span>
          </div>
        </Panel>
        <div>
          <Panel title="按平台拆分" subtitle={`${providerSplit.length} 个服务提供商在${periodLabel}产生费用`}>
            {providerSplit.length === 0 ? <div className="ws-empty">所选范围内没有调用记录</div> : <>
              {providerSplit.slice(0, 4).map((item) => <div className="ws-list-item" key={item.provider} style={{ marginBottom: 8 }}>
                <span className="ws-avatar-sm">{item.provider.slice(0, 2)}</span>
                <div className="ws-grow"><div className="t">{item.provider}</div><div className="s">请求 {item.requestCount} 次 · Token {formatTokens(item.totalTokens)}</div></div>
                <div className="ws-amount"><div className="t">{formatPoints(item.costPoints)}</div><div className="s">{periodLabel}消费</div></div>
              </div>)}
              <RatioBar value={providerSplit[0].costPoints} total={usageSummary?.costPoints ?? 0} />
              <p className="ws-note" style={{ marginTop: 8 }}>首位平台占{periodLabel}全部消费的 {usageSummary && usageSummary.costPoints > 0 ? Math.round((providerSplit[0].costPoints / usageSummary.costPoints) * 100) : 0}%。</p>
            </>}
          </Panel>
          <Panel title="模型分布" subtitle={`${usageSummary?.byModel.length ?? 0} 个模型在${periodLabel}产生调用，按消费排序`}>
            {!usageSummary || usageSummary.byModel.length === 0 ? <div className="ws-empty">暂无数据</div> : <table className="ws-table"><thead><tr><th>模型</th><th>请求</th><th>Token</th><th>实际消费</th></tr></thead><tbody>
              {usageSummary.byModel.slice(0, 5).map((bucket) => <tr key={bucket.key}>
                <td>{modelById.get(bucket.key)?.name ?? bucket.key}<div className="ws-note">{modelById.get(bucket.key)?.provider ?? '未标注'}</div></td>
                <td>{bucket.requestCount}</td>
                <td>{formatTokens(bucket.totalTokens)}</td>
                <td>{formatPoints(bucket.costPoints)}</td>
              </tr>)}
            </tbody></table>}
          </Panel>
        </div>
      </div>

      <Panel title="余额水位" action={<span className="ws-muted">已用 {usedRatio}%</span>}>
        <div className="ws-progress-track"><i style={{ width: `${usedRatio}%` }} /></div>
        <p className="ws-detail-copy">总额度 {formatPoints(totalQuota)} · 已用 {formatPoints(summary.used)} · 预扣 {formatPoints(summary.reserved)} · 可用 {formatPoints(summary.available)}</p>
        <div className="ws-inline">
          {summary.permissions.canRecharge && <button className="ws-text-button" onClick={() => onNotify('充值需先接入支付渠道，本期仅支持运维发放')}>充值与额度购买</button>}
          {!summary.permissions.canRecharge && summary.identityType === 'enterprise' && <span className="ws-muted">企业额度由企业管理员分配；如需充值请联系管理员</span>}
          {summary.permissions.canAllocate && <button className="ws-text-button" onClick={() => onNotify('成员额度管理在企业额度接口就绪后开放')}>成员额度管理</button>}
        </div>
      </Panel>

      <Panel title="最近用量" subtitle="按当前身份与时间范围取最新的调用明细，完整记录见「使用记录」。">
        {usageRows.length === 0 ? <div className="ws-empty">暂无用量记录</div> : <table className="ws-table"><thead><tr><th>时间</th><th>模型</th><th>Token</th><th>消费</th><th>状态</th></tr></thead><tbody>
          {usageRows.slice(0, 5).map((row) => <tr key={row.id}><td>{formatTime(row.usageAt)}</td><td>{row.modelId ?? '未标注'}</td><td>{formatTokens(row.totalTokens)}</td><td>{formatPoints(row.costPoints)}</td><td><Badge tone={row.status === 'success' ? 'green' : 'muted'}>{row.status === 'success' ? '成功' : '失败'}</Badge></td></tr>)}
        </tbody></table>}
      </Panel>

      {summary.sub2apiHealth === 'unavailable' && <Panel title="算力服务暂不可用"><p className="ws-detail-copy">Sub2API 健康检查失败，新的模型请求会快速失败；正在进行的流式请求会自然结束。</p></Panel>}

      {summary.provisionState !== 'ready' && summary.provisionState !== 'default_key_created' && <Panel title="初始化进度">
        <p className="ws-detail-copy">当前身份：{summary.identityType === 'personal' ? '个人身份' : '企业身份'} · 状态：{PROVISION_LABELS[summary.provisionState] ?? summary.provisionState}。初始化未完成前不展示可用额度。</p>
        <button className="ws-primary" onClick={() => void retryProvision()}>重试初始化</button>
      </Panel>}
    </>}

    {view === 'keys' && <>
      <div className="ws-page-heading">
        <div><h1>API 密钥</h1><p>网关节点运行正常 ｜ 管理用于调用算力平台的访问密钥，控制其所属分组、限额与有效期；用量与费用会实时回写到密钥维度。</p></div>
      </div>
      <Panel title="密钥清单" subtitle="按分组与状态筛选；完整 Key 只在创建成功时展示一次，列表仅保留前缀。"
        action={<div className="ws-tool-row">
          <div className="ws-sub-search"><Search size={15} /><input placeholder="搜索名称或 Key 前缀..." value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <select aria-label="分组筛选" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
            <option value="">全部分组</option>
            {groupOptions.map((group) => <option key={group} value={group}>{group}</option>)}
          </select>
          <select aria-label="状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">全部状态</option>
            {Object.entries(KEY_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button className="ws-primary" onClick={() => setShowKeyForm(true)}><Plus size={15} /> 创建密钥</button>
        </div>}>
        {filteredKeys.length === 0 ? <div className="ws-empty">没有符合筛选条件的 API 密钥</div> : <table className="ws-table"><thead><tr>
          <th>名称</th><th>分组</th><th>限额 / 速率</th><th>用量</th><th>过期时间</th><th>状态</th><th>创建时间</th><th>操作</th>
        </tr></thead><tbody>
          {filteredKeys.map((key) => <tr key={key.id}>
            <td>
              <div>{key.isDefault ? '● ' : ''}{key.name}{key.isDefault && <> <Badge>系统默认</Badge></>}</div>
              <code>{key.keyPrefix}…</code>
            </td>
            <td>
              <Badge tone="blue">{key.groupId ?? '默认分组'}</Badge>
              <div className="ws-note" style={{ marginTop: 4 }}>分组由服务端模型目录维护</div>
            </td>
            <td>
              <div>{key.quotaPoints != null ? formatPoints(key.quotaPoints) : '不限额'}</div>
              <div className="ws-note">{key.rpm != null ? `${key.rpm} RPM` : '未设速率上限'}</div>
            </td>
            <td>
              <div>今日: {formatPoints(key.todayUsagePoints)}</div>
              <div className="ws-note">30天: ——（服务端暂未提供该口径）</div>
            </td>
            <td>{key.expiresAt ? <span>{formatTime(key.expiresAt)}</span> : <Badge tone="green">永久有效</Badge>}</td>
            <td>
              <Badge tone={key.status === 'active' ? 'green' : 'muted'}>{KEY_STATUS_LABELS[key.status] ?? key.status}</Badge>
              <div className="ws-note" style={{ marginTop: 4 }}>{key.lastSyncedAt ? `最近同步 ${formatTime(key.lastSyncedAt)}` : '尚未同步用量'}</div>
            </td>
            <td>{formatTime(key.createdAt)}</td>
            <td>
              <div className="ws-inline" style={{ flexWrap: 'wrap' }}>
                <button className="ws-ghost" onClick={() => void copyExample(key)}><Copy size={13} /> 使用</button>
                <button className="ws-ghost" onClick={() => openEdit(key)}><Pencil size={13} /> 编辑</button>
                {key.status === 'active' && <button className="ws-ghost" onClick={() => void disableKey(key)}>停用</button>}
                {!key.isDefault && key.status !== 'deleted'
                  ? <button className="ws-ghost danger" onClick={() => void deleteKey(key)}><Trash2 size={13} /> 删除</button>
                  : key.isDefault ? <span className="ws-muted">默认 Key 不可删除</span> : null}
              </div>
            </td>
          </tr>)}
        </tbody></table>}
        <p className="ws-table-footer" style={{ marginTop: 10 }}>共 {filteredKeys.length} 条记录 ｜ ● 用量随网关调用实时回写</p>
      </Panel>
    </>}

    {view === 'usage' && <>
      <div className="ws-page-heading">
        <div><h1>使用记录</h1><p>网关节点运行正常 ｜ 按时间、模型与密钥回溯每一次调用的用量与费用，可导出 CSV 用于内部对账。</p></div>
      </div>

      <Panel title="统计范围" subtitle="统计口径：一条请求记一行，重试单独计数；消费按请求返回后的实际结算价计入。">
        <div className="ws-tool-row">
          <span className="ws-muted">时间范围:</span>
          {rangeSelect}
          <span className="ws-muted">粒度:</span>
          <span className="ws-muted">按天（服务端聚合）</span>
          <span className="ws-muted">时区:</span>
          <span className="ws-muted">UTC+08:00</span>
          <div className="ws-right">
            {summary?.permissions.canViewOrganizationUsage && <div className="ws-segment compact">
              <button className={scope === 'self' ? 'active' : ''} onClick={() => { setScope('self'); setPage(1); }}>我的用量</button>
              <button className={scope === 'organization' ? 'active' : ''} onClick={() => { setScope('organization'); setPage(1); }}>成员汇总</button>
            </div>}
            <button className="ws-ghost" onClick={() => { setRecordsToken((token) => token + 1); void refresh(); }}><RefreshCw size={14} /> 刷新</button>
            <button className="ws-ghost" onClick={() => void exportUsage()}><Download size={14} /> 导出 CSV</button>
          </div>
        </div>
      </Panel>

      <div className="ws-stats four">
        <Metric icon={<FileText />} label="总请求数" value={`${usageSummary?.requestCount ?? 0}`} desc={`所选范围内 ｜ 成功率 ${successRate}，失败 ${usageSummary?.failureCount ?? 0} 次`} />
        <Metric icon={<Database />} label="总 Token" value={formatTokens(usageSummary?.totalTokens)}
          desc={`输入 ${formatTokens(usageSummary?.inputTokens)} / 输出 ${formatTokens(usageSummary?.outputTokens)} / 缓存 ——`} />
        <Metric accent icon={<Wallet />} label="总消费" value={formatPoints(usageSummary?.costPoints)} desc="按实际结算价计入（积分）" />
        <Metric icon={<Clock3 />} label="平均耗时" value={usageSummary?.avgLatencyMs != null ? `${Math.round(usageSummary.avgLatencyMs)}ms` : '—'} desc={`${usageSummary?.requestCount ?? 0} 次请求的端到端平均时延`} />
      </div>

      <Panel title="模型分布" subtitle={`所选范围内 ${usageSummary?.byModel.length ?? 0} 个模型产生调用，占比与消费逐一对应`}>
        {!usageSummary || usageSummary.byModel.length === 0 ? <div className="ws-empty">所选范围内没有调用记录</div> : <div className="ws-cols-2-1">
          <table className="ws-table"><thead><tr><th>模型</th><th>请求</th><th>Token</th><th>实际消费</th></tr></thead><tbody>
            {usageSummary.byModel.map((bucket) => <tr key={bucket.key}>
              <td>
                <div>{modelById.get(bucket.key)?.name ?? bucket.key}</div>
                <div className="ws-note">{modelById.get(bucket.key)?.provider ?? '未标注'} ｜ 可用分组 {modelById.get(bucket.key)?.availableGroups.join('、') || '—'}</div>
                <div style={{ marginTop: 6, maxWidth: 220 }}><RatioBar value={bucket.totalTokens} total={usageSummary.totalTokens} /></div>
              </td>
              <td>{bucket.requestCount}</td>
              <td>{formatTokens(bucket.totalTokens)}</td>
              <td>{formatPoints(bucket.costPoints)}</td>
            </tr>)}
          </tbody></table>
          <div>
            <div className="ws-empty" style={{ minHeight: 0, alignItems: 'flex-start' }}>
              <strong>Token 占比</strong>
              <small>首位模型占 {usageSummary.totalTokens > 0 ? Math.round((topModelTokens / usageSummary.totalTokens) * 100) : 0}%</small>
            </div>
            <div className="ws-inline" style={{ flexWrap: 'wrap', marginTop: 10 }}>
              {usageSummary.byModel.slice(0, 4).map((bucket) => <Badge key={bucket.key}>{modelById.get(bucket.key)?.name ?? bucket.key} {formatTokens(bucket.totalTokens)}</Badge>)}
            </div>
            <p className="ws-note" style={{ marginTop: 10 }}>
              分组与端点维度的分布由服务端后续补充汇总接口，当前不展示未采集的口径。
            </p>
          </div>
        </div>}
      </Panel>

      <Panel title="Token 使用趋势" subtitle="按天铺开输入与输出 Token；缓存读取与缓存创建由上游返回，网关暂未采集。">
        <TrendBars buckets={usageSummary?.byDay ?? []} />
        <div className="ws-inline" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <Badge>输入 {formatTokens(usageSummary?.inputTokens)}</Badge>
          <Badge tone="green">输出 {formatTokens(usageSummary?.outputTokens)}</Badge>
          <span className="ws-muted">缓存 ——</span>
        </div>
      </Panel>

      <Panel title="高级筛选" subtitle="按密钥、模型与项目组合过滤，条件只作用于当前视图，不会改动任何数据。"
        action={<div className="ws-inline">
          <button className="ws-ghost" onClick={() => { setRecordsToken((token) => token + 1); void refresh(); }}><RefreshCw size={14} /> 刷新</button>
          <button className="ws-ghost" onClick={() => { setPage(1); setFilters({ from: '', to: '', modelId: '', keyId: '', projectId: '' }); setRange('24h'); }}>重置</button>
        </div>}>
        <div className="ws-mini-grid">
          <label className="ws-field">开始时间<input type="datetime-local" value={filters.from} onChange={(event) => { setPage(1); setFilters((prev) => ({ ...prev, from: event.target.value })); }} /></label>
          <label className="ws-field">结束时间<input type="datetime-local" value={filters.to} onChange={(event) => { setPage(1); setFilters((prev) => ({ ...prev, to: event.target.value })); }} /></label>
          <label className="ws-field">API 密钥<select value={filters.keyId} onChange={(event) => { setPage(1); setFilters((prev) => ({ ...prev, keyId: event.target.value })); }}><option value="">全部密钥</option>{keys.map((key) => <option key={key.id} value={key.id}>{key.name}</option>)}</select></label>
          <label className="ws-field">模型<select value={filters.modelId} onChange={(event) => { setPage(1); setFilters((prev) => ({ ...prev, modelId: event.target.value })); }}><option value="">全部模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
          <label className="ws-field">项目<select value={filters.projectId} onChange={(event) => { setPage(1); setFilters((prev) => ({ ...prev, projectId: event.target.value })); }}><option value="">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        </div>
      </Panel>

      <Panel title="调用明细" subtitle="一条请求记一行，分页读取；导出由服务端生成 CSV 并完成权限校验。">
        {usageRows.length === 0 ? <div className="ws-empty">当前筛选条件下暂无用量记录</div> : <table className="ws-table"><thead><tr><th>请求时间</th><th>模型</th><th>API 密钥</th><th>输入/输出 Token</th><th>实际消费</th><th>耗时</th><th>状态</th></tr></thead><tbody>
          {usageRows.map((row) => <tr key={row.id}>
            <td>{formatTime(row.usageAt)}</td>
            <td>{row.modelId ?? '未标注'}</td>
            <td>{row.keyPrefix ? `${row.keyPrefix}…` : '—'}</td>
            <td>{formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens)}</td>
            <td>{formatPoints(row.costPoints)}</td>
            <td>{row.latencyMs != null ? `${row.latencyMs}ms` : '—'}</td>
            <td><Badge tone={row.status === 'success' ? 'green' : 'muted'}>{row.status === 'success' ? '成功' : '失败'}</Badge></td>
          </tr>)}
        </tbody></table>}
        <p className="ws-table-footer" style={{ marginTop: 10 }}>共 {usageTotal} 条记录 · 第 {page} 页
          <button className="ws-text-button" disabled={page <= 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>上一页</button>
          <button className="ws-text-button" disabled={page * 20 >= usageTotal} onClick={() => setPage((prev) => prev + 1)}>下一页</button>
        </p>
      </Panel>
    </>}

    {view === 'market' && <>
      <div className="ws-page-heading">
        <div><h1>模型广场</h1><p>{models.length} 款模型已就绪 · 支持按单价 / 名称排序，选用后由智能调度引擎自动挂载到对应智能体</p></div>
      </div>

      <div className="ws-stats two">
        <Metric accent icon={<Wallet />} label="账户余额" value={formatPoints(summary?.available)}
          desc={summary ? `可用 ${formatPoints(summary.available)} ｜ 已用 ${formatPoints(summary.used)}` : '按当前身份计算'} />
        <Metric icon={<Layers />} label="已上架模型" value={`${models.length}`}
          desc={`覆盖 ${[...new Set(models.map((model) => model.provider))].slice(0, 4).join(' / ') || '—'}`} />
      </div>

      <Panel title="模型检索" subtitle="模型与路由均由服务端模型目录下发，本页只读，不支持编辑或填写上游 Key。">
        <div className="ws-tool-row">
          <div className="ws-sub-search" style={{ flex: 1, minWidth: 240 }}><Search size={16} /><input placeholder="搜索模型名称、ID 或供应商..." value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="ws-inline">
            <span className="ws-muted">排序规则</span>
            <div className="ws-segment">
              <button className={marketSort === 'price' ? 'active' : ''} onClick={() => setMarketSort('price')}>单价最优</button>
              <button className={marketSort === 'name' ? 'active' : ''} onClick={() => setMarketSort('name')}>名称</button>
            </div>
          </div>
          <div className="ws-right">
            <span className="ws-muted">可用余额 {formatPoints(summary?.available)}</span>
          </div>
        </div>
        <div className="ws-chips" style={{ marginTop: 12 }}>
          {CATEGORY_OPTIONS.map((option) => <button key={option.id} className={marketCategory === option.id ? 'active' : ''} onClick={() => setMarketCategory(option.id)}>
            {option.label}{option.id === 'all' ? ` (${models.length})` : ''}
          </button>)}
        </div>
      </Panel>

      <div className="ws-inline" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <strong style={{ fontSize: 13, color: '#263b55' }}>模型清单</strong>
          <div className="ws-note">按当前筛选与排序展示 {sortedModels.length} 款模型，规格与费率均来自服务端目录。</div>
        </div>
        <Badge>平台目录</Badge>
      </div>

      {sortedModels.length === 0 ? <div className="ws-empty">没有符合筛选条件的模型</div> : <div className="ws-card-grid-3">
        {sortedModels.map((model) => <article className="ws-model" key={model.id}>
          <div className="ws-model-head">
            <span className="ws-model-icon">{model.name.slice(0, 1)}</span>
            <div><h3>{model.name}</h3><small>{model.provider} / {model.id}</small></div>
            <Badge tone={model.available ? 'green' : 'muted'}>{model.available ? '可用' : '停用'}</Badge>
          </div>
          <div className="ws-chip-row">{model.capabilities.vision && <Badge>视觉</Badge>}{model.capabilities.reasoning && <Badge>推理</Badge>}{model.capabilities.tools && <Badge>工具调用</Badge>}{model.capabilities.streaming && <Badge>流式</Badge>}</div>
          <div className="ws-mini-grid">
            <div><div className="ws-t-micro">上下文窗口</div><b>{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K` : '—'}</b></div>
            <div><div className="ws-t-micro">输入计费</div><b>{model.inputPricePerMillionTokensPoints != null ? `${formatPoints(model.inputPricePerMillionTokensPoints)}/M` : '待同步'}</b></div>
            <div><div className="ws-t-micro">输出计费</div><b>{model.outputPricePerMillionTokensPoints != null ? `${formatPoints(model.outputPricePerMillionTokensPoints)}/M` : '待同步'}</b></div>
          </div>
          <div className="ws-inline" style={{ justifyContent: 'space-between' }}>
            <span className="ws-muted">可用分组</span>
            <span className="ws-note">{model.availableGroups.length ? model.availableGroups.join('、') : '—'}</span>
          </div>
        </article>)}
      </div>}
    </>}

    {view === 'members' && <>
      <div className="ws-page-heading">
        <div><h1>成员管理</h1><p>{orgOverview?.organizationName ? `${orgOverview.organizationName} · ` : ''}企业额度 = 管理员持有 + 全部成员持有；分发是管理员与成员在算力上游账号之间的额度划转，企业总额不变。</p></div>
        <div className="ws-inline"><button className="ws-ghost" onClick={() => setOrgToken((token) => token + 1)}><RefreshCw size={14} /> 刷新</button></div>
      </div>

      {!canManageMembers
        ? <Panel title="需要企业管理员权限">
          <p className="ws-detail-copy">当前身份没有「查看企业算力数据」权限，或当前不是企业身份。请在身份选择里切换到企业身份；若仍不可见，请联系企业管理员分配权限。</p>
        </Panel>
        : <>
          <Panel title="企业邀请码" subtitle="把邀请码发给同事，对方在「创建/加入企业」中输入即可加入本企业；加入后会自动开通成员角色与算力账号。">
            <div className="ws-inline">
              <code style={{ fontSize: 18, letterSpacing: 2, fontWeight: 700 }}>{orgOverview?.inviteCode ?? '——'}</code>
              <button className="ws-text-button" onClick={() => void copyInviteCode()}><Copy size={13} /> 复制邀请码</button>
            </div>
          </Panel>

          <div className="ws-stats four">
            <Metric accent icon={<Wallet />} label="企业总额度" value={formatPoints(orgPool?.quotaTotal)} desc={`可用合计 ${formatPoints(orgPool?.available)} ｜ 已用 ${formatPoints(orgPool?.quotaUsed)}`} />
            <Metric icon={<Database />} label="管理员持有" value={formatPoints(orgPool?.adminHeld)} desc="管理员上游账号中尚未分发的余额" />
            <Metric icon={<Users />} label="成员持有 / 人数" value={formatPoints(orgPool?.memberHeld)} desc={`已分发到 ${orgMembers.filter((m) => m.role === 'member').length} 名成员`} />
            <Metric icon={<Activity />} label="成员已用" value={formatPoints(orgPool?.quotaUsed)} desc={`预扣中 ${formatPoints(orgPool?.quotaReserved)}`} />
          </div>

          <Panel title="成员额度" subtitle="分发：管理员余额扣减、成员余额增加；回收反之。双方各自对应独立的算力上游账号。"
            action={<span className="ws-muted">企业 {organizationId?.slice(0, 8)}…</span>}>
            {orgMembers.length === 0
              ? <div className="ws-empty">该企业暂无成员。普通用户可在「创建/加入企业」里用企业邀请码加入。</div>
              : <table className="ws-table"><thead><tr>
                <th>成员</th><th>角色</th><th>算力账号</th><th>总额度</th><th>已用</th><th>可用</th><th>操作</th>
              </tr></thead><tbody>
                {orgMembers.map((member) => {
                  const isSelf = member.identityId === summary?.identityId;
                  const ready = member.provisionStatus === 'ready' || member.provisionStatus === 'default_key_created';
                  return <tr key={member.identityId}>
                    <td>
                      <div>{member.userName || member.displayName}{isSelf && <> <Badge>本人</Badge></>}</div>
                      <div className="ws-note">{member.displayName}{member.userEmail ? ` · ${member.userEmail}` : ''}</div>
                    </td>
                    <td>{member.role === 'admin' ? <Badge tone="blue">管理员</Badge> : <Badge tone="green">成员</Badge>}</td>
                    <td>{ready
                      ? <Badge tone="green">已开通</Badge>
                      : <Badge tone="orange">{PROVISION_LABELS[member.provisionStatus ?? ''] ?? '初始化中'}</Badge>}</td>
                    <td>{formatPoints(member.quotaTotal)}</td>
                    <td>{formatPoints(member.quotaUsed)}</td>
                    <td>{formatPoints(member.available)}</td>
                    <td>
                      {member.role === 'admin' || isSelf
                        ? <span className="ws-muted">—</span>
                        : <div className="ws-inline" style={{ flexWrap: 'wrap' }}>
                          <button className="ws-ghost" disabled={!ready} onClick={() => openAllocation(member, 'allocate')}><Plus size={13} /> 分发额度</button>
                          <button className="ws-ghost" disabled={!ready || member.available <= 0} onClick={() => openAllocation(member, 'reclaim')}><Undo2 size={13} /> 回收</button>
                        </div>}
                    </td>
                  </tr>;
                })}
              </tbody></table>}
            <p className="ws-note" style={{ marginTop: 10 }}>
              可回收上限为成员当前可用额度（已消费部分不可回收）。管理员行与本人行不展示分发操作；服务端会二次校验权限、成员归属与上游账号状态。
            </p>
          </Panel>

          <Panel title="企业额度流水" subtitle="每笔分配/回收在管理员与成员账户各记一条流水：“账户”为流水归属，“对方”为交易对手方，金额带 +/− 表示流入/流出。">
            {orgLedger.length === 0
              ? <div className="ws-empty">暂无企业额度流水</div>
              : <table className="ws-table"><thead><tr>
                <th>时间</th><th>操作</th><th>账户</th><th>对方</th><th>变动</th><th>状态</th><th>上游同步</th><th>请求号</th>
              </tr></thead><tbody>
                {orgLedger.slice(0, 20).map((entry) => {
                  const meta = entry.metadata as { direction?: string } | null;
                  const direction = meta?.direction === 'out' ? 'out' : meta?.direction === 'in' ? 'in' : null;
                  return <tr key={entry.id}>
                  <td>{formatTime(entry.createdAt)}</td>
                  <td><Badge tone={entry.operation === 'reclaim' ? 'orange' : 'blue'}>{LEDGER_LABELS[entry.operation] ?? entry.operation}</Badge></td>
                  <td>{entry.identityName ?? '—'}</td>
                  <td>{entry.counterpartyName ?? '—'}</td>
                  <td>{direction === 'in'
                    ? <b style={{ color: '#1a7f37' }}>划入 +{formatPoints(entry.amount)}</b>
                    : direction === 'out'
                      ? <b style={{ color: '#b42318' }}>划出 −{formatPoints(entry.amount)}</b>
                      : (entry.operation === 'recharge' || entry.operation === 'grant')
                        ? <b style={{ color: '#1a7f37' }}>+{formatPoints(entry.amount)}</b>
                        : formatPoints(entry.amount)}</td>
                  <td>{entry.status === 'completed' ? '已完成' : entry.status}</td>
                  <td>{entry.sub2apiSynced ? '已同步' : <Badge tone="orange">待同步</Badge>}</td>
                  <td><code>{entry.requestId ? `${entry.requestId.slice(0, 8)}…` : '—'}</code></td>
                </tr>;
                })}
              </tbody></table>}
          </Panel>
        </>}
    </>}

    {allocTarget && <div className="ws-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAllocTarget(null); }}>
      <div className="ws-modal">
        <header><h2>{allocMode === 'allocate' ? '分配额度' : '回收额度'} · {allocTarget.displayName}</h2><button className="ws-icon-button" aria-label="关闭" onClick={() => setAllocTarget(null)}>×</button></header>
        <form onSubmit={(event) => void submitAllocation(event)}>
          <label>积分<input autoFocus required type="number" min="0.001" step="0.001" value={allocAmount} onChange={(event) => setAllocAmount(event.target.value)} placeholder="请输入积分" /></label>
          <p className="ws-detail-copy">
            成员当前可用 {formatPoints(allocTarget.available)} ｜ 总额度 {formatPoints(allocTarget.quotaTotal)} ｜ 已用 {formatPoints(allocTarget.quotaUsed)}
            {allocMode === 'reclaim' && <> ｜ 可回收上限 {formatPoints(allocTarget.available)}</>}
          </p>
          {allocMode === 'allocate'
            ? <p className="ws-detail-copy">额度从管理员账户（企业池未分发部分）划出；管理员当前持有 {formatPoints(orgPool?.adminHeld)}，不足会被服务端拒绝。</p>
            : <p className="ws-detail-copy">回收的额度退回管理员账户（企业池）。</p>}
          <footer><button type="button" onClick={() => setAllocTarget(null)}>取消</button><button className="ws-primary" disabled={allocSubmitting}>{allocSubmitting ? '提交中…' : allocMode === 'allocate' ? '确认分配' : '确认回收'}</button></footer>
        </form>
      </div>
    </div>}

    {showKeyForm && <div className="ws-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowKeyForm(false); }}>
      <div className="ws-modal">
        <header><h2>创建 API 密钥</h2><button className="ws-icon-button" aria-label="关闭" onClick={() => setShowKeyForm(false)}>×</button></header>
        <form onSubmit={(event) => void createKey(event)}>
          <label>名称<input required value={keyForm.name} onChange={(event) => setKeyForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="请输入密钥名称" /></label>
          <label>模型分组（选填）<input value={keyForm.groupId} onChange={(event) => setKeyForm((prev) => ({ ...prev, groupId: event.target.value }))} placeholder="留空使用默认分组" /></label>
          <label>限额积分（选填）<input type="number" min="0" step="0.001" value={keyForm.quota} onChange={(event) => setKeyForm((prev) => ({ ...prev, quota: event.target.value }))} /></label>
          <label>速率 RPM（选填）<input type="number" min="1" step="1" value={keyForm.rpm} onChange={(event) => setKeyForm((prev) => ({ ...prev, rpm: event.target.value }))} /></label>
          <label>有效期（选填）<input type="datetime-local" value={keyForm.expiresAt} onChange={(event) => setKeyForm((prev) => ({ ...prev, expiresAt: event.target.value }))} /></label>
          <p className="ws-detail-copy">完整密钥仅在创建成功后展示一次，服务端只保存前缀与指纹。</p>
          <footer><button type="button" onClick={() => setShowKeyForm(false)}>取消</button><button className="ws-primary" disabled={submitting}>{submitting ? '创建中…' : '创建'}</button></footer>
        </form>
      </div>
    </div>}

    {editKey && <div className="ws-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditKey(null); }}>
      <div className="ws-modal">
        <header><h2>编辑密钥 · {editKey.name}</h2><button className="ws-icon-button" aria-label="关闭" onClick={() => setEditKey(null)}>×</button></header>
        <form onSubmit={(event) => void submitEdit(event)}>
          <label>名称<input required value={editForm.name} onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))} /></label>
          <label>限额积分<input type="number" min="0" step="0.001" value={editForm.quota} onChange={(event) => setEditForm((prev) => ({ ...prev, quota: event.target.value }))} placeholder="留空表示不限额" /></label>
          <label>速率 RPM<input type="number" min="1" step="1" value={editForm.rpm} onChange={(event) => setEditForm((prev) => ({ ...prev, rpm: event.target.value }))} placeholder="留空表示不设上限" /></label>
          <label>有效期<input type="datetime-local" value={editForm.expiresAt} onChange={(event) => setEditForm((prev) => ({ ...prev, expiresAt: event.target.value }))} /></label>
          <p className="ws-detail-copy">留空即清除该限制；分组与完整密钥不可在此修改，{editKey.isDefault ? '默认 Key 不可删除。' : '如需更换密钥请删除后重建。'}</p>
          <footer><button type="button" onClick={() => setEditKey(null)}>取消</button><button className="ws-primary" disabled={submitting}>{submitting ? '保存中…' : '保存'}</button></footer>
        </form>
      </div>
    </div>}

    {createdSecret && <div className="ws-modal-backdrop">
      <div className="ws-modal ws-auth-modal">
        <header><h2>请立即保存密钥</h2></header>
        {createdSecret.secret ? <>
          <p className="ws-detail-copy">密钥 <b>{createdSecret.name}</b> 的完整内容只显示这一次，关闭后无法再次查看。</p>
          <div className="ws-inline"><code style={{ wordBreak: 'break-all' }}>{createdSecret.secret}</code><button className="ws-text-button" onClick={() => { void navigator.clipboard?.writeText(createdSecret.secret ?? ''); onNotify('已复制密钥'); }}><Copy size={13} /> 复制</button></div>
        </> : <p className="ws-detail-copy">密钥 <b>{createdSecret.name}</b> 已创建，但上游未返回完整密钥内容，请在 Sub2API 侧确认。</p>}
        <footer><button className="ws-primary" onClick={() => setCreatedSecret(null)}><Check size={14} /> 我已保存</button></footer>
      </div>
    </div>}
  </>;
}
