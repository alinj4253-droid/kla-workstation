import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultPackRoot = resolve(
  scriptDir,
  '../resources/tools/paddleocr',
);
const packRoot = resolve(process.env.KUNQING_PADDLEOCR_ROOT || defaultPackRoot);

async function hasFile(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && await hasFile(child)) return true;
  }
  return false;
}

const manifest = JSON.parse(await readFile(join(packRoot, 'manifest.json'), 'utf8'));
const required = manifest.requiredPaths ?? [
  manifest.runtime?.executable,
  manifest.entry,
  ...Object.values(manifest.models ?? {}),
];
const missing = [];
for (const relativePath of required.filter(Boolean)) {
  const absolutePath = resolve(packRoot, relativePath);
  if (absolutePath !== packRoot && !absolutePath.startsWith(`${packRoot}\\`) && !absolutePath.startsWith(`${packRoot}/`)) {
    throw new Error(`PaddleOCR manifest path escapes the pack: ${relativePath}`);
  }
  try {
    await access(absolutePath);
    if (!relativePath.includes('.') && !await hasFile(absolutePath)) missing.push(`${relativePath} (empty)`);
  } catch {
    missing.push(relativePath);
  }
}

if (missing.length > 0) {
  throw new Error(`PaddleOCR offline pack is incomplete:\n- ${missing.join('\n- ')}\nRun pnpm paddleocr:prepare on the Windows build machine.`);
}

console.log('PaddleOCR offline runtime and models are complete.');
