import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrationFiles } from './migrations.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kla-migrations-'));
  tempDirs.push(dir);
  return dir;
}

// Windows 文件系统大小写不敏感，无法构造仅大小写不同的文件名对。
const itOnCaseSensitiveFs = it.skipIf(process.platform === 'win32');

describe('loadMigrationFiles', () => {
  it('按文件名排序加载 .sql 迁移并忽略无关文件', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, '0005_collaboration_runtime.sql'), 'SELECT 5;');
    await writeFile(join(dir, '0004_identity_organizations.sql'), 'SELECT 4;');
    await writeFile(join(dir, 'README.md'), 'notes');

    const migrations = await loadMigrationFiles(dir);

    expect(migrations.map((migration) => migration.id)).toEqual(['0004_identity_organizations', '0005_collaboration_runtime']);
    expect(migrations[1]?.sql).toBe('SELECT 5;');
  });

  it('拒绝空目录', async () => {
    const emptyDir = await createTempDir();
    await expect(loadMigrationFiles(emptyDir)).rejects.toThrow('找到任何迁移文件');
  });

  it('按完整文件名区分同编号不同业务迁移', async () => {
    const duplicateDir = await createTempDir();
    await writeFile(join(duplicateDir, '0036_binary_ppt_artifacts.sql'), 'SELECT 1;');
    await writeFile(join(duplicateDir, '0036_compute_points_and_tools.sql'), 'SELECT 2;');
    const migrations = await loadMigrationFiles(duplicateDir);
    expect(migrations.map(migration => migration.id)).toEqual(['0036_binary_ppt_artifacts', '0036_compute_points_and_tools']);
  });

  itOnCaseSensitiveFs('在大小写敏感文件系统上保留不同完整文件名', async () => {
    const duplicateDir = await createTempDir();
    await writeFile(join(duplicateDir, '0007_add_files.sql'), 'SELECT 1;');
    await writeFile(join(duplicateDir, '0007_ADD_FILES.sql'), 'SELECT 2;');
    const migrations = await loadMigrationFiles(duplicateDir);
    expect(migrations).toHaveLength(2);
  });

  it('解析仓库真实迁移目录（守护相对路径定位）', async () => {
    const migrations = await loadMigrationFiles();
    expect(migrations.length).toBeGreaterThanOrEqual(3);
    expect(migrations[0]?.id).toBe('0004_identity_organizations');
    expect(migrations.every((migration) => migration.sql.trim().length > 0)).toBe(true);
  });
});
