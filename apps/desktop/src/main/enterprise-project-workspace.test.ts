// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => process.cwd()), getAppPath: vi.fn(() => process.cwd()) },
}));

import Database from 'better-sqlite3';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureEnterpriseProjectWorkspaces,
  resolveAssociatedEnterpriseProjectId,
} from './enterprise-project-workspace';
import { setStudioRoot } from './paths';

describe('enterprise project workspaces', () => {
  let db: Database.Database;
  let studioRoot: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE enterprise_projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', token_used INTEGER NOT NULL DEFAULT 0,
        completed_nodes INTEGER NOT NULL DEFAULT 0, total_nodes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_resource_links (
        project_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, permission TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(resource_type, resource_id)
      );
    `);
    studioRoot = await mkdtemp(join(tmpdir(), 'kla-project-workspace-'));
    setStudioRoot(studioRoot);
  });

  afterEach(async () => {
    db.close();
    setStudioRoot('');
    await rm(studioRoot, { recursive: true, force: true });
  });

  it('creates the complete project workspace and migrates linked legacy group data non-destructively', async () => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO enterprise_projects VALUES (?, ?, ?, 0, 0, 0, ?, ?)')
      .run('enterprise-1', '专项项目', '', now, now);
    db.prepare("INSERT INTO project_resource_links VALUES (?, 'group', ?, 'read-write', 'active', ?, ?)")
      .run('enterprise-1', 'group-1', now, now);

    const legacyRoot = join(studioRoot, 'group-chats', 'group-1-workspace', 'project-shared');
    await mkdir(join(legacyRoot, 'knowledge', 'wiki'), { recursive: true });
    await writeFile(join(legacyRoot, 'knowledge', 'wiki', 'legacy.md'), 'legacy knowledge', 'utf8');

    await ensureEnterpriseProjectWorkspaces(db);

    const projectRoot = join(studioRoot, 'projects', 'enterprise-1');
    for (const relativePath of [
      'original-files/uploads',
      'original-files/groups',
      'original-files/meetings',
      'original-files/operations',
      'knowledge/graph',
      'knowledge/wiki',
      'knowledge/review',
      'graph-visualization',
      'outputs',
      'experience',
      '.runtime/trash',
      '.runtime/versions',
    ]) {
      await expect(access(join(projectRoot, relativePath))).resolves.toBeUndefined();
    }
    expect(await readFile(join(projectRoot, 'knowledge', 'wiki', 'legacy.md'), 'utf8')).toBe('legacy knowledge');
  });

  it('grants project scope only through an active resource association', () => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO enterprise_projects VALUES (?, ?, ?, 0, 0, 0, ?, ?)')
      .run('enterprise-1', '专项项目', '', now, now);
    db.prepare("INSERT INTO project_resource_links VALUES (?, 'meeting', ?, 'read-write', 'active', ?, ?)")
      .run('enterprise-1', 'meeting-1', now, now);
    db.prepare("INSERT INTO project_resource_links VALUES (?, 'operation', ?, 'read-write', 'revoked', ?, ?)")
      .run('enterprise-1', 'operation-1', now, now);

    expect(resolveAssociatedEnterpriseProjectId(db, 'meeting', 'meeting-1')).toBe('enterprise-1');
    expect(resolveAssociatedEnterpriseProjectId(db, 'operation', 'operation-1')).toBeNull();
    expect(resolveAssociatedEnterpriseProjectId(db, 'group', 'group-1')).toBeNull();
  });
});
