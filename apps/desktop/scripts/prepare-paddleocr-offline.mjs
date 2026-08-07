import { access, cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultPackRoot = resolve(
  scriptDir,
  '../resources/tools/paddleocr',
);
const packRoot = resolve(process.env.KUNQING_PADDLEOCR_ROOT || defaultPackRoot);
const buildRoot = resolve(process.env.KUNQING_PADDLEOCR_BUILD_ROOT || join(process.env.TEMP || process.cwd(), 'kunqing-paddleocr-build'));
const sourcePythonArg = process.env.PYTHON || process.argv.find((arg) => arg.startsWith('--python='))?.slice(9) || '';
if (!sourcePythonArg) throw new Error('Set PYTHON to an existing 64-bit Windows Python executable.');
const sourcePython = resolve(sourcePythonArg);
await access(sourcePython);

const buildRuntimeRoot = join(buildRoot, 'python');
const runtimeRoot = join(packRoot, 'runtime', 'win32-x64', 'python');
const embeddedPython = join(buildRuntimeRoot, 'python.exe');
await mkdir(buildRuntimeRoot, { recursive: true });
await cp(dirname(sourcePython), buildRuntimeRoot, {
  recursive: true,
  force: true,
  filter: (source) => !/[\\/](?:__pycache__|\.pytest_cache|\.mypy_cache)(?:[\\/]|$)/i.test(source),
});

function run(command, args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: packRoot, env, shell: false, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} exited with code ${code}`)));
  });
}

await run(embeddedPython, [
  '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-cache-dir', '--upgrade',
  '-r', join(packRoot, 'requirements.lock'),
]);

const modelEnv = {
  ...process.env,
  PADDLE_PDX_CACHE_HOME: join(buildRoot, '.model-cache'),
  PADDLEX_HOME: join(buildRoot, '.model-cache'),
  PADDLE_PDX_MODEL_SOURCE: 'BOS',
  PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
};
await run(embeddedPython, [join(packRoot, 'setup', 'download_models.py'), '--pack-root', packRoot], modelEnv);
await mkdir(runtimeRoot, { recursive: true });
await cp(buildRuntimeRoot, runtimeRoot, {
  recursive: true,
  force: true,
  filter: (source) => !/[\\/](?:__pycache__|\.pytest_cache|\.mypy_cache)(?:[\\/]|$)/i.test(source),
});
const finalPython = join(runtimeRoot, 'python.exe');
await run(finalPython, [join(packRoot, 'runner', 'run_ocr.py'), '--self-check'], {
  ...modelEnv,
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  PYTHONNOUSERSITE: '1',
});
await run(process.execPath, [join(scriptDir, 'verify-paddleocr-offline.mjs')]);
