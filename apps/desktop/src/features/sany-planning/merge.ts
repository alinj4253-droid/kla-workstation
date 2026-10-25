import type { SanyFieldDto, SanyTaskDto } from '../../api/sany';

export type MergeSourceRow = {
  key: string;
  scope: 'company' | 'unit';
  name: string;
  typeLabel: string;
  owner: string;
  status: string;
  docs: number;
  prefill: number;
  verified: number;
  gaps: number;
  mergedCount: number;
  note: string;
};

export type CompareDimension = {
  name: string;
  companyValue: string;
  unitSum: string;
  diffLabel: string;
  diffTone: '' | 'g' | 'w' | 'r';
  note: string;
};

export type MergeSummary = {
  companyTotal: number;
  companyVerified: number;
  companyDocs: number;
  companyMissing: number;
  companyReady: boolean;
  unitClosed: number;
  unitTotal: number;
  coverage: number;
  mergedTotal: number;
  sources: MergeSourceRow[];
  compare: CompareDimension[];
};

const amountPattern = /([0-9][0-9,，]*(?:\.[0-9]+)?)\s*万?亿?元?/;
const yiPattern = /([0-9][0-9,，]*(?:\.[0-9]+)?)\s*亿/;

export function parseAmount(text: string | undefined | null): number | null {
  if (!text) return null;
  const yi = yiPattern.exec(text);
  if (yi) return Number(yi[1].replaceAll(/[，,]/g, '')) * 10000;
  const plain = amountPattern.exec(text);
  if (!plain) return null;
  const value = Number(plain[1].replaceAll(/[，,]/g, ''));
  return Number.isFinite(value) ? value : null;
}

export function parseYearValue(text: string | undefined | null, year: string): number | null {
  if (!text) return null;
  const line = text.split(/\n+/).find(item => item.includes(year));
  if (!line) return null;
  return parseAmount(line.replace(new RegExp(`${year}\\s*年?`, 'g'), ''));
}

function countLines(text: string | undefined | null): number {
  if (!text) return 0;
  return text.split(/\n+/).filter(line => line.trim() && !line.trim().startsWith('（')).length;
}

function fieldValue(field: SanyFieldDto | undefined): string | null {
  if (!field) return null;
  if (field.status !== 'accepted' && field.status !== 'edited') return null;
  return field.human ?? field.ai ?? null;
}

function companyField(fields: SanyFieldDto[], moduleKey: string, fieldKey: string): SanyFieldDto | undefined {
  return fields.find(field => field.scope === 'company' && field.moduleKey === moduleKey && field.k === fieldKey && !field.removed);
}

function unitField(fields: SanyFieldDto[], taskId: string, moduleKey: string, fieldKey: string): SanyFieldDto | undefined {
  return fields.find(field => field.scope === 'unit' && field.taskId === taskId && field.moduleKey === moduleKey && field.k === fieldKey && !field.removed);
}

function sumUnitAmount(fields: SanyFieldDto[], tasks: SanyTaskDto[], moduleKey: string, fieldKey: string, year?: string): { total: number | null; parts: number } {
  let total: number | null = null;
  let parts = 0;
  for (const task of tasks) {
    const value = year
      ? parseYearValue(fieldValue(unitField(fields, task.id, moduleKey, fieldKey)), year)
      : parseAmount(fieldValue(unitField(fields, task.id, moduleKey, fieldKey)));
    if (value !== null) {
      total = (total ?? 0) + value;
      parts += 1;
    }
  }
  return { total, parts };
}

function formatAmount(value: number | null): string {
  if (value === null) return '—';
  return `${value.toLocaleString('zh-CN')} 万元`;
}

function formatRate(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function buildMergeSummary(input: {
  fields: SanyFieldDto[];
  tasks: SanyTaskDto[];
  companyDocs: number;
}): MergeSummary {
  const { fields, tasks } = input;
  const companyFields = fields.filter(field => field.scope === 'company' && !field.removed);
  const companyVerifiedFields = companyFields.filter(field => field.status === 'accepted' || field.status === 'edited');
  const companyMissing = companyFields.filter(field => field.status === 'missing').length;
  const companyDocs = input.companyDocs;
  const companyReady = companyDocs > 0;

  const mergedCountOf = (taskId: string | null): number => fields.filter(field =>
    field.scope === (taskId ? 'unit' : 'company')
    && (taskId ? field.taskId === taskId : true)
    && !field.removed
    && (field.status === 'accepted' || field.status === 'edited'),
  ).length;

  const closedStatuses = ['已通过', '已收束'];
  const unitClosed = tasks.filter(task => closedStatuses.includes(task.status)).length;

  const sources: MergeSourceRow[] = [
    {
      key: 'company',
      scope: 'company',
      name: '集团战略管理部（你自己）',
      typeLabel: '公司层',
      owner: '管理员',
      status: companyReady ? (companyVerifiedFields.length === companyFields.length && companyFields.length > 0 ? '可合并' : '校验中') : '未开始',
      docs: companyDocs,
      prefill: companyFields.length,
      verified: companyVerifiedFields.length,
      gaps: companyMissing,
      mergedCount: mergedCountOf(null),
      note: '集团经营回顾 · 行业趋势洞察 · 业务组合澄清 · 集团三一规划',
    },
    ...tasks.map(task => ({
      key: task.id,
      scope: 'unit' as const,
      name: task.unit,
      typeLabel: `${task.type} ${task.typeName}`,
      owner: task.owner,
      status: task.status,
      docs: task.docs,
      prefill: task.prefill,
      verified: task.verified,
      gaps: task.gaps,
      mergedCount: mergedCountOf(task.id),
      note: task.submissions > 0 ? `成果提交 ${task.submissions} 次` : '尚未提交成果',
    })),
  ];

  const companyRevenue = parseAmount(fieldValue(companyField(fields, 'review', 'gRev')));
  const unitRevenue = sumUnitAmount(fields, tasks, 'review', 'revenue');
  const companyTarget = parseYearValue(fieldValue(companyField(fields, 'plan', 'gGoal')), '2029');
  const unitTarget = sumUnitAmount(fields, tasks, 'plan', 'goals', '2029');
  const companyMoves = countLines(fieldValue(companyField(fields, 'plan', 'gMoves')));
  const unitMoves = tasks.reduce((sum, task) => sum + countLines(fieldValue(unitField(fields, task.id, 'plan', 'moves'))), 0);
  const companyMetrics = countLines(fieldValue(companyField(fields, 'plan', 'gKPI')));
  const unitMetrics = tasks.reduce((sum, task) => sum + countLines(fieldValue(unitField(fields, task.id, 'plan', 'metrics'))), 0);

  const cagr = (base: number | null, target: number | null): number | null => {
    if (base === null || target === null || base <= 0 || target <= 0) return null;
    return Math.pow(target / base, 1 / 3) - 1;
  };
  const companyCagr = cagr(companyRevenue, companyTarget);
  const unitCagr = cagr(unitRevenue.total, unitTarget.total);

  const compare: CompareDimension[] = [
    {
      name: '2026 年营业收入基线',
      companyValue: formatAmount(companyRevenue),
      unitSum: formatAmount(unitRevenue.total),
      diffLabel: companyRevenue !== null && unitRevenue.total !== null
        ? (companyRevenue === unitRevenue.total ? '一致' : `差 ${Math.abs(companyRevenue - unitRevenue.total).toLocaleString('zh-CN')} 万元`)
        : '口径待统一',
      diffTone: companyRevenue !== null && unitRevenue.total !== null && companyRevenue !== unitRevenue.total ? 'w' : companyRevenue !== null && unitRevenue.total !== null ? 'g' : '',
      note: unitRevenue.parts < tasks.length ? `${tasks.length - unitRevenue.parts} 个单元基线未确认，暂无法对齐` : '口径以已确认字段为准',
    },
    {
      name: '2029 年营业收入目标',
      companyValue: formatAmount(companyTarget),
      unitSum: formatAmount(unitTarget.total),
      diffLabel: companyTarget !== null && unitTarget.total !== null
        ? (unitTarget.total > companyTarget ? `超 ${(unitTarget.total - companyTarget).toLocaleString('zh-CN')} 万元` : unitTarget.total === companyTarget ? '一致' : '低于预算框')
        : '待裁定',
      diffTone: companyTarget !== null && unitTarget.total !== null && unitTarget.total > companyTarget ? 'r' : '',
      note: companyTarget !== null && unitTarget.total !== null && unitTarget.total > companyTarget ? '单元加总超集团预算框，需集团裁定' : '目标以已确认字段为准',
    },
    {
      name: '三年复合增长率',
      companyValue: formatRate(companyCagr),
      unitSum: formatRate(unitCagr),
      diffLabel: companyCagr !== null && unitCagr !== null
        ? (Math.abs(companyCagr - unitCagr) < 0.005 ? '一致' : `差 ${(Math.abs(companyCagr - unitCagr) * 100).toFixed(1)}pt`)
        : '由目标差异推导',
      diffTone: companyCagr !== null && unitCagr !== null && Math.abs(companyCagr - unitCagr) >= 0.005 ? 'w' : '',
      note: '由基线与 2029 目标推导',
    },
    {
      name: '重大战略举措',
      companyValue: `${companyMoves} 项`,
      unitSum: `${unitMoves} 项`,
      diffLabel: companyMoves === unitMoves ? '一致' : '需归并',
      diffTone: companyMoves === unitMoves ? 'g' : '',
      note: '单元举措需向上归到集团举措，避免重复与碎片',
    },
    {
      name: '指标数量',
      companyValue: `${companyMetrics} 项`,
      unitSum: `${unitMetrics} 项`,
      diffLabel: companyMetrics === unitMetrics ? '一致' : '需去重',
      diffTone: companyMetrics === unitMetrics ? 'g' : '',
      note: '按集团口径收敛为统一指标集',
    },
  ];

  return {
    companyTotal: companyFields.length,
    companyVerified: companyVerifiedFields.length,
    companyDocs,
    companyMissing,
    companyReady,
    unitClosed,
    unitTotal: tasks.length,
    coverage: Math.round((companyVerifiedFields.length + tasks.reduce((sum, task) => sum + task.verified, 0))
      / Math.max(1, companyFields.length + tasks.reduce((sum, task) => sum + task.prefill, 0)) * 100),
    mergedTotal: companyVerifiedFields.length + tasks.reduce((sum, task) => sum + task.verified, 0),
    sources,
    compare,
  };
}
