import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type LocalOcrStatus = { available: boolean; runtime: 'paddleocr'; detail: string; packRoot?: string };

type PaddleOcrPackManifest = {
  schemaVersion: number;
  offline: true;
  runtime: { executable: string };
  entry: string;
  models: { detection: string; recognition: string; classification: string };
  requiredPaths?: string[];
};

type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

const PACK_RELATIVE_PATH = join('tools', 'paddleocr');
const packAliases = new Map<string, { drive: string; root: string }>();
let aliasCleanupRegistered = false;

function executionRoot(root: string): string {
  if (process.platform !== 'win32' || /^[\x00-\x7f]*$/.test(root)) return root;
  const cached = packAliases.get(root);
  if (cached && existsSync(cached.root)) return cached.root;

  const subst = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'subst.exe');
  for (let code = 'Z'.charCodeAt(0); code >= 'R'.charCodeAt(0); code -= 1) {
    const drive = `${String.fromCharCode(code)}:`;
    const aliasRoot = `${drive}\\`;
    const result = spawnSync(subst, [drive, root], { windowsHide: true, shell: false, encoding: 'utf8' });
    if (result.status !== 0 || !existsSync(aliasRoot)) continue;
    packAliases.set(root, { drive, root: aliasRoot });
    if (!aliasCleanupRegistered) {
      aliasCleanupRegistered = true;
      process.once('exit', () => {
        for (const alias of packAliases.values()) {
          spawnSync(subst, [alias.drive, '/D'], { windowsHide: true, shell: false });
        }
      });
    }
    return aliasRoot;
  }
  throw new Error('无法为 PaddleOCR 离线资源创建兼容路径');
}

function releaseExecutionRoot(path: string): void {
  for (const [sourceRoot, alias] of packAliases) {
    if (alias.root.toLowerCase() !== path.toLowerCase() && !path.toLowerCase().startsWith(alias.root.toLowerCase())) continue;
    const subst = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'subst.exe');
    spawnSync(subst, [alias.drive, '/D'], { windowsHide: true, shell: false });
    packAliases.delete(sourceRoot);
    break;
  }
}

function defaultPackRoots(): string[] {
  const resourceRoot = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  return [...new Set([
    process.env.KUNQING_PADDLEOCR_ROOT ?? '',
    resourceRoot ? join(resourceRoot, 'resources', PACK_RELATIVE_PATH) : '',
    resourceRoot ? join(resourceRoot, PACK_RELATIVE_PATH) : '',
    join(process.cwd(), 'resources', PACK_RELATIVE_PATH),
    join(process.cwd(), 'apps', 'desktop', 'resources', PACK_RELATIVE_PATH),
  ].filter(Boolean).map((path) => resolve(path)))];
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, cwd: options.cwd, env: options.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      releaseExecutionRoot(command);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      releaseExecutionRoot(command);
      resolvePromise({ stdout, stderr, code });
    });
  });
}

function inside(root: string, value: string): string {
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, value);
  const relativePath = relative(normalizedRoot, target);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('PaddleOCR 离线包路径非法');
  }
  return target;
}

function parseOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as { text?: unknown; lines?: unknown };
    if (typeof parsed.text === 'string') return parsed.text.trim();
    if (Array.isArray(parsed.lines)) return parsed.lines.filter((line): line is string => typeof line === 'string').join('\n').trim();
  } catch { /* allow a plain-text runner */ }
  return trimmed;
}

export class LocalOcrService {
  constructor(
    private packRoots = defaultPackRoots(),
    private commandRunner: CommandRunner = runProcess,
  ) {}

  private resolvePack(): { root: string; sourceRoot: string; manifest: PaddleOcrPackManifest } | null {
    for (const root of this.packRoots) {
      const manifestPath = join(root, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PaddleOcrPackManifest;
        if (manifest.schemaVersion !== 1 || manifest.offline !== true) continue;
        const required = manifest.requiredPaths ?? [manifest.runtime.executable, manifest.entry, ...Object.values(manifest.models)];
        if (required.every((path) => existsSync(inside(root, path)))) {
          return { root: executionRoot(root), sourceRoot: root, manifest };
        }
      } catch { /* try the next bundled root */ }
    }
    return null;
  }

  async status(): Promise<LocalOcrStatus> {
    const pack = this.resolvePack();
    if (!pack) return { available: false, runtime: 'paddleocr', detail: '技能内 PaddleOCR 离线运行时或模型不完整' };
    const executable = inside(pack.root, pack.manifest.runtime.executable);
    const entry = inside(pack.root, pack.manifest.entry);
    try {
      const result = await this.commandRunner(executable, [entry, '--self-check'], 30_000, {
        cwd: pack.root,
        env: this.offlineEnv(),
      });
      return result.code === 0
        ? { available: true, runtime: 'paddleocr', detail: '官方 PaddleOCR 离线模型已就绪', packRoot: pack.sourceRoot }
        : { available: false, runtime: 'paddleocr', detail: result.stderr.trim() || '官方 PaddleOCR 自检失败', packRoot: pack.sourceRoot };
    } catch (error) {
      return { available: false, runtime: 'paddleocr', detail: error instanceof Error ? error.message : '官方 PaddleOCR 自检失败', packRoot: pack.sourceRoot };
    }
  }

  async extract(filePath: string): Promise<string> {
    const pack = this.resolvePack();
    if (!pack) throw new Error('技能内 PaddleOCR 离线运行时或模型不完整');
    const manifest = pack.manifest;
    const executable = inside(pack.root, manifest.runtime.executable);
    const args = [
      inside(pack.root, manifest.entry),
      '--image', isAbsolute(filePath) ? filePath : resolve(filePath),
      '--det-model-dir', inside(pack.root, manifest.models.detection),
      '--rec-model-dir', inside(pack.root, manifest.models.recognition),
      '--cls-model-dir', inside(pack.root, manifest.models.classification),
    ];
    const result = await this.commandRunner(executable, args, 10 * 60_000, { cwd: pack.root, env: this.offlineEnv() });
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'PaddleOCR 识别失败');
    return parseOutput(result.stdout);
  }

  private offlineEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
      PADDLEOCR_HOME: '',
      PYTHONNOUSERSITE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      NO_PROXY: '*',
    };
  }
}
