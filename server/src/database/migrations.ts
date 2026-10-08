import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export type MigrationFile = { id: string; sql: string };

const MIGRATION_FILE_PATTERN = /^(\d{4,}_[a-z0-9_]+)\.sql$/i;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export async function loadMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const fileNames = entries.filter((name) => MIGRATION_FILE_PATTERN.test(name)).sort();
  if (fileNames.length === 0) {
    throw new Error(`未在 ${dir} 找到任何迁移文件（命名形如 0004_identity_organizations.sql）`);
  }
  const migrations: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const fileName of fileNames) {
    const id = fileName.replace(/\.sql$/i, '').toLowerCase();
    if (seen.has(id)) throw new Error(`迁移编号重复: ${id}`);
    seen.add(id);
    migrations.push({ id, sql: await readFile(join(dir, fileName), 'utf8') });
  }
  return migrations;
}

export async function runMigrations(pool: Pool, schema = 'kla'): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error('非法数据库 schema 名称');
  const migrations = await loadMigrationFiles();
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}" AUTHORIZATION CURRENT_USER`);
  const setupClient = await pool.connect();
  await setupClient.query(`SET search_path TO "${schema}", public`);
  await setupClient.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  setupClient.release();
  for (const migration of migrations) {
    const checkClient = await pool.connect();
    await checkClient.query(`SET search_path TO "${schema}", public`);
    const existing = await checkClient.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migration.id]);
    checkClient.release();
    if (existing.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}", public`);
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
