import { describe, expect, it } from 'vitest';
import { validateModelForAgent, BUILTIN_AGENT_REQUIREMENTS } from '../src/capabilities';
import type { ModelCapability } from '../src/types';

describe('BUILTIN_AGENT_REQUIREMENTS', () => {
  it('contains orchestrator with streaming, toolCalling, structuredOutput', () => {
    const orch = BUILTIN_AGENT_REQUIREMENTS.find((r) => r.definitionId === 'builtin.orchestrator');
    expect(orch).toBeDefined();
    expect(orch!.requiredCapabilities).toContain('streaming');
    expect(orch!.requiredCapabilities).toContain('toolCalling');
    expect(orch!.requiredCapabilities).toContain('structuredOutput');
  });

  it('uses the local executor as the single specialist capability boundary', () => {
    const local = BUILTIN_AGENT_REQUIREMENTS.find((r) => r.definitionId === 'builtin.local-executor');
    expect(local).toBeDefined();
    expect(local!.requiredCapabilities).toEqual(expect.arrayContaining(['streaming', 'toolCalling', 'structuredOutput']));
    expect(BUILTIN_AGENT_REQUIREMENTS.some((r) => [
      'builtin.knowledge-manager', 'builtin.researcher', 'builtin.material-writer', 'builtin.acceptance-reviewer',
    ].includes(r.definitionId))).toBe(false);
  });
});

describe('validateModelForAgent', () => {
  it('returns allowed: true when all required capabilities are satisfied', () => {
    const capabilities: ModelCapability[] = ['streaming', 'toolCalling', 'structuredOutput'];
    const result = validateModelForAgent('builtin.orchestrator', capabilities);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns allowed: false when required capabilities are missing', () => {
    const capabilities: ModelCapability[] = ['streaming'];
    const result = validateModelForAgent('builtin.orchestrator', capabilities);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('toolCalling');
    expect(result.reason).toContain('structuredOutput');
  });

  it('returns allowed: true for unknown agent definition', () => {
    const capabilities: ModelCapability[] = ['streaming'];
    const result = validateModelForAgent('unknown.agent', capabilities);
    expect(result.allowed).toBe(true);
  });

  it('returns reason with all missing capabilities', () => {
    const capabilities: ModelCapability[] = [];
    const result = validateModelForAgent('builtin.orchestrator', capabilities);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('streaming');
    expect(result.reason).toContain('toolCalling');
    expect(result.reason).toContain('structuredOutput');
  });

  it('treats legacy specialist definitions as compatibility aliases', () => {
    const capabilities: ModelCapability[] = ['streaming'];
    const result = validateModelForAgent('builtin.knowledge-manager', capabilities);
    expect(result.allowed).toBe(true);
  });

  it('ignores extra capabilities beyond requirements', () => {
    const capabilities: ModelCapability[] = ['streaming', 'toolCalling', 'structuredOutput'];
    const result = validateModelForAgent('builtin.local-executor', capabilities);
    expect(result.allowed).toBe(true);
  });
});
