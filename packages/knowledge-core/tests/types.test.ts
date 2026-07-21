import { describe, expect, it } from 'vitest';
import { hashContent, slugify, isTextFile } from '../src/types';

describe('hashContent', () => {
  it('returns a consistent hash for the same input', () => {
    const h1 = hashContent('hello world');
    const h2 = hashContent('hello world');
    expect(h1).toBe(h2);
  });

  it('returns different hashes for different inputs', () => {
    const h1 = hashContent('hello');
    const h2 = hashContent('world');
    expect(h1).not.toBe(h2);
  });

  it('returns an 8-character hex string', () => {
    const h = hashContent('any text');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles empty string', () => {
    const h = hashContent('');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles unicode characters', () => {
    const h = hashContent('知识图谱');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('slugify', () => {
  it('converts to lowercase and replaces spaces with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('replaces special characters', () => {
    expect(slugify('What is AI?')).toBe('what-is-ai');
  });

  it('handles Chinese characters', () => {
    expect(slugify('知识图谱')).toBe('知识图谱');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('  hello  ')).toBe('hello');
  });

  it('limits to 80 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });
});

describe('isTextFile', () => {
  it('returns true for common text extensions', () => {
    expect(isTextFile('txt')).toBe(true);
    expect(isTextFile('md')).toBe(true);
    expect(isTextFile('json')).toBe(true);
    expect(isTextFile('csv')).toBe(true);
    expect(isTextFile('xml')).toBe(true);
    expect(isTextFile('js')).toBe(true);
    expect(isTextFile('ts')).toBe(true);
    expect(isTextFile('html')).toBe(true);
  });

  it('returns false for binary extensions', () => {
    expect(isTextFile('pdf')).toBe(false);
    expect(isTextFile('docx')).toBe(false);
    expect(isTextFile('xlsx')).toBe(false);
    expect(isTextFile('png')).toBe(false);
    expect(isTextFile('jpg')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isTextFile('TXT')).toBe(true);
    expect(isTextFile('MD')).toBe(true);
  });
});