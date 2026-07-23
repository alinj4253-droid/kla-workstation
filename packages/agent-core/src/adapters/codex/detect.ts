import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DetectInput, DetectedExecutable } from '../../external-agent-adapter';

const execFileAsync = promisify(execFile);

export class CodexDetector {
  async detect(input: DetectInput, _signal: AbortSignal): Promise<DetectedExecutable[]> {
    const searchPaths = input.searchPaths ?? [];
    const candidates = [...searchPaths, ...(process.env.PATH ?? '').split(';').filter(Boolean)];

    for (const dir of candidates) {
      try {
        const base = 'codex';
        const result = await execFileAsync(base, ['--version'], { shell: false, timeout: 5000 });
        const version = result.stdout?.trim() || result.stderr?.trim() || null;
        return [{ executablePath: base, source: 'path', versionHint: version }];
      } catch {
        continue;
      }
    }
    return [];
  }
}
