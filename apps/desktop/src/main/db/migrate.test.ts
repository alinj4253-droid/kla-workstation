import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './migrate';
import { closeDatabase } from './connection';

describe('DB migration — clean install', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'migrate-clean-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('runs all 16 migrations on empty database', () => {
    runMigrations(dbPath);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT name FROM _migrations ORDER BY id').all() as Array<{ id: number; name: string }>;
    expect(rows.length).toBe(16);
    expect(rows[0]!.name).toBe('001_initial');
    expect(rows[15]!.name).toBe('018_local_knowledge_index');
    db.close();
  });

  it('creates all expected tables after migration', () => {
    runMigrations(dbPath);
    const db = new Database(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('messages');
    expect(tableNames).toContain('agent_profiles');
    expect(tableNames).toContain('model_providers');
    expect(tableNames).toContain('files');
    expect(tableNames).toContain('memory_records');
    expect(tableNames).toContain('memory_tombstones');
    expect(tableNames).toContain('skill_packages');
    expect(tableNames).toContain('agent_definition_skills');
    expect(tableNames).toContain('agent_run_skills');
    expect(tableNames).toContain('workflow_packages');
    expect(tableNames).toContain('knowledge_nodes');
    expect(tableNames).toContain('knowledge_document_profiles');
    expect(tableNames).toContain('knowledge_chunk_embeddings');
    expect(tableNames).toContain('channels');
    expect(tableNames).toContain('wiki_pages');
    db.close();
  });

  it('is idempotent — running twice produces same result', () => {
    runMigrations(dbPath);
    runMigrations(dbPath);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT name FROM _migrations ORDER BY id').all() as Array<{ name: string }>;
    expect(rows.length).toBe(16);
    db.close();
  });

  it('creates FTS virtual tables', () => {
    runMigrations(dbPath);
    const db = new Database(dbPath);
    const ftsTables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'",
    ).all() as Array<{ name: string }>;
    expect(ftsTables.map((t) => t.name)).toContain('project_fts');
    expect(ftsTables.map((t) => t.name)).toContain('message_fts');
    db.close();
  });
});

describe('DB migration — schema upgrade', () => {
  let tmpDir: string;
  let dbPath: string;

  function bootstrapDb(): void {
    // Run full migration, then manipulate _migrations to simulate older state
    runMigrations(dbPath);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'migrate-upgrade-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('re-applies only missing 009_skills on upgrade', () => {
    // Bootstrap full schema, delete migration 009 to simulate "stuck before 009"
    bootstrapDb();
    const db = new Database(dbPath);
    db.prepare("DELETE FROM _migrations WHERE name = '009_create_skills_tables'").run();
    db.close();

    // Re-run migration — 009 should be re-applied (uses IF NOT EXISTS, safe to re-run)
    runMigrations(dbPath);

    const checkDb = new Database(dbPath);
    const rows = checkDb.prepare('SELECT name FROM _migrations ORDER BY id').all() as Array<{ name: string }>;
    expect(rows.length).toBe(16);
    const names = rows.map((r) => r.name);
    expect(names.filter((n) => n === '009_create_skills_tables').length).toBe(1);
    checkDb.close();
  });

  it('preserves existing data after full migration cycle', () => {
    bootstrapDb();

    // Insert data
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO projects (id, name, created_at, updated_at, last_active_at) VALUES (?, ?, ?, ?, ?)',
    ).run('test-proj-1', '测试项目', now, now, now);
    db.prepare(
      'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
    ).run('theme', JSON.stringify({ value: 'dark' }), now);
    db.close();

    // Re-run migration
    runMigrations(dbPath);

    const checkDb = new Database(dbPath);
    const project = checkDb.prepare('SELECT id, name FROM projects WHERE id = ?').get('test-proj-1') as {
      id: string;
      name: string;
    };
    expect(project.name).toBe('测试项目');

    const setting = checkDb.prepare('SELECT value_json as v FROM settings WHERE key = ?').get('theme') as { v: string };
    expect(JSON.parse(setting.v).value).toBe('dark');
    checkDb.close();
  });
});
