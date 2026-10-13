import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { freshInterview, valueEstimate, assessment, judge, candidates, reportMarkdown, invalidate } from './interview.js';
import { STAGES } from './catalog.js';
import { canConfirm } from './domain.js';

describe('home AI migration parity', () => {
  it.skipIf(!existsSync(resolve('../../testintent/ai-opportunity/interview.js')))('matches the original source for candidates, values, grades and reports', async () => {
    const old = await import(pathToFileURL(resolve('../../testintent/ai-opportunity/interview.js')).href);
    for (const variant of ['ready','missing','negative','noReview','measured']) {
      const state = freshInterview() as any;
      state.selected='review'; state.profileConfirmed=true;
      state.answers={role:'审单主管',idea:'订单与报价核对'};
      const a=assessment(state,'review');
      a.checks={data:'yes',rules:'yes',review:'yes',access:'yes',evidence:'yes'};
      a.numbers={volume:200,before:25,after:10,coverage:80,hourly:60,cash:50,cost:300,setup:1000};
      if(variant==='missing') delete a.numbers.volume;
      if(variant==='negative') a.numbers.after=30;
      if(variant==='noReview') a.checks.review='no';
      if(variant==='measured') {a.source='measured';a.target=30;state.documents=[{id:'d',name:'订单',chunks:[{text:'审单核对订单号和版本',location:'行1'}]}];}
      const stage=STAGES.find(s=>s.id==='review')!;
      expect(valueEstimate(a.numbers)).toEqual(old.valueEstimate(a.numbers));
      expect(candidates(structuredClone(state))).toEqual(old.candidates(structuredClone(state)));
      expect(judge(structuredClone(state),stage)).toEqual(old.judge(structuredClone(state),stage));
      expect(reportMarkdown(structuredClone(state))).toEqual(old.reportMarkdown(structuredClone(state)));
    }
  });
  it('requires user-confirmed profile and valid conditions, and changes clear prior acceptance', () => {
    const s=freshInterview() as any; s.selected='review';
    const a=assessment(s,'review');a.checks={data:'yes',rules:'yes',review:'yes',access:'yes'};
    a.numbers={volume:200,before:25,after:10,coverage:80};
    expect(canConfirm(s,'review')).toBe(false);s.profileConfirmed=true;
    expect(canConfirm(s,'review')).toBe(true);a.checks.review='no';expect(canConfirm(s,'review')).toBe(false);
    s.accepted=true;s.confirmedScenes={review:{}};invalidate(s);expect(s.accepted).toBe(false);expect(s.confirmedScenes).toEqual({});
  });
});
