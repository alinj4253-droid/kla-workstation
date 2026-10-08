import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export type MigrationFile = { id: string; sql: string };

// 相对定位迁移目录：src/database/migrations.ts（tsx dev）与 dist/database/migrations.js（编译产物）
// 深度一致，从模块文件向上三级即为 server/migrations。
const defaultMigrationsDir = join(fileURLToPath(import.meta.url), '..', '..', '..', 'migrations');

/** 按文件名升序加载 .sql 迁移；拒绝空目录与重复编号。 */
export async function loadMigrationFiles(dir: string = defaultMigrationsDir): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`迁移目录中未找到任何迁移文件：${dir}`);
  const numbers = files.map((name) => name.slice(0, name.indexOf('_')));
  const duplicated = numbers.find((number, index) => numbers.indexOf(number) !== index);
  if (duplicated) throw new Error(`迁移编号重复：${duplicated}`);
  return Promise.all(files.map(async (name) => ({ id: name.replace(/\.sql$/, ''), sql: await readFile(join(dir, name), 'utf8') })));
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
