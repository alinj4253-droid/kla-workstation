import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistry, parseSkillMarkdown } from './skill-registry';

describe('SkillRegistry', () => {
  let db: Database.Database;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kunqing-skills-'));
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT, description TEXT, prompt_md TEXT, required_capabilities_json TEXT, enabled INTEGER, is_builtin INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE agent_skills (agent_definition_id TEXT, agent_definition_version TEXT, skill_id TEXT, ordinal INTEGER, UNIQUE(agent_definition_id, agent_definition_version, skill_id));
      CREATE TABLE skill_packages (id TEXT, version TEXT, name TEXT, description TEXT, package_rel_path TEXT, entry_rel_path TEXT, manifest_json TEXT, checksum TEXT, source TEXT, enabled INTEGER, installed_at TEXT, updated_at TEXT, PRIMARY KEY(id, version));
      CREATE TABLE agent_definition_skills (agent_definition_id TEXT, agent_definition_version TEXT, skill_id TEXT, skill_version TEXT, ordinal INTEGER, config_json TEXT, PRIMARY KEY(agent_definition_id, agent_definition_version, skill_id, skill_version));
      CREATE TABLE agent_run_skills (run_id TEXT, skill_id TEXT, skill_version TEXT, checksum TEXT, package_rel_path TEXT, snapshot_json TEXT, created_at TEXT, PRIMARY KEY(run_id, skill_id, skill_version));
    `);
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('parses Codex-compatible frontmatter and keeps the body separate', () => {
    const parsed = parseSkillMarkdown('---\nname: document-chunking\ndescription: 按语义边界切片。\n---\n\n# Instructions\n\nDo work.');
    expect(parsed.name).toBe('document-chunking');
    expect(parsed.description).toBe('按语义边界切片。');
    expect(parsed.body).toContain('Do work.');
  });

  it('scans packages, supports legacy SKILL.md, isolates definitions and snapshots each Run', async () => {
    const first = join(root, 'agent-definitions', 'built-in', 'agent.one', '1.0.0', 'skills', 'document-chunking');
    const second = join(root, 'agent-definitions', 'custom', 'agent.two', '2.0.0', 'skills', 'legacy-research');
    await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
    await writeFile(join(first, 'SKILL.md'), '---\nname: document-chunking\ndescription: 按语义边界切片并保留来源。\n---\n\n# 文档切片\n\n执行切片。', 'utf8');
    await writeFile(join(first, 'kunqing.json'), JSON.stringify({ schemaVersion: 1, id: 'document-chunking', version: '1.2.0', entry: 'SKILL.md', requiredTools: ['workspace:readFile'] }), 'utf8');
    await writeFile(join(second, 'SKILL.md'), '# 旧式调研\n\n执行资料调研。', 'utf8');

    const registry = new SkillRegistry(db, root);
    expect(await registry.syncFromWorkspace()).toBe(2);
    expect(registry.resolveForDefinition('agent.one', '1.0.0').map((item) => item.id)).toEqual(['document-chunking']);
    expect(registry.resolveForDefinition('agent.two', '2.0.0').map((item) => item.id)).toEqual(['legacy-research']);
    expect(registry.resolveForDefinition('agent.one', '1.0.0').map((item) => item.id)).not.toContain('legacy-research');

    const loaded = await registry.loadForDefinition('agent.one', '1.0.0', 'document-chunking', '1.2.0');
    expect(loaded).toContain('执行切片');

    const snapshot = registry.snapshotForRun('run-1', 'agent.one', '1.0.0');
    expect(snapshot[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    const persisted = db.prepare("SELECT skill_id as skillId, skill_version as version FROM agent_run_skills WHERE run_id = 'run-1'").get() as { skillId: string; version: string };
    expect(persisted).toEqual({ skillId: 'document-chunking', version: '1.2.0' });
    expect(registry.searchForRun('run-1', '读取文档后按语义切片')[0]?.id).toBe('document-chunking');
    expect(registry.loadForRun('run-1', 'document-chunking', '1.2.0')).toContain('执行切片');
    expect(registry.loadForRun('run-1', 'legacy-research')).toBeNull();
  });

  it('binds official skills to knowledge, writer and reviewer definitions', () => {
    const registry = new SkillRegistry(db, root);
    registry.seedBuiltinSkills();

    const knowledgeSkills = registry.snapshotForRun('run-knowledge', 'builtin.knowledge-manager', '1.0.0');
    expect(knowledgeSkills.map((skill) => skill.id)).toEqual(expect.arrayContaining([
      'process-knowledge-files',
      'retrieve-knowledge',
    ]));
    expect(registry.loadForRun('run-knowledge', 'process-knowledge-files')).toContain('增量处理群聊原始文件');
    expect(registry.loadForRun('run-knowledge', 'retrieve-knowledge')).toContain('全文、向量、图谱与 Wiki');

    registry.snapshotForRun('run-researcher', 'builtin.researcher', '1.0.0');
    expect(registry.resolveForDefinition('builtin.researcher', '1.0.0').find((skill) => skill.id === 'web-search')?.requiredTools).toContain('web:search');
    expect(registry.loadForRun('run-researcher', 'web-search')).toContain('网页搜索');
    expect(registry.loadForRun('run-researcher', 'process-knowledge-files')).toBeNull();
    expect(registry.loadForRun('run-researcher', 'retrieve-knowledge')).toBeNull();

    const writerSkills = registry.snapshotForRun('run-writer', 'builtin.material-writer', '1.0.0');
    expect(writerSkills.map((skill) => skill.id)).toEqual(['document-authoring']);
    expect(registry.loadForRun('run-writer', 'document-authoring')).toContain('先列框架');
    expect(registry.loadForRun('run-writer', 'retrieve-knowledge')).toBeNull();

    const reviewerSkills = registry.snapshotForRun('run-reviewer', 'builtin.acceptance-reviewer', '1.0.0');
    expect(reviewerSkills.map((skill) => skill.id)).toEqual(expect.arrayContaining([
      'retrieve-knowledge',
      'provenance-validation',
      'deliverable-acceptance',
    ]));
    expect(registry.loadForRun('run-reviewer', 'retrieve-knowledge')).toContain('全文、向量、图谱与 Wiki');
    expect(registry.loadForRun('run-reviewer', 'provenance-validation')).toContain('材料主张');
  });
});
