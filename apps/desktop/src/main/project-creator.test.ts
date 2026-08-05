// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.1.0' },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: {} as never,
}));

import { setStudioRoot, getProjectRoot } from './paths';
import { addProjectAgents, createProject, seedDefaultProfiles } from './project-creator';
import { ContextBuilder, type ContextSnapshot } from './context-builder';
import {
  ProjectRepository,
  AgentInstanceRepository,
  AgentProfileRepository,
  MessageRepository,
} from '@kunqing/database';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','reviewing','archived')),
  summary TEXT,
  leader_instance_id TEXT,
  workspace_rel_path TEXT,
  shared_knowledge_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_last_active ON projects(last_active_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  sender_type TEXT NOT NULL CHECK(sender_type IN ('user','agent','system')),
  sender_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','artifact','system')),
  content_json TEXT NOT NULL,
  routing_json TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sending','sent','failed')),
  reply_to_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at, id);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK(runtime_mode IN ('native-model','external-cli')),
  model_profile_id TEXT,
  cli_connection_id TEXT,
  overrides_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  delegatable INTEGER NOT NULL DEFAULT 1,
  is_system_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_agent_instances (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  agent_profile_id TEXT NOT NULL,
  definition_id TEXT,
  definition_version TEXT,
  role TEXT NOT NULL CHECK(role IN ('leader','teammate')),
  runtime_mode TEXT NOT NULL CHECK(runtime_mode IN ('native-model','external-cli')),
  model_profile_id TEXT,
  cli_connection_id TEXT,
  identity_rel_path TEXT,
  memory_rel_path TEXT,
  effective_permissions_json TEXT,
  ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_agent_instances_ordinal ON project_agent_instances(project_id, ordinal);

CREATE TABLE IF NOT EXISTS agent_definitions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL DEFAULT '1.0.0',
  kind TEXT NOT NULL DEFAULT 'builtin',
  manifest_rel_path TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  framework_entry TEXT,
  max_permissions_json TEXT,
  model_requirements_json TEXT,
  is_builtin INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_requests (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

let studioRoot: string;
let db: Database.Database;

beforeAll(async () => {
  studioRoot = mkdtempSync(join(tmpdir(), 'kp-test-'));
  setStudioRoot(studioRoot);

  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA_SQL);
  await seedDefaultProfiles(db);
});

afterAll(async () => {
  db.close();
  await rm(studioRoot, { recursive: true, force: true });
});

describe('createProject', () => {
  it('AC-HOME-04 creates project with queryable project, instances, message and FS', async () => {
    const input = {
      idempotencyKey: 'home-04-key',
      content: { text: '年度财务报表审核与分析' },
    };

    const result = await createProject(db, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { id: projectId, status, createdAt } = result.data;
    expect(projectId).toBeTruthy();
    expect(status).toBe('active');

    const projectRepo = new ProjectRepository(db);
    const instanceRepo = new AgentInstanceRepository(db);
    const messageRepo = new MessageRepository(db);
    const profileRepo = new AgentProfileRepository(db);

    // Project queryable
    const project = projectRepo.getById(projectId);
    expect(project.name).toContain('年度财务报表');
    expect(project.status).toBe('active');

    // Project appears in list
    const allProjects = projectRepo.list();
    expect(allProjects.some((p) => p.id === projectId)).toBe(true);

    // Agent instances queryable
    const instances = instanceRepo.listByProject(projectId);
    expect(instances.length).toBe(3);
    expect(new Set(instances.map((instance) => instance.id)).size).toBe(instances.length);
    expect(instances.every((instance) => instance.id.startsWith(`${projectId}-`))).toBe(true);

    const leader = instances.find((i) => i.role === 'leader');
    expect(leader).toBeDefined();
    expect(leader!.agentProfileId).toBe('builtin-orchestrator-profile');

    const teammates = instances.filter((i) => i.role === 'teammate');
    expect(teammates.length).toBe(2);
    const knowledgeTeammate = teammates.find((t) => t.agentProfileId === 'builtin-knowledge-profile');
    expect(knowledgeTeammate).toBeDefined();
    const researcherTeammate = teammates.find((t) => t.agentProfileId === 'builtin-researcher-profile');
    expect(researcherTeammate).toBeDefined();

    // Messages queryable
    const messages = messageRepo.listByProject(projectId);
    expect(messages.messages.length).toBe(1);
    expect(messages.messages[0]!.senderType).toBe('user');
    expect(messages.messages[0]!.contentJson).toContain('年度财务报表审核与分析');

    // Agent profiles still queryable
    const orchProfile = profileRepo.getById('builtin-orchestrator-profile');
    expect(orchProfile.name).toBe('统筹管理智能体');
    const knowProfile = profileRepo.getById('builtin-knowledge-profile');
    expect(knowProfile.name).toBe('知识管理智能体');
  });

  it('AC-HOME-05 orchestrator joins as leader, knowledge joins as teammate', async () => {
    const result = await createProject(db, {
      idempotencyKey: 'home-05-key',
      content: { text: '市场调研分析' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const instanceRepo = new AgentInstanceRepository(db);
    const instances = instanceRepo.listByProject(result.data.id);

    const leader = instances.find((i) => i.role === 'leader');
    expect(leader).toBeDefined();
    expect(leader!.agentProfileId).toBe('builtin-orchestrator-profile');

    const teammates = instances.filter((i) => i.role === 'teammate');
    expect(teammates.length).toBe(2);
    const knowTeammate = teammates.find((t) => t.agentProfileId === 'builtin-knowledge-profile');
    expect(knowTeammate).toBeDefined();
    const resTeammate = teammates.find((t) => t.agentProfileId === 'builtin-researcher-profile');
    expect(resTeammate).toBeDefined();

    // Leader ordinal is 0, teammates ordinal are 1,2
    const sorted = [...instances].sort((a, b) => a.ordinal - b.ordinal);
    expect(sorted[0]!.role).toBe('leader');
    expect(sorted[1]!.role).toBe('teammate');
    expect(sorted[2]!.role).toBe('teammate');
  });

  it('AC-HOME-06 creates identity files and memory directories for both agents', async () => {
    const result = await createProject(db, {
      idempotencyKey: 'home-06-key',
      content: { text: '研发项目评估' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const projectRoot = getProjectRoot(result.data.id);
    const instanceRepo = new AgentInstanceRepository(db);
    const instances = instanceRepo.listByProject(result.data.id);

    for (const inst of instances) {
      // Identity file exists
      if (inst.identityRelPath) {
        const identityPath = join(projectRoot, inst.identityRelPath);
        expect(existsSync(identityPath)).toBe(true);
        const content = readFileSync(identityPath, 'utf8');
        expect(content).toContain('schemaVersion: 2');
        expect(existsSync(join(identityPath, '..', 'ROLE.md'))).toBe(true);
        expect(existsSync(join(identityPath, '..', 'ADAPTATION.md'))).toBe(true);
        expect(existsSync(join(identityPath, '..', 'IDENTITY.snapshot.json'))).toBe(true);
      }

      // Memory directories exist
      if (inst.memoryRelPath) {
        expect(existsSync(join(projectRoot, inst.memoryRelPath, 'short-term'))).toBe(true);
        expect(existsSync(join(projectRoot, inst.memoryRelPath, 'long-term'))).toBe(true);
        expect(existsSync(join(projectRoot, inst.memoryRelPath, 'short-term', 'current.md'))).toBe(true);
        expect(existsSync(join(projectRoot, inst.memoryRelPath, 'long-term', 'summary.md'))).toBe(true);
      }
    }

    // Standard workspace directories exist
    expect(existsSync(join(projectRoot, 'original-files'))).toBe(true);
    expect(existsSync(join(projectRoot, 'knowledge', 'graph', 'schema'))).toBe(true);
    expect(existsSync(join(projectRoot, 'knowledge', 'wiki', 'entities'))).toBe(true);
    expect(existsSync(join(projectRoot, 'knowledge', 'wiki', 'topics'))).toBe(true);
    expect(existsSync(join(projectRoot, 'graph-visualization', 'layouts'))).toBe(true);
    expect(existsSync(join(projectRoot, 'graph-visualization', 'exports'))).toBe(true);
    expect(existsSync(join(projectRoot, 'outputs'))).toBe(true);
    expect(existsSync(join(projectRoot, '.runtime', 'trash'))).toBe(true);
    expect(existsSync(join(projectRoot, '.runtime', 'versions'))).toBe(true);
    expect(existsSync(join(projectRoot, '.runtime', 'run-temp'))).toBe(true);
    expect(existsSync(join(projectRoot, '.runtime', 'sandboxes'))).toBe(true);

    // group.yaml exists
    const groupYaml = readFileSync(join(projectRoot, 'group.yaml'), 'utf8');
    expect(groupYaml).toContain(`projectId: ${result.data.id}`);
  });

  it('AC-HOME-02 idempotency key returns same project on repeated call', async () => {
    const input = {
      idempotencyKey: `dup-key-${Date.now()}`,
      content: { text: '去重测试' },
    };

    const first = await createProject(db, input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await createProject(db, input);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Same project ID returned
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.status).toBe(first.data.status);
    expect(second.data.createdAt).toBe(first.data.createdAt);

    // Only one project in DB
    const projectRepo = new ProjectRepository(db);
    const project = projectRepo.getById(first.data.id);
    expect(project).toBeDefined();
    expect(project.id).toBe(first.data.id);
  });

  it('creates project with empty text', async () => {
    const result = await createProject(db, {
      content: { text: '' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const projectRepo = new ProjectRepository(db);
    const project = projectRepo.getById(result.data.id);
    // Uses auto-generated name for empty text
    expect(project.name).toMatch(/^新对话 - /);
  });

  it('adds an agent to an existing group and initializes private local files', async () => {
    const now = new Date().toISOString();
    const profileId = `external-profile-${Date.now()}`;
    db.prepare(
      `INSERT INTO agent_profiles
       (id, name, definition_id, definition_version, runtime_mode, cli_connection_id, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, '测试 CLI 智能体', 'external.codebuddy', '1.0.0', 'external-cli', 'cli-test', 1, 1, 0, ?, ?)`,
    ).run(profileId, now, now);
    const definitionRoot = join(studioRoot, 'agent-definitions', 'custom', 'external.codebuddy', '1.0.0');
    await mkdir(join(definitionRoot, 'prompts'), { recursive: true });
    await writeFile(join(definitionRoot, 'IDENTITY.template.md'), '---\nschemaVersion: 2\ndefinitionId: external.codebuddy\n---\n\n# 身份\n\n这是人工维护的 CodeBuddy 全局身份模板。\n', 'utf8');
    await writeFile(join(definitionRoot, 'prompts', 'system.md'), '这是人工维护的 CodeBuddy 系统规则。', 'utf8');
    const created = await createProject(db, { content: { text: '添加成员测试' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const agents = await addProjectAgents(db, created.data.id, [profileId]);
    expect(agents).toHaveLength(4);
    const added = agents.find((agent) => agent.agentName === '测试 CLI 智能体');
    expect(added?.role).toBe('teammate');
    expect(added?.runtimeMode).toBe('external-cli');
    const addedIdentityPath = join(getProjectRoot(created.data.id), 'agent-identities', added!.id, 'IDENTITY.md');
    expect(existsSync(addedIdentityPath)).toBe(true);
    expect(readFileSync(addedIdentityPath, 'utf8')).toContain('人工维护的 CodeBuddy 全局身份模板');
    expect(existsSync(join(getProjectRoot(created.data.id), 'agent-identities', added!.id, 'ROLE.md'))).toBe(true);
    expect(existsSync(join(getProjectRoot(created.data.id), 'agent-identities', added!.id, 'ADAPTATION.md'))).toBe(true);
    expect(existsSync(join(getProjectRoot(created.data.id), 'agent-memories', added!.id, 'short-term', 'current.md'))).toBe(true);

    const runtimeIdentity = (new ContextBuilder(db) as unknown as {
      buildAgentInfo(instanceId: string): ContextSnapshot['agent'];
    }).buildAgentInfo(added!.id);
    expect(runtimeIdentity.definitionSystemPrompt).toContain('人工维护的 CodeBuddy 系统规则');
    expect(runtimeIdentity.identity).toContain('人工维护的 CodeBuddy 全局身份模板');
    expect(runtimeIdentity.identity).toContain('群聊适应性补充');

    const duplicate = await addProjectAgents(db, created.data.id, [profileId]);
    expect(duplicate).toHaveLength(4);
  });

  it('archives a dissolved group without deleting its workspace', async () => {
    const created = await createProject(db, { content: { text: '待解散群聊' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const projectRoot = getProjectRoot(created.data.id);
    const repo = new ProjectRepository(db);

    repo.archive(created.data.id);

    expect(repo.list().some((project) => project.id === created.data.id)).toBe(false);
    expect(repo.getById(created.data.id).status).toBe('archived');
    expect(existsSync(projectRoot)).toBe(true);
    expect(existsSync(join(projectRoot, 'original-files'))).toBe(true);
  });
});
