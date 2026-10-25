import type { SanyFieldDto, SanyIssueDto, SanyTaskDto } from '../../api/sany';

export type ReleaseCheck = {
  key: string;
  label: string;
  satisfied: boolean;
  pendingNote: string;
};

export type ResultPage = {
  key: string;
  title: string;
  description: string;
  filled: number;
  missing: string[];
  scopeLabel: string;
};

export type CompanyOutputPlan = {
  checks: ReleaseCheck[];
  allSatisfied: boolean;
  pages: ResultPage[];
  draftOnly: boolean;
  missingUnits: string[];
  submittedUnits: number;
  blocking: number;
  fileBase: string;
};

const MODULE_NAMES: Record<string, string> = {
  review: '经营回顾',
  market: '市场洞察',
  biz: '业务澄清',
  plan: '三一规划',
};

const COMPANY_MODULE_TITLES: Record<string, string> = {
  review: '集团经营回顾',
  market: '行业趋势洞察',
  biz: '业务组合澄清',
  plan: '集团三一规划',
};

export function buildCompanyOutputPlan(input: {
  fields: SanyFieldDto[];
  tasks: SanyTaskDto[];
  issues: SanyIssueDto[];
  projectName: string;
}): CompanyOutputPlan {
  const { fields, tasks, issues } = input;
  const companyFields = fields.filter(field => field.scope === 'company' && !field.removed);
  const companyVerified = companyFields.filter(field => field.status === 'accepted' || field.status === 'edited');
  const unitFields = fields.filter(field => field.scope === 'unit' && !field.removed);
  const unitPending = unitFields.filter(field => field.status === 'pending').length;
  const blockingIssues = issues.filter(issue => issue.level === '阻断' && issue.status !== '已解决');
  const blocking = blockingIssues.length;

  const closedStatuses = ['已通过', '已收束'];
  const missingUnits = tasks.filter(task => !closedStatuses.includes(task.status)).map(task => task.unit);
  const submittedUnits = tasks.length - missingUnits.length;

  const noSource = (scope: 'company' | 'unit'): number => fields.filter(field =>
    field.scope === scope && !field.removed
    && (field.status === 'accepted' || field.status === 'edited')
    && !field.src && !field.human,
  ).length;

  const checks: ReleaseCheck[] = [
    {
      key: 'companyVerified',
      label: '公司层四模块已校验',
      satisfied: companyFields.length > 0 && companyVerified.length === companyFields.length,
      pendingNote: `已确认 ${companyVerified.length} / ${companyFields.length} 项`,
    },
    {
      key: 'unitsSubmitted',
      label: '全部责任单元已收束',
      satisfied: tasks.length > 0 && missingUnits.length === 0,
      pendingNote: missingUnits.length ? `未收束：${missingUnits.join('、')}` : `${submittedUnits} / ${tasks.length} 已收束`,
    },
    {
      key: 'unitsVerified',
      label: '单元内容经逐项校验',
      satisfied: unitPending === 0,
      pendingNote: unitPending ? `${unitPending} 项待确认` : '无待确认项',
    },
    {
      key: 'targetAligned',
      label: '集团目标与预算框已对齐',
      satisfied: !blockingIssues.some(issue => issue.title.includes('目标') || issue.title.includes('预算')),
      pendingNote: blockingIssues.some(issue => issue.title.includes('目标') || issue.title.includes('预算')) ? '存在阻断级目标冲突' : '无目标冲突',
    },
    {
      key: 'blockingResolved',
      label: '阻断级问题已裁定',
      satisfied: blocking === 0,
      pendingNote: blocking ? `${blocking} 项阻断未裁定` : '阻断为 0',
    },
    {
      key: 'traceable',
      label: '关键结论可回溯',
      satisfied: noSource('company') === 0 && noSource('unit') === 0,
      pendingNote: noSource('company') + noSource('unit') ? `${noSource('company') + noSource('unit')} 项已确认内容无来源` : '全部结论带来源',
    },
  ];

  const allSatisfied = checks.every(check => check.satisfied);

  const pages: ResultPage[] = [];
  for (const moduleKey of ['review', 'market', 'biz', 'plan'] as const) {
    const moduleFields = companyFields.filter(field => field.moduleKey === moduleKey);
    if (!moduleFields.length) continue;
    const verified = moduleFields.filter(field => field.status === 'accepted' || field.status === 'edited');
    const missing = moduleFields.filter(field => field.status === 'missing').map(field => field.n);
    pages.push({
      key: `company-${moduleKey}`,
      title: COMPANY_MODULE_TITLES[moduleKey],
      description: `集团口径 · ${MODULE_NAMES[moduleKey]}已确认内容`,
      filled: verified.length,
      missing,
      scopeLabel: '公司层',
    });
  }
  for (const task of tasks) {
    const taskFields = unitFields.filter(field => field.taskId === task.id);
    if (!taskFields.length) continue;
    const verified = taskFields.filter(field => field.status === 'accepted' || field.status === 'edited');
    const missing = taskFields.filter(field => field.status === 'missing').map(field => field.n);
    pages.push({
      key: `unit-${task.id}`,
      title: `${task.unit}规划`,
      description: closedStatuses.includes(task.status) ? `${task.typeName} · 已收束内容` : `${task.typeName} · ${task.status}，内容进草稿并标注`,
      filled: verified.length,
      missing,
      scopeLabel: task.unit,
    });
  }
  if (blocking) {
    pages.push({
      key: 'pending-decisions',
      title: '未决事项',
      description: '阻断级冲突以「未决」标注进入草稿，放行前需裁定',
      filled: 0,
      missing: blockingIssues.map(issue => issue.title),
      scopeLabel: '集团层面',
    });
  }

  return {
    checks,
    allSatisfied,
    pages,
    draftOnly: !allSatisfied,
    missingUnits,
    submittedUnits,
    blocking,
    fileBase: input.projectName,
  };
}
