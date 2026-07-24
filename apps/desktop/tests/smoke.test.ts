import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';

const WEB_DIST = resolve(import.meta.dirname, '..', 'dist-web');

describe('Web build smoke test', () => {
  beforeAll(() => {
    if (!existsSync(WEB_DIST)) {
      throw new Error(`Web build not found at ${WEB_DIST}. Run 'pnpm build:web' first.`);
    }
  });

  it('produces index.html with correct title', () => {
    const html = readFileSync(resolve(WEB_DIST, 'index.html'), 'utf-8');
    expect(html).toContain('鲲擎');
    expect(html).toContain('id="root"');
  });

  it('produces JS bundle', () => {
    const files = readFileSync(resolve(WEB_DIST, 'index.html'), 'utf-8');
    const scriptMatch = files.match(/src="\/assets\/([^"]+\.js)"/);
    expect(scriptMatch).not.toBeNull();
    const jsPath = resolve(WEB_DIST, 'assets', scriptMatch![1]!);
    expect(existsSync(jsPath)).toBe(true);
  });

  it('produces CSS bundle', () => {
    const files = readFileSync(resolve(WEB_DIST, 'index.html'), 'utf-8');
    const cssMatch = files.match(/href="\/assets\/([^"]+\.css)"/);
    expect(cssMatch).not.toBeNull();
    const cssPath = resolve(WEB_DIST, 'assets', cssMatch![1]!);
    expect(existsSync(cssPath)).toBe(true);
  });
});

describe('Main process build smoke test', () => {
  it('produces main/index.js', () => {
    const mainJs = resolve(import.meta.dirname, '..', 'out', 'main', 'index.js');
    expect(existsSync(mainJs)).toBe(true);
  });

  it('produces preload/index.cjs', () => {
    const preloadJs = resolve(import.meta.dirname, '..', 'out', 'preload', 'index.cjs');
    expect(existsSync(preloadJs)).toBe(true);
  });
});
