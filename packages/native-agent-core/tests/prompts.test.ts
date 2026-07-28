import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_SYSTEM_PROMPT, KM_SYSTEM_PROMPT } from '../src/prompts';

describe('ORCHESTRATOR_SYSTEM_PROMPT', () => {
  it('contains orchestrator identity', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('统筹');
  });

  it('describes tool usage format', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('工具调用');
  });

  it('mentions knowledge manager delegation', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('知识管理员');
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

  it('is a non-empty string', () => {
    expect(KM_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });
});
