import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { getEnterpriseProjectRoot, getProjectRoot } from './paths';

export type ProjectResourceType = 'group' | 'meeting' | 'operation';

type EnterpriseProjectRecord = {
  id: string;
  name: string;
  description?: string;
  tokenUsed?: number;
  completedNodes?: number;
  totalNodes?: number;
  createdAt?: string;
  updatedAt?: string;
};

function settingValue<T>(db: Database.Database, key: string, fallback: T): T {
  try {
    const row = db.prepare('SELECT value_json as valueJson FROM settings WHERE key = ?').get(key) as { valueJson?: string } | undefined;
    if (!row?.valueJson) return fallback;
    const parsed = JSON.parse(row.valueJson) as { value?: T };
    return parsed.value ?? fallback;
  } catch {
    return fallback;
  }
}

export function listEnterpriseProjects(db: Database.Database): EnterpriseProjectRecord[] {
  try {
    return db.prepare(
      `SELECT id, name, description, token_used as tokenUsed, completed_nodes as completedNodes,
              total_nodes as totalNodes, created_at as createdAt, updated_at as updatedAt
       FROM enterprise_projects ORDER BY updated_at DESC`,
    ).all() as EnterpriseProjectRecord[];
  } catch {
    return settingValue<EnterpriseProjectRecord[]>(db, 'enterpriseProjects', []);
  }
}

export function getEnterpriseProject(db: Database.Database, projectId: string): EnterpriseProjectRecord | null {
  return listEnterpriseProjects(db).find((project) => project.id === projectId) ?? null;
}

export function resolveAssociatedEnterpriseProjectId(
  db: Database.Database,
  resourceType: ProjectResourceType,
  resourceId: string,
): string | null {
  try {
    const row = db.prepare(
      `SELECT project_id as projectId FROM project_resource_links
       WHERE resource_type = ? AND resource_id = ? AND status = 'active'`,
    ).get(resourceType, resourceId) as { projectId?: string } | undefined;
    if (row?.projectId) return row.projectId;
  } catch { /* legacy workspace */ }
  const associations = settingValue<Record<string, string>>(db, 'enterpriseProjectAssociations', {});
  return associations[`${resourceType}:${resourceId}`] ?? null;
}

export function syncEnterpriseProjectSettings(
  db: Database.Database,
  projects: unknown,
  associations: unknown,
): void {
  if (Array.isArray(projects)) {
    const now = new Date().toISOString();
    const upsert = db.prepare(
      `INSERT INTO enterprise_projects
       (id, name, description, token_used, completed_nodes, total_nodes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
         token_used = excluded.token_used, completed_nodes = excluded.completed_nodes,
         total_nodes = excluded.total_nodes, updated_at = excluded.updated_at`,
    );
    const keep = new Set<string>();
    for (const value of projects) {
      if (!value || typeof value !== 'object') continue;
      const project = value as Partial<EnterpriseProjectRecord>;
      if (!project.id?.trim() || !project.name?.trim()) continue;
      keep.add(project.id);
      upsert.run(
        project.id,
        project.name,
        project.description ?? '',
        Number(project.tokenUsed ?? 0),
        Number(project.completedNodes ?? 0),
        Number(project.totalNodes ?? 0),
        project.createdAt ?? now,
        project.updatedAt ?? now,
      );
    }
    const existing = db.prepare('SELECT id FROM enterprise_projects').all() as Array<{ id: string }>;
    for (const row of existing) {
      if (!keep.has(row.id)) db.prepare('DELETE FROM enterprise_projects WHERE id = ?').run(row.id);
    }
  }

  if (associations && typeof associations === 'object' && !Array.isArray(associations)) {
    const now = new Date().toISOString();
    const values = associations as Record<string, unknown>;
    db.prepare('DELETE FROM project_resource_links').run();
    const insert = db.prepare(
      `INSERT INTO project_resource_links
       (project_id, resource_type, resource_id, permission, status, created_at, updated_at)
       VALUES (?, ?, ?, 'read-write', 'active', ?, ?)`,
    );
    for (const [key, projectId] of Object.entries(values)) {
      const match = key.match(/^(group|meeting|operation):(.+)$/);
      if (!match || typeof projectId !== 'string' || !projectId.trim()) continue;
      insert.run(projectId, match[1], match[2], now, now);
    }
  }
}

async function copyLegacyProjectWorkspace(groupId: string, targetRoot: string): Promise<void> {
  const legacyRoot = join(getProjectRoot(groupId), 'project-shared');
  try {
    await access(legacyRoot);
    await cp(legacyRoot, targetRoot, { recursive: true, force: false, errorOnExist: false });
  } catch { /* no legacy project workspace */ }
}

export async function ensureEnterpriseProjectWorkspace(input: { projectId: string; name?: string }): Promise<string> {
  const root = getEnterpriseProjectRoot(input.projectId);
  await copyLegacyProjectWorkspace(input.projectId, root);
  await Promise.all([
    mkdir(join(root, 'original-files', 'uploads'), { recursive: true }),
    mkdir(join(root, 'original-files', 'groups'), { recursive: true }),
    mkdir(join(root, 'original-files', 'meetings'), { recursive: true }),
    mkdir(join(root, 'original-files', 'operations'), { recursive: true }),
    mkdir(join(root, 'templates'), { recursive: true }),
    mkdir(join(root, 'standardized-files'), { recursive: true }),
    mkdir(join(root, 'knowledge', 'graph'), { recursive: true }),
    mkdir(join(root, 'knowledge', 'wiki'), { recursive: true }),
    mkdir(join(root, 'knowledge', 'review'), { recursive: true }),
    mkdir(join(root, 'graph-visualization'), { recursive: true }),
    mkdir(join(root, 'outputs'), { recursive: true }),
    mkdir(join(root, 'experience'), { recursive: true }),
    mkdir(join(root, '.runtime', 'trash'), { recursive: true }),
    mkdir(join(root, '.runtime', 'versions'), { recursive: true }),
    mkdir(join(root, '.runtime', 'run-temp'), { recursive: true }),
  ]);
  const manifest = join(root, 'project.yaml');
  try {
    await access(manifest);
  } catch {
    await writeFile(manifest, `schemaVersion: 1\nprojectId: ${input.projectId}\nname: ${JSON.stringify(input.name?.trim() || input.projectId)}\n`, 'utf8');
  }
  return root;
}

export async function ensureEnterpriseProjectWorkspaces(db: Database.Database): Promise<void> {
  const projects = listEnterpriseProjects(db);
  const roots = new Map<string, string>();
  await Promise.all(projects.map(async (project) => {
    roots.set(project.id, await ensureEnterpriseProjectWorkspace({ projectId: project.id, name: project.name }));
  }));

  let groupLinks: Array<{ projectId: string; resourceId: string }> = [];
  try {
    groupLinks = db.prepare(
      `SELECT project_id as projectId, resource_id as resourceId
       FROM project_resource_links
       WHERE resource_type = 'group' AND status = 'active'`,
    ).all() as Array<{ projectId: string; resourceId: string }>;
  } catch { /* legacy database without association table */ }
  await Promise.all(groupLinks.map(async (link) => {
    const targetRoot = roots.get(link.projectId);
    if (targetRoot) await copyLegacyProjectWorkspace(link.resourceId, targetRoot);
  }));
}

export async function readEnterpriseProjectManifest(projectId: string): Promise<string> {
  return readFile(join(getEnterpriseProjectRoot(projectId), 'project.yaml'), 'utf8');
}
