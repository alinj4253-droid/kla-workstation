import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

import type { DetectInput, DetectedExecutable } from '../external-agent-adapter';

export function buildSearchPaths(
  input: DetectInput,
  knownDirs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = os.homedir();
  const paths = [
    ...(input.searchPaths ?? []),
    ...(env.PATH ?? '').split(path.delimiter),
    ...knownDirs,
  ];

  if (process.platform === 'win32') {
    if (env.APPDATA) paths.push(path.join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) paths.push(path.join(env.LOCALAPPDATA, 'pnpm'));
    if (env.PNPM_HOME) paths.push(env.PNPM_HOME);
    if (env.NVM_SYMLINK) paths.push(env.NVM_SYMLINK);
  } else {
    paths.push(path.join(home, '.local', 'bin'));
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

export function buildDetectionEnv(pathDirs: string[]): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: pathDirs.join(path.delimiter),
  };
}

export function buildExecutableCandidates(base: string): string[] {
  if (process.platform !== 'win32') return [base];
  return [`${base}.cmd`, `${base}.exe`, `${base}.bat`, base];
}

export async function tryExec(
  binary: string,
  args: string[],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  timeout = 3000,
): Promise<DetectedExecutable | null> {
  try {
    const result = await execFileAsync(binary, args, {
      env, shell: false, timeout, windowsHide: true, signal,
    });
    const version = result.stdout?.trim() || result.stderr?.trim() || null;
    return { executablePath: binary, source: 'path', versionHint: version };
  } catch {
    if (process.platform === 'win32') {
      if (path.isAbsolute(binary) && !existsSync(binary)) {
        return null;
      }
      try {
        const result = await execFileAsync(binary, args, {
          env, shell: true, timeout, windowsHide: true, signal,
        });
        const version = result.stdout?.trim() || result.stderr?.trim() || null;
        return { executablePath: binary, source: 'path', versionHint: version };
      } catch { /* ignore */ }
    }
    return null;
  }
}

export async function detectExecutables(
  input: DetectInput,
  signal: AbortSignal,
  binaries: string[],
  knownDirs: string[] = [],
  args: string[] = ['--version'],
  env: NodeJS.ProcessEnv = process.env,
): Promise<DetectedExecutable[]> {
  const pathDirs = buildSearchPaths(input, knownDirs, env);
  const detectionEnv = buildDetectionEnv(pathDirs);

  for (const base of binaries) {
    for (const dir of pathDirs) {
      for (const candidate of buildExecutableCandidates(base)) {
        const detected = await tryExec(path.join(dir, candidate), args, signal, detectionEnv);
        if (detected) return [detected];
      }
    }

    const detected = await tryExec(base, args, signal, detectionEnv);
    if (detected) return [detected];
  }
  return [];
}
