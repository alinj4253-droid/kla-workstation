import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const YML_PATH = resolve(import.meta.dirname, '..', 'electron-builder.yml');

describe('Install — electron-builder config', () => {
  it('config file exists', () => {
    expect(existsSync(YML_PATH)).toBe(true);
  });

  const yml = readFileSync(YML_PATH, 'utf-8');

  it('targets nsis', () => {
    expect(yml).toMatch(/nsis/);
  });

  it('allows custom install directory', () => {
    expect(yml).toContain('allowToChangeInstallationDirectory: true');
  });

  it('has artifact name pattern', () => {
    expect(yml).toContain('artifactName');
    expect(yml).toContain('${productName}');
  });

  it('extraResources includes resources/', () => {
    expect(yml).toContain('from: resources');
  });
});
