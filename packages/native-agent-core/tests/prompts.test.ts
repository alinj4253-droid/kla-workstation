import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_SYSTEM_PROMPT, KM_SYSTEM_PROMPT } from '../src/prompts';

describe('ORCHESTRATOR_SYSTEM_PROMPT', () => {
  it('contains orchestrator identity', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('统筹');
  });

  it('keeps the orchestrator inside the task-manager tool boundary', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('工具边界');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('禁止自己编写最终代码');
  });

  it('uses structured delegation without a fixed local decomposition template', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('NEED_AGENTS');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('动态拆解');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('不预设步骤数量');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).not.toContain('1-4 个');
  });

  it('mentions knowledge manager delegation', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('知识管理智能体');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('知识和经验');
  });

  it('is a non-empty string', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });
});

describe('KM_SYSTEM_PROMPT', () => {
  it('contains knowledge manager identity', () => {
    expect(KM_SYSTEM_PROMPT).toContain('知识');
  });

  it('mentions knowledge graph', () => {
    expect(KM_SYSTEM_PROMPT).toContain('知识图谱');
  });

  it('owns post-task knowledge capture and business-process applicability decisions', () => {
    expect(KM_SYSTEM_PROMPT).toContain('知识文档');
    expect(KM_SYSTEM_PROMPT).toContain('业务流程');
    expect(KM_SYSTEM_PROMPT).toContain('不要硬凑流程');
    expect(KM_SYSTEM_PROMPT).toContain('不是执行日志');
  });

  it('is a non-empty string', () => {
    expect(KM_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });
});
