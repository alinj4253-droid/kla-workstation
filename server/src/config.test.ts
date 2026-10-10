import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('Sub2API configuration', () => {
  it('requires an absolute upstream URL when configured', () => {
    expect(() => loadConfig({ SUB2API_BASE_URL: '/api' })).toThrow('SUB2API_BASE_URL');
    expect(loadConfig({ SUB2API_BASE_URL: 'http://sub2api.test:8099/' }).sub2api.baseUrl).toBe('http://sub2api.test:8099/');
  });
});
