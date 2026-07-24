import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import type { DetectInput, DetectedExecutable } from '../../external-agent-adapter';

export class QwenCodeDetector {
  async detect(input: DetectInput, _signal: AbortSignal): Promise<DetectedExecutable[]> {
    const searchPaths = input.searchPaths ?? [];
    const candidates = [...searchPaths, ...(process.env.PATH ?? '').split(';').filter(Boolean)];
    const binaries = ['qwen-code', 'qwen'];

    for (const base of binaries) {
      for (const dir of candidates) {
        try {
          const result = await execFileAsync(base, ['--version'], { shell: false, timeout: 5000 });
          const version = result.stdout?.trim() || result.stderr?.trim() || null;
          return [{ executablePath: base, source: 'path', versionHint: version }];
        } catch {
          continue;
        }
      }
    }
    return [];
  }
}
