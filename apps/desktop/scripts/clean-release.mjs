import { rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const releaseDir = 'D:\\temp\\kunqing-release';
const unpackedDir = resolve(releaseDir, 'win-unpacked');
const unpackedTmpDir = resolve(releaseDir, 'win-unpacked.tmp');

function forceRemove(dirPath) {
  if (!existsSync(dirPath)) return true;
  try {
    rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch {
    try {
      execSync(`rd /s /q "${dirPath.replace(/\//g, '\\')}"`, { timeout: 15000, shell: 'cmd.exe', stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}

// 删除 win-unpacked 和 win-unpacked.tmp
for (const dir of [unpackedTmpDir, unpackedDir]) {
  if (existsSync(dir)) {
    console.log(`Removing ${resolve(dir, '..').split('\\').pop()}\\${dir.split('\\').pop()}...`);
    if (!forceRemove(dir)) {
      console.error(`FATAL: Could not remove ${dir}. Close any app using this folder.`);
      process.exit(1);
    }
  }
}

// 删除整个 release 目录
if (existsSync(releaseDir)) {
  try {
    rmSync(releaseDir, { recursive: true, force: true });
    console.log('Cleaned release directory');
    process.exit(0);
  } catch (err) {
    console.warn(`rmSync failed: ${err.code || err.message}`);
  }

  try {
    execSync(`rd /s /q "${releaseDir.replace(/\//g, '\\')}"`, { timeout: 15000, shell: 'cmd.exe', stdio: 'inherit' });
    console.log('Cleaned release directory via cmd');
    process.exit(0);
  } catch (err) {
    console.error('FATAL: Could not clean release directory.');
    console.error('Close Trae CN or any app using this folder, then retry.');
    process.exit(1);
  }
} else {
  console.log('No release directory to clean');
  process.exit(0);
}
