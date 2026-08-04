import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

import type { DetectInput, DetectedExecutable } from '../../external-agent-adapter';

export const CODEBUDDY_BINARY_NAMES = ['codebuddy', 'codebuddy-code', 'cbc'] as const;

export function buildCodeBuddySearchPaths(
  input: DetectInput,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const paths = [
    ...(input.searchPaths ?? []),
    ...(env.PATH ?? '').split(path.delimiter),
  ];

  if (process.platform === 'win32') {
    if (env.APPDATA) paths.push(path.join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) paths.push(path.join(env.LOCALAPPDATA, 'pnpm'));
    if (env.PNPM_HOME) paths.push(env.PNPM_HOME);
    if (env.NVM_SYMLINK) paths.push(env.NVM_SYMLINK);
    if (env.VOLTA_HOME) paths.push(path.join(env.VOLTA_HOME, 'bin'));
    if (env.ProgramW6432) paths.push(path.join(env.ProgramW6432, 'nodejs'));
    if (env.ProgramFiles) paths.push(path.join(env.ProgramFiles, 'nodejs'));
    if (env['ProgramFiles(x86)']) paths.push(path.join(env['ProgramFiles(x86)'], 'nodejs'));
  }

  const seen = new Set<string>();
  return paths
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => {
      if (!entry) return false;
      const key = process.platform === 'win32' ? entry.toLowerCase() : entry;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildDetectionEnv(pathDirs: string[]): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: pathDirs.join(path.delimiter),
  };
}

async function tryExec(
  binary: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<DetectedExecutable | null> {
  try {
    const result = await execFileAsync(binary, ['--version'], {
      env, shell: false, timeout: 3000, windowsHide: true, signal,
    });
    const version = result.stdout?.trim() || result.stderr?.trim() || null;
    return { executablePath: binary, source: 'path', versionHint: version };
  } catch {
    if (process.platform === 'win32') {
      try {
        const result = await execFileAsync(binary, ['--version'], {
          env, shell: true, timeout: 3000, windowsHide: true, signal,
        });
        const version = result.stdout?.trim() || result.stderr?.trim() || null;
        return { executablePath: binary, source: 'path', versionHint: version };
      } catch { /* ignore */ }
    }
    return null;
  }
}

export class CodeBuddyDetector {
  async detect(input: DetectInput, signal: AbortSignal): Promise<DetectedExecutable[]> {
    const pathDirs = buildCodeBuddySearchPaths(input);
    const env = buildDetectionEnv(pathDirs);

    for (const base of CODEBUDDY_BINARY_NAMES) {
      for (const dir of pathDirs) {
        const candidates = process.platform === 'win32'
          ? [`${base}.cmd`, `${base}.exe`, `${base}.bat`, base]
          : [base];
        for (const candidate of candidates) {
          const fullPath = path.join(dir, candidate);
          const detected = await tryExec(fullPath, signal, env);
          if (detected) return [detected];
        }
      }

      const result = await tryExec(base, signal, env);
      if (result) return [result];
    }
    return [];
  }
}
