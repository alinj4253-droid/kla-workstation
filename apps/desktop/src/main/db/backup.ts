import Database from 'better-sqlite3';
import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { closeDatabase } from './connection';
import { runMigrations } from './migrate';

async function removeIfExists(fp: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try { await unlink(fp); return; } catch (e: unknown) {
      if (i < 4 && (e as NodeJS.ErrnoException)?.code === 'EBUSY') {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      return;
    }
  }
}

export interface BackupMeta {
  filename: string;
  size: number;
  createdAt: string;
}

export function backupDatabase(dbPath: string, backupDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `k_studio_${timestamp}.db`);
  const db = new Database(dbPath);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return backupPath;
}

export async function restoreDatabase(dbPath: string, backupPath: string): Promise<void> {
  closeDatabase();
  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }
  await Promise.all(['-wal', '-shm'].map((ext) => removeIfExists(dbPath + ext)));
  await copyFile(backupPath, dbPath);
  runMigrations(dbPath);
  closeDatabase();
}

export async function listBackups(backupDir: string): Promise<BackupMeta[]> {
  try {
    await mkdir(backupDir, { recursive: true });
  } catch { /* ignore */ }
  let entries: string[];
  try {
    entries = await readdir(backupDir);
  } catch {
    return [];
  }
  const dbFiles = entries.filter((f) => f.startsWith('k_studio_') && f.endsWith('.db'));
  const result: BackupMeta[] = [];
  for (const f of dbFiles) {
    const fp = join(backupDir, f);
    try {
      const s = await stat(fp);
      result.push({ filename: f, size: s.size, createdAt: s.birthtime.toISOString() });
    } catch { /* ignore */ }
  }
  result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return result;
}

export async function deleteBackup(backupDir: string, filename: string): Promise<void> {
  const fp = join(backupDir, basename(filename));
  if (existsSync(fp)) {
    await unlink(fp);
  }
}
