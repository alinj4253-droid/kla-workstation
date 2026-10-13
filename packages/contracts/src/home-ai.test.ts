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
});
