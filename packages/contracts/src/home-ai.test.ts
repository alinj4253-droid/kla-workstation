import { describe, expect, it } from 'vitest';
import { homeAiToolArguments, homeAiConfirmationSchema } from './home-ai.js';
const sessionId = '11111111-1111-4111-8111-111111111111';
describe('home AI boundary contracts', () => {
  it('rejects model-supplied state, confirmation and ownership', () => {
    for (const key of ['state','accepted','identityId','profileConfirmed']) {
      expect(homeAiToolArguments.home_ai_interview_update.safeParse({sessionId,expectedRevision:0,answerId:'role',answer:'审单', [key]:true}).success).toBe(false);
    }
    expect('home_ai_confirm' in homeAiToolArguments).toBe(false);
  });
  it('requires revision and validates actual percentages without filling missing inputs', () => {
    const input = {sessionId,stageId:'review',numbers:{coverage:101}};
    expect(homeAiToolArguments.home_ai_value_estimate.safeParse(input).success).toBe(false);
    expect(homeAiToolArguments.home_ai_value_estimate.parse({...input,expectedRevision:0,numbers:{}}).numbers).toEqual({});
    expect(homeAiToolArguments.home_ai_value_estimate.safeParse({...input,expectedRevision:0}).success).toBe(false);
  });
  it('requires the selected report scene for human confirmation', () => {
    expect(homeAiConfirmationSchema.safeParse({expectedRevision:0,kind:'report'}).success).toBe(false);
    expect(homeAiConfirmationSchema.parse({expectedRevision:0,kind:'profile'}).kind).toBe('profile');
  });
  it('accepts Chinese enum values and normalizes them like the waste/route tools', () => {
    // answerId：模型可能写「职责」「指标」
    const answer = homeAiToolArguments.home_ai_interview_update.parse({sessionId,expectedRevision:0,answerId:'职责',answer:'审单'});
    expect(answer.answerId).toBe('role');
    expect(homeAiToolArguments.home_ai_interview_update.parse({sessionId,expectedRevision:0,answerId:'指标',answer:'x'}).answerId).toBe('kpi');
    // stageId：「报价」「拆单」「售后」
    const stage = homeAiToolArguments.home_ai_conditions_update.parse({sessionId,expectedRevision:0,stageId:'报价',checks:{数据:'成立'}});
    expect(stage.stageId).toBe('quote');
    expect(stage.checks).toEqual({data:'yes'});
    // source：「实测」；非法中文仍拒绝
    expect(homeAiToolArguments.home_ai_value_estimate.parse({sessionId,expectedRevision:0,stageId:'拆单',numbers:{},source:'实测'}).source).toBe('measured');
    expect(homeAiToolArguments.home_ai_interview_update.safeParse({sessionId,expectedRevision:0,answerId:'饼图',answer:'x'}).success).toBe(false);
  });
});
