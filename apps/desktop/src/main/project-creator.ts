import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  ProjectRepository,
  AgentInstanceRepository,
  AgentProfileRepository,
  AgentDefinitionRepository,
  MessageRepository,
} from '@kunqing/database';
import { getProjectRoot, getStudioRoot } from './paths';
import { ensureAgentIdentityFiles } from './agent-identity';
export { validateEffectivePermissions, type PermissionDefinition } from './permission-validator';

const ORCHESTRATOR_PROFILE_ID = 'builtin-orchestrator-profile';
const KNOWLEDGE_PROFILE_ID = 'builtin-knowledge-profile';
const RESEARCHER_PROFILE_ID = 'builtin-researcher-profile';
const MATERIAL_WRITER_PROFILE_ID = 'builtin-material-writer-profile';
const ACCEPTANCE_REVIEWER_PROFILE_ID = 'builtin-acceptance-reviewer-profile';

function extractProjectName(text: string, templateId?: string): string {
  if (templateId) {
    const names: Record<string, string> = {
      'financial-audit': '财务审计协同',
      'market-research': '市场调研小组',
      'rd-collaboration': '智能研发协作',
      'creative-workshop': '创意营销工坊',
    };
    return names[templateId] ?? '新项目';
  }
  const stripped = text.replace(/[\r\n]/g, ' ').trim();
  if (!stripped) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `新对话 - ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
  return stripped.slice(0, 24);
}

function generateUlid(): string {
  return randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
}

function generateInstanceId(projectId: string, suffix: string): string {
  return `${projectId}-${suffix}`;
}

export async function ensureProjectAgentFiles(db: Database.Database, projectId: string): Promise<void> {
  const now = new Date().toISOString();
  const projectRoot = getProjectRoot(projectId);
  db.prepare(
    `UPDATE project_agent_instances
     SET identity_rel_path = COALESCE(identity_rel_path, 'agent-identities/' || id || '/IDENTITY.md'),
         memory_rel_path = COALESCE(memory_rel_path, 'agent-memories/' || id)
     WHERE project_id = ?`,
  ).run(projectId);
  const instances = db.prepare(
    `SELECT pai.id, pai.role, pai.runtime_mode as runtimeMode, pai.definition_id as definitionId,
            pai.definition_version as definitionVersion, ap.name
     FROM project_agent_instances pai
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE pai.project_id = ? ORDER BY pai.ordinal`,
  ).all(projectId) as Array<{ id: string; role: string; runtimeMode: string; definitionId: string; definitionVersion: string; name: string }>;

  for (const instance of instances) {
    const identityRoot = join(projectRoot, 'agent-identities', instance.id);
    const memoryRoot = join(projectRoot, 'agent-memories', instance.id);
    await Promise.all([
      mkdir(identityRoot, { recursive: true }),
      mkdir(join(memoryRoot, 'short-term'), { recursive: true }),
      mkdir(join(memoryRoot, 'sessions'), { recursive: true }),
      mkdir(join(memoryRoot, 'long-term'), { recursive: true }),
    ]);
    await ensureAgentIdentityFiles({
      projectId,
      instanceId: instance.id,
      name: instance.name,
      role: instance.role,
      runtimeMode: instance.runtimeMode,
      definitionId: instance.definitionId,
      definitionVersion: instance.definitionVersion ?? '1.0.0',
    });
    const currentPath = join(memoryRoot, 'short-term', 'current.md');
    try { await access(currentPath); } catch {
      await writeFile(currentPath, `---\nschemaVersion: 1\nscope: short-term\nupdatedAt: ${now}\n---\n\n# 当前任务记忆\n\n暂无活跃任务。\n`, 'utf8');
    }
    const longTermPath = join(memoryRoot, 'long-term', 'summary.md');
    try { await access(longTermPath); } catch {
      await writeFile(longTermPath, `---\nschemaVersion: 1\nscope: long-term\nupdatedAt: ${now}\n---\n\n# 长期记忆摘要\n\n暂无长期记忆。\n`, 'utf8');
    }
    const indexPath = join(memoryRoot, 'index.jsonl');
    try { await access(indexPath); } catch { await writeFile(indexPath, '', 'utf8'); }
  }
}

export async function addProjectAgents(
  db: Database.Database,
  projectId: string,
  requestedProfileIds: string[],
): Promise<Array<{ id: string; projectId: string; agentName: string; role: string; runtimeMode: string }>> {
  const instanceRepo = new AgentInstanceRepository(db);
  const existing = instanceRepo.listByProject(projectId);
  const existingProfileIds = new Set(existing.map((instance) => instance.agentProfileId));
  const uniqueRequestedIds = [...new Set(requestedProfileIds)].filter((id) => !existingProfileIds.has(id));

  if (existing.length + uniqueRequestedIds.length > 9) {
    throw new Error('每个群聊最多可添加 9 个智能体');
  }

  if (uniqueRequestedIds.length > 0) {
    const placeholders = uniqueRequestedIds.map(() => '?').join(',');
    const profiles = db.prepare(
      `SELECT id, name, definition_id as definitionId, definition_version as definitionVersion,
              runtime_mode as runtimeMode, cli_connection_id as cliConnectionId
       FROM agent_profiles
       WHERE enabled = 1 AND id IN (${placeholders})
       ORDER BY name`,
    ).all(...uniqueRequestedIds) as Array<{
      id: string;
      name: string;
      definitionId: string;
      definitionVersion: string;
      runtimeMode: 'native-model' | 'external-cli';
      cliConnectionId: string | null;
    }>;

    if (profiles.length !== uniqueRequestedIds.length) {
      throw new Error('部分智能体不可用，请刷新列表后重试');
    }

    db.transaction(() => {
      let ordinal = existing.reduce((max, instance) => Math.max(max, instance.ordinal), -1) + 1;
      for (const profile of profiles) {
        if (profile.runtimeMode === 'external-cli' && !profile.cliConnectionId) {
          throw new Error(`${profile.name} 尚未完成 CLI 连接配置`);
        }
        const instanceId = generateInstanceId(projectId, `agent-${generateUlid().slice(0, 10)}`);
        instanceRepo.create({
          id: instanceId,
          projectId,
          agentProfileId: profile.id,
          definitionId: profile.definitionId,
          definitionVersion: profile.definitionVersion,
          role: 'teammate',
          runtimeMode: profile.runtimeMode,
          ...(profile.cliConnectionId ? { cliConnectionId: profile.cliConnectionId } : {}),
          identityRelPath: `agent-identities/${instanceId}/IDENTITY.md`,
          memoryRelPath: `agent-memories/${instanceId}`,
          ordinal: ordinal++,
        });
      }
    })();

    await ensureProjectAgentFiles(db, projectId);
  }

  return db.prepare(
    `SELECT pai.id, pai.project_id as projectId, ap.name as agentName, pai.role, pai.runtime_mode as runtimeMode
     FROM project_agent_instances pai
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE pai.project_id = ? ORDER BY pai.ordinal`,
  ).all(projectId) as Array<{ id: string; projectId: string; agentName: string; role: string; runtimeMode: string }>;
}

const SAFE_FILENAME_RE = /^[a-zA-Z0-9._\u4e00-\u9fff -]+$/;
const MAX_FILENAME_BYTES = 240;

export function safeFileName(name: string): string {
  const base = basename(name).trim();
  if (!base || base === '.' || base === '..') return 'untitled';
  const safe = base.replace(/[^a-zA-Z0-9.\u4e00-\u9fff _-]/g, '_').substring(0, MAX_FILENAME_BYTES);
  return safe;
}

async function nextPath(dir: string, fileName: string): Promise<string> {
  const extIdx = fileName.lastIndexOf('.');
  const stem = extIdx > 0 ? fileName.slice(0, extIdx) : fileName;
  const ext = extIdx > 0 ? fileName.slice(extIdx) : '';
  let candidate = join(dir, fileName);
  for (let i = 1; ; i++) {
    try {
      await access(candidate);
      candidate = join(dir, `${stem} (${i})${ext}`);
    } catch {
      return candidate;
    }
  }
}

export async function createProject(
  db: Database.Database,
  input: {
    idempotencyKey?: string;
    content: { schemaVersion?: number; text?: string; mentions?: unknown[]; stagedUploadIds?: string[] };
    templateId?: string;
    requestedAgentProfileIds?: string[];
  },
): Promise<{ ok: true; data: { id: string; status: string; createdAt: string; firstMessageId?: string } } | { ok: false; error: { code: string; message: string; retryable: boolean } }> {
  if (input.idempotencyKey) {
    const existing = db.prepare(
      `SELECT result_json FROM idempotency_requests WHERE key = ? AND operation = 'projects:create'`,
    ).get(input.idempotencyKey) as { result_json: string } | undefined;
    if (existing) return JSON.parse(existing.result_json) as { ok: true; data: { id: string; status: string; createdAt: string; firstMessageId?: string } };
  }

  const projectId = generateUlid();
  const now = new Date().toISOString();
  const contentText = input.content?.text ?? '';
  const projectName = extractProjectName(contentText, input.templateId);

  const orchInstanceId = generateInstanceId(projectId, 'orch');
  const knowInstanceId = generateInstanceId(projectId, 'know');
  const resInstanceId = generateInstanceId(projectId, 'res');
  const writerInstanceId = generateInstanceId(projectId, 'writer');
  const reviewerInstanceId = generateInstanceId(projectId, 'reviewer');
  const projectRoot = getProjectRoot(projectId);

  const projectRepo = new ProjectRepository(db);
  const instanceRepo = new AgentInstanceRepository(db);
  const profileRepo = new AgentProfileRepository(db);
  const messageRepo = new MessageRepository(db);

  let fsCreated = false;
  const copiedStagedFiles: string[] = [];

  try {
    db.exec('BEGIN IMMEDIATE');

    projectRepo.create(projectName, projectId);

    const leaderProfile = profileRepo.getById(ORCHESTRATOR_PROFILE_ID);
    const knowledgeProfile = profileRepo.getById(KNOWLEDGE_PROFILE_ID);
    const researcherProfile = profileRepo.getById(RESEARCHER_PROFILE_ID);
    const materialWriterProfile = profileRepo.getById(MATERIAL_WRITER_PROFILE_ID);
    const acceptanceReviewerProfile = profileRepo.getById(ACCEPTANCE_REVIEWER_PROFILE_ID);

    instanceRepo.create({
      id: orchInstanceId,
      projectId,
      agentProfileId: leaderProfile.id,
      definitionId: leaderProfile.definitionId,
      definitionVersion: leaderProfile.definitionVersion,
      role: 'leader',
      runtimeMode: 'native-model',
      identityRelPath: `agent-identities/${orchInstanceId}/IDENTITY.md`,
      memoryRelPath: `agent-memories/${orchInstanceId}`,
      ordinal: 0,
    });

    instanceRepo.create({
      id: knowInstanceId,
      projectId,
      agentProfileId: knowledgeProfile.id,
      definitionId: knowledgeProfile.definitionId,
      definitionVersion: knowledgeProfile.definitionVersion,
      role: 'teammate',
      runtimeMode: 'native-model',
      identityRelPath: `agent-identities/${knowInstanceId}/IDENTITY.md`,
      memoryRelPath: `agent-memories/${knowInstanceId}`,
      ordinal: 1,
    });

    instanceRepo.create({
      id: resInstanceId,
      projectId,
      agentProfileId: researcherProfile.id,
      definitionId: researcherProfile.definitionId,
      definitionVersion: researcherProfile.definitionVersion,
      role: 'teammate',
      runtimeMode: 'native-model',
      identityRelPath: `agent-identities/${resInstanceId}/IDENTITY.md`,
      memoryRelPath: `agent-memories/${resInstanceId}`,
      ordinal: 2,
    });

    instanceRepo.create({
      id: writerInstanceId,
      projectId,
      agentProfileId: materialWriterProfile.id,
      definitionId: materialWriterProfile.definitionId,
      definitionVersion: materialWriterProfile.definitionVersion,
      role: 'teammate',
      runtimeMode: 'native-model',
      identityRelPath: `agent-identities/${writerInstanceId}/IDENTITY.md`,
      memoryRelPath: `agent-memories/${writerInstanceId}`,
      ordinal: 3,
    });

    instanceRepo.create({
      id: reviewerInstanceId,
      projectId,
      agentProfileId: acceptanceReviewerProfile.id,
      definitionId: acceptanceReviewerProfile.definitionId,
      definitionVersion: acceptanceReviewerProfile.definitionVersion,
      role: 'teammate',
      runtimeMode: 'native-model',
      identityRelPath: `agent-identities/${reviewerInstanceId}/IDENTITY.md`,
      memoryRelPath: `agent-memories/${reviewerInstanceId}`,
      ordinal: 4,
    });

    // 仅创建用户选择的 CLI 智能体（排除内置智能体 profile ID）
    const BUILTIN_PROFILE_IDS = new Set([
      ORCHESTRATOR_PROFILE_ID,  // 'builtin-orchestrator-profile'
      KNOWLEDGE_PROFILE_ID,     // 'builtin-knowledge-profile'
      RESEARCHER_PROFILE_ID,    // 'builtin-researcher-profile'
      MATERIAL_WRITER_PROFILE_ID,
      ACCEPTANCE_REVIEWER_PROFILE_ID,
    ]);
    const requestedIds = input.requestedAgentProfileIds ?? [];
    const cliRequestedIds = requestedIds.filter((id) => !BUILTIN_PROFILE_IDS.has(id));
    if (cliRequestedIds.length > 4) {
      throw new Error('群聊已包含 5 个内置智能体，最多还能添加 4 个外部智能体');
    }

    if (cliRequestedIds.length > 0) {
      const placeholders = cliRequestedIds.map(() => '?').join(',');
      const cliProfiles = db.prepare(
        `SELECT id, name, definition_id as definitionId, definition_version as definitionVersion,
                cli_connection_id as cliConnectionId
         FROM agent_profiles
         WHERE runtime_mode = 'external-cli' AND enabled = 1 AND cli_connection_id IS NOT NULL
           AND id IN (${placeholders})
         ORDER BY name`,
      ).all(...cliRequestedIds) as Array<{ id: string; name: string; definitionId: string; definitionVersion: string; cliConnectionId: string }>;

      let cliOrdinal = 5;
      for (const cliProfile of cliProfiles) {
        const cliInstanceId = generateInstanceId(projectId, `cli-${cliProfile.id.slice(0, 8)}`);
        instanceRepo.create({
          id: cliInstanceId,
          projectId,
          agentProfileId: cliProfile.id,
          definitionId: cliProfile.definitionId,
          definitionVersion: cliProfile.definitionVersion,
          role: 'teammate',
          runtimeMode: 'external-cli',
          cliConnectionId: cliProfile.cliConnectionId,
          identityRelPath: `agent-identities/${cliInstanceId}/IDENTITY.md`,
          memoryRelPath: `agent-memories/${cliInstanceId}`,
          ordinal: cliOrdinal++,
        });
      }
    }

    const stagedUploadIds = input.content?.stagedUploadIds ?? [];
    let firstMessageId: string | undefined;
    if (contentText) {
      const contentJson = JSON.stringify({ schemaVersion: 1, text: contentText, mentions: input.content?.mentions ?? [], stagedUploadIds });
      firstMessageId = messageRepo.createUserMessage(projectId, contentJson).id;
    }

    const allInstances = db.prepare(
      `SELECT pai.id, pai.role, pai.runtime_mode as runtimeMode, pai.definition_id as definitionId,
              pai.definition_version as definitionVersion, ap.name
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.project_id = ? ORDER BY pai.ordinal`,
    ).all(projectId) as Array<{ id: string; role: string; runtimeMode: string; definitionId: string; definitionVersion: string; name: string }>;

    await mkdir(join(projectRoot, 'original-files'), { recursive: true });
    await mkdir(join(projectRoot, 'knowledge', 'graph', 'schema'), { recursive: true });
    await mkdir(join(projectRoot, 'knowledge', 'wiki', 'entities'), { recursive: true });
    await mkdir(join(projectRoot, 'knowledge', 'wiki', 'topics'), { recursive: true });
    await mkdir(join(projectRoot, 'graph-visualization', 'layouts'), { recursive: true });
    await mkdir(join(projectRoot, 'graph-visualization', 'exports'), { recursive: true });
    await mkdir(join(projectRoot, 'outputs'), { recursive: true });
    await mkdir(join(projectRoot, '.runtime', 'trash'), { recursive: true });
    await mkdir(join(projectRoot, '.runtime', 'versions'), { recursive: true });
    await mkdir(join(projectRoot, '.runtime', 'run-temp'), { recursive: true });
    await mkdir(join(projectRoot, '.runtime', 'sandboxes'), { recursive: true });
    await mkdir(join(projectRoot, '.runtime', 'review-drafts'), { recursive: true });

    for (const instance of allInstances) {
      const instId = instance.id;
      const memRoot = join(projectRoot, 'agent-memories', instId);
      const curPath = join(memRoot, 'short-term', 'current.md');
      const longPath = join(memRoot, 'long-term', 'summary.md');
      const idxPath = join(memRoot, 'index.jsonl');
      await mkdir(join(memRoot, 'short-term'), { recursive: true });
      await mkdir(join(memRoot, 'sessions'), { recursive: true });
      await mkdir(join(memRoot, 'long-term'), { recursive: true });
      await ensureAgentIdentityFiles({
        projectId,
        instanceId: instId,
        name: instance.name,
        role: instance.role,
        runtimeMode: instance.runtimeMode,
        definitionId: instance.definitionId,
        definitionVersion: instance.definitionVersion ?? '1.0.0',
      });
      try { await access(curPath); } catch { await writeFile(curPath, `---\nschemaVersion: 1\nmemoryId: current\ntype: summary\nscope: short-term\nconfidence: 1\ncreatedAt: ${now}\nupdatedAt: ${now}\n---\n\n# 当前会话\n\n群聊已创建，等待首次对话。\n`, 'utf8'); }
      try { await access(longPath); } catch { await writeFile(longPath, `---\nschemaVersion: 1\nscope: long-term\nupdatedAt: ${now}\n---\n\n# 长期记忆摘要\n\n暂无长期记忆。\n`, 'utf8'); }
      try { await access(idxPath); } catch { await writeFile(idxPath, '', 'utf8'); }
    }

    fsCreated = true;

    const publicName = projectName.replace(/[\r\n]/g, ' ').trim() || projectId;
    await writeFile(join(projectRoot, 'group.yaml'), `schemaVersion: 1\nprojectId: ${projectId}\nname: ${JSON.stringify(publicName)}\n`, 'utf8');

    if (stagedUploadIds.length > 0) {
      const studioRoot = getStudioRoot();
      const stagingRoot = join(studioRoot, '.kstudio', 'temp', 'staged-uploads');
      const originalFilesDir = join(projectRoot, 'original-files');

      for (const stagedId of stagedUploadIds) {
        const srcPath = join(stagingRoot, stagedId);
        const metaPath = join(stagingRoot, `${stagedId}.meta`);
        let originalName = stagedId;
        try {
          const metaRaw = await readFile(metaPath, 'utf8');
          const meta = JSON.parse(metaRaw) as { originalName: string };
          if (meta.originalName) originalName = meta.originalName;
        } catch { /* fallback to stagedId as filename */ }
        const safeName = safeFileName(originalName);
        const destPath = await nextPath(originalFilesDir, safeName);
        await copyFile(srcPath, destPath);
        copiedStagedFiles.push(destPath);
      }
    }

    db.exec('COMMIT');

    const returnData: { id: string; status: string; createdAt: string; firstMessageId?: string } = { id: projectId, status: 'active' as const, createdAt: now };
    if (firstMessageId) returnData.firstMessageId = firstMessageId;
    if (input.idempotencyKey) {
      const result = { ok: true as const, data: returnData };
      db.prepare(
        `INSERT OR IGNORE INTO idempotency_requests (key, operation, request_hash, result_json, expires_at, created_at)
         VALUES (?, 'projects:create', '', ?, datetime('now', '+24 hours'), ?)`,
      ).run(input.idempotencyKey, JSON.stringify(result), now);
    }

    return { ok: true as const, data: returnData };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    if (fsCreated) {
      try {
        const { rm, unlink } = await import('node:fs/promises');
        if (copiedStagedFiles.length > 0) {
          await Promise.all(copiedStagedFiles.map((f) => unlink(f).catch(() => {})));
        }
        await rm(projectRoot, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false as const, error: { code: 'INTERNAL_ERROR', message, retryable: false } };
  }
}

export const FAKE_PROVIDER_ID = 'fake-provider';
export const FAKE_REASONING_PROFILE_ID = 'fake-reasoning-profile';
export const FAKE_FAST_PROFILE_ID = 'fake-fast-profile';

export function seedFakeModelProvider(db: Database.Database): void {
  const now = new Date().toISOString();

  // 检查是否已存在
  const existing = db.prepare('SELECT id FROM model_providers WHERE id = ?').get(FAKE_PROVIDER_ID) as { id: string } | undefined;
  if (existing) return;

  // 1. 创建 fake model_provider（openai 兼容，无密钥）
  db.prepare(
    `INSERT INTO model_providers (id, name, type, base_url, auth_type, secret_ref, config_json, status, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?)`,
  ).run(FAKE_PROVIDER_ID, 'Fake Provider', 'openai', 'http://localhost:9999/v1', 'none', null, null, now);

  // 2. 创建两个 model_profiles（reasoning + fast 槽位）
  db.prepare(
    `INSERT OR IGNORE INTO model_profiles (id, name, provider_id, model_id, model_slot, parameters_json, declared_capabilities_json, verified_capabilities_json, capability_tested_at, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    FAKE_REASONING_PROFILE_ID, 'Fake Reasoning', FAKE_PROVIDER_ID, 'gpt-4o', 'reasoning',
    JSON.stringify({ temperature: 0.7, maxTokens: 4096 }),
    JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']),
    JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']),
    now,
  );

  db.prepare(
    `INSERT OR IGNORE INTO model_profiles (id, name, provider_id, model_id, model_slot, parameters_json, declared_capabilities_json, verified_capabilities_json, capability_tested_at, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    FAKE_FAST_PROFILE_ID, 'Fake Fast', FAKE_PROVIDER_ID, 'gpt-4o-mini', 'fast',
    JSON.stringify({ temperature: 0.3, maxTokens: 2048 }),
    JSON.stringify(['streaming']),
    JSON.stringify(['streaming']),
    now,
  );

  // 3. 绑定槽位
  db.prepare(
    `INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)`,
  ).run('reasoning', FAKE_REASONING_PROFILE_ID, now);

  db.prepare(
    `INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)`,
  ).run('fast', FAKE_FAST_PROFILE_ID, now);
}

export async function seedDefaultProfiles(db: Database.Database): Promise<void> {
  const now = new Date().toISOString();
  const profileRepo = new AgentProfileRepository(db);
  const defRepo = new AgentDefinitionRepository(db);

  const existingDefs = defRepo.list();
  const hasOrchDef = existingDefs.some((d) => d.id === 'builtin.orchestrator');
  const hasKnowDef = existingDefs.some((d) => d.id === 'builtin.knowledge-manager');

  if (!hasOrchDef) {
    defRepo.create({
      id: 'builtin.orchestrator',
      kind: 'built-in',
      isBuiltin: true,
      manifestRelPath: 'agents/builtin-orchestrator/manifest.json',
      maxPermissionsJson: JSON.stringify({
        read: ['group.original-files', 'group.knowledge', 'shared.knowledge', 'group.messages'],
        write: ['self.memory', 'group.outputs'],
        network: 'model-gateway-only',
        shell: 'deny',
      }),
      modelRequirementsJson: JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']),
    });
  }

  if (!hasKnowDef) {
    defRepo.create({
      id: 'builtin.knowledge-manager',
      kind: 'built-in',
      isBuiltin: true,
      manifestRelPath: 'agents/builtin-knowledge-manager/manifest.json',
      maxPermissionsJson: JSON.stringify({
        read: ['group.original-files', 'group.knowledge', 'shared.knowledge', 'group.messages'],
        write: ['self.memory', 'group.outputs', 'group.knowledge'],
        network: 'model-gateway-only',
        shell: 'deny',
      }),
      modelRequirementsJson: JSON.stringify(['streaming']),
    });
  }

  const hasResDef = existingDefs.some((d) => d.id === 'builtin.researcher');
  if (!hasResDef) {
    defRepo.create({
      id: 'builtin.researcher',
      kind: 'built-in',
      isBuiltin: true,
      manifestRelPath: 'agents/builtin-researcher/manifest.json',
      maxPermissionsJson: JSON.stringify({
        read: ['group.knowledge', 'group.messages'],
        write: ['self.memory'],
        network: 'model-gateway-only',
        shell: 'deny',
      }),
      modelRequirementsJson: JSON.stringify(['streaming']),
    });
  }

  const hasWriterDef = existingDefs.some((d) => d.id === 'builtin.material-writer');
  if (!hasWriterDef) {
    defRepo.create({
      id: 'builtin.material-writer',
      kind: 'built-in',
      isBuiltin: true,
      manifestRelPath: 'agents/builtin-material-writer/manifest.json',
      maxPermissionsJson: JSON.stringify({
        read: ['group.original-files', 'group.knowledge', 'shared.knowledge', 'group.messages'],
        write: ['self.memory', 'group.review-drafts'],
        network: 'model-gateway-only',
        shell: 'deny',
      }),
      modelRequirementsJson: JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']),
    });
  }

  const hasReviewerDef = existingDefs.some((d) => d.id === 'builtin.acceptance-reviewer');
  if (!hasReviewerDef) {
    defRepo.create({
      id: 'builtin.acceptance-reviewer',
      kind: 'built-in',
      isBuiltin: true,
      manifestRelPath: 'agents/builtin-acceptance-reviewer/manifest.json',
      maxPermissionsJson: JSON.stringify({
        read: ['group.original-files', 'group.knowledge', 'shared.knowledge', 'group.messages', 'group.review-drafts'],
        write: ['self.memory'],
        network: 'model-gateway-only',
        shell: 'deny',
      }),
      modelRequirementsJson: JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']),
    });
  }

  const existing = db.prepare('SELECT definition_id as definitionId FROM agent_profiles').all() as Array<{ definitionId: string }>;
  const hasOrch = existing.some((p) => p.definitionId === 'builtin.orchestrator');
  const hasKnow = existing.some((p) => p.definitionId === 'builtin.knowledge-manager');
  const hasRes = existing.some((p) => p.definitionId === 'builtin.researcher');
  const hasWriter = existing.some((p) => p.definitionId === 'builtin.material-writer');
  const hasReviewer = existing.some((p) => p.definitionId === 'builtin.acceptance-reviewer');

  if (!hasOrch) {
    db.prepare(
      `INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`,
    ).run(ORCHESTRATOR_PROFILE_ID, '统筹管理智能体', 'builtin.orchestrator', '1.0.0', 'native-model', now, now);
  }

  if (!hasKnow) {
    db.prepare(
      `INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`,
    ).run(KNOWLEDGE_PROFILE_ID, '知识管理智能体', 'builtin.knowledge-manager', '1.0.0', 'native-model', now, now);
  }

  if (!hasRes) {
    db.prepare(
      `INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`,
    ).run(RESEARCHER_PROFILE_ID, '资料调研智能体', 'builtin.researcher', '1.0.0', 'native-model', now, now);
  }

  if (!hasWriter) {
    db.prepare(
      `INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`,
    ).run(MATERIAL_WRITER_PROFILE_ID, '材料编写智能体', 'builtin.material-writer', '1.0.0', 'native-model', now, now);
  }

  if (!hasReviewer) {
    db.prepare(
      `INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`,
    ).run(ACCEPTANCE_REVIEWER_PROFILE_ID, '验收智能体', 'builtin.acceptance-reviewer', '1.0.0', 'native-model', now, now);
  }

  // 历史群聊在容量允许时补齐官方写作/验收角色。两者作为一个闭环补充，
  // 不会为了塞入单个角色而突破每群 9 个智能体的上限。
  const projects = db.prepare("SELECT id FROM projects WHERE status != 'archived' ORDER BY created_at").all() as Array<{ id: string }>;
  const builtinAdditions = [
    { profileId: MATERIAL_WRITER_PROFILE_ID, suffix: 'writer', definitionId: 'builtin.material-writer' },
    { profileId: ACCEPTANCE_REVIEWER_PROFILE_ID, suffix: 'reviewer', definitionId: 'builtin.acceptance-reviewer' },
  ];
  const touchedProjects: string[] = [];
  for (const project of projects) {
    const instances = new AgentInstanceRepository(db).listByProject(project.id);
    const existingProfileIds = new Set(instances.map((instance) => instance.agentProfileId));
    const missing = builtinAdditions.filter((item) => !existingProfileIds.has(item.profileId));
    if (missing.length === 0 || instances.length + missing.length > 9) continue;
    let ordinal = instances.reduce((max, instance) => Math.max(max, instance.ordinal), -1) + 1;
    for (const item of missing) {
      const profile = profileRepo.getById(item.profileId);
      const instanceId = generateInstanceId(project.id, item.suffix);
      new AgentInstanceRepository(db).create({
        id: instanceId,
        projectId: project.id,
        agentProfileId: profile.id,
        definitionId: item.definitionId,
        definitionVersion: profile.definitionVersion,
        role: 'teammate',
        runtimeMode: 'native-model',
        identityRelPath: `agent-identities/${instanceId}/IDENTITY.md`,
        memoryRelPath: `agent-memories/${instanceId}`,
        ordinal: ordinal++,
      });
    }
    touchedProjects.push(project.id);
  }
  for (const projectId of touchedProjects) await ensureProjectAgentFiles(db, projectId);
}

/** 根据 agent_instance_id 解析当前 slot 绑定的模型快照，用于 Run 创建时快照 */
  export function buildModelProfileSnapshot(db: Database.Database, agentInstanceId: string): string | null {
    const row = db.prepare(
      `SELECT ap.definition_id as definitionId
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = ?`,
    ).get(agentInstanceId) as { definitionId: string } | undefined;

    if (!row) return null;

    const slot = (row.definitionId === 'builtin.knowledge-manager' || row.definitionId === 'builtin.researcher') ? 'fast' : 'reasoning';

    const snapshot = db.prepare(
      `SELECT mp.id as profileId, mp.name as profileName, mp.model_id as modelId, mp.model_slot as modelSlot,
              mp.parameters_json as parametersJson, mp.verified_capabilities_json as verifiedCapabilitiesJson,
              prv.id as providerId, prv.name as providerName, prv.type as providerType, prv.base_url as baseUrl
       FROM model_slot_bindings msb
       JOIN model_profiles mp ON mp.id = msb.model_profile_id
       JOIN model_providers prv ON prv.id = mp.provider_id
       WHERE msb.slot = ? AND mp.enabled = 1`,
    ).get(slot) as {
      profileId: string; profileName: string; modelId: string; modelSlot: string | null;
      parametersJson: string | null; verifiedCapabilitiesJson: string | null;
      providerId: string; providerName: string; providerType: string; baseUrl: string | null;
    } | undefined;

    if (!snapshot) return null;

    return JSON.stringify({
      profileId: snapshot.profileId,
      profileName: snapshot.profileName,
      providerId: snapshot.providerId,
      providerName: snapshot.providerName,
      providerType: snapshot.providerType,
      baseUrl: snapshot.baseUrl,
      modelId: snapshot.modelId,
      modelSlot: snapshot.modelSlot,
      parameters: snapshot.parametersJson ? JSON.parse(snapshot.parametersJson) : null,
      capabilities: snapshot.verifiedCapabilitiesJson ? JSON.parse(snapshot.verifiedCapabilitiesJson) : null,
      capturedAt: new Date().toISOString(),
    });
  }
