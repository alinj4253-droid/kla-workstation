import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = resolve(import.meta.dirname, '..', 'src', 'renderer', 'src', 'styles.css');
const css = readFileSync(CSS_PATH, 'utf-8');

describe('Visual — design tokens', () => {
  it('CSS file exists', () => {
    expect(existsSync(CSS_PATH)).toBe(true);
  });

  const requiredTokens = [
    '--kq-bg', '--kq-surface', '--kq-text', '--kq-text-secondary',
    '--kq-primary', '--kq-primary-hover', '--kq-border',
    '--kq-success', '--kq-danger', '--kq-info',
    '--kq-header-height', '--kq-global-sidebar-width',
  ];

  for (const token of requiredTokens) {
    it(`defines ${token}`, () => {
      expect(css).toContain(token);
    });
  }
});

describe('Visual — minimum viewport', () => {
  it('has min-width 1280px', () => {
    expect(css).toContain('min-width: 1280px');
  });
});
