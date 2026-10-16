import { describe, expect, it } from 'vitest';
import { businessPlannerInputRequest, businessPlannerAssistantRole } from './business-planner-assistant.js';

describe('business planner original-input boundary', () => {
  it('requires a successful original-material receipt before a final answer', () => {
    expect(businessPlannerInputRequest([], true)?.text).toContain('原始经营材料');
    expect(businessPlannerInputRequest([{ tool_name: 'local_read', status: 'completed', result: { text: '旧示例' } }], true)?.text).toContain('已暂停');
    expect(businessPlannerInputRequest([{ tool_name: 'local_business_metrics', status: 'failed' }], true)).not.toBeNull();
    expect(businessPlannerInputRequest([{ tool_name: 'local_business_metrics', status: 'completed', result: { status: 'ready' } }], true)).toBeNull();
  });
  it('asks the real user for missing input even after an earlier successful read', () => {
    const request = businessPlannerInputRequest([
      { tool_name: 'local_business_metrics', status: 'completed', result: { status: 'ready' } },
      { tool_name: 'local_business_plan', status: 'completed', result: { needsInput: true, questions: ['请补充回顾期'], issues: [{ fileName: '计划.pdf', reason: '需要OCR' }] } },
    ]);
    expect(request?.questions).toEqual(['请补充回顾期']); expect(request?.text).toContain('计划.pdf：需要OCR');
    expect(request?.text).toContain('再次 @建潘-三一规划智能体');
  });
  it('does not change unrelated tools or default to historical knowledge-pack facts', () => {
    expect(businessPlannerInputRequest([{ tool_name: 'local_ppt_build', status: 'completed', result: { needsInput: true } }])).toBeNull();
    expect(businessPlannerAssistantRole).toContain('不是查询技能包中的历史示例企业');
    expect(businessPlannerAssistantRole).toContain('统一技能/工具网关');
  });
});
