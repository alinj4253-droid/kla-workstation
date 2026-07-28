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

  it('contains knowledge-manager with streaming and structuredOutput', () => {
    const km = BUILTIN_AGENT_REQUIREMENTS.find((r) => r.definitionId === 'builtin.knowledge-manager');
    expect(km).toBeDefined();
    expect(km!.requiredCapabilities).toContain('streaming');
    expect(km!.requiredCapabilities).toContain('structuredOutput');
  });

  it('contains researcher with streaming and structuredOutput', () => {
    const res = BUILTIN_AGENT_REQUIREMENTS.find((r) => r.definitionId === 'builtin.researcher');
    expect(res).toBeDefined();
    expect(res!.requiredCapabilities).toContain('streaming');
    expect(res!.requiredCapabilities).toContain('structuredOutput');
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

  it('returns allowed: true for knowledge-manager with streaming only', () => {
    const capabilities: ModelCapability[] = ['streaming'];
    const result = validateModelForAgent('builtin.knowledge-manager', capabilities);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('structuredOutput');
  });

  it('returns allowed: true with all capabilities for knowledge-manager', () => {
    const capabilities: ModelCapability[] = ['streaming', 'structuredOutput'];
    const result = validateModelForAgent('builtin.knowledge-manager', capabilities);
    expect(result.allowed).toBe(true);
  });

  it('ignores extra capabilities beyond requirements', () => {
    const capabilities: ModelCapability[] = ['streaming', 'toolCalling', 'structuredOutput'];
    const result = validateModelForAgent('builtin.knowledge-manager', capabilities);
    expect(result.allowed).toBe(true);
  });
});
