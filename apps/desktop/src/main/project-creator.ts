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
import { getExternalAgentRole } from './external-agent-roles';
import { resolveRuntimeLimits } from './runtime-limits';
import { rebuildProjectCoordinationRegistry } from './coordination-registry';
export { validateEffectivePermissions, type PermissionDefinition } from './permission-validator';

const ORCHESTRATOR_PROFILE_ID = 'builtin-orchestrator-profile';
const KNOWLEDGE_PROFILE_ID = 'builtin-knowledge-profile';
const RESEARCHER_PROFILE_ID = 'builtin-researcher-profile';
const MATERIAL_WRITER_PROFILE_ID = 'builtin-material-writer-profile';
const ACCEPTANCE_REVIEWER_PROFILE_ID = 'builtin-acceptance-reviewer-profile';
export const LOCAL_EXECUTOR_PROFILE_ID = 'builtin-local-executor-profile';
const GM_PROFILE_ID = 'builtin-gm-profile';

/** 群聊挂载操作平台时使用的虚拟选择项前缀。实际 profile 会在首次挂载时持久化。 */
const OPERATION_PLATFORM_SELECTION_PREFIX = 'operation-platform:';

function operationProfileId(platformId: string): string {
  const safe = platformId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72);
  return `operation-profile-${safe}`;
}

type OperationPlatformContext = {
  id: string;
  name: string;
  url: string;
  description: string;
  skills: Array<{ name: string; description: string }>;
};

function getOperationPlatformContext(db: Database.Database, definitionId: string): OperationPlatformContext | undefined {
  if (!definitionId.startsWith('operation-agent-')) return undefined;
  const platform = db.prepare(
    `SELECT id, name, url, description
     FROM operation_platforms
     WHERE owner_agent_id = ? AND status = 'active' LIMIT 1`,
  ).get(definitionId) as Omit<OperationPlatformContext, 'skills'> | undefined;
  if (!platform) return undefined;
  const skills = db.prepare(
    `SELECT name, description FROM operation_skills
     WHERE platform_id = ? AND status = 'active' AND enabled = 1
     ORDER BY updated_at DESC`,
  ).all(platform.id) as Array<{ name: string; description: string }>;
  return { ...platform, skills };
}

function ensureOperationProfile(db: Database.Database, platformId: string, now: string): string {
  const platform = db.prepare(
    `SELECT id, owner_agent_id as ownerAgentId, name, model_profile_id as modelProfileId
     FROM operation_platforms WHERE id = ? AND status = 'active'`,
  ).get(platformId) as { id: string; ownerAgentId: string; name: string; modelProfileId: string | null } | undefined;
  if (!platform) throw new Error('操作平台不存在或已注销，请刷新列表后重试');
  if (!platform.modelProfileId?.trim()) throw new Error(`操作平台“${platform.name}”尚未绑定模型，无法加入群聊`);

  const profileId = operationProfileId(platform.id);
  db.prepare(
    `INSERT INTO agent_profiles
       (id, name, definition_id, definition_version, runtime_mode, model_profile_id,
        enabled, delegatable, is_system_default, created_at, updated_at)
     VALUES (?, ?, ?, '1.0.0', 'native-model', ?, 1, 1, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name,
       definition_id = excluded.definition_id, runtime_mode = 'native-model',
       model_profile_id = excluded.model_profile_id, enabled = 1, delegatable = 1,
       updated_at = excluded.updated_at`,
  ).run(profileId, `${platform.name}操作智能体`, platform.ownerAgentId, platform.modelProfileId, now, now);
  return profileId;
}

const DEFAULT_TEAM_PROFILE_IDS = [
  ORCHESTRATOR_PROFILE_ID,
  LOCAL_EXECUTOR_PROFILE_ID,
] as const;

const LEGACY_PROFILE_ALIASES: Record<string, string> = {
  orchestrator: ORCHESTRATOR_PROFILE_ID,
  knowledge: LOCAL_EXECUTOR_PROFILE_ID,
  researcher: LOCAL_EXECUTOR_PROFILE_ID,
  writer: LOCAL_EXECUTOR_PROFILE_ID,
  reviewer: LOCAL_EXECUTOR_PROFILE_ID,
  [KNOWLEDGE_PROFILE_ID]: LOCAL_EXECUTOR_PROFILE_ID,
  [RESEARCHER_PROFILE_ID]: LOCAL_EXECUTOR_PROFILE_ID,
  [MATERIAL_WRITER_PROFILE_ID]: LOCAL_EXECUTOR_PROFILE_ID,
  [ACCEPTANCE_REVIEWER_PROFILE_ID]: LOCAL_EXECUTOR_PROFILE_ID,
};

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
    const operationPlatform = getOperationPlatformContext(db, instance.definitionId);
    await ensureAgentIdentityFiles({
      projectId,
      instanceId: instance.id,
      name: instance.name,
      role: instance.role,
      runtimeMode: instance.runtimeMode,
      definitionId: instance.definitionId,
      definitionVersion: instance.definitionVersion ?? '1.0.0',
      ...(operationPlatform ? { operationPlatform } : {}),
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
  // Identity/COORDINATION files remain the editable public source. Compile
  // them once into a project-scoped registry so the leader can read the whole
  // team in one query instead of re-reading every member file on every turn.
  try {
    rebuildProjectCoordinationRegistry(db, projectId);
  } catch (error) {
    // Compatibility for isolated tests/repair utilities that intentionally
    // open a partial pre-031 schema. Normal application startup migrates
    // before identities are ensured, so real registry errors still surface.
    if (!(error instanceof Error) || !/no such table: project_agent_coordination/i.test(error.message)) throw error;
  }
}

export async function addProjectAgents(
  db: Database.Database,
  projectId: string,
  requestedProfileIds: string[],
): Promise<Array<{ id: string; projectId: string; agentName: string; role: string; runtimeMode: string }>> {
  if (requestedProfileIds.includes(GM_PROFILE_ID)) {
    throw new Error('GM 智能体是全局管理智能体，不能作为普通群聊成员添加');
  }
  const instanceRepo = new AgentInstanceRepository(db);
  const existing = instanceRepo.listByProject(projectId);
  const existingProfileIds = new Set(existing.map((instance) => instance.agentProfileId));

  // 操作平台不是普通全局 Profile：它拥有自己的模型、技能和工作区。
  // 这里为群聊创建一个轻量 profile 代理，definition_id 使用平台 ownerAgentId，
  // 执行器再通过 operation_platforms 找回真实平台运行器。
  const operationSelections = requestedProfileIds
    .filter((id) => id.startsWith(OPERATION_PLATFORM_SELECTION_PREFIX))
    .map((id) => id.slice(OPERATION_PLATFORM_SELECTION_PREFIX.length).trim())
    .filter(Boolean);
  if (operationSelections.length > 0) {
    const now = new Date().toISOString();
    const operationProfileIds = operationSelections.map((platformId) => ensureOperationProfile(db, platformId, now));
    requestedProfileIds = requestedProfileIds
      .filter((id) => !id.startsWith(OPERATION_PLATFORM_SELECTION_PREFIX))
      .concat(operationProfileIds);
  }
  const normalizedRequestedIds = requestedProfileIds.map((id) => LEGACY_PROFILE_ALIASES[id] ?? id);
  const uniqueRequestedIds = [...new Set(normalizedRequestedIds)].filter((id) => !existingProfileIds.has(id));
  const activeInstanceCount = (db.prepare(
    `SELECT COUNT(*) as count FROM project_agent_instances pai
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE pai.project_id = ? AND ap.enabled = 1`,
  ).get(projectId) as { count: number }).count;

  if (activeInstanceCount + uniqueRequestedIds.length > resolveRuntimeLimits(db).maxAgentsPerProject) {
    throw new Error(`每个群聊最多可添加 ${resolveRuntimeLimits(db).maxAgentsPerProject} 个智能体`);
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
     WHERE pai.project_id = ? AND ap.enabled = 1 ORDER BY pai.ordinal`,
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
    customName?: string;
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
  const projectName = input.customName?.replace(/[\r\n]/g, ' ').trim().slice(0, 40)
    || extractProjectName(contentText, input.templateId);

  const orchInstanceId = generateInstanceId(projectId, 'orch');
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

    // 未显式给出成员时初始化“统筹 + 本地执行”团队；首页 GM 和手动建群显式传入时，
    // 只初始化所选成员，并始终由统筹管理智能体担任 Leader。旧四角色统一迁移为本地执行智能体。
    const rawRequestedIds = input.requestedAgentProfileIds === undefined
      ? [...DEFAULT_TEAM_PROFILE_IDS]
      : input.requestedAgentProfileIds;
    const requestedIds = rawRequestedIds.map((id) => {
      if (id.startsWith(OPERATION_PLATFORM_SELECTION_PREFIX)) {
        const platformId = id.slice(OPERATION_PLATFORM_SELECTION_PREFIX.length).trim();
        if (!platformId) throw new Error('所选操作平台标识无效');
        return ensureOperationProfile(db, platformId, now);
      }
      return LEGACY_PROFILE_ALIASES[id] ?? id;
    });
    const selectedProfileIds = [...new Set([ORCHESTRATOR_PROFILE_ID, ...requestedIds])]
      .filter((id) => id !== GM_PROFILE_ID);
    if (selectedProfileIds.length > resolveRuntimeLimits(db).maxAgentsPerProject) throw new Error(`每个群聊最多可添加 ${resolveRuntimeLimits(db).maxAgentsPerProject} 个智能体`);

    let ordinal = 1;
    for (const profileId of selectedProfileIds) {
      if (profileId === ORCHESTRATOR_PROFILE_ID) continue;
      const profile = db.prepare(
        `SELECT id, definition_id as definitionId, definition_version as definitionVersion,
                runtime_mode as runtimeMode, cli_connection_id as cliConnectionId, enabled
         FROM agent_profiles WHERE id = ?`,
      ).get(profileId) as {
        id: string;
        definitionId: string;
        definitionVersion: string;
        runtimeMode: 'native-model' | 'external-cli';
        cliConnectionId: string | null;
        enabled: number;
      } | undefined;
      // 旧模板中可能带有已下线的占位 profile；忽略占位项但不影响建群。
      // 用户在创建弹窗中明确选择的操作平台则已在上面转换为持久 Profile，
      // 转换失败会直接报错，不能静默创建一个缺成员的群聊。
      if (!profile) continue;
      if (!profile.enabled) throw new Error('所选智能体当前不可用');
      if (profile.runtimeMode === 'external-cli' && !profile.cliConnectionId) {
        throw new Error('所选外部智能体尚未完成 CLI 连接配置');
      }
      const suffixByProfile: Record<string, string> = {
        [LOCAL_EXECUTOR_PROFILE_ID]: 'local',
      };
      const instanceId = generateInstanceId(projectId, suffixByProfile[profile.id] ?? `agent-${generateUlid().slice(0, 10)}`);
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
    await mkdir(join(projectRoot, 'templates'), { recursive: true });
    await mkdir(join(projectRoot, 'standardized-files'), { recursive: true });
    await mkdir(join(projectRoot, 'knowledge', 'graph', 'schema'), { recursive: true });
    await mkdir(join(projectRoot, 'knowledge', 'wiki', 'entities'), { recursive: true });
    await mkdir(join(projectRoot, 'knowledge', 'wiki', 'topics'), { recursive: true });
    await mkdir(join(projectRoot, 'graph-visualization', 'layouts'), { recursive: true });
    await mkdir(join(projectRoot, 'graph-visualization', 'exports'), { recursive: true });
    await mkdir(join(projectRoot, 'outputs'), { recursive: true });
    await mkdir(join(projectRoot, '.runtime', 'trash'), { recursive: true });
    await mkdir(join(projectRoot, 'temp'), { recursive: true });
    await mkdir(join(projectRoot, '.runtime', 'versions'), { recursive: true });
    await mkdir(join(projectRoot, '.runtime', 'run-temp'), { recursive: true });
    await mkdir(join(projectRoot, '.runtime', 'sandboxes'), { recursive: true });

    for (const instance of allInstances) {
      const instId = instance.id;
      const memRoot = join(projectRoot, 'agent-memories', instId);
      const curPath = join(memRoot, 'short-term', 'current.md');
      const longPath = join(memRoot, 'long-term', 'summary.md');
      const idxPath = join(memRoot, 'index.jsonl');
      await mkdir(join(memRoot, 'short-term'), { recursive: true });
      await mkdir(join(memRoot, 'sessions'), { recursive: true });
      await mkdir(join(memRoot, 'long-term'), { recursive: true });
      const operationPlatform = getOperationPlatformContext(db, instance.definitionId);
      await ensureAgentIdentityFiles({
        projectId,
        instanceId: instId,
        name: instance.name,
        role: instance.role,
        runtimeMode: instance.runtimeMode,
        definitionId: instance.definitionId,
        definitionVersion: instance.definitionVersion ?? '1.0.0',
        ...(operationPlatform ? { operationPlatform } : {}),
      });
      try { await access(curPath); } catch { await writeFile(curPath, `---\nschemaVersion: 1\nmemoryId: current\ntype: summary\nscope: short-term\nconfidence: 1\ncreatedAt: ${now}\nupdatedAt: ${now}\n---\n\n# 当前会话\n\n群聊已创建，等待首次对话。\n`, 'utf8'); }
      try { await access(longPath); } catch { await writeFile(longPath, `---\nschemaVersion: 1\nscope: long-term\nupdatedAt: ${now}\n---\n\n# 长期记忆摘要\n\n暂无长期记忆。\n`, 'utf8'); }
      try { await access(idxPath); } catch { await writeFile(idxPath, '', 'utf8'); }
    }

    fsCreated = true;

    const publicName = projectName.replace(/[\r\n]/g, ' ').trim() || projectId;
    await writeFile(
      join(projectRoot, 'group.yaml'),
      `schemaVersion: 1\nprojectId: ${projectId}\nname: ${JSON.stringify(publicName)}\nmembershipPolicy: ${input.requestedAgentProfileIds === undefined ? 'legacy-default' : 'selected'}\n`,
      'utf8',
    );

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
    `INSERT OR IGNORE INTO model_profiles (id, name, provider_id, model_id, parameters_json, declared_capabilities_json, verified_capabilities_json, capability_tested_at, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    FAKE_REASONING_PROFILE_ID, 'Fake Reasoning', FAKE_PROVIDER_ID, 'gpt-4o',
    JSON.stringify({ temperature: 0.7, maxTokens: 4096 }),
    JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']),
    JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']),
    now,
  );

  db.prepare(
    `INSERT OR IGNORE INTO model_profiles (id, name, provider_id, model_id, parameters_json, declared_capabilities_json, verified_capabilities_json, capability_tested_at, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    FAKE_FAST_PROFILE_ID, 'Fake Fast', FAKE_PROVIDER_ID, 'gpt-4o-mini',
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
  const hasLocalExecutorDef = existingDefs.some((d) => d.id === 'builtin.local-executor');
  const hasGmDef = existingDefs.some((d) => d.id === 'builtin.gm');

  if (!hasGmDef) {
    defRepo.create({
      id: 'builtin.gm',
      kind: 'built-in',
      isBuiltin: true,
      manifestRelPath: 'agents/builtin-gm/manifest.json',
      maxPermissionsJson: JSON.stringify({
        read: ['system.projects', 'system.agent-profiles', 'system.settings', 'group.original-files', 'group.knowledge', 'shared.knowledge', 'group.messages'],
        write: ['system.projects', 'system.project-members', 'system.project-names', 'system.plans'],
        administer: ['projects.create', 'projects.configure', 'agents.select'],
        network: 'model-gateway-only',
        shell: 'deny',
      }),
      modelRequirementsJson: JSON.stringify(['structuredOutput']),
    });
  }

  if (!hasOrchDef) {
    defRepo.create({
      id: 'builtin.orchestrator',
      kind: 'built-in',
      isBuiltin: true,
      manifestRelPath: 'agents/builtin-orchestrator/manifest.json',
      maxPermissionsJson: JSON.stringify({
        read: ['group.original-files', 'group.knowledge', 'shared.knowledge', 'group.messages', 'group.temp'],
        write: ['self.memory', 'group.outputs', 'group.temp'],
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
        read: ['group.original-files', 'project.original-files', 'shared.original-files', 'group.messages'],
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
        read: ['group.knowledge', 'group.messages', 'group.temp'],
        write: ['self.memory', 'group.temp'],
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
        read: ['group.original-files', 'group.templates', 'group.knowledge', 'project.templates', 'project.knowledge', 'shared.templates', 'shared.knowledge', 'group.messages', 'group.temp'],
        write: ['self.memory', 'group.temp'],
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
        read: ['group.original-files', 'group.templates', 'group.knowledge', 'project.templates', 'project.knowledge', 'shared.templates', 'shared.knowledge', 'group.messages', 'group.temp'],
        write: ['self.memory'],
        network: 'model-gateway-only',
        shell: 'deny',
      }),
      modelRequirementsJson: JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']),
    });
  }

  if (!hasLocalExecutorDef) {
    defRepo.create({
      id: 'builtin.local-executor',
      kind: 'built-in',
      isBuiltin: true,
      manifestRelPath: 'agents/builtin-local-executor/manifest.json',
      maxPermissionsJson: JSON.stringify({
        read: ['group.original-files', 'project.original-files', 'shared.original-files', 'group.templates', 'project.templates', 'shared.templates', 'group.knowledge', 'project.knowledge', 'shared.knowledge', 'group.messages', 'group.temp'],
        write: ['self.memory', 'group.knowledge', 'group.temp', 'group.outputs'],
        network: 'model-gateway-only',
        shell: 'deny',
      }),
      modelRequirementsJson: JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']),
    });
  }

  const updateBuiltinPermissions = db.prepare('UPDATE agent_definitions SET max_permissions_json = ? WHERE id = ?');
  updateBuiltinPermissions.run(JSON.stringify({
    read: ['group.original-files', 'group.knowledge', 'shared.knowledge', 'group.messages', 'group.temp'],
    write: ['self.memory', 'group.outputs', 'group.temp'],
    network: 'model-gateway-only',
    shell: 'deny',
  }), 'builtin.orchestrator');
  updateBuiltinPermissions.run(JSON.stringify({
    read: ['group.original-files', 'project.original-files', 'shared.original-files', 'group.templates', 'project.templates', 'shared.templates', 'group.knowledge', 'project.knowledge', 'shared.knowledge', 'group.messages', 'group.temp'],
    write: ['self.memory', 'group.knowledge', 'group.temp', 'group.outputs'],
    network: 'model-gateway-only',
    shell: 'deny',
  }), 'builtin.local-executor');
  updateBuiltinPermissions.run(JSON.stringify({
    read: ['group.original-files', 'project.original-files', 'shared.original-files', 'group.messages', 'group.temp'],
    write: ['self.memory', 'group.outputs', 'group.knowledge', 'group.temp'],
    network: 'model-gateway-only',
    shell: 'deny',
  }), 'builtin.knowledge-manager');
  updateBuiltinPermissions.run(JSON.stringify({
    read: ['group.knowledge', 'group.messages', 'group.temp'],
    write: ['self.memory', 'group.temp'],
    network: 'model-gateway-only',
    shell: 'deny',
  }), 'builtin.researcher');
  updateBuiltinPermissions.run(JSON.stringify({
    read: ['group.original-files', 'group.templates', 'group.knowledge', 'project.templates', 'project.knowledge', 'shared.templates', 'shared.knowledge', 'group.messages', 'group.temp'],
    write: ['self.memory', 'group.temp'],
    network: 'model-gateway-only',
    shell: 'deny',
  }), 'builtin.material-writer');
  updateBuiltinPermissions.run(JSON.stringify({
    read: ['group.original-files', 'group.templates', 'group.knowledge', 'project.templates', 'project.knowledge', 'shared.templates', 'shared.knowledge', 'group.messages', 'group.temp'],
    write: ['self.memory'],
    network: 'model-gateway-only',
    shell: 'deny',
  }), 'builtin.acceptance-reviewer');

  const existing = db.prepare('SELECT id, definition_id as definitionId FROM agent_profiles').all() as Array<{ id: string; definitionId: string }>;

  // Keep already connected external agents on the stable product role cards.
  // This is deliberately idempotent and only changes the definition identity;
  // it does not alter the user's connection, model, memories, or memberships.
  for (const row of db.prepare("SELECT ap.id, cc.adapter_type as adapterType FROM agent_profiles ap JOIN cli_connections cc ON cc.id = ap.cli_connection_id WHERE ap.runtime_mode = 'external-cli'").all() as Array<{ id: string; adapterType: string }>) {
    const role = getExternalAgentRole(row.adapterType);
    db.prepare('UPDATE agent_profiles SET definition_id = ?, updated_at = ? WHERE id = ? AND definition_id != ?').run(role.definitionId, now, row.id, role.definitionId);
  }
  const hasOrch = existing.some((p) => p.definitionId === 'builtin.orchestrator');
  const hasKnow = existing.some((p) => p.definitionId === 'builtin.knowledge-manager');
  const hasRes = existing.some((p) => p.definitionId === 'builtin.researcher');
  const hasWriter = existing.some((p) => p.definitionId === 'builtin.material-writer');
  const hasReviewer = existing.some((p) => p.definitionId === 'builtin.acceptance-reviewer');
  const hasLocalExecutor = existing.some((p) => p.id === LOCAL_EXECUTOR_PROFILE_ID);
  const hasGm = existing.some((p) => p.definitionId === 'builtin.gm');

  if (!hasGm) {
    db.prepare(
      `INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`,
    ).run(GM_PROFILE_ID, 'GM智能体', 'builtin.gm', '1.0.0', 'native-model', now, now);
  }

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

  if (!hasLocalExecutor) {
    const inherited = db.prepare(
      `SELECT model_profile_id as modelProfileId, overrides_json as overridesJson
       FROM agent_profiles
       WHERE id IN (?, ?, ?, ?)
       ORDER BY (model_profile_id IS NULL), CASE id WHEN ? THEN 0 WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END
       LIMIT 1`,
    ).get(
      MATERIAL_WRITER_PROFILE_ID,
      ACCEPTANCE_REVIEWER_PROFILE_ID,
      KNOWLEDGE_PROFILE_ID,
      RESEARCHER_PROFILE_ID,
      MATERIAL_WRITER_PROFILE_ID,
      ACCEPTANCE_REVIEWER_PROFILE_ID,
      KNOWLEDGE_PROFILE_ID,
    ) as { modelProfileId: string | null; overridesJson: string | null } | undefined;
    db.prepare(
      `INSERT INTO agent_profiles (
         id, name, definition_id, definition_version, runtime_mode,
         model_profile_id, overrides_json, enabled, delegatable, is_system_default, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`,
    ).run(
      LOCAL_EXECUTOR_PROFILE_ID,
      '本地执行智能体',
      'builtin.local-executor',
      '1.0.0',
      'native-model',
      inherited?.modelProfileId ?? null,
      inherited?.overridesJson ?? null,
      now,
      now,
    );
  } else {
    db.prepare(
      'UPDATE agent_profiles SET name = ?, enabled = 1, delegatable = 1, updated_at = ? WHERE id = ?',
    ).run('本地执行智能体', now, LOCAL_EXECUTOR_PROFILE_ID);
  }

  // 旧四角色仅保留 Profile 和实例用于历史消息回显；不再出现在成员池、设置页或调度上下文中。
  // 其能力已由 builtin.local-executor 的技能绑定承接。
  db.prepare(
    `UPDATE agent_profiles SET enabled = 0, delegatable = 0, is_system_default = 0, updated_at = ?
     WHERE id IN (?, ?, ?, ?)`,
  ).run(
    now,
    KNOWLEDGE_PROFILE_ID,
    RESEARCHER_PROFILE_ID,
    MATERIAL_WRITER_PROFILE_ID,
    ACCEPTANCE_REVIEWER_PROFILE_ID,
  );

  // 历史群聊只要曾包含任一旧专业角色，就补入一个本地执行实例。
  // 旧实例不删除，以保留历史消息发送者和既有记忆文件。
  const projects = db.prepare("SELECT id FROM projects WHERE status != 'archived' ORDER BY created_at").all() as Array<{ id: string }>;
  const touchedProjects: string[] = [];
  for (const project of projects) {
    const instances = new AgentInstanceRepository(db).listByProject(project.id);
    const existingProfileIds = new Set(instances.map((instance) => instance.agentProfileId));
    const hadLegacySpecialist = [
      KNOWLEDGE_PROFILE_ID,
      RESEARCHER_PROFILE_ID,
      MATERIAL_WRITER_PROFILE_ID,
      ACCEPTANCE_REVIEWER_PROFILE_ID,
    ].some((profileId) => existingProfileIds.has(profileId));
    if (!hadLegacySpecialist || existingProfileIds.has(LOCAL_EXECUTOR_PROFILE_ID)) continue;
    let ordinal = instances.reduce((max, instance) => Math.max(max, instance.ordinal), -1) + 1;
    const profile = profileRepo.getById(LOCAL_EXECUTOR_PROFILE_ID);
    const preferredInstanceId = generateInstanceId(project.id, 'local');
    const instanceId = db.prepare('SELECT 1 FROM project_agent_instances WHERE id = ?').get(preferredInstanceId)
      ? generateInstanceId(project.id, `local-${generateUlid().slice(0, 8)}`)
      : preferredInstanceId;
    new AgentInstanceRepository(db).create({
      id: instanceId,
      projectId: project.id,
      agentProfileId: profile.id,
      definitionId: 'builtin.local-executor',
      definitionVersion: profile.definitionVersion,
      role: 'teammate',
      runtimeMode: 'native-model',
      identityRelPath: `agent-identities/${instanceId}/IDENTITY.md`,
      memoryRelPath: `agent-memories/${instanceId}`,
      ordinal: ordinal++,
    });
    touchedProjects.push(project.id);
  }
  for (const projectId of touchedProjects) await ensureProjectAgentFiles(db, projectId);
}

/** 优先按智能体挂载模型生成 Run 快照，未挂载时回退到兼容槽位。 */
  export function buildModelProfileSnapshot(db: Database.Database, agentInstanceId: string): string | null {
    const row = db.prepare(
      `SELECT ap.definition_id as definitionId,
              COALESCE(pai.model_profile_id, ap.model_profile_id) as mountedProfileId,
              ap.overrides_json as overridesJson
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = ?`,
    ).get(agentInstanceId) as { definitionId: string; mountedProfileId: string | null; overridesJson: string | null } | undefined;

    if (!row) return null;

    const slot = (row.definitionId === 'builtin.knowledge-manager' || row.definitionId === 'builtin.researcher') ? 'fast' : 'reasoning';

    const snapshot = row.mountedProfileId ? db.prepare(
      `SELECT mp.id as profileId, mp.name as profileName, mp.model_id as modelId,
              mp.parameters_json as parametersJson, mp.verified_capabilities_json as verifiedCapabilitiesJson,
              prv.id as providerId, prv.name as providerName, prv.type as providerType, prv.base_url as baseUrl
       FROM model_profiles mp
       JOIN model_providers prv ON prv.id = mp.provider_id
       WHERE mp.id = ? AND mp.enabled = 1`,
    ).get(row.mountedProfileId) : db.prepare(
      `SELECT mp.id as profileId, mp.name as profileName, mp.model_id as modelId,
              mp.parameters_json as parametersJson, mp.verified_capabilities_json as verifiedCapabilitiesJson,
              prv.id as providerId, prv.name as providerName, prv.type as providerType, prv.base_url as baseUrl
       FROM model_slot_bindings msb
       JOIN model_profiles mp ON mp.id = msb.model_profile_id
       JOIN model_providers prv ON prv.id = mp.provider_id
       WHERE msb.slot = ? AND mp.enabled = 1`,
    ).get(slot);
    const typedSnapshot = snapshot as {
      profileId: string; profileName: string; modelId: string;
      parametersJson: string | null; verifiedCapabilitiesJson: string | null;
      providerId: string; providerName: string; providerType: string; baseUrl: string | null;
    } | undefined;

    if (!typedSnapshot) return null;

    let profileParameters: Record<string, unknown> = {};
    let modelOptions: Record<string, unknown> = {};
    try { profileParameters = typedSnapshot.parametersJson ? JSON.parse(typedSnapshot.parametersJson) as Record<string, unknown> : {}; } catch { /* ignore malformed model parameters */ }
    try {
      const overrides = row.overridesJson ? JSON.parse(row.overridesJson) as { modelOptions?: unknown } : {};
      if (overrides.modelOptions && typeof overrides.modelOptions === 'object') modelOptions = overrides.modelOptions as Record<string, unknown>;
    } catch { /* ignore malformed agent overrides */ }

    return JSON.stringify({
      profileId: typedSnapshot.profileId,
      profileName: typedSnapshot.profileName,
      providerId: typedSnapshot.providerId,
      providerName: typedSnapshot.providerName,
      providerType: typedSnapshot.providerType,
      baseUrl: typedSnapshot.baseUrl,
      modelId: typedSnapshot.modelId,
      modelSlot: slot,
      bindingSource: row.mountedProfileId ? 'agent' : 'slot',
      parameters: { ...profileParameters, ...modelOptions },
      capabilities: typedSnapshot.verifiedCapabilitiesJson ? JSON.parse(typedSnapshot.verifiedCapabilitiesJson) : null,
      capturedAt: new Date().toISOString(),
    });
  }
