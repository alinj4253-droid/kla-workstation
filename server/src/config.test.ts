import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('Sub2API configuration', () => {
  it('requires an absolute upstream URL when configured', () => {
    expect(() => loadConfig({ SUB2API_BASE_URL: '/api' })).toThrow('SUB2API_BASE_URL');
    expect(loadConfig({ SUB2API_BASE_URL: 'http://sub2api.test:8099/' }).sub2api.baseUrl).toBe('http://sub2api.test:8099/');
  });
  it('configures model calls separately from administrative requests', () => {
    const configured = loadConfig({ SUB2API_TIMEOUT_MS: '15000', SUB2API_MODEL_TIMEOUT_MS: '90000', SUB2API_TOOL_MODEL_TIMEOUT_MS: '420000', AGENT_STEP_MAX_TURNS: '80' });
    expect(configured.sub2api.timeoutMs).toBe(15000);
    expect(configured.compute.modelTimeoutMs).toBe(90000);
    expect(configured.compute.toolModelTimeoutMs).toBe(420000);
    expect(configured.agentStepMaxTurns).toBe(80);
    expect(loadConfig({ SUB2API_TOOL_MODEL_TIMEOUT_MS: 'Infinity' }).compute.toolModelTimeoutMs).toBe(300000);
  });
});
