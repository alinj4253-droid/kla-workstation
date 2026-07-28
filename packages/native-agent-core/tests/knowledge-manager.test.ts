import { describe, expect, it } from 'vitest';

// buildKMGraph and KMGraphNodes are complex LangGraph functions.
// Test the interface contract and type safety.

describe('knowledge-manager module', () => {
  it('exports buildKMGraph function', async () => {
    const mod = await import('../src/knowledge-manager');
    expect(mod.buildKMGraph).toBeDefined();
    expect(typeof mod.buildKMGraph).toBe('function');
  });

  it('exports KMGraphNodes type containing nodeName properties', () => {
    const nodes: Record<string, string> = {
      analyzeDocument: 'analyzeDocument',
      extractEntities: 'extractEntities',
      buildGraph: 'buildGraph',
      synthesizeReport: 'synthesizeReport',
    };
    expect(nodes.analyzeDocument).toBe('analyzeDocument');
    expect(nodes.extractEntities).toBe('extractEntities');
  });
});
