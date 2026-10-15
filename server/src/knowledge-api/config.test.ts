import { describe, expect, it } from 'vitest';
import { normalizeServiceUrl } from './config.js';

describe('normalizeServiceUrl', () => {
  it('removes whitespace and trailing slashes so endpoint joins are stable', () => {
    expect(normalizeServiceUrl('  http://192.168.10.206:8120/// ')).toBe('http://192.168.10.206:8120');
  });

  it('does not alter a URL path that is part of the configured base', () => {
    expect(normalizeServiceUrl('https://kb.example.test/api/v1/')).toBe('https://kb.example.test/api/v1');
  });
});
