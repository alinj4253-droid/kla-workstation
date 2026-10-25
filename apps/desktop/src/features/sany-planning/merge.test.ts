import { describe, expect, it } from 'vitest';
import { buildMergeSummary, parseAmount, parseYearValue } from './merge';
import type { SanyFieldDto, SanyTaskDto } from '../../api/sany';

const field = (input: Partial<SanyFieldDto> & { id: string; scope: 'company' | 'unit'; moduleKey: SanyFieldDto['moduleKey']; k: string; n: string }): SanyFieldDto => ({
  taskId: null,
  type: 'num',
  ai: '',
  conf: 0,
  src: '',
  status: 'pending',
  removed: false,
  custom: false,
  ...input,
} as SanyFieldDto);

const task = (input: Partial<SanyTaskDto> & { id: string; unit: string }): SanyTaskDto => ({
  code: 'R-01', title: input.unit, owner: '负责人', type: 'T-BG', typeName: '成长型业务',
  deadline: '2026-11-15', assignedAt: '2026-10-08', status: '待上传', intent: '', requirements: [],
  docs: 0, prefill: 0, verified: 0, gaps: 0, submissions: 0, latestSubmission: null,
  ...input,
} as SanyTaskDto);

describe('parseAmount', () => {
  it('解析万元与亿元文本', () => {
    expect(parseAmount('186,000 万元')).toBe(186000);
    expect(parseAmount('净利润 28,600 万元，净利率 11.4%')).toBe(28600);
    expect(parseAmount('投入 8.6 亿元')).toBe(86000);
    expect(parseAmount('（缺少数据）')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe('parseYearValue', () => {
  it('按年份取目标行数值', () => {
    const text = '2027 年：216,000 万元\n2029 年：292,000 万元';
    expect(parseYearValue(text, '2029')).toBe(292000);
    expect(parseYearValue(text, '2031')).toBeNull();
  });
});

describe('buildMergeSummary', () => {
  const tasks = [
    task({ id: 't1', unit: '智能家居业务单元', status: '已收束', prefill: 2, verified: 2 }),
    task({ id: 't2', unit: '物联平台业务单元', status: '待上传' }),
  ];

  it('公司层未准备时给出告警信号且来源含公司层卡片', () => {
    const summary = buildMergeSummary({ fields: [], tasks, companyDocs: 0 });
    expect(summary.companyReady).toBe(false);
    expect(summary.sources[0].scope).toBe('company');
    expect(summary.sources).toHaveLength(3);
    expect(summary.unitClosed).toBe(1);
  });

  it('对照表从已确认字段计算加总与差异', () => {
    const fields: SanyFieldDto[] = [
      field({ id: 'f1', scope: 'company', moduleKey: 'review', k: 'gRev', n: '集团营收', ai: '250,000 万元', status: 'accepted' }),
      field({ id: 'f2', scope: 'company', moduleKey: 'plan', k: 'gGoal', n: '集团目标', ai: '2029 年：342,000 万元', status: 'accepted' }),
      field({ id: 'f3', scope: 'company', moduleKey: 'plan', k: 'gMoves', n: '集团举措', ai: 'GI-01 双引擎协同\nGI-02 平台统一\n（需集团确认）', status: 'edited' }),
      field({ id: 'f4', scope: 'unit', taskId: 't1', moduleKey: 'review', k: 'revenue', n: '单元营收', ai: '186,000 万元', status: 'accepted' }),
      field({ id: 'f5', scope: 'unit', taskId: 't2', moduleKey: 'review', k: 'revenue', n: '单元营收', ai: '64,000 万元', status: 'accepted' }),
      field({ id: 'f6', scope: 'unit', taskId: 't1', moduleKey: 'plan', k: 'goals', n: '单元目标', ai: '2029 年：292,000 万元', status: 'accepted' }),
      field({ id: 'f7', scope: 'unit', taskId: 't1', moduleKey: 'plan', k: 'moves', n: '单元举措', ai: 'I-01 渠道下沉\nI-02 服务化转型', status: 'accepted' }),
    ];
    const summary = buildMergeSummary({ fields, tasks, companyDocs: 6 });

    expect(summary.companyReady).toBe(true);
    expect(summary.companyVerified).toBe(3);
    const revenue = summary.compare.find(row => row.name.includes('营业收入基线'))!;
    expect(revenue.companyValue).toBe('250,000 万元');
    expect(revenue.unitSum).toBe('250,000 万元');
    expect(revenue.diffLabel).toBe('一致');

    const target = summary.compare.find(row => row.name.includes('营业收入目标'))!;
    expect(target.unitSum).toBe('292,000 万元');
    expect(target.diffLabel).toBe('低于预算框');

    const moves = summary.compare.find(row => row.name === '重大战略举措')!;
    expect(moves.companyValue).toBe('2 项');
    expect(moves.unitSum).toBe('2 项');

    const cagr = summary.compare.find(row => row.name === '三年复合增长率')!;
    expect(cagr.companyValue).not.toBe('—');
  });

  it('未确认字段不参与加总并提示缺口', () => {
    const fields: SanyFieldDto[] = [
      field({ id: 'f1', scope: 'company', moduleKey: 'review', k: 'gRev', n: '集团营收', ai: '250,000 万元', status: 'pending' }),
    ];
    const summary = buildMergeSummary({ fields, tasks, companyDocs: 2 });
    const revenue = summary.compare.find(row => row.name.includes('营业收入基线'))!;
    expect(revenue.companyValue).toBe('—');
    expect(revenue.diffLabel).toBe('口径待统一');
    expect(revenue.note).toContain('基线未确认');
  });
});
