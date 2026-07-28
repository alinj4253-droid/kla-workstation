import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { backupDatabase, restoreDatabase, listBackups, deleteBackup } from './backup';
import { closeDatabase } from './connection';
import { runMigrations } from './migrate';

describe('DB backup/restore', () => {
  let tmpDir: string;
  let dbPath: string;
  let backupDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'backup-test-'));
    dbPath = join(tmpDir, 'k_studio.db');
    backupDir = join(tmpDir, 'backups');
    await mkdir(backupDir, { recursive: true });

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE test_data (id TEXT PRIMARY KEY, value TEXT);
      INSERT INTO test_data (id, value) VALUES ('a', 'hello');
      INSERT INTO test_data (id, value) VALUES ('b', 'world');
    `);
    db.close();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a backup file via VACUUM INTO', () => {
    const backupPath = backupDatabase(dbPath, backupDir);
    expect(existsSync(backupPath)).toBe(true);
    const backupDb = new Database(backupPath);
    const rows = backupDb.prepare('SELECT id, value FROM test_data ORDER BY id').all() as Array<{ id: string; value: string }>;
    expect(rows).toEqual([{ id: 'a', value: 'hello' }, { id: 'b', value: 'world' }]);
    backupDb.close();
  });

  it('backup file is valid SQLite database', () => {
    const backupPath = backupDatabase(dbPath, backupDir);
    const backupDb = new Database(backupPath);
    const tables = backupDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.some((t) => t.name === 'test_data')).toBe(true);
    backupDb.close();
  });

  it('listBackups returns backup entries sorted by newest first', async () => {
    const b1 = backupDatabase(dbPath, backupDir);
    await new Promise((r) => setTimeout(r, 10));
    const b2 = backupDatabase(dbPath, backupDir);

    const entries = await listBackups(backupDir);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]!.filename).toBe(entries[0]!.filename);
    expect(entries[0]!.createdAt >= entries[1]!.createdAt).toBe(true);
  });

  it('listBackups handles empty backup dir', async () => {
    const emptyDir = join(tmpDir, 'empty-backups');
    const entries = await listBackups(emptyDir);
    expect(entries).toEqual([]);
  });

  it('restoreDatabase copies backup and re-runs migrations', async () => {
    const backupPath = backupDatabase(dbPath, backupDir);

    {
      const liveDb = new Database(dbPath);
      liveDb.exec("INSERT INTO test_data (id, value) VALUES ('c', 'extra')");
      liveDb.close();
    }

    await restoreDatabase(dbPath, backupPath);

    const restoredDb = new Database(dbPath);
    const rows = restoredDb.prepare('SELECT id, value FROM test_data ORDER BY id').all() as Array<{ id: string; value: string }>;
    expect(rows).toEqual([{ id: 'a', value: 'hello' }, { id: 'b', value: 'world' }]);
    restoredDb.close();
  });

  it('restoreDatabase throws for missing backup file', async () => {
    await expect(restoreDatabase(dbPath, join(tmpDir, 'nonexistent.db'))).rejects.toThrow('Backup file not found');
  });

  it('deleteBackup removes the specified file', async () => {
    const backupPath = backupDatabase(dbPath, backupDir);
    expect(existsSync(backupPath)).toBe(true);

    const filename = backupPath.split('\\').pop()!.split('/').pop()!;
    await deleteBackup(backupDir, filename);
    expect(existsSync(backupPath)).toBe(false);
  });

  it('backup includes migration metadata when migrations exist', () => {
    const migDbPath = join(tmpDir, 'migrated.db');
    runMigrations(migDbPath);

    const backupPath = backupDatabase(migDbPath, backupDir);
    const backupDb = new Database(backupPath);
    const mRows = backupDb.prepare('SELECT name FROM _migrations ORDER BY id').all() as Array<{ name: string }>;
    expect(mRows.length).toBe(10);
    expect(mRows[0]!.name).toBe('001_initial');
    backupDb.close();
    closeDatabase();
  });
});
