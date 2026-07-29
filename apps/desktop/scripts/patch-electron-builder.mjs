import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve app-builder-lib from electron-builder's dependencies by version
let targetPath;
try {
  const ebPkg = require('electron-builder/package.json');
  const ebVersion = ebPkg.version;
  const { readdirSync } = require('node:fs');
  const pnpmDir = resolve(__dirname, '..', '..', '..', 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    const entries = readdirSync(pnpmDir).filter(e => e.startsWith(`app-builder-lib@${ebVersion}_`));
    if (entries.length > 0) {
      targetPath = resolve(pnpmDir, entries[0], 'node_modules', 'app-builder-lib', 'out', 'util', 'electronGet.js');
    }
  }
  if (!targetPath || !existsSync(targetPath)) {
    targetPath = resolve(dirname(require.resolve('app-builder-lib/package.json')), 'out', 'util', 'electronGet.js');
  }
} catch {
  const { readdirSync } = require('node:fs');
  const pnpmDir = resolve(__dirname, '..', '..', '..', 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) {
    console.error('Cannot find node_modules/.pnpm directory');
    process.exit(1);
  }
  const entries = readdirSync(pnpmDir).filter(e => e.startsWith('app-builder-lib@'));
  if (entries.length === 0) {
    console.error('Cannot find app-builder-lib in pnpm store');
    process.exit(1);
  }
  targetPath = resolve(pnpmDir, entries[0], 'node_modules', 'app-builder-lib', 'out', 'util', 'electronGet.js');
}

if (!existsSync(targetPath)) {
  console.error(`electronGet.js not found at: ${targetPath}`);
  process.exit(1);
}

const content = await readFile(targetPath, 'utf8');

const oldCode = `        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(tmpDir, dir);
    }
    finally {
        await release().catch(err => builder_util_1.log.warn({ err }, "failed to release lockfile"));
    }`;

const newCode = `        await fs.rm(dir, { recursive: true, force: true });
        // Patch: release lock before rename (Windows cannot rename a dir with open handles inside)
        await release();
        await fs.rename(tmpDir, dir);
    }
    finally {
        // Lock already released in try block; finalizer is only for error path.
    }`;

let patched = content;

// Fix 1: extractArchive - release lock before rename
if (patched.includes('// Patch: release lock before rename')) {
  console.log('extractArchive: already patched');
} else if (!patched.includes(oldCode)) {
  console.error('extractArchive: patch target not found, may have changed');
  process.exit(1);
} else {
  patched = patched.replace(oldCode, newCode);
  console.log('extractArchive: patched');
}

// Also fix resolveCacheMode: @electron/get@3.x doesn't export ElectronDownloadCacheMode
// Replace usage with hardcoded values: ReadWrite=0, ReadOnly=1, WriteOnly=2, Bypass=3
const oldResolve = `    return get_1.ElectronDownloadCacheMode.ReadWrite;
}`;

const newResolve = `    return 0; // ReadWrite
}`;

if (patched.includes(oldResolve)) {
  patched = patched.replace(oldResolve, newResolve);
  console.log('Also patched resolveCacheMode to hardcode ReadWrite');
}

// Fix all usages of ElectronDownloadCacheMode (not exported in @electron/get@3.x)
const replaceOld = (o, n) => { if (patched.includes(o)) { patched = patched.replace(o, n); return true; } return false; };

// 1. env-var check
replaceOld(
  `    if (cacheOverride && Number(cacheOverride) in get_1.ElectronDownloadCacheMode) {`,
  `    if (cacheOverride && Number(cacheOverride) >= 0 && Number(cacheOverride) <= 3) {`
);

// 2. default return value
replaceOld(
  `    return get_1.ElectronDownloadCacheMode.ReadWrite;`,
  `    return 0; /* ReadWrite */`
);

// 3. WriteOnly retry
replaceOld(
  `cacheMode: get_1.ElectronDownloadCacheMode.WriteOnly`,
  `cacheMode: 2 /* WriteOnly */`
);

await writeFile(targetPath, patched, 'utf8');
console.log(`Patched: ${targetPath}`);
