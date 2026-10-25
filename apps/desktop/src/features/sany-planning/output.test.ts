import { describe, expect, it } from 'vitest';
import { buildCompanyOutputPlan } from './output';
import type { SanyFieldDto, SanyIssueDto, SanyTaskDto } from '../../api/sany';

const field = (input: Partial<SanyFieldDto> & { id: string; scope: 'company' | 'unit'; moduleKey: SanyFieldDto['moduleKey'] }): SanyFieldDto => ({
  k: 'k', n: '字段', type: 'text', ai: '', conf: 0, src: '材料A · P1', status: 'accepted',
  removed: false, custom: false, taskId: null, ...input,
} as SanyFieldDto);

const task = (input: Partial<SanyTaskDto> & { id: string; unit: string }): SanyTaskDto => ({
  code: 'R-01', title: 't', owner: 'o', type: 'T-BG', typeName: '成长型业务',
  deadline: '2026-11-15', assignedAt: '2026-10-08', status: '待上传', intent: '', requirements: [],
  docs: 0, prefill: 1, verified: 1, gaps: 0, submissions: 0, latestSubmission: null,
  ...input,
} as SanyTaskDto);

const issue = (input: Partial<SanyIssueDto> & { id: string }): SanyIssueDto => ({
  code: 'ISS-01', level: '一般', title: '标题', detail: '', owner: '', status: '待裁定',
  ...input,
} as SanyIssueDto);

describe('buildCompanyOutputPlan', () => {
  it('前置条件不满足时标记草稿并列出缺口', () => {
    const plan = buildCompanyOutputPlan({
      fields: [
        field({ id: 'f1', scope: 'company', moduleKey: 'review', status: 'pending' }),
        field({ id: 'f2', scope: 'unit', taskId: 't1', moduleKey: 'review' }),
      ],
      tasks: [task({ id: 't1', unit: '智能家居业务单元', status: '待上传' })],
      issues: [issue({ id: 'i1', level: '阻断', title: '目标加总超预算框', status: '待裁定' })],
      projectName: '三一集团规划',
    });

    expect(plan.draftOnly).toBe(true);
    expect(plan.checks.find(check => check.key === 'companyVerified')!.satisfied).toBe(false);
    expect(plan.checks.find(check => check.key === 'unitsSubmitted')!.satisfied).toBe(false);
    expect(plan.checks.find(check => check.key === 'blockingResolved')!.satisfied).toBe(false);
    expect(plan.checks.find(check => check.key === 'targetAligned')!.satisfied).toBe(false);
    expect(plan.missingUnits).toEqual(['智能家居业务单元']);
    expect(plan.pages.some(page => page.title === '未决事项')).toBe(true);
  });

  it('全部满足时可出正式版', () => {
    const plan = buildCompanyOutputPlan({
      fields: [
        field({ id: 'f1', scope: 'company', moduleKey: 'review' }),
        field({ id: 'f2', scope: 'unit', taskId: 't1', moduleKey: 'review' }),
      ],
      tasks: [task({ id: 't1', unit: '智能家居业务单元', status: '已收束' })],
      issues: [],
      projectName: '三一集团规划',
    });

    expect(plan.checks.every(check => check.satisfied)).toBe(true);
    expect(plan.draftOnly).toBe(false);
    expect(plan.missingUnits).toHaveLength(0);
    const titles = plan.pages.map(page => page.title);
    expect(titles).toContain('集团经营回顾');
    expect(titles).toContain('智能家居业务单元规划');
    expect(titles).not.toContain('未决事项');
  });

  it('缺材料字段计入页面缺项，无来源已确认项阻断回溯条件', () => {
    const plan = buildCompanyOutputPlan({
      fields: [
        field({ id: 'f1', scope: 'company', moduleKey: 'review', status: 'missing', n: '协同测算', src: '' }),
        field({ id: 'f2', scope: 'company', moduleKey: 'plan', src: '' }),
        field({ id: 'f3', scope: 'unit', taskId: 't1', moduleKey: 'review' }),
      ],
      tasks: [task({ id: 't1', unit: '物联平台业务单元', status: '已收束' })],
      issues: [],
      projectName: 'X',
    });

    const companyPage = plan.pages.find(page => page.key === 'company-review')!;
    expect(companyPage.missing).toContain('协同测算');
    expect(plan.checks.find(check => check.key === 'traceable')!.satisfied).toBe(false);
    expect(plan.checks.find(check => check.key === 'traceable')!.pendingNote).toContain('1 项');
  });
});
