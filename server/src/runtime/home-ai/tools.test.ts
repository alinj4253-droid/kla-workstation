import { describe, expect, it } from 'vitest';
import { homeAiToolArguments, runtimeSkillBundles } from '@kla-workstation/contracts';
import { agentTools, parseToolArguments } from '../tools.js';
import type { RegisteredAgent } from '../registry.js';
import { homeAiWriteTools } from './service.js';
const agent={id:'11111111-1111-4111-8111-111111111111',name:'诊断',role:'',execution_location:'server',skills:Object.keys(homeAiToolArguments)} as RegisteredAgent;
describe('home AI model-facing tools',()=>{
  it('exposes only mounted functions and keeps manual fields aligned with Zod',()=>{
    const tools=agentTools(agent);
    expect(tools).toHaveLength(7);
    for(const tool of tools) {
      const schema=homeAiToolArguments[tool.function.name as keyof typeof homeAiToolArguments];
      expect(Object.keys(tool.function.parameters.properties).sort()).toEqual(Object.keys(schema.shape).sort());
      expect(tool.function.parameters.required.sort()).toEqual(Object.entries(schema.shape).filter(([,s])=>!s.isOptional()).map(([k])=>k).sort());
    }
    expect(agentTools({...agent,skills:[]})).toEqual([]);
    expect(runtimeSkillBundles.find(b=>b.code==='home_ai_diagnosis')?.tools).toEqual(Object.keys(homeAiToolArguments));
  });
  it('gives actionable errors and treats state mutation as write',()=>{
    expect(()=>parseToolArguments('home_ai_interview_update',{sessionId:agent.id,answerId:'role',answer:'审单'})).toThrow(/expectedRevision/);
    expect(()=>parseToolArguments('home_ai_value_estimate',{sessionId:agent.id,expectedRevision:0,stageId:'review',numbers:{coverage:101}})).toThrow(/numbers.coverage/);
    expect(homeAiWriteTools.has('home_ai_interview_update')).toBe(true);
    expect(homeAiWriteTools.has('home_ai_report_build')).toBe(false);
  });
});
