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

  it('keeps discussion and brainstorming outside the file workflow by default', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('头脑风暴默认交付观点与结论');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('不得自行附加文件生成');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('独立验收也不是固定环节');
  });

  it('delegates a complete business package to the unified local executor', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('本地执行智能体');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('自身挂载技能');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('完整工作包');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('不要把这些内部技能拆成多个统筹阶段');
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

  it('owns ingestion but explicitly rejects retrieval, templates and writing', () => {
    expect(KM_SYSTEM_PROMPT).toContain('知识文档');
    expect(KM_SYSTEM_PROMPT).toContain('业务流程');
    expect(KM_SYSTEM_PROMPT).toContain('不得执行知识检索');
    expect(KM_SYSTEM_PROMPT).toContain('模板读取');
    expect(KM_SYSTEM_PROMPT).toContain('材料编写智能体负责检索、读取和输出');
  });

  it('is a non-empty string', () => {
    expect(KM_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });
});
