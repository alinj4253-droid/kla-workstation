import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { getLogger } from './logger';
import { getStudioRoot } from './paths';

export type SkillDefinition = {
  id: string;
  name: string;
  description: string;
  promptMd: string | null;
  requiredCapabilities: string[];
  enabled: boolean;
  isBuiltin: boolean;
};

export type SkillBinding = {
  agentDefinitionId: string;
  agentDefinitionVersion: string;
  skillId: string;
  ordinal: number;
};

export type SkillPackageManifest = {
  schemaVersion: number;
  id: string;
  version: string;
  entry: string;
  agentDefinitions?: string[];
  executionMode?: 'instructions' | 'script' | 'hybrid';
  requiredTools?: string[];
  permissions?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;
  scripts?: Record<string, string>;
  compatibility?: Record<string, unknown>;
  source?: string;
  instructions?: string;
};

export type ResolvedSkillPackage = {
  id: string;
  version: string;
  name: string;
  description: string;
  packageRelPath: string;
  entryRelPath: string;
  checksum: string;
  source: 'built-in' | 'custom' | 'legacy';
  requiredTools: string[];
  ordinal: number;
};

export function parseSkillMarkdown(markdown: string): { name: string | null; description: string | null; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { name: null, description: null, body: markdown.trim() };
  const frontmatter = match[1] ?? '';
  const field = (key: string): string | null => {
    const value = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'))?.[1]?.trim();
    if (!value) return null;
    return value.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  };
  return { name: field('name'), description: field('description'), body: markdown.slice(match[0].length).trim() };
}

const jsonArray = (value: string | null): string[] => {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const checksum = (...values: string[]): string => createHash('sha256').update(values.join('\n')).digest('hex');
const normalizeRelPath = (value: string): string => value.replaceAll('\\', '/');

export class SkillRegistry {
  constructor(private db: Database.Database, private studioRoot = getStudioRoot()) {}

  /** 设置页兼容接口。 */
  listSkills(definitionId?: string, definitionVersion?: string): SkillDefinition[] {
    const rows = definitionId && definitionVersion
      ? this.db.prepare(
        `SELECT s.id, s.name, s.description, s.prompt_md as promptMd,
                s.required_capabilities_json as requiredCapabilitiesJson,
                s.enabled, s.is_builtin as isBuiltin
         FROM skills s JOIN agent_skills a ON a.skill_id = s.id
         WHERE a.agent_definition_id = ? AND a.agent_definition_version = ? ORDER BY a.ordinal`,
      ).all(definitionId, definitionVersion)
      : this.db.prepare(
        `SELECT id, name, description, prompt_md as promptMd,
                required_capabilities_json as requiredCapabilitiesJson,
                enabled, is_builtin as isBuiltin
         FROM skills WHERE enabled = 1 ORDER BY name`,
      ).all();
    return (rows as Array<{
      id: string; name: string; description: string; promptMd: string | null;
      requiredCapabilitiesJson: string | null; enabled: number; isBuiltin: number;
    }>).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      promptMd: row.promptMd,
      requiredCapabilities: jsonArray(row.requiredCapabilitiesJson),
      enabled: row.enabled === 1,
      isBuiltin: row.isBuiltin === 1,
    }));
  }

  getSkill(skillId: string): SkillDefinition | null {
    const row = this.db.prepare(
      `SELECT id, name, description, prompt_md as promptMd,
              required_capabilities_json as requiredCapabilitiesJson,
              enabled, is_builtin as isBuiltin FROM skills WHERE id = ?`,
    ).get(skillId) as {
      id: string; name: string; description: string; promptMd: string | null;
      requiredCapabilitiesJson: string | null; enabled: number; isBuiltin: number;
    } | undefined;
    return row ? {
      id: row.id,
      name: row.name,
      description: row.description,
      promptMd: row.promptMd,
      requiredCapabilities: jsonArray(row.requiredCapabilitiesJson),
      enabled: row.enabled === 1,
      isBuiltin: row.isBuiltin === 1,
    } : null;
  }

  getBindings(definitionId: string, definitionVersion: string): SkillBinding[] {
    return this.db.prepare(
      'SELECT agent_definition_id as agentDefinitionId, agent_definition_version as agentDefinitionVersion, skill_id as skillId, ordinal FROM agent_skills WHERE agent_definition_id = ? AND agent_definition_version = ? ORDER BY ordinal',
    ).all(definitionId, definitionVersion) as SkillBinding[];
  }

  resolveForDefinition(definitionId: string, definitionVersion: string): ResolvedSkillPackage[] {
    try {
      const rows = this.db.prepare(
        `SELECT p.id, p.version, p.name, p.description, p.package_rel_path as packageRelPath,
                p.entry_rel_path as entryRelPath, p.manifest_json as manifestJson,
                p.checksum, p.source, b.ordinal
         FROM skill_packages p
         JOIN agent_definition_skills b ON b.skill_id = p.id AND b.skill_version = p.version
         WHERE b.agent_definition_id = ? AND b.agent_definition_version = ? AND p.enabled = 1
         ORDER BY b.ordinal`,
      ).all(definitionId, definitionVersion) as Array<Omit<ResolvedSkillPackage, 'requiredTools'> & { manifestJson: string }>;
      return rows.map((row) => {
        let manifest: Partial<SkillPackageManifest> = {};
        try { manifest = JSON.parse(row.manifestJson) as Partial<SkillPackageManifest>; } catch { /* empty */ }
        return { ...row, requiredTools: Array.isArray(manifest.requiredTools) ? manifest.requiredTools : [] };
      });
    } catch {
      try {
        return this.listSkills(definitionId, definitionVersion).map((skill, ordinal) => ({
          id: skill.name,
          version: '1.0.0',
          name: skill.name,
          description: skill.description,
          packageRelPath: '',
          entryRelPath: 'SKILL.md',
          checksum: checksum(skill.promptMd ?? ''),
          source: 'legacy',
          requiredTools: skill.requiredCapabilities,
          ordinal,
        }));
      } catch {
        return [];
      }
    }
  }

  snapshotForRun(runId: string, definitionId: string, definitionVersion: string): ResolvedSkillPackage[] {
    const skills = this.resolveForDefinition(definitionId, definitionVersion);
    try {
      const remove = this.db.prepare('DELETE FROM agent_run_skills WHERE run_id = ?');
      const insert = this.db.prepare(
        `INSERT INTO agent_run_skills (run_id, skill_id, skill_version, checksum, package_rel_path, snapshot_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      this.db.transaction(() => {
        remove.run(runId);
        const now = new Date().toISOString();
        for (const skill of skills) insert.run(runId, skill.id, skill.version, skill.checksum, skill.packageRelPath, JSON.stringify(skill), now);
      })();
    } catch (err) {
      getLogger()?.warn({ err, runId }, 'SkillRegistry: Run 技能快照写入失败');
    }
    return skills;
  }

  async loadForDefinition(definitionId: string, definitionVersion: string, skillId: string, skillVersion?: string): Promise<string | null> {
    const resolved = this.resolveForDefinition(definitionId, definitionVersion)
      .find((skill) => skill.id === skillId && (!skillVersion || skill.version === skillVersion));
    if (!resolved) return null;
    if (resolved.packageRelPath) {
      try {
        return await readFile(join(this.studioRoot, resolved.packageRelPath, resolved.entryRelPath), 'utf8');
      } catch { /* use bundled legacy instructions */ }
    }
    try {
      const row = this.db.prepare('SELECT manifest_json as manifestJson FROM skill_packages WHERE id = ? AND version = ?')
        .get(resolved.id, resolved.version) as { manifestJson: string } | undefined;
      const manifest = row ? JSON.parse(row.manifestJson) as Partial<SkillPackageManifest> : {};
      return typeof manifest.instructions === 'string' ? manifest.instructions : null;
    } catch {
      return null;
    }
  }

  /** 扫描 Agent Definition 下的 skills；绑定关系只来源于定义目录，不引用群聊。 */
  async syncFromWorkspace(): Promise<number> {
    let synced = 0;
    for (const kind of ['built-in', 'custom'] as const) {
      const kindRoot = join(this.studioRoot, 'agent-definitions', kind);
      let definitions;
      try { definitions = await readdir(kindRoot, { withFileTypes: true }); } catch { continue; }
      for (const definition of definitions.filter((entry) => entry.isDirectory())) {
        const definitionRoot = join(kindRoot, definition.name);
        const versions = await readdir(definitionRoot, { withFileTypes: true }).catch(() => []);
        for (const versionDir of versions.filter((entry) => entry.isDirectory())) {
          const skillsRoot = join(definitionRoot, versionDir.name, 'skills');
          const skillDirs = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
          let ordinal = 0;
          for (const skillDir of skillDirs.filter((entry) => entry.isDirectory())) {
            try {
              const packageRoot = join(skillsRoot, skillDir.name);
              const manifestPath = join(packageRoot, 'kunqing.json');
              const manifestRaw = await readFile(manifestPath, 'utf8').catch(() => '');
              const parsedManifest = manifestRaw ? JSON.parse(manifestRaw) as Partial<SkillPackageManifest> : {};
              const entry = typeof parsedManifest.entry === 'string' && !parsedManifest.entry.includes('..') ? parsedManifest.entry : 'SKILL.md';
              const markdown = await readFile(join(packageRoot, entry), 'utf8');
              const parsed = parseSkillMarkdown(markdown);
              const id = typeof parsedManifest.id === 'string' ? parsedManifest.id : skillDir.name;
              const version = typeof parsedManifest.version === 'string' ? parsedManifest.version : '1.0.0';
              if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(version)) continue;
              const legacy = this.listSkills(definition.name, versionDir.name).find((item) => item.name === skillDir.name);
              const name = parsed.name ?? skillDir.name;
              const description = parsed.description ?? legacy?.description ?? parsed.body.split(/\r?\n/).find(Boolean)?.replace(/^#+\s*/, '').slice(0, 300) ?? name;
              const manifest: SkillPackageManifest = {
                schemaVersion: typeof parsedManifest.schemaVersion === 'number' ? parsedManifest.schemaVersion : 1,
                id,
                version,
                entry,
                executionMode: parsedManifest.executionMode ?? 'instructions',
                requiredTools: Array.isArray(parsedManifest.requiredTools) ? parsedManifest.requiredTools.filter((item): item is string => typeof item === 'string') : legacy?.requiredCapabilities ?? [],
                ...(Array.isArray(parsedManifest.agentDefinitions) ? { agentDefinitions: parsedManifest.agentDefinitions.filter((item): item is string => typeof item === 'string') } : {}),
                ...(Array.isArray(parsedManifest.permissions) ? { permissions: parsedManifest.permissions.filter((item): item is string => typeof item === 'string') } : {}),
              };
              const now = new Date().toISOString();
              const digest = checksum(markdown, JSON.stringify(manifest));
              const packageRelPath = normalizeRelPath(relative(this.studioRoot, packageRoot));
              this.db.prepare(
                `INSERT INTO skill_packages (id, version, name, description, package_rel_path, entry_rel_path, manifest_json, checksum, source, enabled, installed_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                 ON CONFLICT(id, version) DO UPDATE SET name = excluded.name, description = excluded.description,
                   package_rel_path = excluded.package_rel_path, entry_rel_path = excluded.entry_rel_path,
                   manifest_json = excluded.manifest_json, checksum = excluded.checksum, source = excluded.source, updated_at = excluded.updated_at`,
              ).run(id, version, name, description, packageRelPath, entry, JSON.stringify(manifest), digest, kind, now, now);
              this.db.prepare(
                `INSERT INTO agent_definition_skills (agent_definition_id, agent_definition_version, skill_id, skill_version, ordinal, config_json)
                 VALUES (?, ?, ?, ?, ?, NULL)
                 ON CONFLICT(agent_definition_id, agent_definition_version, skill_id, skill_version)
                 DO UPDATE SET ordinal = excluded.ordinal`,
              ).run(definition.name, versionDir.name, id, version, ordinal++);
              synced++;
            } catch (err) {
              getLogger()?.warn({ err, definitionId: definition.name, skill: skillDir.name }, 'SkillRegistry: 跳过无效技能包');
            }
          }
        }
      }
    }
    return synced;
  }

  /** 安装内置技能，同时为尚未扫描文件系统的启动阶段提供版本化兜底。 */
  seedBuiltinSkills(): void {
    const now = new Date().toISOString();
    const definitions = [
      ['builtin.orchestrator', [
        ['team-planning', '团队规划与任务拆分：从业务目标拆出可验收工作包，并选择合适成员。', ['list_project_agents', 'delegate_tasks']],
        ['result-synthesis', '结果汇总与交付：核对成员结果、处理缺口并形成统一交付。', []],
      ]],
      ['builtin.knowledge-manager', [
        ['process-knowledge-files', '增量处理群聊原始文件，生成切片、摘要、标签、向量、图谱、Wiki 与离线可视化。', ['workspace:readFile', 'knowledge:ingest', 'local:ocr', 'local:embed']],
        ['retrieve-knowledge', '按问题自适应融合全文、向量、图谱与 Wiki 检索，并返回可溯源证据。', ['knowledge:search', 'knowledge:listGraph']],
        ['document-ingestion', '文档导入与语义切片：解析文件、分块并保留来源位置。', ['workspace:readFile']],
        ['entity-relation-extraction', '实体关系抽取：形成带置信度和来源的知识图谱。', ['knowledge:search']],
        ['provenance-validation', '来源溯源与验证：核验知识与原始资料的一致性。', ['workspace:readFile', 'knowledge:search']],
        ['wiki-materialization', 'Wiki 生成：将知识图谱整理为可读知识文档。', ['publish_artifact']],
        ['graph-projection', '图谱投影：生成前端可视化所需的节点和边数据。', ['knowledge:listGraph', 'publish_artifact']],
      ]],
      ['builtin.researcher', [
        ['information-retrieval', '信息检索：搜索、筛选并排序与任务相关的资料。', ['knowledge:search']],
        ['source-analysis', '来源分析：评估可靠性并交叉验证不同来源。', ['knowledge:search']],
      ]],
    ] as const;
    const legacyInsert = this.db.prepare(
      `INSERT OR IGNORE INTO skills (id, name, description, prompt_md, required_capabilities_json, enabled, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    );
    const legacyBind = this.db.prepare(
      'INSERT OR IGNORE INTO agent_skills (agent_definition_id, agent_definition_version, skill_id, ordinal) VALUES (?, ?, ?, ?)',
    );
    const packageInsert = this.db.prepare(
      `INSERT OR IGNORE INTO skill_packages (id, version, name, description, package_rel_path, entry_rel_path, manifest_json, checksum, source, enabled, installed_at, updated_at)
       VALUES (?, '1.0.0', ?, ?, '', 'SKILL.md', ?, ?, 'legacy', 1, ?, ?)`,
    );
    const packageBind = this.db.prepare(
      `INSERT OR IGNORE INTO agent_definition_skills (agent_definition_id, agent_definition_version, skill_id, skill_version, ordinal, config_json)
       VALUES (?, '1.0.0', ?, '1.0.0', ?, NULL)`,
    );
    this.db.transaction(() => {
      for (const [definitionId, skills] of definitions) {
        skills.forEach(([name, description, requiredTools], ordinal) => {
          const instructions = `# ${name}\n\n${description}`;
          const manifest: SkillPackageManifest = { schemaVersion: 1, id: name, version: '1.0.0', entry: 'SKILL.md', executionMode: 'instructions', requiredTools: [...requiredTools], instructions };
          legacyInsert.run(`skill.${name}`, name, description, instructions, JSON.stringify(requiredTools), now, now);
          legacyBind.run(definitionId, '1.0.0', `skill.${name}`, ordinal);
          packageInsert.run(name, name, description, JSON.stringify(manifest), checksum(instructions, JSON.stringify(manifest)), now, now);
          packageBind.run(definitionId, name, ordinal);
        });
      }
    })();
    getLogger()?.info('SkillRegistry: 内置技能与版本化绑定已安装');
  }
}
