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

const ORCHESTRATOR_PROFILE_ID = 'builtin-orchestrator-profile';
const KNOWLEDGE_PROFILE_ID = 'builtin-knowledge-profile';

const ORCHESTRATOR_IDENTITY_TPL = `---
schemaVersion: 1
definitionId: builtin.orchestrator
definitionVersion: 1.0.0
role: leader
---

# 身份

你是当前群聊的统筹管理智能体，负责理解用户目标、制定计划、委派子任务并汇总结果。
`;

const KNOWLEDGE_IDENTITY_TPL = `---
schemaVersion: 1
definitionId: builtin.knowledge-manager
definitionVersion: 1.0.0
role: teammate
---

# 身份

你是当前群聊的知识管理智能体，负责文档入库、实体关系提取、图谱构建和 Wiki 生成。
`;

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

    const stagedUploadIds = input.content?.stagedUploadIds ?? [];
    let firstMessageId: string | undefined;
    if (contentText) {
      const contentJson = JSON.stringify({ schemaVersion: 1, text: contentText, mentions: input.content?.mentions ?? [], stagedUploadIds });
      firstMessageId = messageRepo.createUserMessage(projectId, contentJson).id;
    }

    await mkdir(join(projectRoot, 'agent-identities', orchInstanceId), { recursive: true });
    await mkdir(join(projectRoot, 'agent-identities', knowInstanceId), { recursive: true });
    await mkdir(join(projectRoot, 'agent-memories', orchInstanceId, 'short-term'), { recursive: true });
    await mkdir(join(projectRoot, 'agent-memories', orchInstanceId, 'sessions'), { recursive: true });
    await mkdir(join(projectRoot, 'agent-memories', orchInstanceId, 'long-term'), { recursive: true });
    await mkdir(join(projectRoot, 'agent-memories', knowInstanceId, 'short-term'), { recursive: true });
    await mkdir(join(projectRoot, 'agent-memories', knowInstanceId, 'sessions'), { recursive: true });
    await mkdir(join(projectRoot, 'agent-memories', knowInstanceId, 'long-term'), { recursive: true });
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

    await writeFile(join(projectRoot, 'agent-identities', orchInstanceId, 'IDENTITY.md'), ORCHESTRATOR_IDENTITY_TPL, 'utf8');
    await writeFile(join(projectRoot, 'agent-identities', knowInstanceId, 'IDENTITY.md'), KNOWLEDGE_IDENTITY_TPL, 'utf8');

    for (const instId of [orchInstanceId, knowInstanceId]) {
      const memRoot = join(projectRoot, 'agent-memories', instId);
      const curPath = join(memRoot, 'short-term', 'current.md');
      const idxPath = join(memRoot, 'index.jsonl');
      try { await access(curPath); } catch { await writeFile(curPath, `---\nschemaVersion: 1\nmemoryId: current\ntype: summary\nscope: short-term\nconfidence: 1\ncreatedAt: ${now}\nupdatedAt: ${now}\n---\n\n# 当前会话\n\n群聊已创建，等待首次对话。\n`, 'utf8'); }
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

export async function seedDefaultProfiles(db: Database.Database): Promise<void> {
  const now = new Date().toISOString();
  const profileRepo = new AgentProfileRepository(db);
  const defRepo = new AgentDefinitionRepository(db);

  const existingDefs = defRepo.list();
  const hasOrchDef = existingDefs.some((d) => d.id === 'builtin.orchestrator');
  const hasKnowDef = existingDefs.some((d) => d.id === 'builtin.knowledge-manager');

  if (!hasOrchDef) {
    defRepo.create({ id: 'builtin.orchestrator', kind: 'builtin', isBuiltin: true, manifestRelPath: 'agents/builtin-orchestrator/manifest.json' });
  }

  if (!hasKnowDef) {
    defRepo.create({ id: 'builtin.knowledge-manager', kind: 'builtin', isBuiltin: true, manifestRelPath: 'agents/builtin-knowledge-manager/manifest.json' });
  }

  const existing = profileRepo.listByEnabled();
  const hasOrch = existing.some((p) => p.definitionId === 'builtin.orchestrator');
  const hasKnow = existing.some((p) => p.definitionId === 'builtin.knowledge-manager');

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
}
