import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

import type { DetectInput, DetectedExecutable } from '../../external-agent-adapter';

async function tryExec(
  binary: string,
  signal: AbortSignal,
): Promise<DetectedExecutable | null> {
  try {
    const result = await execFileAsync(binary, ['--version'], { shell: false, timeout: 2000, windowsHide: true });
    const version = result.stdout?.trim() || result.stderr?.trim() || null;
    return { executablePath: binary, source: 'path', versionHint: version };
  } catch {
    if (process.platform === 'win32') {
      try {
        const result = await execFileAsync(binary, ['--version'], { shell: true, timeout: 2000, windowsHide: true });
        const version = result.stdout?.trim() || result.stderr?.trim() || null;
        return { executablePath: binary, source: 'path', versionHint: version };
      } catch { /* ignore */ }
    }
    return null;
  }
}

export class GeminiDetector {
  async detect(input: DetectInput, signal: AbortSignal): Promise<DetectedExecutable[]> {
    const searchPaths = input.searchPaths ?? [];
    const pathDirs = [...searchPaths, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)];
    const binaries = ['gemini'];

    for (const base of binaries) {
      const result = await tryExec(base, signal);
      if (result) return [result];
      for (const dir of pathDirs) {
        const fullPath = path.join(dir, base);
        const result = await tryExec(fullPath, signal);
        if (result) return [result];
      }
    }
    return [];
  }
}
