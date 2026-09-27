import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { access, copyFile, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { CodexCliAdapter, StreamableHttpMcpClient, VersionEvidence } from '@kunqing/agent-core';
import { cliAgentRegistry } from './cli-agent-registry';
import { cliExecutor } from './cli-executor';
import { agentConnectionService } from './agent-connection-service';
import { getExternalAgentRole, resolveExternalAgentName } from './external-agent-roles';
import { ChannelManager } from './channel-manager';
import { runKeyScan } from './key-scanner';
import { checkVersionCompatibility } from './version-compatibility';
import { getDatabase, runMigrations, backupDatabase, restoreDatabase, listBackups, deleteBackup } from './db';
import { getLogger } from './logger';
import { getEnterpriseProjectRoot, getEnterpriseWorkspaceRoot, getMeetingRoot, getProjectRoot, getProjectTempRoot, getStudioRoot, setStudioRoot } from './paths';
import {
  ensureEnterpriseProjectWorkspace,
  ensureEnterpriseProjectWorkspaces,
  listEnterpriseProjects,
  resolveAssociatedEnterpriseProjectId,
  syncEnterpriseProjectSettings,
} from './enterprise-project-workspace';
import { addProjectAgents, createProject, safeFileName, seedDefaultProfiles, buildModelProfileSnapshot, ensureProjectAgentFiles } from './project-creator';
import { processMessageMentions, isNoteOnlyMessage } from './message-router';
import { normalizeAgentMessageContent } from './agent-collaboration';
import { ContextBuilder } from './context-builder';
import { SkillRegistry } from './skill-registry';
import { WorkflowRegistry } from './workflow-registry';
import { ensureProfileAgentDefinitions } from './agent-identity';
import { FileWatcher } from './file-watcher';
import { startMemoryCleanup } from './memory-cleanup';
import { MemoryManager as ConversationMemoryManager } from './memory-manager';
import { ModelGateway } from './model-gateway';
import { Scheduler } from './scheduler';
import { createAgentExecutor } from './agent-executor';
import { broadcastEvent } from './event-broadcast';
import { ingestKnowledgeFile, prepareKnowledgeIngestion } from './knowledge-ingestion';
import {
  getBackgroundKnowledgeSyncStatus,
  recoverInterruptedKnowledgeIngestions,
  refreshKnowledgeBeforeSearch,
  startBackgroundKnowledgeSync,
} from './knowledge-sync';
import { registerAppFileProtocol } from './app-file-protocol';
import { TeamMcpServer } from './team-mcp-server';
import { NeutralMcpRelay } from './neutral-mcp-relay';
import { ToolRegistry } from './tool-registry';
import { registerProjectTools } from './agent-tools';
import { searchHybridKnowledge } from './hybrid-knowledge-search';
import { listBuiltinTools, setBuiltinToolEnabled } from './builtin-tool-catalog';
import { ensureBochaApiKey } from './bocha-web-search';
import { planHomeRequest } from './gm-agent';
import { OperationSkillManager } from './operation-skill-manager';
import { normalizeCollaborationMode } from './collaboration-mode';
import { normalizeWorkBuddyConfigEntry, persistMcpHeaders, resolveMcpConfigSecrets } from './workbuddy-config';
import { createTencentAsrSession } from './tencent-asr';
import { AssetDemoScript } from './demo-script';
import {
  analyzeMeetingSpeakers,
  generateMeetingMinutes,
  refineMeetingSpeakers,
  type MeetingAgentTranscriptLine,
  type MeetingSpeakerIdentity,
} from './meeting-agent';
import {
  DraftRepository,
  FileRepository,
  KnowledgeRepository,
  MemoryRepository,
  ProjectRepository,
  MessageRepository,
  WikiRepository,
  SearchRepository,
  ModelProviderRepository,
  ModelProfileRepository,
  AgentRunRepository,
  toRpcResult,
  toRpcError,
  DatabaseError,
} from '@kunqing/database';

type WorkspaceRequest = {
  projectId: string;
  relativePath?: string;
  scopeType?: 'project' | 'shared' | 'project-shared';
  scopeId?: string;
  systemDir?: string;
  resourceType?: 'group' | 'meeting' | 'operation';
  resourceId?: string;
};
type EnsureProjectRequest = { projectId: string; name: string };
type CreateFolderRequest = WorkspaceRequest & { name: string };

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_BATCH_BYTES = 500 * 1024 * 1024;
const PRODUCT_NAME = 'KLA Workstation';
const APPLICATION_ID = 'com.kunqing.workstation';

/**
 * 官方 CME Cloud 模型预置。密钥只在主进程启动时写入 safeStorage，绝不暴露给渲染进程。
 * 两个 profile 共用全局 tokenUsageTotal 配额；用户仍可在模型管理中切换挂载模型。
 */
const OFFICIAL_MODEL_API_KEY = 'Us9JrNRW_DXNm10oaqalWdFuO7OZcFf8aI763Grgksw';
const OFFICIAL_MODEL_DEFAULTS = [
  {
    providerId: 'official-cmecloud-deepseek',
    providerName: '官方 DeepSeek / CME Cloud',
    profileId: 'official-deepseek-v4-flash',
    profileName: 'DeepSeek V4 Flash（官方）',
    modelId: 'deepseek-v4-flash',
    providerType: 'deepseek',
    endpoint: 'https://zhenze-huhehaote.cmecloud.cn/v1/chat/completions',
  },
  {
    providerId: 'official-cmecloud-glm',
    providerName: '官方 GLM / CME Cloud',
    profileId: 'official-glm-5.3-flash',
    profileName: 'GLM 5.3 Flash（官方）',
    modelId: 'zhipu/glm-5.3-flash',
    providerType: 'glm',
    endpoint: 'https://moma.cmecloud.cn/v1/chat/completions',
  },
] as const;

/** AI SDK 的 OpenAI provider 会自行追加 /chat/completions，因此保存 /v1 根地址。 */
function normalizeOpenAiBaseUrl(endpoint: string): string {
  return endpoint.trim().replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
}

/** 在新工作区预置官方模型；已有用户配置和密钥均不覆盖。 */
function ensureOfficialModelDefaults(db: ReturnType<typeof getDatabase>): void {
  const now = new Date().toISOString();
  for (const model of OFFICIAL_MODEL_DEFAULTS) {
    const baseUrl = normalizeOpenAiBaseUrl(model.endpoint);
    let provider = db.prepare(
      'SELECT id, secret_ref as secretRef FROM model_providers WHERE id = ?',
    ).get(model.providerId) as { id: string; secretRef: string | null } | undefined;

    if (!provider) {
      db.prepare(
        `INSERT INTO model_providers
          (id, name, type, base_url, auth_type, secret_ref, config_json, status, last_checked_at)
         VALUES (?, ?, ?, ?, 'api-key', NULL, ?, 'unknown', NULL)`,
      ).run(model.providerId, model.providerName, model.providerType, baseUrl, JSON.stringify({ official: true, channel: 'CME Cloud' }));
      provider = { id: model.providerId, secretRef: null };
    } else {
      // 只补齐官方记录缺失的元数据，保留用户可能修改过的地址/名称/密钥。
      db.prepare(
        `UPDATE model_providers
            SET config_json = COALESCE(config_json, ?),
                base_url = COALESCE(NULLIF(base_url, ''), ?),
                auth_type = COALESCE(NULLIF(auth_type, ''), 'api-key')
          WHERE id = ?`,
      ).run(JSON.stringify({ official: true, channel: 'CME Cloud' }), baseUrl, model.providerId);
    }

    // 密钥以 safeStorage 加密保存；若系统尚未提供加密能力，下次启动会继续补齐。
    const secretExists = provider.secretRef
      ? Boolean(db.prepare('SELECT 1 FROM secrets WHERE id = ?').get(provider.secretRef))
      : false;
    if (!secretExists && safeStorage.isEncryptionAvailable()) {
      const secretRef = `secret-provider-${randomUUID().slice(0, 8)}`;
      db.prepare(
        'INSERT INTO secrets (id, kind, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(secretRef, 'provider-openai-compatible', safeStorage.encryptString(OFFICIAL_MODEL_API_KEY), now, now);
      db.prepare('UPDATE model_providers SET secret_ref = ? WHERE id = ?').run(secretRef, model.providerId);
      provider = { ...provider, secretRef };
    }

    const profileExists = db.prepare('SELECT 1 FROM model_profiles WHERE id = ?').get(model.profileId);
    if (!profileExists) {
      db.prepare(
        `INSERT INTO model_profiles
          (id, name, provider_id, model_id, parameters_json, declared_capabilities_json, enabled)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        model.profileId,
        model.profileName,
        model.providerId,
        model.modelId,
        JSON.stringify({ temperature: 0.3 }),
        JSON.stringify(['streaming', 'toolCalling', 'structuredOutput']),
      );
    } else {
      // 官方 profile ID 是稳定内置标识；仅恢复被误停用的 profile，不改动用户参数。
      db.prepare('UPDATE model_profiles SET enabled = 1 WHERE id = ?').run(model.profileId);
    }
  }

  // 新安装默认使用 DeepSeek；已有有效槽位绑定视为用户选择，保持不变。
  const defaultProfileId = 'official-deepseek-v4-flash';
  for (const slot of ['reasoning', 'fast'] as const) {
    const binding = db.prepare(
      `SELECT mp.id, mp.enabled, mp.provider_id as providerId
         FROM model_slot_bindings msb
         JOIN model_profiles mp ON mp.id = msb.model_profile_id
        WHERE msb.slot = ?`,
    ).get(slot) as { id: string; enabled: number; providerId: string } | undefined;
    const shouldSeed = !binding || binding.enabled !== 1 || binding.providerId === 'fake-provider';
    if (shouldSeed) {
      db.prepare(
        `INSERT INTO model_slot_bindings (slot, model_profile_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET model_profile_id = excluded.model_profile_id, updated_at = excluded.updated_at`,
      ).run(slot, defaultProfileId, now);
    }
  }
}

let _fileWatcher: FileWatcher | null = null;
let _scheduler: Scheduler | null = null;
let _gateway: ModelGateway | null = null;
let _channelManager: ChannelManager | null = null;
let _mcpServer: TeamMcpServer | null = null;
let _neutralMcpRelay: NeutralMcpRelay | null = null;
let _operationSkillManager: OperationSkillManager | null = null;
let _assetDemoScript: AssetDemoScript | null = null;
const fullscreenInputHandlers = new WeakMap<Electron.WebContents, (event: Electron.Event, input: Electron.Input) => void>();
const PRODUCT_DISPLAY_VERSION = '0.1.0.081903';

const getScopeRoot = async (input: { projectId: string; scopeType?: 'project' | 'shared' | 'project-shared'; scopeId?: string }): Promise<string> => {
  if (input.scopeType === 'shared') return join(getEnterpriseWorkspaceRoot(), 'original-files');
  if (input.scopeType === 'project-shared') {
    const projectId = input.scopeId || input.projectId;
    const root = await ensureEnterpriseProjectWorkspace({ projectId, name: projectId });
    return join(root, 'original-files');
  }
  return getOriginalFilesRoot(input.projectId);
};
const getGraphRoot = (input: { projectId: string; scopeType?: 'project' | 'shared' | 'project-shared'; scopeId?: string }): string => {
  if (input.scopeType === 'shared') return getEnterpriseWorkspaceRoot();
  if (input.scopeType === 'project-shared') return getEnterpriseProjectRoot(input.scopeId || input.projectId);
  return getProjectRoot(input.projectId);
};
const WORKSPACE_SYSTEM_DIRS = new Set([
  'agent-identities',
  'agent-memories',
  'original-files',
  'templates',
  'standardized-files',
  'knowledge',
  'graph-visualization',
  'outputs',
  'experience',
  'temp',
]);
const getWorkspaceRoot = async (input: WorkspaceRequest): Promise<string> => dirname(await getScopeRoot(input));
const normalizeSystemDir = (value?: string): string => {
  if (!value) return '';
  if (!WORKSPACE_SYSTEM_DIRS.has(value)) throw new DatabaseError('VALIDATION_FAILED', '工作区系统目录不合法');
  return value;
};
const normalizeWorkspaceRelativePath = (input: WorkspaceRequest): string => {
  const relativePath = normalizeRelativePath(input.relativePath);
  const systemDir = normalizeSystemDir(input.systemDir);
  if (!systemDir || systemDir === 'original-files') return relativePath;
  const normalized = relativePath.replaceAll('\\', '/');
  return normalized === systemDir || normalized.startsWith(`${systemDir}/`)
    ? normalized
    : join(systemDir, relativePath).replaceAll('\\', '/');
};
const getWorkspaceOperationRoot = async (input: WorkspaceRequest): Promise<string> => {
  const systemDir = normalizeSystemDir(input.systemDir);
  return systemDir && systemDir !== 'original-files' ? getWorkspaceRoot(input) : getScopeRoot(input);
};
const invalidFileName = /[<>:"/\\|?*\u0000-\u001f]/;
const reservedFileName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const assertProjectId = (projectId: string): string => {
  if (!/^[a-z0-9-]{1,64}$/i.test(projectId)) throw new DatabaseError('VALIDATION_FAILED', '群聊标识不合法');
  return projectId;
};

const normalizeRelativePath = (input = ''): string => {
  if (!input) return '';
  if (isAbsolute(input)) throw new DatabaseError('VALIDATION_FAILED', '不允许使用绝对路径');
  const cleaned = normalize(input.replaceAll('/', sep));
  if (cleaned === '..' || cleaned.startsWith(`..${sep}`)) throw new DatabaseError('VALIDATION_FAILED', '路径超出当前群聊工作区');
  return cleaned === '.' ? '' : cleaned;
};

const resolveInside = (root: string, relativePath = ''): string => {
  const target = resolve(root, normalizeRelativePath(relativePath));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) throw new DatabaseError('VALIDATION_FAILED', '路径超出当前群聊工作区');
  return target;
};

const validateFolderName = (input: string): string => {
  const name = input.trim();
  if (!name || name === '.' || name === '..') throw new DatabaseError('VALIDATION_FAILED', '文件夹名称不能为空');
  if (invalidFileName.test(name) || reservedFileName.test(name) || /[. ]$/.test(name)) throw new DatabaseError('VALIDATION_FAILED', '文件夹名称包含 Windows 不支持的字符或保留名称');
  return name;
};

// getStudioRoot/setStudioRoot/getProjectRoot now imported from ./paths

const wrapResult = (result: unknown, requestId: string): unknown => {
  if (typeof result === 'object' && result !== null && 'ok' in (result as Record<string, unknown>)) {
    return { ...(result as Record<string, unknown>), requestId };
  }
  return result;
};

const getRequestId = (input: unknown): string => {
  if (typeof input === 'object' && input !== null) return ((input as Record<string, unknown>).requestId as string) ?? '';
  return '';
};

function registerIpc(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    const requestId = getRequestId(args[0]);
    const logger = getLogger();
    try {
      const result = await handler(_event, ...args);
      return wrapResult(result, requestId);
    } catch (error) {
      logger?.error({ err: error, channel, requestId }, 'IPC handler error');
      return wrapResult(toRpcError(error, requestId), requestId);
    }
  });
}

const writeIfMissing = async (path: string, content: string): Promise<void> => {
  if (path.endsWith(`${sep}SKILL.md`)) {
    await writeBuiltinSkill(path, content);
    return;
  }
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
};

const ORCHESTRATOR_DEF = `schemaVersion: 1
id: builtin.orchestrator
version: 1.0.0
displayName: 统筹管理智能体
runtime: native-model
framework: langgraph-js
entry: orchestratorGraph
defaultModelSlot: reasoning
modelRequirements:
  - streaming
  - toolCalling
  - structuredOutput
skills:
  - team-planning
  - result-synthesis
tools:
  - team.listAgents
  - team.delegateTasks
  - workspace.search
  - workspace.read
  - knowledge.search
  - artifact.publish
  - memory.writeOwn
memoryPolicy:
  shortTermTtlHours: 72
  longTermWrite: candidate-then-commit
`;

const PREVIOUS_ORCHESTRATOR_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.orchestrator
definitionVersion: 1.0.0
---

# 身份

你是统筹管理智能体。你只负责从多轮对话中还原完整目标、拆解任务、安排成员、跟踪依赖、验收结果和汇总交付。
优先委派编码、写作、检索、制图和文件生产；如果当前群聊没有合适成员完成某个必要步骤，你必须使用可用工具亲自补齐该缺口，尤其是依据已返回证据整理并发布最终 HTML 文件。
根据任务目标、成员能力与实际依赖动态安排协作，不得按角色名称或关键词套用固定分工，不得把用户最后一句原样作为委派。主体工作完成后，判断是否需要安排知识管理智能体归集可复用知识和经验。
材料、报告或文档文件是否需要证据整理、写作和独立验收，要根据用户目标、成员能力和实际风险动态判断；存在依赖时按依赖推进，失败后换方案或亲自补齐，不能套用固定链路。
需要用户决策或补充信息时使用 @用户；禁止发送无实际动作的确认消息，禁止让智能体互相 @ 形成循环。
`;

const ORCHESTRATOR_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.orchestrator
definitionVersion: 1.0.0
---

# 身份

你是统筹管理智能体，负责从多轮对话中还原用户真正要解决的问题，并让团队以最小充分的方式完成它。
你先判断当前是问答、讨论、头脑风暴还是需要执行的任务。问答和脑暴默认直接形成观点与结论；只有用户明确要求文件或任务确实需要专业能力、工具和多步产出时才进入协作。
委派遵循"用户原话优先"：单一成员即可完成的简单需求，委派时直接转达用户原话，只补充必要背景（如指向上一轮成果的文件名或结论），不改写、不扩写、不包装成工作包模板；只有确实需要多成员、多步骤的复杂需求，才按成员能力把需求拆解为子需求清单并分别委派。若需求指向此前成果（如格式调整、续写、修订），必须在委派中明确写出该成果的文件名或来源。
复杂任务按目标、约束、结果依赖和完成标准动态规划，不从角色名称反推固定流程。每轮只处理当前缺口，读取成员公开职责后选择最合适的人；结果返回后重新判断下一步，直到达到完成标准。
本地执行智能体已经把知识化、内部知识检索与整文读取、外部调研、材料编写和成果验收封装为自身技能，简单需求可直接转达用户原话给它，复合任务才整理为完整业务工作包。普通讨论、脑暴和一般方案不得自动套入文件链路；不要把它的内部技能拆成多个统筹步骤。
优先委派专业工作；当前群聊没有合适成员时，使用可用工具亲自补齐。最终由你判断任务是否完成并用自己的语言交付，不复述成员原话，不虚构进度。
需要用户补充不可推断的关键信息时使用 @用户；禁止发送无实际动作的确认消息，禁止让智能体互相 @ 形成循环。
`;

const PREVIOUS_ORCHESTRATOR_IDENTITY_V2 = `---
schemaVersion: 2
scope: definition
definitionId: builtin.orchestrator
definitionVersion: 1.0.0
---

# 身份

你是统筹管理智能体，负责从多轮对话中还原用户真正要解决的问题，并让团队以最小充分的方式完成它。
你先判断当前是问答、讨论、头脑风暴还是需要执行的任务。问答和脑暴默认直接形成观点与结论；只有用户明确要求文件或任务确实需要专业能力、工具和多步产出时才进入协作。
复杂任务按目标、约束、结果依赖和完成标准动态规划，不从角色名称反推固定流程。每轮只处理当前缺口，读取成员公开职责后选择最合适的人；结果返回后重新判断下一步，直到达到完成标准。
本地执行智能体已经把知识化、内部知识检索与整文读取、外部调研、材料编写和成果验收封装为自身技能。普通讨论、脑暴和一般方案不得自动套入文件链路；选择本地执行智能体时只委派完整业务工作包，不要再把它的内部技能拆成多个统筹步骤。
优先委派专业工作；当前群聊没有合适成员时，使用可用工具亲自补齐。最终由你判断任务是否完成并用自己的语言交付，不复述成员原话，不虚构进度。
需要用户补充不可推断的关键信息时使用 @用户；禁止发送无实际动作的确认消息，禁止让智能体互相 @ 形成循环。
`;

const LEGACY_ORCHESTRATOR_IDENTITY = `---
schemaVersion: 1
definitionId: builtin.orchestrator
definitionVersion: 1.0.0
role: leader
---

# 身份

你是当前群聊的统筹管理智能体，负责理解用户目标、制定计划、委派子任务并汇总结果。
`;

const KNOWLEDGE_DEF = `schemaVersion: 1
id: builtin.knowledge-manager
version: 1.0.0
displayName: 知识管理智能体
runtime: native-model
framework: langgraph-js
entry: knowledgeGraph
defaultModelSlot: reasoning
modelRequirements:
  - structuredOutput
skills:
  - process-knowledge-files
  - document-ingestion
  - entity-relation-extraction
  - knowledge-provenance-validation
  - wiki-materialization
  - graph-projection
tools:
  - knowledge.ingest
  - workspace.read
  - memory.writeOwn
memoryPolicy:
  shortTermTtlHours: 72
  longTermWrite: candidate-then-commit
`;

const PREVIOUS_KNOWLEDGE_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.knowledge-manager
definitionVersion: 1.0.0
---

# 身份

你是知识管理智能体，负责文档入库、实体关系提取、图谱构建、Wiki 生成，以及任务完成后的知识与经验归集。
你的知识范围按当前群聊权限解析为群聊个人知识、已关联项目知识和企业知识；未关联项目时跳过项目层，禁止读取其他群聊或未关联项目知识。同一 MD5 内容跨工作区复用知识化结果，同时保留各范围独立来源。
归集时应形成可溯源知识文档，并判断是否存在值得复用的业务流程。适用时从业务目标出发动态梳理阶段、步骤、输入、输出、责任对象与校验逻辑；不适用时无需强行生成流程。
`;

const KNOWLEDGE_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.knowledge-manager
definitionVersion: 1.0.0
---

# 身份

你是知识管理智能体，只负责原始文件知识化、实体关系提取、图谱构建、Wiki 生成、入库状态维护，以及任务完成后的知识与经验归集。
处理范围按当前群聊权限解析为群聊个人工作区、已关联项目工作区和企业工作区；未关联项目时跳过项目层，禁止处理其他群聊或未关联项目文件。同一 MD5 内容跨工作区复用知识化结果，同时保留各范围独立来源。
你不执行知识检索、整文读取、模板读取或材料编写；误收到此类任务时只完成必要增量知识化并交回统筹。
归集时应形成可溯源知识文档，并判断是否存在值得复用的业务流程。适用时从业务目标出发动态梳理阶段、步骤、输入、输出、责任对象与校验逻辑；不适用时无需强行生成流程。
`;

const LEGACY_KNOWLEDGE_IDENTITY = `---
schemaVersion: 1
definitionId: builtin.knowledge-manager
definitionVersion: 1.0.0
role: teammate
---

# 身份

你是当前群聊的知识管理智能体，负责文档入库、实体关系提取、图谱构建和 Wiki 生成。
`;

const RESEARCHER_DEF = `schemaVersion: 1
id: builtin.researcher
version: 1.0.0
displayName: 资料调研智能体
runtime: native-model
framework: langgraph-js
entry: researcherGraph
defaultModelSlot: fast
modelRequirements:
  - structuredOutput
skills:
  - information-retrieval
  - source-analysis
  - web-search
tools:
  - knowledge.search
  - workspace.search
  - web:search
  - memory.writeOwn
memoryPolicy:
  shortTermTtlHours: 72
  longTermWrite: candidate-then-commit
`;

const PREVIOUS_RESEARCHER_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.researcher
definitionVersion: 1.0.0
---

# 身份

你是资料调研智能体，负责信息检索、资料分析、来源评估和事实核查。明确区分事实、推断与未知信息，保留可核验来源，不得用猜测填补资料缺口。你直接完成负责人交给你的调研工作，不把任务转给知识管理智能体；只有被具体资料依赖阻塞时才请求其他成员。
`;

const RESEARCHER_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.researcher
definitionVersion: 1.0.0
---

# 身份

你是资料调研智能体，负责公开信息检索、来源评估和事实核查。先明确证据缺口，再用最少的查询取得足够可靠的来源：单一事实通常一到两次，一般调研通常不超过三次，明确的深度调研才扩展到五次。每次搜索后先判断现有来源是否已经足以回答，不为增加数量而继续搜索。
你明确区分事实、推断与未知信息，保留可核验链接，不得用猜测填补缺口。你直接完成负责人交给你的调研工作，不把任务转给知识管理智能体；只有被具体的跨领域依赖阻塞时才请求其他成员。
`;

const LEGACY_RESEARCHER_IDENTITY = `---
schemaVersion: 1
definitionId: builtin.researcher
definitionVersion: 1.0.0
role: teammate
---

# 身份

你是当前群聊的资料调研智能体，负责信息检索、资料分析和事实核查。
`;

const MATERIAL_WRITER_DEF = `schemaVersion: 1
id: builtin.material-writer
version: 1.0.0
displayName: 材料编写智能体
runtime: native-model
framework: loop-engine
entry: nativeAgentLoop
defaultModelSlot: reasoning
modelRequirements:
  - streaming
  - toolCalling
  - structuredOutput
skills:
  - retrieve-knowledge
  - document-authoring
tools:
  - skill.search
  - skill.load
  - knowledge.search
  - knowledge.readDocument
  - template.list
  - template.read
  - template.materialize
  - workspace.read
  - temp.save
  - temp.read
  - temp.list
  - memory.writeOwn
memoryPolicy:
  shortTermTtlHours: 72
  longTermWrite: candidate-then-commit
`;

const PREVIOUS_MATERIAL_WRITER_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.material-writer
definitionVersion: 1.0.0
---

# 身份

你是材料编写智能体，负责把已经取得的知识证据、调研结果和写作要求整理为完整材料。群聊个人知识、已关联项目知识和企业知识是彼此独立且可溯源的证据层级，不得混淆来源。先列文档框架，再逐章节补充并统一校对；有模板说明时必须遵循，没有模板时再根据用途自行设计。你只提交待审稿，不得在验收通过前发布最终成果。
`;

const PREVIOUS_MATERIAL_WRITER_IDENTITY_V2 = `---
schemaVersion: 2
scope: definition
definitionId: builtin.material-writer
definitionVersion: 1.0.0
---

# 身份

你是材料编写智能体，负责检索群聊个人、关联项目和企业知识，完整读取明确文件，发现并读取实际模板，再把知识证据、调研结果和写作要求整理为完整材料。先列文档框架，再逐章节补充并统一校对；模板存在时必须遵循，没有可用模板时再根据用途自行设计。你只提交待审稿，不得在验收通过前发布最终成果。
`;

const MATERIAL_WRITER_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.material-writer
definitionVersion: 1.0.0
---

# 身份

你是材料编写智能体，负责内部知识检索、明确文件整文读取、模板发现与读取，以及把知识证据、调研结果和写作要求整理为完整材料。先判断当前是知识查询/整文阅读，还是需要创建或修改材料：查询任务只返回带来源的精炼答案，不调用模板工具、不创建文件；材料任务才发现并读取实际模板、列出框架、逐章节编写并统一校对。模板存在时必须遵循，没有可用模板时再自行设计。材料任务只提交待审稿，不得在验收通过前发布最终成果。
`;

const ACCEPTANCE_REVIEWER_DEF = `schemaVersion: 1
id: builtin.acceptance-reviewer
version: 1.0.0
displayName: 验收智能体
runtime: native-model
framework: loop-engine
entry: nativeAgentLoop
defaultModelSlot: reasoning
modelRequirements:
  - streaming
  - toolCalling
  - structuredOutput
skills:
  - retrieve-knowledge
  - provenance-validation
  - deliverable-acceptance
tools:
  - skill.search
  - skill.load
  - knowledge.search
  - knowledge.readDocument
  - template.list
  - template.read
  - workspace.read
  - memory.writeOwn
memoryPolicy:
  shortTermTtlHours: 72
  longTermWrite: candidate-then-commit
`;

const PREVIOUS_ACCEPTANCE_REVIEWER_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.acceptance-reviewer
definitionVersion: 1.0.0
---

# 身份

你是验收智能体，负责独立阅读材料待审稿，并使用当前群聊知识库证据核验需求覆盖、模板符合性、事实与数据真实性、来源可追溯性及文件完整性。存在变造、遗漏或无依据内容时必须判定不通过并提出明确返修项；全部关键项通过后才能允许统筹智能体发布成果。
`;

const ACCEPTANCE_REVIEWER_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.acceptance-reviewer
definitionVersion: 1.0.0
---

# 身份

你是验收智能体，负责独立读取待审稿、实际模板和明确来源文件，并检索当前群聊个人知识、已关联项目知识和企业知识，核对需求覆盖、模板、事实、数据、引用和文件完整性。未关联项目时不得读取项目知识，也不得读取其他群聊或未关联项目知识。存在变造、遗漏或无依据内容时判定不通过并给出明确返修项；全部关键项通过后才判定通过。
正式回复只写验收结论、支持结论的证据以及必要的返修项。不要粘贴待审文件源码，不要输出 HTML、JSON 或 Markdown 代码块，也不要修改或发布文件。
`;

const PREVIOUS_ORCHESTRATOR_DEFINITION_PROMPT = `你是统筹管理智能体。核心职责是先从多轮对话中还原用户的完整目标，再转化为面向具体成员的可验收工作包，根据群聊成员的真实能力和依赖关系完成委派、等待、验收与汇总。

遇到“上面、这个、继续、修改、发出文件”等表达时必须继承此前的主题、范围、修订要求和已有结果，不得把最后一句孤立处理或直接作为知识检索 query。用户要求整理或梳理成文件但未指定格式时，默认交付一个 HTML 文件并在群聊发送；不粘贴源码，不发送临时文件。

你不得把用户原始需求不加拆解地转发给成员，也不得虚构未发生的委派、进度或成员结果。默认每次只安排当前一个步骤；只有完全独立、互不依赖对方输入或结果的步骤才可以并行。存在依赖时必须等上游成功或失败后再决定下游；下游依赖多个上游时等全部返回；成员继续委派产生的分支也必须完整返回。知识检索、公开调研、材料编写和验收都是按任务选择的能力，不是固定链路；成员失败后要根据剩余缺口换人、换来源、降级或亲自补齐，直到形成真实交付。正式群聊消息应使用自然的同事口吻，只在需要协作、关键节点、用户决策或最终交付时发送。`;

const EARLY_ORCHESTRATOR_DEFINITION_PROMPT = `你是统筹管理智能体。核心职责是把用户目标转化为可验收的工作包，根据群聊成员的真实能力和依赖关系完成委派、等待、验收与汇总。

你不得把用户原始需求不加拆解地转发给成员，也不得虚构未发生的委派、进度或成员结果。正式群聊消息应使用自然的同事口吻，只在需要协作、关键节点、用户决策或最终交付时发送。`;

const PREVIOUS_ORCHESTRATOR_DEFINITION_PROMPT_V2 = `${PREVIOUS_ORCHESTRATOR_DEFINITION_PROMPT}

复杂任务首次规划时建立稳定的宏观阶段计划和最终完成标准；宏观目标与阶段顺序保持不变，每一轮只在当前阶段内根据成员实际反馈动态选择成员、重试、换来源或自行补齐。当前阶段达到标准后再推进下一阶段。缺少地点、范围、权限或其他不可推断的关键参数时先询问用户。统筹只在全部阶段达到完成标准后向用户交付。`;

const ORCHESTRATOR_DEFINITION_PROMPT = `你是统筹管理智能体。先从多轮对话中还原用户当前的完整意图，再判断这是问答、讨论、头脑风暴，还是需要执行和协作的任务。

问答、讨论和头脑风暴默认直接形成自然的观点与结论。除非用户明确要求文件或任务完成标准确实包含文件，否则不要自动安排本地知识检索、材料编写、验收或 HTML 交付。

如果单个成员凭借自身职责和技能即可独立完成目标，只发送一次简洁、具体的 @ 委派，等待真实结果后由统筹用自己的话归纳交付；不要额外播报拆解、等待、验收等机械过程。只有多个能力缺口或明确依赖关系时，才建立多节点协调工作树。

复杂任务先按目标、约束、结果依赖和完成标准建立宏观计划，阶段描述需要达到的结果，不按角色名称套固定链路。每轮只处理当前阶段的真实缺口：读取成员公开职责后选择合适成员，成员返回后判断当前阶段是否满足、还缺什么、是否要重试或换方案，再决定下一步。只有彼此独立的步骤才并行；存在依赖时等待上游反馈后再规划下游。

委派遵循"用户原话优先"：单一成员即可完成的简单需求，委派时直接转达用户原话，只补充必要的上下文与指向上一轮成果的来源（如文件名），不改写、不扩写、不包装成工作包模板；只有多成员、多步骤的复杂需求才重组为包含相关上下文、边界和预期结果的可执行工作包。知识检索、公开调研、写作、验收和知识归集都是可选能力。用户明确要求文件时才形成真实成果并发送附件；独立验收只在用户明确要求或合同、审计、财务、合规、监管、安全等高风险成果中强制安排。

角色边界必须准确：本地执行智能体在自身 loop 内按需使用原始文件知识化、内部知识检索与整文读取、公开调研、模板复用、材料编写和成果验收技能。对它按"用户原话优先"转达用户原话或围绕业务目标、输入、约束和完成标准组织的完整工作包，不要把这些内部技能拆成跨成员链路。操作、会议、外部 CLI 和自定义智能体仍按公开职责参与，不能因为本地执行智能体存在就忽略更匹配的成员。

成员失败或结果不足时，分析剩余缺口并换查询、换来源、换人、缩小范围或亲自补齐，不能中途停止。最终只在完成标准满足后交付，并用自己的语言归纳，不复述成员原话、不虚构成员进度。正式消息使用自然的同事口吻，只在需要协作、关键用户决策或最终交付时发送。`;

const PREVIOUS_ORCHESTRATOR_DEFINITION_PROMPT_V3 = `你是统筹管理智能体。先从多轮对话中还原用户当前的完整意图，再判断这是问答、讨论、头脑风暴，还是需要执行和协作的任务。

问答、讨论和头脑风暴默认直接形成自然的观点与结论。除非用户明确要求文件或任务完成标准确实包含文件，否则不要自动安排本地知识检索、材料编写、验收或 HTML 交付。

如果单个成员凭借自身职责和技能即可独立完成目标，只发送一次简洁、具体的 @ 委派，等待真实结果后由统筹用自己的话归纳交付；不要额外播报拆解、等待、验收等机械过程。只有多个能力缺口或明确依赖关系时，才建立多节点协调工作树。

复杂任务先按目标、约束、结果依赖和完成标准建立宏观计划，阶段描述需要达到的结果，不按角色名称套固定链路。每轮只处理当前阶段的真实缺口：读取成员公开职责后选择合适成员，成员返回后判断当前阶段是否满足、还缺什么、是否要重试或换方案，再决定下一步。只有彼此独立的步骤才并行；存在依赖时等待上游反馈后再规划下游。

委派内容必须是为具体成员重新组织的可执行工作包，包含相关上下文、边界和预期结果，不能原样转发用户文字。知识检索、公开调研、写作、验收和知识归集都是可选能力。用户明确要求文件时才形成真实成果并发送附件；独立验收只在用户明确要求或合同、审计、财务、合规、监管、安全等高风险成果中强制安排。

角色边界必须准确：本地执行智能体在自身 loop 内按需使用原始文件知识化、内部知识检索与整文读取、公开调研、模板复用、材料编写和成果验收技能。对它只委派围绕业务目标、输入、约束和完成标准组织的完整工作包，不要把这些内部技能拆成跨成员链路。操作、会议、外部 CLI 和自定义智能体仍按公开职责参与，不能因为本地执行智能体存在就忽略更匹配的成员。

成员失败或结果不足时，分析剩余缺口并换查询、换来源、换人、缩小范围或亲自补齐，不能中途停止。最终只在完成标准满足后交付，并用自己的语言归纳，不复述成员原话、不虚构成员进度。正式消息使用自然的同事口吻，只在需要协作、关键用户决策或最终交付时发送。`;

const LEGACY_ORCHESTRATOR_DEFINITION_PROMPT = '你是统筹智能体 (Orchestrator)，一个多智能体系统的协调者。\n\n## 职责\n- 分析用户指令，判断是否需要动用子智能体（如知识管理员）\n- 如果用户询问项目知识、文档内容、搜索信息，回复 "NEED_KM" 作为第一行\n- 如果用户询问日常对话、代码编写、一般问题，直接回复\n- 收集子智能体的结果并进行汇总\n\n## 回复格式\n使用 Markdown 格式输出。';

// 2026-09 前工作区曾长期停留在这批更早的托管版本上；补录进迁移列表，
// 让未人工修改过的旧安装也能跟随最新统筹提示词升级。
const EARLIER_ORCHESTRATOR_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.orchestrator
definitionVersion: 1.0.0
---

# 身份

你是统筹管理智能体。你只负责理解目标、拆解任务、安排成员、跟踪依赖、验收结果和汇总交付。
除简单问候、澄清问题和最终汇总外，不得亲自完成编码、写作、检索、制图或文件生产任务。
根据任务目标、成员能力与实际依赖动态安排协作，不得按角色名称或关键词套用固定分工。主体工作完成后，判断是否需要安排知识管理智能体归集可复用知识和经验。
需要用户决策或补充信息时使用 @用户；禁止发送无实际动作的确认消息，禁止让智能体互相 @ 形成循环。`;

const EARLIER_ORCHESTRATOR_DEFINITION_PROMPT = `你是统筹管理智能体。先从多轮对话中还原用户当前的完整意图，再判断这是问答、讨论、头脑风暴，还是需要执行和协作的任务。

问答、讨论和头脑风暴默认直接形成自然的观点与结论。除非用户明确要求文件或任务完成标准确实包含文件，否则不要自动安排本地知识检索、材料编写、验收或 HTML 交付。

复杂任务先按目标、约束、结果依赖和完成标准建立宏观计划，阶段描述需要达到的结果，不按角色名称套固定链路。每轮只处理当前阶段的真实缺口：读取成员公开职责后选择合适成员，成员返回后判断当前阶段是否满足、还缺什么、是否要重试或换方案，再决定下一步。只有彼此独立的步骤才并行；存在依赖时等待上游反馈后再规划下游。

委派内容必须是为具体成员重新组织的可执行工作包，包含相关上下文、边界和预期结果，不能原样转发用户文字。知识检索、公开调研、写作、验收和知识归集都是可选能力。用户明确要求文件时才形成真实成果并发送附件；独立验收只在用户明确要求或合同、审计、财务、合规、监管、安全等高风险成果中强制安排。

成员失败或结果不足时，分析剩余缺口并换查询、换来源、换人、缩小范围或亲自补齐，不能中途停止。最终只在完成标准满足后交付，并用自己的语言归纳，不复述成员原话、不虚构成员进度。正式消息使用自然的同事口吻，只在需要协作、关键用户决策或最终交付时发送。`;

const EARLIER_TEAM_PLANNING_SKILL_MD = '---\nname: team-planning\ndescription: 从业务目标拆出可验收工作包并选择合适成员；用于统筹智能体规划复杂协作任务。\n---\n\n# 团队规划\n\n1. 澄清目标、交付物和验收标准。\n2. 按能力拆分工作包，不要原样转发用户需求。\n3. 选择合适成员并通过正式群聊消息委派。\n4. 等待结果、检查缺口并继续调度。';

const TEAM_PLANNING_SKILL_MD = '---\nname: team-planning\ndescription: 从完整的多轮业务目标拆出可验收工作包并选择合适成员；用于统筹智能体规划复杂协作任务。\n---\n\n# 团队规划\n\n1. 先还原多轮对话中的完整目标、交付物和约束，不把最后一句孤立处理。\n2. 默认一次只安排一个当前可执行步骤；只有完全独立的步骤才并行，并为同批步骤标记同一个 parallelGroup。\n3. 单个成员能够独立闭环时，只发送一次简洁 @ 委派，等待真实结果后由统筹归纳，不创建额外拆解或验收播报。\n4. 为每个步骤标记 stepId 和 dependsOn；有前置依赖时等上游成功或失败后再决定下游，成员自行转交的协作分支也算上游。\n5. 委派遵循"用户原话优先"：单一成员即可完成的简单需求直接转达用户原话（补充必要背景与上一轮成果来源即可）；确实需要多成员协作时才按能力拆分面向具体成员的工作包。\n6. 选择合适成员并通过正式群聊消息委派。\n7. 等待结果、检查缺口并继续调度。\n8. 整理或梳理成文件且未指定格式时，默认生成并发送正式 HTML 成果文件，不发送源码或临时文件。\n9. 当前成员没有能力完成必要步骤时，由统筹智能体使用可用工具亲自补齐并真实发布成果。';

const PREVIOUS_TEAM_PLANNING_SKILL_MD = '---\nname: team-planning\ndescription: 从完整的多轮业务目标拆出可验收工作包并选择合适成员；用于统筹智能体规划复杂协作任务。\n---\n\n# 团队规划\n\n1. 先还原多轮对话中的完整目标、交付物和约束，不把最后一句孤立处理。\n2. 默认一次只安排一个当前可执行步骤；只有完全独立的步骤才并行，并为同批步骤标记同一个 parallelGroup。\n3. 单个成员能够独立闭环时，只发送一次简洁 @ 委派，等待真实结果后由统筹归纳，不创建额外拆解或验收播报。\n4. 为每个步骤标记 stepId 和 dependsOn；有前置依赖时等上游成功或失败后再决定下游，成员自行转交的协作分支也算上游。\n5. 按能力拆分面向具体成员的工作包，不原样转发用户需求。\n6. 选择合适成员并通过正式群聊消息委派。\n7. 等待结果、检查缺口并继续调度。\n8. 整理或梳理成文件且未指定格式时，默认生成并发送正式 HTML 成果文件，不发送源码或临时文件。\n9. 当前成员没有能力完成必要步骤时，由统筹智能体使用可用工具亲自补齐并真实发布成果。';

const PREVIOUS_KNOWLEDGE_DEFINITION_PROMPT = `你是知识管理智能体。你只处理当前群聊允许访问的资料、成果与知识库内容，输出必须保留来源和可验证关系。

原始文件新增、变化、删除或需要重新入库时使用 process-knowledge-files；基于知识库回答、核验或查找证据时使用 retrieve-knowledge。检索必须优先使用本地证据，不得把模型常识伪装成知识库内容。

任务完成后的知识归集应区分可复用知识、一次性任务记录和业务流程。只有确实存在可复用业务步骤时才输出业务流程，不得把智能体思考或运行轨迹当作业务流程。`;

const PREVIOUS_KNOWLEDGE_DEFINITION_PROMPT_V2 = `${PREVIOUS_KNOWLEDGE_DEFINITION_PROMPT}

本地知识领域的主任务必须由你闭环完成：知识范围按当前群聊权限自动解析为群聊个人知识、已关联项目知识和企业知识；未关联项目时跳过项目层，禁止读取其他群聊或未关联项目知识。先检查全部允许范围的原始文件是否变化，必要时完成知识化；同一 MD5 内容跨工作区复用处理结果但保留独立来源。再循环调整关键词、同义词、范围和混合检索策略，最后聚合为带工作区层级和来源的证据答案。不得把归档、知识化或内部检索推给资料调研智能体；只有完成主任务所必需的外部事实依赖才请求协作，收到依赖结果后继续完成自己的任务。`;

const KNOWLEDGE_DEFINITION_PROMPT = `你是知识管理智能体，只负责当前群聊授权范围内的原始文件知识化和知识底座维护。

检查个人、关联项目和企业工作区中的新增、变更、未完成与删除来源；按文件类型完成 OCR、标准化、切片、摘要、标签、向量、实体关系、图谱、Wiki、入库与溯源。同一 MD5 内容跨工作区复用处理结果但保留独立来源，删除来源停用但保留历史记录。

不得调用 knowledge.search、knowledge:readDocument、template:list 或 template:read，不回答制度、业务和材料问题，不编写报告，也不自行委派其他成员。误收到检索、整文、模板、写作或验收任务时，只完成必要增量知识化并明确交回统筹。正式消息只汇报处理状态、失败文件和人工复核项。`;

const LEGACY_KNOWLEDGE_DEFINITION_PROMPT = '你是知识管理员 (Knowledge Manager)。你负责管理项目知识库。\n\n## 可用工具\n- knowledge:search - 搜索知识库文档\n- workspace:readFile - 读取工作区文件\n- project:search - 跨项目搜索\n- knowledge:listGraph - 列出知识图谱\n- list_project_agents - 列出项目智能体\n- publish_artifact - 发布成果文件\n\n## 输出\n基于获取的信息，给出准确的回答。如果信息不足，明确告知用户。';

const PREVIOUS_RESEARCHER_DEFINITION_PROMPT = `你是资料调研智能体。围绕负责人交给你的具体问题检索与分析资料，区分事实、推断和未知信息，并为重要结论提供可核验来源。资料不足时明确说明缺口，不得编造引用。需要公开网络资料时，先按需加载 web-search 技能并调用 web:search；网页资料必须保留 URL，不得把网页摘要伪装成本地知识。统筹负责人负责全局拆解和委派；你应先完成自己的调研，不要把任务转给知识管理智能体，只有被具体资料依赖阻塞时才正式 @ 请求对应成员。`;

const EARLY_RESEARCHER_DEFINITION_PROMPT = `你是资料调研智能体。围绕负责人交给你的具体问题检索与分析资料，区分事实、推断和未知信息，并为重要结论提供可核验来源。资料不足时明确说明缺口，不得编造引用。`;

const PREVIOUS_RESEARCHER_DEFINITION_PROMPT_V2 = `${PREVIOUS_RESEARCHER_DEFINITION_PROMPT}

公开资料调研必须由你负责到底：先设计查询，再调用 web:search，评估来源、时效和覆盖度；不足时调整关键词、时间范围、站点或问题拆分继续检索，直到形成可用结论或能够说明已经穷尽。不得要求知识管理智能体替你归集公开资料，也不得把调研主任务转派出去。`;

const RESEARCHER_DEFINITION_PROMPT = `${PREVIOUS_RESEARCHER_DEFINITION_PROMPT}

公开资料调研由你负责到底，但搜索目标是“证据充分”，不是“次数越多越好”。先把问题压缩为最小查询集，搜索后立即评估来源、时效、冲突和覆盖度；现有结果足够支持结论时立即停止。单一事实通常一到两次搜索，一般调研通常不超过三次，只有负责人明确要求深度、全面或系统调研时才扩展到五次。不得重复或轻微改写同一查询来增加结果，不得要求知识管理智能体替你完成公开调研。

普通调研结果直接交回负责人。任务明确要求保存调研摘要、数据表或其他中间文件时，只调用 temp:save 保存到当前根任务的个人工作区“临时”目录；只填文件名，不填路径。不得写入 outputs/ 或声称未经工具保存的文件已存在，正式发布由统筹智能体完成。`;

const LEGACY_RESEARCHER_DEFINITION_PROMPT = '你是资料调研智能体，负责根据指令搜索知识库、分析信息并输出结构化调研报告。\n\n## 输出格式\n1. **调研摘要** — 关键发现概述\n2. **信息来源** — 引用来源 ID 和内容摘要\n3. **详细分析** — 按主题组织的信息\n4. **置信度评估** — 每个结论的可靠性标注\n\n## 限制\n- 不确定时明确告知而不是猜测';

const PREVIOUS_MATERIAL_WRITER_DEFINITION_PROMPT = `你是材料编写智能体。依据统筹提供的完整任务、知识证据、调研结果和模板说明，先设计章节框架，再逐章完成内容并统一校对。需要补查内部证据时，knowledge.search 会统一覆盖当前群聊个人知识、已关联项目知识和企业知识并标注层级；未关联项目时不得读取项目知识。模板存在时必须遵循；没有模板时才自行设计。事实和数字不得超出证据，不得混淆不同工作区来源。完整 HTML 待审稿只能通过 review:writeDraft 写入指定的 .runtime/review-drafts/ 路径，不得写入 outputs/ 或提前发布。返修时逐项处理验收意见。`;

const PREVIOUS_MATERIAL_WRITER_DEFINITION_PROMPT_V2 = `你是材料编写智能体，负责内部知识检索、明确文件整文读取、模板发现与读取，以及完整材料编写。

先用 template:list 查找个人、关联项目和企业模板区；找到适配模板后用 template:read 连续读取到 READ_COMPLETE: true，正文完成后用 template:materialize 套用原始 HTML 外壳，确认没有可用模板时才自行设计结构。无明确文件指向时用 knowledge:search 检索三层知识并综合证据；点名文件、依据某文件、审阅全文或逐条比较时，用 knowledge:readDocument 从 cursor=0 连续读取到 READ_COMPLETE: true。不得把检索或模板查找交给知识管理智能体。

先建立章节框架与证据对应关系，再逐章写作并统一校对。事实、数字和制度条款不得超出证据。完整 HTML 待审稿只能通过 review:writeDraft 写入指定 .runtime/review-drafts/ 路径，不写 outputs/，不提前发布；返修时覆盖同一路径。`;

const MATERIAL_WRITER_DEFINITION_PROMPT = `你是材料编写智能体，负责内部知识检索、明确文件整文读取、模板发现与读取，以及完整材料编写。

先判断任务类型。知识查询或整文阅读任务只使用 knowledge:search 或 knowledge:readDocument，综合为带来源的精炼答案，不调用模板工具、不创建文件。需要创建或修改材料时，才用 template:list 查找个人、关联项目和企业模板区；找到适配 HTML 模板后用 template:read 连续读取到 READ_COMPLETE: true，并用 template:materialize 将正文嵌入原始外壳；确认没有可用模板时才自行设计结构。不得把检索、整文读取或模板查找交给知识管理智能体。

材料任务先建立章节框架与证据对应关系，再逐章写作并统一校对。事实、数字和制度条款不得超出证据。所有框架、摘要和候选稿必须使用 temp:save 真实保存到当前任务个人工作区的临时目录，只填写文件名，不填写路径；模板外壳需保留，不能写入 outputs/ 或提前发布。返修时用 temp:read 读取并用 temp:save 覆盖同一文件名。`;

const PREVIOUS_ACCEPTANCE_REVIEWER_DEFINITION_PROMPT = `你是验收智能体。读取指定待审稿，使用知识检索和来源溯源技能核对完整需求、模板、关键事实、数字、制度条款、引用、内部一致性与 HTML 完整性。证据不足、存在变造或遗漏时明确判定不通过并列出可执行返修项；全部关键项通过时才判定通过。回复最后必须单独写“验收结论：通过”或“验收结论：不通过”。你不能修改或发布文件。`;

const ACCEPTANCE_REVIEWER_DEFINITION_PROMPT = `${PREVIOUS_ACCEPTANCE_REVIEWER_DEFINITION_PROMPT}

独立使用 template:list/template:read 核对实际模板，使用 knowledge.search 检索当前群聊个人、关联项目和企业知识；明确来源文件时使用 knowledge:readDocument 连续读取到 READ_COMPLETE: true。未关联项目时不得读取项目知识，也不得读取其他群聊或未关联项目知识。

正式回复只包含：验收结论、支持结论的关键证据、需要返修的问题。不要复制待审稿正文，不要输出 HTML、JSON、Markdown 源码或任何代码围栏。最后单独一行写“验收结论：通过”或“验收结论：不通过”。`;

const PREVIOUS_WEB_SEARCH_SKILL = `---
name: web-search
description: Search current public web information through the built-in Bocha search tool, verify sources, and synthesize cited research. Use for current events, companies, markets, competitors, policies, products, statistics, or other questions that require external public sources rather than local group knowledge.
---

# Web Search

1. Turn the assigned research question into the smallest useful set of search queries.
2. Call \`web:search\` and refine the query when the first result set is insufficient.
3. Assess relevance, publication time, source authority, primary versus secondary status, and conflicts between sources.
4. Keep the URL, site name, and publication date for material claims. Separate verified facts, inference, and unknown information.
5. Synthesize the smallest sufficient evidence set instead of pasting raw result lists.

Never send group messages, role cards, memories, local file contents, credentials, personal data, or other private workspace information to the search API.`;

const WEB_SEARCH_SKILL = `---
name: web-search
description: Search current public web information through the built-in Bocha search tool, verify sources, and synthesize cited research. Use for current events, companies, markets, competitors, policies, products, statistics, or other questions that require external public sources rather than local group knowledge.
---

# Web Search

1. Identify the exact evidence gap and turn it into the smallest useful query set.
2. Search once, then assess relevance, date, authority, primary versus secondary status, conflicts, and whether the current evidence is already sufficient.
3. Stop immediately when the available sources can support the requested conclusion. Refine only for a named missing fact, source conflict, or uncovered dimension; never repeat or lightly rephrase the same query.
4. Use one to two searches for a single current fact, normally no more than three for general research, and up to five only for an explicitly deep or comprehensive study.
5. Keep URL, site name, and publication date for material claims. Separate verified facts, inference, and unknown information, then synthesize rather than pasting raw result lists.

Never send group messages, role cards, memories, local file contents, credentials, personal data, or other private workspace information to the search API.`;

const installAgentDefinitions = async (root: string): Promise<void> => {
  const bundledDefinitionRoots = [
    join(process.resourcesPath, 'resources', 'agent-definitions'),
    join(app.getAppPath(), 'resources', 'agent-definitions'),
  ];
  const bundledDefinitions = bundledDefinitionRoots.find((path) => existsSync(path));
  if (bundledDefinitions) {
    await cp(bundledDefinitions, join(root, 'agent-definitions'), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });

    // The graph report is an official managed template. Keep existing workspaces on
    // the same visual contract while leaving every other agent definition untouched.
    const graphProjectionSource = join(
      bundledDefinitions,
      'built-in',
      'builtin.knowledge-manager',
      '1.0.0',
      'skills',
      'graph-projection',
    );
    if (existsSync(graphProjectionSource)) {
      await cp(
        graphProjectionSource,
        join(root, 'agent-definitions', 'built-in', 'builtin.knowledge-manager', '1.0.0', 'skills', 'graph-projection'),
        { recursive: true, force: true, errorOnExist: false },
      );
    }
    const managedBuiltinSkillPaths = [
      ['builtin.knowledge-manager', 'process-knowledge-files'],
      ['builtin.knowledge-manager', 'knowledge-provenance-validation'],
      ['builtin.material-writer', 'document-authoring'],
      ['builtin.material-writer', 'retrieve-knowledge'],
      ['builtin.acceptance-reviewer', 'retrieve-knowledge'],
      ['builtin.acceptance-reviewer', 'provenance-validation'],
      ['builtin.acceptance-reviewer', 'deliverable-acceptance'],
    ] as const;
    for (const [definitionId, skillId] of managedBuiltinSkillPaths) {
      const source = join(bundledDefinitions, 'built-in', definitionId, '1.0.0', 'skills', skillId);
      if (!existsSync(source)) continue;
      await cp(source, join(root, 'agent-definitions', 'built-in', definitionId, '1.0.0', 'skills', skillId), {
        recursive: true,
        force: true,
        errorOnExist: false,
      });
    }
    for (const definitionId of ['builtin.knowledge-manager', 'builtin.material-writer', 'builtin.acceptance-reviewer']) {
      const source = join(bundledDefinitions, 'built-in', definitionId, '1.0.0', 'agent.yaml');
      if (!existsSync(source)) continue;
      await cp(source, join(root, 'agent-definitions', 'built-in', definitionId, '1.0.0', 'agent.yaml'), {
        force: true,
        errorOnExist: false,
      });
    }
  }
  // This skill was previously owned by the knowledge manager. Remove the
  // managed copy so workspace scanning cannot silently restore the retired binding.
  await rm(join(root, 'agent-definitions', 'built-in', 'builtin.knowledge-manager', '1.0.0', 'skills', 'retrieve-knowledge'), {
    recursive: true,
    force: true,
  });
  await rm(join(root, 'agent-definitions', 'built-in', 'builtin.knowledge-manager', '1.0.0', 'skills', 'provenance-validation'), {
    recursive: true,
    force: true,
  });
  const orchestratorDir = join(root, 'agent-definitions', 'built-in', 'builtin.orchestrator', '1.0.0');
  const knowledgeDir = join(root, 'agent-definitions', 'built-in', 'builtin.knowledge-manager', '1.0.0');
  const researcherDir = join(root, 'agent-definitions', 'built-in', 'builtin.researcher', '1.0.0');
  const materialWriterDir = join(root, 'agent-definitions', 'built-in', 'builtin.material-writer', '1.0.0');
  const acceptanceReviewerDir = join(root, 'agent-definitions', 'built-in', 'builtin.acceptance-reviewer', '1.0.0');
  const localExecutorDir = join(root, 'agent-definitions', 'built-in', 'builtin.local-executor', '1.0.0');
  await mkdir(orchestratorDir, { recursive: true });
  await mkdir(knowledgeDir, { recursive: true });
  await mkdir(researcherDir, { recursive: true });
  await mkdir(materialWriterDir, { recursive: true });
  await mkdir(acceptanceReviewerDir, { recursive: true });
  await mkdir(localExecutorDir, { recursive: true });

  // The former specialist definitions are compatibility-only. Their
  // executable skill instructions are mounted on the single local executor.
  await writeIfMissing(join(localExecutorDir, 'agent.yaml'), `schemaVersion: 1
id: builtin.local-executor
version: 1.0.0
displayName: 本地执行智能体
runtime: native-model
framework: loop-engine
entry: nativeAgentLoop
defaultModelSlot: reasoning
skills:
  - local-knowledge-management
  - local-research
  - local-material-authoring
  - local-deliverable-acceptance
  - parallel-agent
`);
  const localSkillDocs: Array<[string, string]> = [
    ['local-knowledge-management', '负责原始文件增量知识化：OCR、解析、标准化、切片、摘要、标签、向量、图谱、Wiki、溯源和入库。'],
    ['local-research', '负责按需检索个人、项目和企业知识及公开网页资料，保留来源并在证据足够时停止。'],
    ['local-material-authoring', '负责检索证据、读取模板、编写和修改材料；中间稿写入 temp，确认真实存在后提升到 outputs。'],
    ['local-deliverable-acceptance', '负责在本地执行 loop 内核验需求、事实来源、模板一致性、文件完整性和可读性，发现问题先返修。'],
    ['parallel-agent', '仅当存在真正独立且有明显收益的子问题时，在本地执行智能体自身职责范围内并行处理并合并结果。'],
  ];
  for (const [skillId, description] of localSkillDocs) {
    const skillDir = join(localExecutorDir, 'skills', skillId);
    await mkdir(skillDir, { recursive: true });
    await writeIfMissing(join(skillDir, 'SKILL.md'), `---\nname: ${skillId}\ndescription: ${description}\n---\n\n# ${skillId}\n\n${description}\n`);
  }

  // agent.yaml + IDENTITY
  await writeIfMissing(join(orchestratorDir, 'agent.yaml'), ORCHESTRATOR_DEF);
  await writeManagedDefinitionFile(join(orchestratorDir, 'IDENTITY.template.md'), ORCHESTRATOR_IDENTITY, [EARLIER_ORCHESTRATOR_IDENTITY, LEGACY_ORCHESTRATOR_IDENTITY, PREVIOUS_ORCHESTRATOR_IDENTITY, PREVIOUS_ORCHESTRATOR_IDENTITY_V2]);
  await writeIfMissing(join(knowledgeDir, 'agent.yaml'), KNOWLEDGE_DEF);
  await writeManagedDefinitionFile(join(knowledgeDir, 'IDENTITY.template.md'), KNOWLEDGE_IDENTITY, [LEGACY_KNOWLEDGE_IDENTITY, PREVIOUS_KNOWLEDGE_IDENTITY]);
  await writeIfMissing(join(researcherDir, 'agent.yaml'), RESEARCHER_DEF);
  await writeManagedDefinitionFile(join(researcherDir, 'IDENTITY.template.md'), RESEARCHER_IDENTITY, [LEGACY_RESEARCHER_IDENTITY, PREVIOUS_RESEARCHER_IDENTITY]);
  await writeIfMissing(join(materialWriterDir, 'agent.yaml'), MATERIAL_WRITER_DEF);
  await writeManagedDefinitionFile(join(materialWriterDir, 'IDENTITY.template.md'), MATERIAL_WRITER_IDENTITY, [PREVIOUS_MATERIAL_WRITER_IDENTITY, PREVIOUS_MATERIAL_WRITER_IDENTITY_V2]);
  await writeIfMissing(join(acceptanceReviewerDir, 'agent.yaml'), ACCEPTANCE_REVIEWER_DEF);
  await writeManagedDefinitionFile(join(acceptanceReviewerDir, 'IDENTITY.template.md'), ACCEPTANCE_REVIEWER_IDENTITY, PREVIOUS_ACCEPTANCE_REVIEWER_IDENTITY);

  // prompts/system.md
  const orchPromptDir = join(orchestratorDir, 'prompts');
  const kmPromptDir = join(knowledgeDir, 'prompts');
  const resPromptDir = join(researcherDir, 'prompts');
  const writerPromptDir = join(materialWriterDir, 'prompts');
  const reviewerPromptDir = join(acceptanceReviewerDir, 'prompts');
  await mkdir(orchPromptDir, { recursive: true });
  await mkdir(kmPromptDir, { recursive: true });
  await mkdir(resPromptDir, { recursive: true });
  await mkdir(writerPromptDir, { recursive: true });
  await mkdir(reviewerPromptDir, { recursive: true });
  await writeManagedDefinitionFile(join(orchPromptDir, 'system.md'), ORCHESTRATOR_DEFINITION_PROMPT, [EARLIER_ORCHESTRATOR_DEFINITION_PROMPT, LEGACY_ORCHESTRATOR_DEFINITION_PROMPT, EARLY_ORCHESTRATOR_DEFINITION_PROMPT, PREVIOUS_ORCHESTRATOR_DEFINITION_PROMPT, PREVIOUS_ORCHESTRATOR_DEFINITION_PROMPT_V2, PREVIOUS_ORCHESTRATOR_DEFINITION_PROMPT_V3]);
  // The four-role architecture was previously a managed built-in prompt but
  // had several patched variants. Migrate only files that still contain that
  // exact retired ownership boundary; preserve unrelated manual prompt edits.
  try {
    const orchestratorPromptPath = join(orchPromptDir, 'system.md');
    const installedPrompt = await readFile(orchestratorPromptPath, 'utf8');
    if (/知识管理智能体只负责[\s\S]{0,500}材料编写智能体/u.test(installedPrompt)) {
      await writeFile(orchestratorPromptPath, ORCHESTRATOR_DEFINITION_PROMPT, 'utf8');
    }
  } catch { /* writeManagedDefinitionFile already handles missing files */ }
  await writeManagedDefinitionFile(join(kmPromptDir, 'system.md'), KNOWLEDGE_DEFINITION_PROMPT, [LEGACY_KNOWLEDGE_DEFINITION_PROMPT, PREVIOUS_KNOWLEDGE_DEFINITION_PROMPT, PREVIOUS_KNOWLEDGE_DEFINITION_PROMPT_V2]);
  await writeManagedDefinitionFile(join(resPromptDir, 'system.md'), RESEARCHER_DEFINITION_PROMPT, [LEGACY_RESEARCHER_DEFINITION_PROMPT, EARLY_RESEARCHER_DEFINITION_PROMPT, PREVIOUS_RESEARCHER_DEFINITION_PROMPT, PREVIOUS_RESEARCHER_DEFINITION_PROMPT_V2]);
  await writeManagedDefinitionFile(join(writerPromptDir, 'system.md'), MATERIAL_WRITER_DEFINITION_PROMPT, [PREVIOUS_MATERIAL_WRITER_DEFINITION_PROMPT, PREVIOUS_MATERIAL_WRITER_DEFINITION_PROMPT_V2]);
  await writeManagedDefinitionFile(join(reviewerPromptDir, 'system.md'), ACCEPTANCE_REVIEWER_DEFINITION_PROMPT, PREVIOUS_ACCEPTANCE_REVIEWER_DEFINITION_PROMPT);

  // orchestrator skills
  const orchSkillsDir = join(orchestratorDir, 'skills');
  const teamSkillDir = join(orchSkillsDir, 'team-planning');
  const resultSkillDir = join(orchSkillsDir, 'result-synthesis');
  await mkdir(teamSkillDir, { recursive: true });
  await mkdir(resultSkillDir, { recursive: true });
  await writeManagedDefinitionFile(join(teamSkillDir, 'SKILL.md'), TEAM_PLANNING_SKILL_MD, [EARLIER_TEAM_PLANNING_SKILL_MD, PREVIOUS_TEAM_PLANNING_SKILL_MD]);
  await writeIfMissing(join(resultSkillDir, 'SKILL.md'), '---\nname: result-synthesis\ndescription: 核对并汇总多个成员的结果形成统一交付；用于统筹智能体收口复杂任务。\n---\n\n# 结果汇总\n\n1. 按用户的完整多轮需求核对各工作包。\n2. 消除冲突和重复，缺失内容返回调度补齐。\n3. 优先把正式成果文件作为群聊附件发送，再给出简洁结论。\n4. 不发送 HTML 源码、临时文件或内部提示词。');

  // knowledge-manager skills
  const kmSkillsDir = join(knowledgeDir, 'skills');
  for (const skillId of ['process-knowledge-files', 'document-ingestion', 'entity-relation-extraction', 'knowledge-provenance-validation', 'wiki-materialization', 'graph-projection']) {
    const d = join(kmSkillsDir, skillId);
    await mkdir(d, { recursive: true });
  }
  await writeIfMissing(join(kmSkillsDir, 'document-ingestion', 'SKILL.md'), '---\nname: document-ingestion\ndescription: 解析群聊文件、按语义切片并保留来源位置；用于文档进入知识库时。\n---\n\n# 文档导入\n\n检查文件后提取正文，按语义边界切片、去重，并保存原始文件与位置引用。');
  await writeIfMissing(join(kmSkillsDir, 'entity-relation-extraction', 'SKILL.md'), '---\nname: entity-relation-extraction\ndescription: 从资料中抽取带置信度和来源的实体关系；用于构建或更新知识图谱。\n---\n\n# 实体关系抽取\n\n识别实体和关系，附带置信度、来源片段和待复核标记。');
  await writeIfMissing(join(kmSkillsDir, 'knowledge-provenance-validation', 'SKILL.md'), '---\nname: knowledge-provenance-validation\ndescription: 核验标准化正文、切片和知识结论与原始资料的一致性，并为知识入库保留来源位置。\n---\n\n# 知识入库溯源\n\n逐项核验知识结论、原始文档和位置引用；低置信度内容进入知识复核区，不执行材料成果验收。');
  await writeIfMissing(join(kmSkillsDir, 'wiki-materialization', 'SKILL.md'), '---\nname: wiki-materialization\ndescription: 把知识图谱整理为可读且可溯源的 Wiki 文档；用于知识沉淀和经验归集。\n---\n\n# Wiki 生成\n\n生成包含摘要、关系和来源的 Markdown 页面，并保存到知识工作区。');
  await writeIfMissing(join(kmSkillsDir, 'graph-projection', 'SKILL.md'), '---\nname: graph-projection\ndescription: 将知识图谱投影为前端可视化数据；用于图谱预览或导出。\n---\n\n# 图谱投影\n\n导出节点、边、标签和分组，生成前端可消费的 JSON。');
  const processKnowledgeSkillDir = join(kmSkillsDir, 'process-knowledge-files');
  await writeIfMissing(join(processKnowledgeSkillDir, 'SKILL.md'), `---
name: process-knowledge-files
description: Incrementally process new, changed, or deleted files across the current group's personal, linked-project, and enterprise workspaces into local chunks, summaries, keywords, tags, embeddings, graph entities, Wiki pages, and visualizations.
---

# Process knowledge files

1. Scan the current group personal workspace, its linked project workspace, and the enterprise workspace. Skip the project scope when no project is linked; never scan another group or unlinked project.
2. Compare files with the stored MD5 fingerprint. Skip unchanged ready sources and reuse completed processing for identical content in another authorized scope while keeping an independent source mapping.
3. Reprocess new or changed sources according to file type; use local OCR only when extracted text is absent or clearly insufficient.
4. Produce semantic chunks with source locations, a document summary, keywords, tags, local embeddings, entities, relationships, provenance, Wiki pages, and graph visualization.
5. When a source is removed, deactivate it so it cannot be retrieved while retaining its historical processing record.
6. Report only meaningful completion statistics, failures, or items requiring review. Do not expose internal pipeline terminology to the user.

Read references/storage-schema.md when checking paths, lifecycle, or output contracts.`);
  await mkdir(join(processKnowledgeSkillDir, 'agents'), { recursive: true });
  await mkdir(join(processKnowledgeSkillDir, 'references'), { recursive: true });
  await writeIfMissing(join(processKnowledgeSkillDir, 'agents', 'openai.yaml'), 'interface:\n  display_name: "知识文件处理"\n  short_description: "增量处理群聊个人、关联项目与企业知识的原始文件"\n  default_prompt: "Use $process-knowledge-files to process new or changed files across authorized personal, linked-project, and enterprise scopes."\npolicy:\n  allow_implicit_invocation: true\n');
  await writeIfMissing(join(processKnowledgeSkillDir, 'references', 'storage-schema.md'), '# 本地存储契约\n\n- `original-files/`: 只读原始输入。\n- `standardized-files/<sourceId>/document.md`: 规范化完整正文。\n- `standardized-files/<sourceId>/manifest.json`: 页、切片、章节和哈希清单。\n- `standardized-files/<sourceId>/chunks/`: 可回溯完整正文的切片中间文件。\n- `knowledge/knowledge-index.json`: 文档摘要、关键词和标签索引。\n- `knowledge/wiki/`: Wiki 页面及 `index.html`。\n- `graph-visualization/knowledge-graph.json`: 图谱投影。\n- `graph-visualization/knowledge-graph.html`: 离线可视化。\n- SQLite: 切片、向量、图谱、溯源和处理状态的权威数据。\n\n文件身份使用 MD5 做处理标记，同时保留 SHA-256 版本校验。源文件删除或新版本入库后必须回收旧来源数据。`standardized-files/` 只供整文读取与溯源，不参与原始文件扫描、二次知识化或普通检索。\n');

  // researcher resources
  const resSkillsDir = join(researcherDir, 'skills');
  const webSearchSkillDir = join(resSkillsDir, 'web-search');
  await mkdir(join(resSkillsDir, 'information-retrieval'), { recursive: true });
  await mkdir(join(resSkillsDir, 'source-analysis'), { recursive: true });
  await mkdir(join(webSearchSkillDir, 'agents'), { recursive: true });
  await writeIfMissing(join(resSkillsDir, 'information-retrieval', 'SKILL.md'), '---\nname: information-retrieval\ndescription: 检索、筛选和排序与任务相关的资料；用于资料调研和事实查找。\n---\n\n# 信息检索\n\n根据问题检索资料，保留出处并按相关性和可靠性排序。');
  await writeIfMissing(join(resSkillsDir, 'source-analysis', 'SKILL.md'), '---\nname: source-analysis\ndescription: 评估资料来源可靠性并进行交叉验证；用于事实核查和研究结论校验。\n---\n\n# 来源分析\n\n比较多个来源的一致性、时效性和利益关系，明确结论置信度。');
  await writeManagedDefinitionFile(join(webSearchSkillDir, 'SKILL.md'), WEB_SEARCH_SKILL, PREVIOUS_WEB_SEARCH_SKILL);
  await writeIfMissing(join(webSearchSkillDir, 'agents', 'openai.yaml'), 'interface:\n  display_name: "网页搜索"\n  short_description: "搜索公开网页资料并保留来源链接，帮助调研智能体核验事实"\n  default_prompt: "Use $web-search to find current public sources for this research question."\npolicy:\n  allow_implicit_invocation: true\n');

  // material writer + acceptance reviewer resources
  const writerSkillDir = join(materialWriterDir, 'skills', 'document-authoring');
  const writerRetrieveDir = join(materialWriterDir, 'skills', 'retrieve-knowledge');
  const reviewerSkillsDir = join(acceptanceReviewerDir, 'skills');
  const reviewerRetrieveDir = join(reviewerSkillsDir, 'retrieve-knowledge');
  const reviewerProvenanceDir = join(reviewerSkillsDir, 'provenance-validation');
  const reviewerAcceptanceDir = join(reviewerSkillsDir, 'deliverable-acceptance');
  await mkdir(writerSkillDir, { recursive: true });
  await mkdir(writerRetrieveDir, { recursive: true });
  await mkdir(reviewerRetrieveDir, { recursive: true });
  await mkdir(reviewerProvenanceDir, { recursive: true });
  await mkdir(reviewerAcceptanceDir, { recursive: true });
  await writeIfMissing(join(writerSkillDir, 'SKILL.md'), '---\nname: document-authoring\ndescription: 自行检索知识、读取明确文件与模板，先搭建框架，再将正文嵌入实际模板并通过 temp:save 保存完整 HTML 候选稿。\n---\n\n# 材料编写\n\n先通过 template:list/template:read 获取实际模板，再使用 knowledge:search 或 knowledge:readDocument 取得证据。发现 HTML 模板后必须保留模板外壳、CSS、logo、页眉、页脚和背景；没有模板时才自行设计。识别读者与约束，列出章节框架和证据对应关系，逐章写作、统一校对，并通过 temp:save 以文件名保存候选稿。不要填写路径或声称未写入的文件已经存在。');
  const sharedKnowledgeRetrievalSkill = '---\nname: retrieve-knowledge\ndescription: 在当前群聊个人、关联项目和企业知识中检索证据；明确文件任务完整读取标准化正文，并提供可溯源的精炼依据。\n---\n\n# 知识检索与整文读取\n\n1. 无明确文件指向时使用 knowledge:search 融合全文、向量、图谱和 Wiki，综合证据而不是堆砌切片。\n2. 点名文件、依据某文件、审阅全文或逐条比较时，使用 knowledge:readDocument 从 cursor=0 连续读取到 READ_COMPLETE: true。\n3. 标注个人、项目或企业层级以及文件、页码、章节或位置；证据不足时明确缺口，不用模型常识冒充内部知识。';
  await writeIfMissing(join(writerRetrieveDir, 'SKILL.md'), sharedKnowledgeRetrievalSkill);
  await writeIfMissing(join(reviewerRetrieveDir, 'SKILL.md'), sharedKnowledgeRetrievalSkill);
  await writeIfMissing(join(reviewerProvenanceDir, 'SKILL.md'), '---\nname: provenance-validation\ndescription: 核验材料主张与原始知识证据的一致性，识别变造、冲突和来源缺口。\n---\n\n# 来源溯源\n\n建立材料主张、知识证据和原始位置的对应关系；无法定位来源或限定条件被改变时判定不通过。');
  await writeIfMissing(join(reviewerAcceptanceDir, 'SKILL.md'), '---\nname: deliverable-acceptance\ndescription: 按需求、实际模板、证据和文件完整性验收待审稿，给出明确通过或不通过结论。\n---\n\n# 成果验收\n\n读取待审稿，使用 template:list/template:read 独立核对实际模板，再逐项检查需求覆盖、证据、口径与 HTML 完整性；不通过时输出可执行返修清单。');

  const parallelAgentSkill = `---
name: parallel-agent
description: Decide whether independent work inside your own role can be split across temporary parallel sub-agents, then merge their results before continuing.
---

# Parallel agent

- Use this only when at least two genuinely independent sub-queries exist and the expected speedup is meaningful.
- Keep every sub-agent inside your own role, skills, permissions, and current group workspace.
- Do not split dependent steps; wait for prerequisite evidence before creating the next sub-task.
- Give each sub-agent a complete natural-language query. Do not ask it to coordinate other primary agents.
- Review, reconcile, and synthesize all returned results yourself. A sub-agent result is evidence, not an automatic conclusion.
- A single task should be completed directly. Never create another generation of sub-agents.
`;
  const parallelAgentDirs = [
    join(kmSkillsDir, 'parallel-agent'),
    join(resSkillsDir, 'parallel-agent'),
    join(materialWriterDir, 'skills', 'parallel-agent'),
    join(acceptanceReviewerDir, 'skills', 'parallel-agent'),
  ];
  for (const directory of parallelAgentDirs) {
    await mkdir(directory, { recursive: true });
    await writeIfMissing(join(directory, 'SKILL.md'), parallelAgentSkill);
  }

  const packageMetadata = [
    [teamSkillDir, 'team-planning', ['list_project_agents', 'delegate_tasks']],
    [resultSkillDir, 'result-synthesis', []],
    [join(kmSkillsDir, 'document-ingestion'), 'document-ingestion', ['workspace:readFile']],
    [join(kmSkillsDir, 'entity-relation-extraction'), 'entity-relation-extraction', ['workspace:readFile']],
    [join(kmSkillsDir, 'knowledge-provenance-validation'), 'knowledge-provenance-validation', ['workspace:readFile']],
    [join(kmSkillsDir, 'wiki-materialization'), 'wiki-materialization', ['publish_artifact']],
    [join(kmSkillsDir, 'graph-projection'), 'graph-projection', ['knowledge:listGraph', 'publish_artifact']],
    [processKnowledgeSkillDir, 'process-knowledge-files', ['workspace:readFile', 'knowledge:ingest', 'local:ocr', 'local:embed']],
    [join(resSkillsDir, 'information-retrieval'), 'information-retrieval', ['knowledge:search']],
    [join(resSkillsDir, 'source-analysis'), 'source-analysis', ['knowledge:search']],
    [webSearchSkillDir, 'web-search', ['web:search']],
    [writerRetrieveDir, 'retrieve-knowledge', ['knowledge:search', 'knowledge:readDocument', 'knowledge:listGraph']],
    [writerSkillDir, 'document-authoring', ['skill:search', 'skill:load', 'knowledge:search', 'knowledge:readDocument', 'template:list', 'template:read', 'temp:save', 'temp:read', 'temp:list', 'workspace:readFile']],
    [reviewerRetrieveDir, 'retrieve-knowledge', ['knowledge:search', 'knowledge:readDocument', 'knowledge:listGraph']],
    [reviewerProvenanceDir, 'provenance-validation', ['workspace:readFile', 'knowledge:search']],
    [reviewerAcceptanceDir, 'deliverable-acceptance', ['temp:list', 'temp:read', 'workspace:readFile', 'knowledge:search', 'knowledge:readDocument', 'template:list', 'template:read', 'skill:load']],
    [join(kmSkillsDir, 'parallel-agent'), 'parallel-agent', ['agent:spawn_parallel']],
    [join(resSkillsDir, 'parallel-agent'), 'parallel-agent', ['agent:spawn_parallel']],
    [join(materialWriterDir, 'skills', 'parallel-agent'), 'parallel-agent', ['agent:spawn_parallel']],
    [join(acceptanceReviewerDir, 'skills', 'parallel-agent'), 'parallel-agent', ['agent:spawn_parallel']],
  ] as const;
  for (const [directory, id, requiredTools] of packageMetadata) {
    const executionMode = id === 'process-knowledge-files' || id === 'retrieve-knowledge'
      ? 'hybrid'
      : 'instructions';
    await writeIfMissing(join(directory, 'kunqing.json'), JSON.stringify({
      schemaVersion: 1,
      id,
      version: '1.0.0',
      entry: 'SKILL.md',
      executionMode,
      requiredTools,
      compatibility: { codexSkill: true, kunqing: '>=0.1.0' },
    }, null, 2));
  }
  await mkdir(join(researcherDir, 'evals'), { recursive: true });
  await writeIfMissing(join(researcherDir, 'evals', 'cases.yaml'), 'cases:\n  - id: research-basic-query\n    instruction: "搜索关于财务报销流程的信息"');

  // evals
  await mkdir(join(orchestratorDir, 'evals'), { recursive: true });
  await mkdir(join(knowledgeDir, 'evals'), { recursive: true });
  await mkdir(join(materialWriterDir, 'evals'), { recursive: true });
  await mkdir(join(acceptanceReviewerDir, 'evals'), { recursive: true });
  await writeIfMissing(join(orchestratorDir, 'evals', 'cases.yaml'), 'cases:\n  - name: direct-answer\n    input: "你好，今天天气怎么样？"\n    expected:\n      intent: "answer"\n      needsKM: false\n  - name: delegate-query-to-writer\n    input: "帮我查一下项目文档中关于数据库设计的内容"\n    expected:\n      intent: "delegate"\n      target: "builtin.material-writer"');
  await writeIfMissing(join(knowledgeDir, 'evals', 'cases.yaml'), 'cases:\n  - name: document-ingestion\n    input: "上传一份 PDF 文档到知识库"\n    expected:\n      action: "ingest"\n  - name: graph-update\n    input: "把新增原始文件知识化并更新知识图谱"\n    expected:\n      action: "ingest"');
  await writeIfMissing(join(materialWriterDir, 'evals', 'cases.yaml'), 'cases:\n  - name: outline-before-writing\n    input: "依据模板和证据编写报告"\n    expected:\n      outlineFirst: true\n      writesReviewDraft: true');
  await writeIfMissing(join(acceptanceReviewerDir, 'evals', 'cases.yaml'), 'cases:\n  - name: reject-unsupported-claim\n    input: "待审稿含无证据关键数据"\n    expected:\n      result: "不通过"\n      searchesKnowledge: true');
};

const tryAcquireLock = async (root: string): Promise<boolean> => {
  const lockPath = join(root, '.kstudio', 'workspace.lock');
  try {
    await writeFile(lockPath, `${process.pid}`, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    // 锁文件已存在，检查是否过期
    try {
      const existingPid = parseInt(await readFile(lockPath, 'utf8'), 10);
      // 如果是同一进程，直接返回成功
      if (existingPid === process.pid) return true;
      // 检查原进程是否还在运行
      try {
        process.kill(existingPid, 0); // 信号 0 只检测进程是否存在，不发送信号
        return false; // 进程仍在运行，不能获取锁
      } catch {
        // 进程已不存在，锁过期，覆盖
        await writeFile(lockPath, `${process.pid}`, { encoding: 'utf8', flag: 'w' });
        return true;
      }
    } catch {
      return false;
    }
  }
};

const releaseLock = async (root: string): Promise<void> => {
  try {
    await writeFile(join(root, '.kstudio', 'workspace.lock'), '', { encoding: 'utf8' });
  } catch { /* ignore */ }
};

const ensureStudioWorkspace = async (): Promise<{ workspaceId: string; isNew: boolean }> => {
  const root = getStudioRoot();
  const markerPath = join(root, '.kstudio', 'workspace.json');
  const isNew = !existsSync(markerPath);
  await Promise.all([
    mkdir(join(root, '.kstudio', 'logs'), { recursive: true }),
    mkdir(join(root, '.kstudio', 'cache'), { recursive: true }),
    mkdir(join(root, '.kstudio', 'backups'), { recursive: true }),
    mkdir(join(root, '.kstudio', 'temp', 'staged-uploads'), { recursive: true }),
    mkdir(join(root, 'agent-definitions', 'built-in'), { recursive: true }),
    mkdir(join(root, 'agent-definitions', 'custom'), { recursive: true }),
    mkdir(join(root, 'workflows', 'built-in'), { recursive: true }),
    mkdir(join(root, 'workflows', 'custom'), { recursive: true }),
    mkdir(join(root, 'group-chats'), { recursive: true }),
    mkdir(join(root, 'projects'), { recursive: true }),
    mkdir(join(root, 'meetings'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'original-files'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'templates'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'standardized-files'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'knowledge', 'graph'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'knowledge', 'wiki'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'knowledge', 'review'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'graph-visualization'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'outputs'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'experience'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', '.runtime', 'trash'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', '.runtime', 'versions'), { recursive: true }),
  ]);
  let workspaceId: string;
  if (isNew) {
    workspaceId = randomUUID();
    await writeFile(markerPath, JSON.stringify({ schemaVersion: 1, workspaceId, product: 'K_Studio', createdAt: new Date().toISOString() }, null, 2));
  } else {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { workspaceId: string };
    workspaceId = marker.workspaceId;
  }
  await installAgentDefinitions(root);
  return { workspaceId, isNew };
};

const ensureProjectWorkspace = async ({ projectId, name }: EnsureProjectRequest): Promise<string> => {
  await ensureStudioWorkspace();
  const projectRoot = getProjectRoot(projectId);
  await Promise.all([
    mkdir(join(projectRoot, 'agent-identities'), { recursive: true }),
    mkdir(join(projectRoot, 'agent-memories'), { recursive: true }),
    mkdir(join(projectRoot, 'original-files'), { recursive: true }),
    mkdir(join(projectRoot, 'templates'), { recursive: true }),
    mkdir(join(projectRoot, 'standardized-files'), { recursive: true }),
    mkdir(join(projectRoot, 'knowledge', 'graph'), { recursive: true }),
    mkdir(join(projectRoot, 'knowledge', 'wiki'), { recursive: true }),
    mkdir(join(projectRoot, 'knowledge', 'review'), { recursive: true }),
    mkdir(join(projectRoot, 'graph-visualization', 'layouts'), { recursive: true }),
    mkdir(join(projectRoot, 'graph-visualization', 'exports'), { recursive: true }),
    mkdir(join(projectRoot, 'outputs'), { recursive: true }),
    mkdir(join(projectRoot, 'experience'), { recursive: true }),
    mkdir(getProjectTempRoot(projectId), { recursive: true }),
    mkdir(join(projectRoot, '.runtime', 'trash'), { recursive: true }),
    mkdir(join(projectRoot, '.runtime', 'versions'), { recursive: true }),
    mkdir(join(projectRoot, '.runtime', 'run-temp'), { recursive: true }),
    mkdir(join(projectRoot, '.runtime', 'sandboxes'), { recursive: true }),
  ]);
  const publicName = name.replace(/[\r\n]/g, ' ').trim() || projectId;
  await writeIfMissing(join(projectRoot, 'group.yaml'), `schemaVersion: 1\nprojectId: ${projectId}\nname: ${JSON.stringify(publicName)}\n`);
  return join(projectRoot, 'original-files');
};

const getOriginalFilesRoot = async (projectId: string): Promise<string> => ensureProjectWorkspace({ projectId, name: projectId });

const assertNoSymlink = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new DatabaseError('VALIDATION_FAILED', '不允许通过符号链接访问群聊工作区外部');
};

const nextAvailablePath = async (directory: string, fileName: string): Promise<string> => {
  const extensionIndex = fileName.lastIndexOf('.');
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : '';
  let candidate = join(directory, fileName);
  let index = 1;
  while (true) {
    try {
      await access(candidate);
      candidate = join(directory, `${stem} (${index})${extension}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
};

const registerWorkspaceIpc = (getDb: () => ReturnType<typeof getDatabase>): void => {
  const assertWorkspaceAccess = (input: WorkspaceRequest): void => {
    if (input.scopeType !== 'project-shared') return;
    const db = getDb();
    const resourceType = input.resourceType ?? 'group';
    const resourceId = assertProjectId(input.resourceId ?? input.projectId);
    const linkedProjectId = resolveAssociatedEnterpriseProjectId(db, resourceType, resourceId);
    if (!linkedProjectId || linkedProjectId !== input.scopeId) {
      throw new DatabaseError('VALIDATION_FAILED', '当前群聊未关联该项目，无法访问项目工作区');
    }
  };
  registerIpc('workspace:ensureProject', async (_event, input: EnsureProjectRequest) => {
    const root = await ensureProjectWorkspace(input);
    if (_fileWatcher) _fileWatcher.addWatch(getProjectRoot(input.projectId), 'project', input.projectId);
    return { ok: true };
  });

  registerIpc('workspace:openItem', async (_event, input: WorkspaceRequest) => {
    assertWorkspaceAccess(input);
    const root = await getScopeRoot(input);
    const target = resolveInside(root, input.relativePath);
    await assertNoSymlink(target);
    const message = await shell.openPath(target);
    if (message) throw new Error(message);
    return { ok: true };
  });

  registerIpc('workspace:openInExplorer', async (_event, input: { projectId: string }) => {
    const root = await getOriginalFilesRoot(input.projectId);
    const message = await shell.openPath(root);
    if (message) throw new Error(message);
    return { ok: true };
  });

  registerIpc('workspace:openWithSystem', async (_event, input: WorkspaceRequest) => {
    assertWorkspaceAccess(input);
    const st = input.scopeType ?? 'project';
    const scopeRoot = await getScopeRoot(input);
    let target: string;
    try {
      target = resolveInside(scopeRoot, input.relativePath);
      await access(target);
    } catch {
      const systemRoot = st === 'shared'
        ? getEnterpriseWorkspaceRoot()
        : st === 'project-shared'
          ? getEnterpriseProjectRoot(input.scopeId || input.projectId)
          : getProjectRoot(input.projectId);
      target = resolveInside(systemRoot, input.relativePath);
      await access(target);
    }
    await assertNoSymlink(target);
    const message = await shell.openPath(target);
    if (message) throw new Error(message);
    return { ok: true };
  });
};

const knowledgeIngestForFile = (db: ReturnType<typeof getDatabase>, fileId: string): unknown => {
  const prepared = prepareKnowledgeIngestion(db, fileId);
  if (_gateway && prepared.started) {
    return ingestKnowledgeFile(db, _gateway, fileId).catch((err: unknown) => {
      getLogger().error({ err, fileId, sourceId: prepared.sourceId }, '知识入库流水线异常');
      return prepared;
    });
  }
  return prepared;
};

const registerFileIpc = (db: ReturnType<typeof getDatabase>): void => {
  const fileRepo = new FileRepository(db);
  const assertWorkspaceAccess = (input: WorkspaceRequest): void => {
    if (input.scopeType !== 'project-shared') return;
    const resourceType = input.resourceType ?? 'group';
    const resourceId = assertProjectId(input.resourceId ?? input.projectId);
    const linkedProjectId = resolveAssociatedEnterpriseProjectId(db, resourceType, resourceId);
    if (!linkedProjectId || linkedProjectId !== input.scopeId) {
      throw new DatabaseError('VALIDATION_FAILED', '当前群聊未关联该项目，无法访问项目工作区');
    }
  };

  registerIpc('workspace:listFiles', async (_event, input: WorkspaceRequest) => {
    assertWorkspaceAccess(input);
    const st = input.scopeType ?? 'project';
    const dbSt: 'project' | 'shared' = st === 'shared' ? 'shared' : 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : st === 'project-shared' ? input.scopeId || input.projectId : input.projectId;
    const root = await getScopeRoot(input);
    const directory = resolveInside(root, input.relativePath);
    await assertNoSymlink(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const result = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry) => {
      const entryPath = join(directory, entry.name);
      const info = await lstat(entryPath);
      const relativePath = join(normalizeRelativePath(input.relativePath), entry.name).replaceAll('\\', '/');
      const dbRow = entry.isDirectory() ? null : fileRepo.getByPath(dbSt, sid, relativePath);
      let size = entry.isDirectory() ? 0 : info.size;
      let sha256: string | undefined;
      let knowledgeStatus: string | undefined;
      if (dbRow?.currentVersionId) {
        const ver = fileRepo.getCurrentVersion(dbRow.id);
        if (ver) { size = ver.size; sha256 = ver.sha256; }
      }
      if (dbRow) {
        const src = new KnowledgeRepository(db).getSourceByFile(dbRow.id);
        if (src) knowledgeStatus = src.status;
      }
      return {
        name: entry.name,
        relativePath,
        kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
        size,
        modifiedAt: info.mtime.toISOString(),
        fileId: dbRow?.id,
        currentVersionId: dbRow?.currentVersionId,
        mimeType: dbRow?.mimeType,
        sha256,
        knowledgeStatus,
      };
    }));
    return { ok: true, data: result.sort((left, right) => left.kind === right.kind ? right.modifiedAt.localeCompare(left.modifiedAt) : left.kind === 'directory' ? -1 : 1) };
  });

  registerIpc('workspace:uploadFiles', async (event, input: WorkspaceRequest) => {
    assertWorkspaceAccess(input);
    if (input.systemDir && !['original-files', 'templates'].includes(input.systemDir)) {
      throw new DatabaseError('VALIDATION_FAILED', '文件只能上传到原始文件区或模板区');
    }
    const st = input.scopeType ?? 'project';
    const dbSt: 'project' | 'shared' = st === 'shared' ? 'shared' : 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : st === 'project-shared' ? input.scopeId || input.projectId : input.projectId;
    const root = await getWorkspaceOperationRoot(input);
    const targetRelativePath = normalizeWorkspaceRelativePath(input);
    const targetDirectory = resolveInside(root, targetRelativePath);
    // A newly selected template subfolder is a valid upload destination. Create
    // it before symlink/path validation so an absent directory does not surface
    // as the misleading "file not found" error.
    await mkdir(targetDirectory, { recursive: true });
    await assertNoSymlink(targetDirectory);
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { title: st === 'project-shared' ? '导入到项目工作区' : st === 'shared' ? '导入到企业工作区' : '导入到个人工作区', properties: ['openFile', 'multiSelections'] };
    const selection = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options);
    if (selection.canceled) return { cancelled: true, importedCount: 0 };
    let sources: Array<{ sourcePath: string; info: Awaited<ReturnType<typeof lstat>> }>;
    try {
      sources = await Promise.all(selection.filePaths.map(async (sourcePath) => ({ sourcePath, info: await lstat(sourcePath) })));
    } catch (error) {
      throw new DatabaseError('VALIDATION_FAILED', `无法读取所选文件（磁盘中不存在该文件）：${error instanceof Error ? error.message : String(error)}`);
    }
    if (sources.some(({ info }) => !info.isFile() || info.isSymbolicLink())) throw new DatabaseError('VALIDATION_FAILED', '只能导入普通文件');
    if (sources.some(({ info }) => Number(info.size) > MAX_FILE_BYTES)) throw new DatabaseError('VALIDATION_FAILED', '单个文件不能超过 100 MB');
    if (sources.reduce((total, { info }) => total + Number(info.size), 0) > MAX_BATCH_BYTES) throw new DatabaseError('VALIDATION_FAILED', '单次导入总量不能超过 500 MB');
    for (const { sourcePath } of sources) {
      const destName = basename(sourcePath);
      const destination = await nextAvailablePath(targetDirectory, destName);
      try {
        await copyFile(sourcePath, destination);
      } catch (error) {
        throw new DatabaseError('VALIDATION_FAILED', `导入文件失败：${sourcePath} -> ${destination}；${error instanceof Error ? error.message : String(error)}`);
      }
      const storageRelPath = join('.runtime', 'versions', basename(destination));
      const { createHash } = await import('node:crypto');
      const { readFile: rf } = await import('node:fs/promises');
      const buf = await rf(destination);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const normalizedPath = join(targetRelativePath, basename(destination)).replaceAll('\\', '/');
      const existing = fileRepo.getByPath(dbSt, sid, normalizedPath);
      if (existing) {
        fileRepo.createVersion({
          fileId: existing.id,
          storageRelPath,
          size: buf.length,
          sha256,
          createdByType: 'user',
          createdById: 'local-user',
          changeNote: 'upload',
        });
      } else {
        const parentPath = targetRelativePath;
        const file = fileRepo.create({
          scopeType: dbSt,
          scopeId: sid,
          parentId: parentPath || null,
          type: 'file',
          name: destName,
          normalizedPath,
          mimeType: '',
          origin: 'upload',
        });
        fileRepo.createVersion({
          fileId: file.id,
          storageRelPath,
          size: buf.length,
          sha256,
          createdByType: 'user',
          createdById: 'local-user',
          changeNote: 'upload',
        });
        fileRepo.markReady(file.id);
      }
    }
    // 原始文件在检索或手动触发时知识化；模板只供材料编写与验收读取。
    return { cancelled: false, importedCount: sources.length };
  });

  registerIpc('workspace:publishToProject', async (_event, input: {
    projectId: string;
    enterpriseProjectId: string;
    relativePath: string;
    sourceArea?: 'original-files' | 'outputs';
  }) => {
    const linkedProjectId = resolveAssociatedEnterpriseProjectId(db, 'group', input.projectId);
    if (!linkedProjectId || linkedProjectId !== input.enterpriseProjectId) {
      throw new DatabaseError('VALIDATION_FAILED', '当前群聊未关联该项目，无法发布文件');
    }
    const sourceArea = input.sourceArea === 'outputs' ? 'outputs' : 'original-files';
    const groupRoot = getProjectRoot(input.projectId);
    const sourceRoot = join(groupRoot, sourceArea);
    const normalizedSourcePath = normalizeRelativePath(input.relativePath).replaceAll('\\', '/');
    const areaRelativePath = normalizedSourcePath.startsWith(`${sourceArea}/`)
      ? normalizedSourcePath.slice(sourceArea.length + 1)
      : normalizedSourcePath;
    const source = resolveInside(sourceRoot, areaRelativePath);
    await assertNoSymlink(source);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile()) throw new DatabaseError('VALIDATION_FAILED', '当前只支持发布单个文件');

    const projectRoot = await ensureEnterpriseProjectWorkspace({ projectId: linkedProjectId });
    const relativeDirectory = join('groups', input.projectId).replaceAll('\\', '/');
    const targetDirectory = join(projectRoot, 'original-files', relativeDirectory);
    await mkdir(targetDirectory, { recursive: true });
    const target = await nextAvailablePath(targetDirectory, safeFileName(basename(source)));
    await copyFile(source, target);

    const buffer = await readFile(target);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const normalizedPath = join(relativeDirectory, basename(target)).replaceAll('\\', '/');
    const existing = fileRepo.getByPath('project', linkedProjectId, normalizedPath);
    const file = existing ?? fileRepo.create({
      scopeType: 'project',
      scopeId: linkedProjectId,
      parentId: relativeDirectory,
      type: 'file',
      name: basename(target),
      normalizedPath,
      mimeType: '',
      origin: 'imported',
    });
    fileRepo.createVersion({
      fileId: file.id,
      storageRelPath: join('.runtime', 'versions', `${sha256.slice(0, 16)}-${basename(target)}`),
      size: buffer.byteLength,
      sha256,
      createdByType: 'user',
      createdById: 'local-user',
      changeNote: `published-from-group:${input.projectId}`,
    });
    fileRepo.markReady(file.id);
    return { ok: true, data: { relativePath: normalizedPath, fileId: file.id, projectId: linkedProjectId } };
  });

  registerIpc('workspace:createFolder', async (_event, input: CreateFolderRequest) => {
    assertWorkspaceAccess(input);
    if (input.systemDir && !['original-files', 'templates'].includes(input.systemDir)) {
      throw new DatabaseError('VALIDATION_FAILED', '只能在原始文件区或模板区新建文件夹');
    }
    const st = input.scopeType ?? 'project';
    const dbSt: 'project' | 'shared' = st === 'shared' ? 'shared' : 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : st === 'project-shared' ? input.scopeId || input.projectId : input.projectId;
    const root = await getWorkspaceOperationRoot(input);
    const parentPath = normalizeWorkspaceRelativePath(input);
    const parent = resolveInside(root, parentPath);
    await assertNoSymlink(parent);
    await mkdir(join(parent, validateFolderName(input.name)), { recursive: false });
    const normalizedPath = join(parentPath, input.name).replaceAll('\\', '/');
    if (!fileRepo.existsByPath(dbSt, sid, normalizedPath)) {
      fileRepo.create({
        scopeType: dbSt,
        scopeId: sid,
        parentId: parentPath || null,
        type: 'directory',
        name: input.name,
        normalizedPath,
      });
    }
    return { ok: true };
  });

  registerIpc('workspace:listVersions', async (_event, input: { fileId: string }) => {
    const versions = fileRepo.listVersions(input.fileId);
    return {
      ok: true,
      data: versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        size: v.size,
        sha256: v.sha256,
        createdByType: v.createdByType,
        createdById: v.createdById,
        runId: v.runId,
        changeNote: v.changeNote,
        createdAt: v.createdAt,
      })),
    };
  });

  registerIpc('workspace:rename', async (_event, input: WorkspaceRequest & { name: string }) => {
    assertWorkspaceAccess(input);
    const st = input.scopeType ?? 'project';
    const dbSt: 'project' | 'shared' = st === 'shared' ? 'shared' : 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : st === 'project-shared' ? input.scopeId || input.projectId : input.projectId;
    const root = await getWorkspaceOperationRoot(input);
    const normalizedInputPath = normalizeWorkspaceRelativePath(input);
    const oldPath = resolveInside(root, normalizedInputPath);
    await assertNoSymlink(oldPath);
    const safeName = safeFileName(input.name);
    const newPath = join(dirname(oldPath), safeName);
    let conflict = false;
    try { await access(newPath); conflict = true; } catch { /* ok */ }
    if (conflict) return { ok: false, error: '目标文件或文件夹已存在' };
    await rename(oldPath, newPath);
    const oldNorm = normalizedInputPath;
    const newNorm = join(dirname(oldNorm), safeName).replaceAll('\\', '/');
    const file = fileRepo.getByPath(dbSt, sid, oldNorm);
    if (file) {
      if (file.type === 'directory') {
        const children = db.prepare(
          "SELECT id, normalized_path FROM files WHERE scope_type = ? AND scope_id = ? AND normalized_path LIKE ?",
        ).all(dbSt, sid, `${oldNorm}/%`) as { id: string; normalized_path: string }[];
        for (const child of children) {
          fileRepo.update(child.id, { normalizedPath: child.normalized_path.replace(oldNorm, newNorm) });
        }
      }
      fileRepo.update(file.id, { name: safeName, normalizedPath: newNorm });
    }
    return { ok: true };
  });

  registerIpc('workspace:move', async (_event, input: WorkspaceRequest & { sourcePaths: string[]; targetDir: string }) => {
    assertWorkspaceAccess(input);
    const st = input.scopeType ?? 'project';
    const dbSt: 'project' | 'shared' = st === 'shared' ? 'shared' : 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : st === 'project-shared' ? input.scopeId || input.projectId : input.projectId;
    const root = await getWorkspaceOperationRoot(input);
    const targetNorm = normalizeWorkspaceRelativePath({ ...input, relativePath: input.targetDir });
    const targetPath = resolveInside(root, targetNorm);
    await assertNoSymlink(targetPath);
    for (const src of input.sourcePaths) {
      const sourceNorm = normalizeWorkspaceRelativePath({ ...input, relativePath: src });
      const sourcePath = resolveInside(root, sourceNorm);
      await assertNoSymlink(sourcePath);
      const safeName = safeFileName(basename(sourcePath));
      const destPath = join(targetPath, safeName);
      let conflict = false;
      try { await access(destPath); conflict = true; } catch { /* ok */ }
      if (conflict) return { ok: false, error: `目标已存在: ${safeName}` };
      await rename(sourcePath, destPath);
      const srcNorm = sourceNorm;
      const destNorm = join(targetNorm, safeName).replaceAll('\\', '/');
      const file = fileRepo.getByPath(dbSt, sid, srcNorm);
      if (file) {
        if (file.type === 'directory') {
          const children = db.prepare(
            "SELECT id, normalized_path FROM files WHERE scope_type = ? AND scope_id = ? AND normalized_path LIKE ?",
          ).all(dbSt, sid, `${srcNorm}/%`) as { id: string; normalized_path: string }[];
          for (const child of children) {
            fileRepo.update(child.id, { normalizedPath: child.normalized_path.replace(srcNorm, destNorm) });
          }
        }
        fileRepo.update(file.id, { name: safeName, normalizedPath: destNorm });
      }
    }
    return { ok: true };
  });

  registerIpc('workspace:softDelete', async (_event, input: WorkspaceRequest & { paths: string[] }) => {
    assertWorkspaceAccess(input);
    const st = input.scopeType ?? 'project';
    const dbSt: 'project' | 'shared' = st === 'shared' ? 'shared' : 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : st === 'project-shared' ? input.scopeId || input.projectId : input.projectId;
    const root = await getWorkspaceOperationRoot(input);
    const trashDir = join(await getWorkspaceRoot(input), '.runtime', 'trash');
    await mkdir(trashDir, { recursive: true });
    for (const src of input.paths) {
      const norm = normalizeWorkspaceRelativePath({ ...input, relativePath: src });
      const sourcePath = resolveInside(root, norm);
      await assertNoSymlink(sourcePath);
      const ts = Date.now();
      const safeName = safeFileName(basename(sourcePath));
      const trashTarget = join(trashDir, `${ts}-${safeName}`);
      await rename(sourcePath, trashTarget);
      const file = fileRepo.getByPath(dbSt, sid, norm);
      if (file) {
        if (file.type === 'directory') {
          const children = db.prepare(
            "SELECT id FROM files WHERE scope_type = ? AND scope_id = ? AND normalized_path LIKE ?",
          ).all(dbSt, sid, `${norm}/%`) as { id: string }[];
          for (const child of children) {
            fileRepo.softDelete(child.id);
            new KnowledgeRepository(db).removeKnowledgeForFile(child.id);
          }
        }
        fileRepo.softDelete(file.id);
        new KnowledgeRepository(db).removeKnowledgeForFile(file.id);
      }
    }
    return { ok: true };
  });

  const sanitizeHtml = (html: string): string => {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<script\b[^>]*\/>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
      .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
      .replace(/href\s*=\s*"javascript:/gi, 'href="#"')
      .replace(/href\s*=\s*'javascript:/gi, "href='#'")
      .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
      .replace(/<embed\b[^>]*>/gi, '');
  };

  registerIpc('workspace:getPreview', async (_event, input: WorkspaceRequest) => {
    assertWorkspaceAccess(input);
    const st = input.scopeType ?? 'project';
    const dbSt: 'project' | 'shared' = st === 'shared' ? 'shared' : 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : st === 'project-shared' ? input.scopeId || input.projectId : input.projectId;
    const normalizedInputPath = normalizeRelativePath(input.relativePath).replaceAll('\\', '/');
    const systemDirectories = ['agent-identities', 'agent-memories', 'templates', 'standardized-files', 'knowledge', 'graph-visualization', 'outputs', 'experience', 'temp'];
    const isSystemFile = systemDirectories.some(
      (directory) => normalizedInputPath === directory || normalizedInputPath.startsWith(`${directory}/`),
    );
    const root = isSystemFile
      ? (st === 'shared'
          ? getEnterpriseWorkspaceRoot()
          : st === 'project-shared'
            ? getEnterpriseProjectRoot(input.scopeId || input.projectId)
            : getProjectRoot(input.projectId))
      : await getScopeRoot(input);
    const target = resolveInside(root, normalizedInputPath);
    await assertNoSymlink(target);
    const info = await lstat(target);
    if (!info.isFile()) return { ok: true, data: null };
    // The asset-design demo intentionally contains a self-contained 3D HTML
    // preview. It is larger than ordinary text previews but remains inside the
    // standard file safety cap and is served through app-file's read-only
    // protocol, so allow this one scripted artefact in the right-side panel.
    const isAssetDemoThreeDHtml = input.projectId === '3bc7f334c12b435ba7193a6d'
      && normalizedInputPath === 'outputs/标品资产设计与入库演示/单资产3D漫游.html';
    if (info.size > MAX_FILE_BYTES && !isAssetDemoThreeDHtml) return { ok: true, data: { error: '文件超出预览大小限制' } };
    const dbRow = fileRepo.getByPath(dbSt, sid, normalizedInputPath);
    const fileId = dbRow?.id;
    const versionId = dbRow?.currentVersionId;
    const ext = basename(target).toLowerCase().split('.').pop() ?? '';
    const textExts = ['txt', 'md', 'json', 'csv', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sh', 'bat', 'ps1', 'py', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'svg'];
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'];
    if (textExts.includes(ext)) {
      const MAX_TEXT_BYTES = 10 * 1024 * 1024;
      let content = await readFile(target, { encoding: 'utf8', flag: 'r' });
      if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES && !isAssetDemoThreeDHtml) return { ok: true, data: { error: '文本文件超出预览大小限制' } };
      if (ext === 'html' || ext === 'htm') {
        const appFileUrl = fileId ? `app-file://preview/${fileId}/${encodeURIComponent(basename(target))}` : undefined;
        return { ok: true, data: { kind: 'html' as const, content, appFileUrl, fileName: basename(target), size: info.size, fileId, versionId } };
      }
      return { ok: true, data: { kind: 'text' as const, content, mimeType: ext === 'md' ? 'text/markdown' : 'text/plain', fileName: basename(target), size: info.size, fileId, versionId } };
    }
    if (ext === 'pptx') {
      const bytes = Uint8Array.from(await readFile(target));
      return { ok: true, data: { kind: 'pptx' as const, bytes, fileName: basename(target), size: info.size, fileId, versionId } };
    }
    if (imageExts.includes(ext)) {
      let buf = await readFile(target);
      if (ext === 'svg') {
        const svgStr = sanitizeHtml(buf.toString('utf8'));
        buf = Buffer.from(svgStr, 'utf8');
      }
      const b64 = buf.toString('base64');
      const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' };
      return { ok: true, data: { kind: 'image' as const, dataUri: `data:${mimeMap[ext] ?? 'application/octet-stream'};base64,${b64}`, fileName: basename(target), size: info.size, fileId, versionId } };
    }
    const pdfExts = ['pdf'];
    if (pdfExts.includes(ext)) {
      const appFileUrl = fileId ? `app-file://file/${fileId}` : versionId ? `app-file://version/${versionId}` : undefined;
      return { ok: true, data: { kind: 'pdf' as const, appFileUrl, fileName: basename(target), size: info.size, fileId, versionId } };
    }
    return { ok: true, data: { kind: 'unknown' as const, fileName: basename(target), size: info.size, mimeType: '', fileId, versionId } };
  });

  registerIpc('workspace:listSystemDirs', async (_event, input: WorkspaceRequest) => {
    assertWorkspaceAccess(input);
    const workspaceRoot = await getWorkspaceRoot(input);
    const systemDirs = (input.scopeType ?? 'project') === 'project'
      ? [
          { name: '智能体身份', physicalName: 'agent-identities' },
          { name: '智能体记忆', physicalName: 'agent-memories' },
          { name: '原始文件', physicalName: 'original-files' },
          { name: '模板', physicalName: 'templates' },
          { name: '标准化文件', physicalName: 'standardized-files' },
          { name: '知识', physicalName: 'knowledge' },
          { name: '图谱可视化', physicalName: 'graph-visualization' },
          { name: '成果', physicalName: 'outputs' },
          { name: '经验', physicalName: 'experience' },
          { name: '临时', physicalName: 'temp' },
        ]
      : [
          { name: '原始文件', physicalName: 'original-files' },
          { name: '模板', physicalName: 'templates' },
          { name: '标准化文件', physicalName: 'standardized-files' },
          { name: '知识', physicalName: 'knowledge' },
          { name: '图谱可视化', physicalName: 'graph-visualization' },
          { name: '成果', physicalName: 'outputs' },
          { name: '经验', physicalName: 'experience' },
        ];
    const entries = [];
    for (const dir of systemDirs) {
      try {
        const info = await lstat(join(workspaceRoot, dir.physicalName));
        entries.push({
          name: dir.name,
          physicalName: dir.physicalName,
          relativePath: dir.physicalName,
          kind: 'directory' as const,
          system: true,
          size: 0,
          modifiedAt: info.mtime.toISOString(),
        });
      } catch {
        // skip if directory doesn't exist yet
      }
    }
    return { ok: true, data: entries };
  });

  registerIpc('workspace:listProjectDir', async (_event, input: WorkspaceRequest) => {
    assertWorkspaceAccess(input);
    const projectRoot = await getWorkspaceRoot(input);
    const normalizedPath = normalizeRelativePath(input.relativePath).replaceAll('\\', '/');
    const topLevelDirectory = normalizedPath.split('/')[0] ?? '';
    if (!WORKSPACE_SYSTEM_DIRS.has(topLevelDirectory) || topLevelDirectory === 'original-files') {
      throw new DatabaseError('VALIDATION_FAILED', '只能浏览当前工作区的系统目录');
    }
    const directory = resolveInside(projectRoot, normalizedPath);
    await assertNoSymlink(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const result = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry) => {
      const entryPath = join(directory, entry.name);
      const info = await lstat(entryPath);
      return {
        name: entry.name,
        physicalName: entry.name,
        relativePath: join(normalizedPath, entry.name).replaceAll('\\', '/'),
        kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
        system: false,
        size: entry.isDirectory() ? 0 : info.size,
        modifiedAt: info.mtime.toISOString(),
      };
    }));
    return { ok: true, data: result.sort((left, right) => left.kind === right.kind ? right.modifiedAt.localeCompare(left.modifiedAt) : left.kind === 'directory' ? -1 : 1) };
  });
};

const registerDraftIpc = (db: ReturnType<typeof getDatabase>): void => {
  const draftRepo = new DraftRepository(db);
  registerIpc('drafts:get', async (_event, input: { scope: string; scopeId: string }) => {
    const data = draftRepo.get(input.scope, input.scopeId);
    return { ok: true, data };
  });
  registerIpc('drafts:update', async (_event, input: { scope: string; scopeId: string; contentJson: string }) => {
    const data = draftRepo.upsert(input.scope, input.scopeId, input.contentJson);
    return { ok: true, data };
  });
  registerIpc('drafts:chooseAttachments', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: true, data: [] };
    const stagingRoot = join(getStudioRoot(), '.kstudio', 'temp', 'staged-uploads');
    const staged: Array<{ id: string }> = [];
    for (const filePath of result.filePaths) {
      const id = randomUUID().replace(/-/g, '').slice(0, 24);
      await copyFile(filePath, join(stagingRoot, id));
      await writeFile(join(stagingRoot, `${id}.meta`), JSON.stringify({ originalName: basename(filePath) }), 'utf8');
      staged.push({ id });
    }
    return { ok: true, data: staged };
  });
  registerIpc('drafts:removeAttachment', async (_event, input: { stagedUploadId: string }) => {
    const stagingRoot = join(getStudioRoot(), '.kstudio', 'temp', 'staged-uploads');
    const { unlink } = await import('node:fs/promises');
    await unlink(join(stagingRoot, input.stagedUploadId)).catch(() => {});
    await unlink(join(stagingRoot, `${input.stagedUploadId}.meta`)).catch(() => {});
    return { ok: true };
  });
};

const registerProjectIpc = (db: ReturnType<typeof getDatabase>): void => {
  const projectRepo = new ProjectRepository(db);
  const runRepo = new AgentRunRepository(db);
  registerIpc('projects:list', async (_event, input: { status?: string; limit?: number; offset?: number }) => {
    const data = projectRepo.list(input.status, input.limit ?? 50, input.offset ?? 0);
    return { ok: true, data };
  });
  registerIpc('projects:planHomeRequest', async (_event, input: { text: string }) => {
    const data = await planHomeRequest(db, _gateway, input.text ?? '');
    return { ok: true, data };
  });
  registerIpc('projects:create', async (event, input: { idempotencyKey: string; content: { schemaVersion?: number; text?: string; mentions?: unknown[]; stagedUploadIds?: string[] }; templateId?: string; requestedAgentProfileIds: string[]; customName?: string; autoStart?: boolean }) => {
    const result = await createProject(db, {
      idempotencyKey: input.idempotencyKey,
      content: input.content,
      ...(input.templateId ? { templateId: input.templateId } : {}),
      requestedAgentProfileIds: input.requestedAgentProfileIds,
      ...(input.customName ? { customName: input.customName } : {}),
    });
    if (result.ok && result.data?.id && _fileWatcher) {
      _fileWatcher.addWatch(getProjectRoot(result.data.id as string), 'project', result.data.id as string);
    }
    if (result.ok && input.autoStart && result.data.firstMessageId && _scheduler) {
      const existingRun = db.prepare(
        'SELECT id FROM agent_runs WHERE trigger_message_id = ? AND requested_by_type = ? LIMIT 1',
      ).get(result.data.firstMessageId, 'user') as { id: string } | undefined;
      const leader = db.prepare(
        `SELECT id FROM project_agent_instances
         WHERE project_id = ? AND role = 'leader' ORDER BY ordinal LIMIT 1`,
      ).get(result.data.id) as { id: string } | undefined;
      if (!existingRun && leader) {
        const instruction = JSON.stringify(input.content);
        const run = runRepo.create({
          projectId: result.data.id,
          agentInstanceId: leader.id,
          requestedByType: 'user',
          requestedById: 'local-user',
          instruction,
          triggerMessageId: result.data.firstMessageId,
          modelProfileSnapshotJson: buildModelProfileSnapshot(db, leader.id),
        });
        runRepo.addEvent(run.id, 'run.anchor', { messageId: result.data.firstMessageId });
        runRepo.addEvent(run.id, 'run.started-by-gm', { source: 'home', gmProfileId: 'builtin-gm-profile' });
        _scheduler.enqueue({
          runId: run.id,
          projectId: result.data.id,
          agentInstanceId: leader.id,
          instruction,
          triggerMessageId: result.data.firstMessageId,
        });
      }
    }
    return result;
  });
  registerIpc('projects:get', async (_event, input: { projectId: string }) => {
    try {
      const data = projectRepo.getById(input.projectId);
      return { ok: true, data };
    } catch {
      return { ok: true, data: null };
    }
  });
  registerIpc('projects:rename', async (_event, input: { projectId: string; name: string }) => {
    projectRepo.rename(input.projectId, input.name);
    return { ok: true };
  });
  registerIpc('projects:archive', async (_event, input: { projectId: string }) => {
    projectRepo.archive(input.projectId);
    return { ok: true };
  });
  registerIpc('projects:restore', async (_event, input: { projectId: string }) => {
    projectRepo.restore(input.projectId);
    return { ok: true };
  });
  registerIpc('projects:setSharedKnowledge', async (_event, input: { projectId: string; enabled: boolean }) => {
    projectRepo.setSharedKnowledgeEnabled(input.projectId, input.enabled);
    return { ok: true };
  });
};

const registerMessageIpc = (db: ReturnType<typeof getDatabase>): void => {
  const messageRepo = new MessageRepository(db);
  const runRepo = new AgentRunRepository(db);
  const conversationMemory = new ConversationMemoryManager(db);
  registerIpc('messages:list', async (_event, input: { projectId: string; before?: string; limit?: number }) => {
    const data = messageRepo.listByProject(input.projectId, input.before, input.limit ?? 50);
    return { ok: true, data };
  });
  registerIpc('messages:listRunActivity', async (_event, input: { projectId: string; limit?: number }) => {
    const runs = runRepo.listByProject(input.projectId, Math.min(input.limit ?? 12, 30));

    // 批量查询当前项目所有 agent 名称（仅一次）
    const agentNames = db.prepare(
      `SELECT pai.id, ap.name
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.project_id = ?
       ORDER BY LENGTH(pai.id) DESC, pai.ordinal`,
    ).all(input.projectId) as Array<{ id: string; name: string }>;
    const agentNameMap = new Map(agentNames.map((a) => [a.id, a.name]));
    const sanitize = (text: string): string => {
      if (!text) return text;
      let s = text;
      for (const agent of agentNames) {
        if (!agent.id || !s.includes(agent.id)) continue;
        s = s.split(agent.id).join(agent.name || '智能体');
      }
      return s;
    };

    // 批量查询所有 run 的 events（一次查询替代 N 次）
    const runIds = runs.map((r) => r.id);
    const allEvents: Array<{
      id: string; runId: string; seq: number; type: string; payloadJson: string | null; createdAt: string;
    }> = runIds.length > 0
      ? db.prepare(
          `SELECT id, run_id as runId, seq, type, payload_json as payloadJson, created_at as createdAt
           FROM agent_run_events WHERE run_id IN (${runIds.map(() => '?').join(',')})
           ORDER BY run_id, seq`,
        ).all(...runIds) as Array<{
          id: string; runId: string; seq: number; type: string; payloadJson: string | null; createdAt: string;
        }>
      : [];
    const eventsByRunId = new Map<string, typeof allEvents>();
    for (const event of allEvents) {
      let list = eventsByRunId.get(event.runId);
      if (!list) { list = []; eventsByRunId.set(event.runId, list); }
      list.push(event);
    }

    const data = runs.map((run) => {
      const runEvents = eventsByRunId.get(run.id) ?? [];
      const agentName = agentNameMap.get(run.agentInstanceId);

      // 单次遍历：收集 traces + 记录每种特殊事件的最后一条
      const traces: Array<Record<string, unknown>> = [];
      let checklistEvent: typeof allEvents[number] | undefined;
      let businessProcessEvent: typeof allEvents[number] | undefined;
      let anchorEvent: typeof allEvents[number] | undefined;
      for (const event of runEvents) {
        if (event.type === 'run.checklist' && event.payloadJson) {
          checklistEvent = event;
        } else if (event.type === 'run.business-process' && event.payloadJson) {
          businessProcessEvent = event;
        } else if (event.type === 'run.anchor' && event.payloadJson) {
          anchorEvent = event;
        } else if (event.type === 'run.trace' && event.payloadJson) {
          try {
            const parsed = JSON.parse(event.payloadJson) as Record<string, unknown>;
            if (parsed && typeof parsed === 'object') {
              traces.push({
                ...parsed,
                ...(typeof parsed.title === 'string' ? { title: sanitize(parsed.title) } : {}),
                ...(typeof parsed.detail === 'string' ? { detail: sanitize(parsed.detail) } : {}),
              });
            }
          } catch { /* skip malformed trace payload */ }
        }
      }

      let anchorMessageId = run.triggerMessageId;
      if (anchorEvent?.payloadJson) {
        try {
          const anchor = JSON.parse(anchorEvent.payloadJson) as { messageId?: unknown };
          if (typeof anchor.messageId === 'string' && anchor.messageId) anchorMessageId = anchor.messageId;
        } catch { /* use trigger message fallback */ }
      }
      let checklist: Record<string, unknown> | null = null;
      if (checklistEvent?.payloadJson) { try { checklist = JSON.parse(checklistEvent.payloadJson) as Record<string, unknown>; } catch { checklist = null; } }
      if (checklist && Array.isArray(checklist.items)) {
        checklist = {
          ...checklist,
          items: checklist.items.map((item) => {
            if (!item || typeof item !== 'object') return item;
            const row = item as Record<string, unknown>;
            return {
              ...row,
              ...(typeof row.title === 'string' ? { title: sanitize(row.title) } : {}),
              ...(typeof row.detail === 'string' ? { detail: sanitize(row.detail) } : {}),
            };
          }),
        };
      }
      let businessProcess: Record<string, unknown> | null = null;
      if (businessProcessEvent?.payloadJson) {
        try { businessProcess = JSON.parse(businessProcessEvent.payloadJson) as Record<string, unknown>; } catch { businessProcess = null; }
      }
      return {
        runId: run.id,
        agentId: run.agentInstanceId,
        agentName: agentName ?? '智能体',
        anchorMessageId,
        triggerMessageId: run.triggerMessageId ?? undefined,
        parentRunId: run.parentRunId ?? undefined,
        requestedByType: run.requestedByType,
        requestedById: run.requestedById,
        createdAt: run.createdAt,
        status: run.status,
        traces,
        checklist,
        businessProcess,
        updatedAt: run.finishedAt ?? run.startedAt ?? run.createdAt,
      };
    });
    return { ok: true, data };
  });
  registerIpc('messages:send', async (_event, input: { idempotencyKey: string; projectId: string; replyToId?: string; content: { text?: string; mentions?: Array<{ target: { scope: string; id: string } }>; collaborationMode?: unknown } }) => {
    const inputContent = {
      ...input.content,
      collaborationMode: normalizeCollaborationMode(input.content.collaborationMode),
    };
    const confirmedContentJson = normalizeAgentMessageContent(
      db,
      input.projectId,
      JSON.stringify(inputContent),
      [],
      'local-user',
    );
    const confirmedContent = JSON.parse(confirmedContentJson) as typeof input.content;
    const messageId = createHash('sha256')
      .update(`messages:send:${input.projectId}:${input.idempotencyKey}`)
      .digest('hex')
      .slice(0, 24);
    const validReply = input.replyToId
      ? db.prepare('SELECT id FROM messages WHERE id = ? AND project_id = ?').get(input.replyToId, input.projectId) as { id: string } | undefined
      : undefined;
    const data = messageRepo.createUserMessage(input.projectId, confirmedContentJson, messageId, validReply?.id ?? null);
    if (!data.created) return { ok: true, data };
    // The fixed demo must not hold this IPC call until its timed script has
    // finished. Broadcast the committed user bubble first, so the renderer
    // shows it before the first scripted agent countdown begins.
    const sourceWindow = BrowserWindow.fromWebContents(_event.sender);
    if (sourceWindow && !sourceWindow.isDestroyed()) {
      broadcastEvent(sourceWindow, {
        type: 'message.committed', projectId: input.projectId, messageId: data.id,
        senderType: 'user', senderId: 'local-user', kind: 'text', content: confirmedContentJson,
      });
    }
    // /note 消息仅落库为群聊记录（P2-18）：不进入记忆指令提取，
    // 也不触发任何 run（含等待用户回复的 run 恢复与 @mention 路由）。
    if (isNoteOnlyMessage(confirmedContent.text)) {
      return { ok: true, data: { ...data, noteOnly: true } };
    }
    if (inputContent.text) {
      await conversationMemory.applyUserDirective(input.projectId, inputContent.text, data.id);
    }
    if (_assetDemoScript?.ensureProjectAgents(input.projectId)) {
      void _assetDemoScript.handleUserMessage(input.projectId, inputContent.text ?? '', data.id)
        .catch((error) => getLogger().error({ err: error, projectId: input.projectId }, 'asset demo transition failed'));
      return { ok: true, data: { ...data, demoHandled: true } };
    }
    if (_scheduler) {
      const replyMessageId = validReply?.id;
      const waitingRuns = replyMessageId ? runRepo.listAwaitingUserByMessage(input.projectId, replyMessageId) : [];
      if (waitingRuns.length > 0) {
        const resumedRunIds: string[] = [];
        let rootTriggerMessageId = waitingRuns[0]?.triggerMessageId ?? data.id;
        const referencedMessage = db.prepare('SELECT content_json as contentJson FROM messages WHERE id = ?').get(replyMessageId) as { contentJson: string } | undefined;
        let waitingQuestion = '';
        try { waitingQuestion = referencedMessage ? (JSON.parse(referencedMessage.contentJson) as { text?: string }).text ?? referencedMessage.contentJson : ''; } catch { waitingQuestion = referencedMessage?.contentJson ?? ''; }
        for (const waitingRun of waitingRuns) {
          let continuationId: string | null = null;
          try {
            // Keep the original Run non-terminal until its continuation returns a
            // real result. Otherwise an upstream agent can consume the question
            // message itself as if it were the completed child result.
            runRepo.setStatus(waitingRun.id, 'running');
            runRepo.addEvent(waitingRun.id, 'run.user-response-received', { messageId: data.id, replyToId: replyMessageId });
            const sourceWindow = BrowserWindow.fromWebContents(_event.sender);
            if (sourceWindow) {
              broadcastEvent(sourceWindow, {
                type: 'run.status', projectId: input.projectId,
                run: { id: waitingRun.id, agentId: waitingRun.agentInstanceId, status: 'running', stage: '已收到用户回复，继续执行' },
              });
            }
            let originalTask = waitingRun.instruction ?? '';
            try { originalTask = (JSON.parse(originalTask) as { text?: string }).text ?? originalTask; } catch { /* use original instruction */ }
            const continuationInstruction = JSON.stringify({
              schemaVersion: 1,
              text: `用户已回复群内等待的关键信息。请结合原任务、公开群聊上下文和这次回复继续执行，直到完成或确实还需要新的关键信息。\n\n原任务：${originalTask}\n\n群内提问：${waitingQuestion}\n\n用户回复：${confirmedContent.text ?? ''}`,
              mentions: confirmedContent.mentions ?? [],
              replyToId: replyMessageId,
            });
            rootTriggerMessageId = waitingRun.triggerMessageId ?? rootTriggerMessageId;
            const continuation = runRepo.create({
              projectId: input.projectId,
              agentInstanceId: waitingRun.agentInstanceId,
              requestedByType: 'user',
              requestedById: 'local-user',
              instruction: continuationInstruction,
              parentRunId: waitingRun.id,
              triggerMessageId: rootTriggerMessageId,
              modelProfileSnapshotJson: buildModelProfileSnapshot(db, waitingRun.agentInstanceId),
            });
            continuationId = continuation.id;
            runRepo.addEvent(continuation.id, 'run.anchor', { messageId: data.id });
            runRepo.addEvent(continuation.id, 'run.resumed-from-user', { waitingRunId: waitingRun.id, replyToId: replyMessageId });
            const enqueued = _scheduler.enqueue({
              runId: continuation.id,
              projectId: input.projectId,
              agentInstanceId: waitingRun.agentInstanceId,
              instruction: continuationInstruction,
              triggerMessageId: rootTriggerMessageId,
            });
            if (!enqueued) throw new Error('续接任务入队被拒绝');
            resumedRunIds.push(continuation.id);
          } catch (resumeError) {
            // 幻影 running 守卫：恢复链路任一步失败（含入队被静默拒绝）时，
            // 将原 Run 回滚为等待用户回复、续接 Run 标记失败，
            // 避免留下无人推进的 running 状态（用户重发回复即可再次恢复）。
            try {
              if (continuationId) {
                runRepo.setStatus(continuationId, 'failed', { errorCode: 'RESUME_ENQUEUE_FAILED', errorMessage: resumeError instanceof Error ? resumeError.message : String(resumeError) });
              }
              runRepo.setStatus(waitingRun.id, 'awaiting_user');
              runRepo.addEvent(waitingRun.id, 'run.resume-rejected', {
                replyToId: replyMessageId,
                error: resumeError instanceof Error ? resumeError.message : String(resumeError),
              });
              // 同步回滚 UI 中的运行状态，避免界面停留在幻影 running。
              const rollbackWindow = BrowserWindow.fromWebContents(_event.sender);
              if (rollbackWindow) {
                broadcastEvent(rollbackWindow, {
                  type: 'run.status', projectId: input.projectId,
                  run: { id: waitingRun.id, agentId: waitingRun.agentInstanceId, status: 'awaiting_user', stage: '恢复失败，等待重新回复' },
                });
              }
            } catch { /* 回滚失败时依赖启动恢复兜底 */ }
          }
        }
        return { ok: true, data: { ...data, resumedRunId: resumedRunIds[0], resumedRunIds, rootTriggerMessageId } };
      }
      const mentions = confirmedContent.mentions ?? [];
      const instanceMentions = mentions.filter((m) => m.target.scope === 'instance');

      // 有 @mention 时路由到对应智能体
      if (instanceMentions.length > 0) {
        processMessageMentions(
          db, runRepo, _scheduler, input.projectId,
          confirmedContentJson, data.id,
          'local-user', undefined, 'user', data.id,
        );
      } else {
        // 无 @mention 时自动触发统筹智能体处理（保持原有行为）
        const leaderInstance = db.prepare(
          `SELECT id FROM project_agent_instances WHERE project_id = ? AND role = 'leader' LIMIT 1`,
        ).get(input.projectId) as { id: string } | undefined;
        if (leaderInstance) {
          const run = runRepo.create({
            projectId: input.projectId,
            agentInstanceId: leaderInstance.id,
            requestedByType: 'user',
            requestedById: 'local-user',
            instruction: confirmedContentJson,
            triggerMessageId: data.id,
            modelProfileSnapshotJson: buildModelProfileSnapshot(db, leaderInstance.id),
          });
          runRepo.addEvent(run.id, 'run.anchor', { messageId: data.id });
          _scheduler.enqueue({
            runId: run.id,
            projectId: input.projectId,
            agentInstanceId: leaderInstance.id,
            instruction: confirmedContentJson,
            triggerMessageId: data.id,
          });
        }
      }
    }
    return { ok: true, data };
  });
  registerIpc('messages:cancelRun', async (_event, input: { runId?: string; projectId?: string }) => {
    if (_scheduler && input.projectId) _scheduler.cancelProject(input.projectId);
    else if (_scheduler && input.runId) _scheduler.cancelRun(input.runId);
    return { ok: true, data: null };
  });
  registerIpc('messages:cancelProjectRuns', async (_event, input: { projectId: string }) => {
    if (_scheduler) _scheduler.cancelProject(input.projectId);
    return { ok: true, data: null };
  });
  registerIpc('messages:retryRun', async (_event, input: { runId: string }) => {
    try {
      const originalRun = runRepo.getById(input.runId);
      const createInput: {
        projectId: string; agentInstanceId: string; requestedByType: string; requestedById: string;
        instruction?: string; triggerMessageId?: string; modelProfileSnapshotJson?: string | null;
      } = {
        projectId: originalRun.projectId,
        agentInstanceId: originalRun.agentInstanceId,
        requestedByType: originalRun.requestedByType,
        requestedById: originalRun.requestedById,
        instruction: originalRun.instruction ?? '',
        modelProfileSnapshotJson: originalRun.modelProfileSnapshotJson,
      };
      if (originalRun.triggerMessageId) {
        createInput.triggerMessageId = originalRun.triggerMessageId;
      }
      const newRun = runRepo.create(createInput);
      if (_scheduler) {
        _scheduler.enqueue({
          runId: newRun.id,
          projectId: newRun.projectId,
          agentInstanceId: newRun.agentInstanceId,
          instruction: newRun.instruction ?? '',
          triggerMessageId: newRun.triggerMessageId ?? '',
        });
      }
      return { ok: true, data: { runId: newRun.id } };
    } catch (err) {
      return { ok: false, requestId: '-', error: { code: 'RETRY_FAILED', message: String(err), retryable: false } };
    }
  });
};

type CliConnectionRow = { id: string; name: string; adapterType: string; executablePath: string; argsJson: string | null; strategyId: string | null; detectedVersion: string | null; status: string; trustTier: 'trusted' | 'sandboxed' | 'restricted' };

const registerAgentIpc = (db: ReturnType<typeof getDatabase>): void => {
  const isLocalNeutralRelayAddress = (value: string): boolean => {
    try {
      const parsed = new URL(value);
      return ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.pathname.replace(/\/$/, '') === '/mcp';
    } catch { return false; }
  };
  const neutralRelayEndpoint = (value: string): boolean => {
    if (!isLocalNeutralRelayAddress(value)) return false;
    try {
      const parsed = new URL(value);
      const current = _neutralMcpRelay?.status();
      return Boolean(current?.running && current.url.replace(/\/$/, '') === `${parsed.origin}${parsed.pathname}`.replace(/\/$/, ''));
    } catch { return false; }
  };
  const resolveWorkBuddyHeaders = (url: string, headers: Record<string, string> | undefined): { headers: Record<string, string>; neutralRelay: boolean } => {
    const supplied = headers ?? {};
    const neutralRelay = neutralRelayEndpoint(url);
    if (!neutralRelay) return { headers: supplied, neutralRelay };
    const token = _neutralMcpRelay?.status().token;
    const withoutStaleAuth = Object.fromEntries(Object.entries(supplied).filter(([key]) => !/^(authorization|x-api-key)$/i.test(key)));
    return token ? { headers: { ...withoutStaleAuth, Authorization: `Bearer ${token}` }, neutralRelay } : { headers: supplied, neutralRelay };
  };
  registerIpc('agents:listDefinitions', async () => {
    const data = db.prepare(
      `SELECT id, version, kind, is_builtin as isBuiltin, installed_at as installedAt
       FROM agent_definitions
       WHERE id NOT IN ('builtin.knowledge-manager', 'builtin.researcher', 'builtin.material-writer', 'builtin.acceptance-reviewer')
       ORDER BY id`,
    ).all();
    return { ok: true, data };
  });
  registerIpc('agents:listProfiles', async () => {
    const data = db.prepare(
      `SELECT ap.id, ap.name, ap.definition_id as definitionId, ap.runtime_mode as runtimeMode,
              ap.enabled, ap.delegatable, ap.cli_connection_id as cliConnectionId,
              ap.model_profile_id as modelProfileId, ap.overrides_json as overridesJson,
              ad.is_builtin as isBuiltin,
              cc.name as cliConnectionName, cc.adapter_type as adapterType
       FROM agent_profiles ap
       LEFT JOIN agent_definitions ad ON ad.id = ap.definition_id AND ad.version = ap.definition_version
       LEFT JOIN cli_connections cc ON cc.id = ap.cli_connection_id
       WHERE ap.definition_id NOT IN ('builtin.knowledge-manager', 'builtin.researcher', 'builtin.material-writer', 'builtin.acceptance-reviewer')
       ORDER BY ap.name`,
    ).all() as any[];
    const profiles = data.filter((r: any) => !String(r.definitionId ?? '').startsWith('operation-agent-')).map((r: any) => ({
      ...r,
      enabled: !!r.enabled,
      delegatable: !!r.delegatable,
      isBuiltin: !!r.isBuiltin || String(r.definitionId ?? '').startsWith('builtin.'),
      overrides: r.overridesJson ? JSON.parse(r.overridesJson) : {},
    }));
    // 操作平台以可挂载的群聊成员形式展示。它们不是普通设置 Profile，
    // 但拥有独立模型、技能和操作工作区，首次挂载时由 project-creator 持久化代理 Profile。
    const operationPlatforms = db.prepare(
      `SELECT id, owner_agent_id as ownerAgentId, name, description,
              model_profile_id as modelProfileId
       FROM operation_platforms WHERE status = 'active' ORDER BY updated_at DESC`,
    ).all() as Array<{ id: string; ownerAgentId: string; name: string; description: string; modelProfileId: string | null }>;
    const existingOperationProfileIds = new Set(profiles.map((profile: any) => String(profile.id)));
    for (const platform of operationPlatforms) {
      const selectionId = `operation-platform:${platform.id}`;
      if (existingOperationProfileIds.has(selectionId)) continue;
      profiles.push({
        id: selectionId,
        name: `${platform.name}操作智能体`,
        definitionId: platform.ownerAgentId,
        runtimeMode: 'native-model',
        enabled: true,
        delegatable: true,
        cliConnectionId: null,
        modelProfileId: platform.modelProfileId,
        overridesJson: null,
        overrides: {},
        isBuiltin: false,
        operationPlatformId: platform.id,
        description: platform.description,
      });
    }
    return { ok: true, data: profiles };
  });
  registerIpc('agents:getProjectInstances', async (_event, input: { projectId: string }) => {
    // The asset-design demo has a fixed four-agent roster. Initialize it at
    // read time as well as on message dispatch so the header is complete even
    // before the first user message (or when the change event was missed).
    _assetDemoScript?.ensureProjectAgents(input.projectId);
    await ensureProjectAgentFiles(db, input.projectId);
    const data = db.prepare(
      `SELECT pai.id, pai.project_id as projectId, ap.name as agentName, pai.role, pai.runtime_mode as runtimeMode
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.project_id = ? AND ap.enabled = 1 ORDER BY pai.ordinal`,
    ).all(input.projectId);
    return { ok: true, data };
  });
  registerIpc('agents:addProjectInstances', async (_event, input: { projectId: string; profileIds: string[] }) => {
    try {
      const data = await addProjectAgents(db, input.projectId, input.profileIds ?? []);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: { code: 'ADD_AGENT_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false } };
    }
  });
  registerIpc('agents:detectCli', async () => {
    const results = await cliAgentRegistry.detectAll();
    const data: Array<{ id: string; adapterType: string; executablePath: string; detectedVersion: string | null; status: string; capabilities: string[] }> = [];
    for (const r of results) {
      if (r.executables.length === 0) {
        data.push({ id: `${r.type}-0`, adapterType: r.type, executablePath: '', detectedVersion: null, status: 'not_found', capabilities: [] });
      }
      for (let j = 0; j < r.executables.length; j++) {
        data.push({ id: `${r.type}-${j}`, adapterType: r.type, executablePath: r.executables[j]!.executablePath, detectedVersion: r.executables[j]!.versionHint, status: 'available', capabilities: ['code-generation'] });
      }
    }
    return { ok: true, data };
  });
  registerIpc('agents:listAdapterTypes', async () => {
    return { ok: true, data: cliAgentRegistry.listAdapterTypes() };
  });
  registerIpc('agents:listCliConnections', async () => {
    const rows = db.prepare('SELECT id, name, adapter_type as adapterType, executable_path as executablePath, detected_version as detectedVersion, status, trust_tier as trustTier FROM cli_connections ORDER BY created_at DESC').all() as Array<{ id: string; name: string; adapterType: string; executablePath: string; detectedVersion: string | null; status: string; trustTier: string }>;
    const data = rows.map((r) => ({
      id: r.id,
      name: r.name,
      adapterType: r.adapterType,
      executablePath: r.executablePath,
      detectedVersion: r.detectedVersion,
      status: r.status,
      capabilities: [],
    }));
    return { ok: true, data };
  });

  registerIpc('agents:deleteCliConnection', async (_event, input: { connectionId: string }) => {
    db.prepare('DELETE FROM agent_profiles WHERE cli_connection_id = ?').run(input.connectionId);
    db.prepare('DELETE FROM cli_connections WHERE id = ?').run(input.connectionId);
    return { ok: true };
  });
  registerIpc('agents:saveCliConnection', async (_event, input: { name: string; adapterType: string; executablePath: string; detectedVersion?: string | null }) => {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = new Date().toISOString();
    const compatibility = checkVersionCompatibility(input.adapterType, input.detectedVersion ?? null);
    const status = compatibility === 'compatible' ? 'compatible' : compatibility === 'experimental' ? 'experimental' : 'unknown';
    db.prepare(`INSERT INTO cli_connections (id, name, adapter_type, executable_path, args_json, strategy_id, detected_version, status, trust_tier, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', 'auto', ?, ?, 'trusted', ?, ?)`).run(id, input.name, input.adapterType, input.executablePath, input.detectedVersion ?? null, status, now, now);
    // 同时创建对应的 agent_profiles 记录，使 CLI 智能体出现在 @ 列表和创建群聊对话框中
    const profileId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const role = getExternalAgentRole(input.adapterType);
    const displayName = resolveExternalAgentName(input.adapterType, input.name);
    db.prepare(`INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, cli_connection_id, enabled, delegatable, is_system_default, created_at, updated_at) VALUES (?, ?, ?, '1.0.0', 'external-cli', ?, 1, 1, 0, ?, ?)`)
      .run(profileId, displayName, role.definitionId, id, now, now);
    return { ok: true, data: { id, name: displayName, role: role.roleLabel, adapterType: input.adapterType, executablePath: input.executablePath, status } };
  });
  registerIpc('agents:testCliConnection', async (_event, input: { connectionId: string }) => {
    try {
      const row = db.prepare('SELECT executable_path as executablePath, adapter_type as adapterType FROM cli_connections WHERE id = ?').get(input.connectionId) as { executablePath: string; adapterType: string } | undefined;
      if (!row) return { ok: false, requestId: '-', error: { code: 'NOT_FOUND', message: 'CLI connection not found', retryable: false } };
      const logger = getLogger('testCliConnection');
      logger.info({ executablePath: row.executablePath, adapterType: row.adapterType }, 'Testing CLI connection');
      const adapter = cliAgentRegistry.getAdapter(row.adapterType) ?? new CodexCliAdapter();
      // 使用已保存的路径直接测试，而不是重新 detect 扫描 PATH
      await access(row.executablePath);
      logger.info('File access successful, reading version');
      const evidence = await adapter.readVersion({ executablePath: row.executablePath }, new AbortController().signal);
      const versionHint = evidence.rawVersion || null;
      logger.info({ version: versionHint }, 'Version read successfully');
      const caps: string[] = adapter && 'getCapabilities' in adapter ? (adapter as any).getCapabilities() : [];
      return { ok: true, data: { success: true, version: versionHint, executablePath: row.executablePath, capabilities: caps } };
    } catch (err) {
      const logger = getLogger('testCliConnection');
      logger.error({ err }, 'Test failed');
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return { ok: true, data: { success: false, error: '可执行文件不存在', version: null, executablePath: '' } };
      }
      return { ok: true, data: { success: false, error: String(err), version: null, executablePath: '' } };
    }
  });
  registerIpc('agents:saveProfile', async (_event, input: { id?: string; name: string; definitionId: string; runtimeMode: string }) => {
    const now = new Date().toISOString();
    if (input.id) {
      db.prepare('UPDATE agent_profiles SET name = ?, updated_at = ? WHERE id = ?').run(input.name, now, input.id);
      return { ok: true, data: { id: input.id, name: input.name, definitionId: input.definitionId, runtimeMode: input.runtimeMode as any, enabled: true, delegatable: true } };
    }
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    db.prepare(`INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at) VALUES (?, ?, ?, '1.0.0', ?, 1, 1, 0, ?, ?)`).run(id, input.name, input.definitionId, input.runtimeMode, now, now);
    return { ok: true, data: { id, name: input.name, definitionId: input.definitionId, runtimeMode: input.runtimeMode as any, enabled: true, delegatable: true } };
  });
  registerIpc('agents:setDefaultLeader', async (_event, input: { profileId: string }) => {
    db.prepare('UPDATE agent_profiles SET is_system_default = 0 WHERE is_system_default = 1').run();
    db.prepare('UPDATE agent_profiles SET is_system_default = 1 WHERE id = ?').run(input.profileId);
    return { ok: true };
  });
  registerIpc('agents:setProfileEnabled', async (_event, input: { profileId: string; enabled: boolean }) => {
    db.prepare('UPDATE agent_profiles SET enabled = ? WHERE id = ?').run(input.enabled ? 1 : 0, input.profileId);
    return { ok: true };
  });
  registerIpc('agents:updateProfileModel', async (_event, input: { profileId: string; modelProfileId: string; temperature?: number; thinking?: boolean; thinkingLevel?: string }) => {
    db.prepare('UPDATE agent_profiles SET model_profile_id = ?, updated_at = ? WHERE id = ?').run(input.modelProfileId, new Date().toISOString(), input.profileId);
    db.prepare('UPDATE project_agent_instances SET model_profile_id = ? WHERE agent_profile_id = ?').run(input.modelProfileId, input.profileId);
    const row = db.prepare('SELECT overrides_json as overridesJson FROM agent_profiles WHERE id = ?').get(input.profileId) as { overridesJson: string | null } | undefined;
    const overrides = row?.overridesJson ? JSON.parse(row.overridesJson) : {};
    overrides.modelOptions = {
      temperature: Number.isFinite(input.temperature) ? input.temperature : 0.7,
      thinking: input.thinking !== false,
      thinkingLevel: input.thinkingLevel || 'medium',
    };
    db.prepare('UPDATE agent_profiles SET overrides_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(overrides), new Date().toISOString(), input.profileId);
    return { ok: true };
  });

  registerIpc('workspace:ensureEnterpriseProject', async (_event, input: EnsureProjectRequest) => {
    await ensureEnterpriseProjectWorkspace(input);
    if (_fileWatcher) _fileWatcher.addWatch(getEnterpriseProjectRoot(input.projectId), 'project', input.projectId);
    return { ok: true };
  });

  registerIpc('agents:importWorkBuddyConfig', async () => {
    const homePaths = [process.env.USERPROFILE, process.env.HOME, app.getPath('home')].filter(Boolean) as string[];
    const candidates = [...new Set(homePaths.flatMap((home) => [
      join(home, '.workbuddy', '.mcp.json'),
      join(home, '.workbuddy', 'mcp.json'),
      join(home, '.config', 'workbuddy', 'mcp.json'),
    ]))];
    // WorkBuddy also writes connector-specific runtime configs below
    // ~/.workbuddy/connectors/<account>/mcp.json. Discover those files without
    // reading logs or process memory; secrets remain in the app's keychain.
    for (const home of homePaths) {
      try {
        const connectorRoot = join(home, '.workbuddy', 'connectors');
        const entries = await readdir(connectorRoot, { withFileTypes: true });
        for (const entry of entries) if (entry.isDirectory()) candidates.push(join(connectorRoot, entry.name, 'mcp.json'));
      } catch { /* connector runtime directory is optional */ }
    }
    let emptyConfigPath: string | null = null;
    for (const configPath of candidates) {
      try {
        const parsed = JSON.parse(await readFile(configPath, 'utf8')) as { mcpServers?: Record<string, any> };
        const entries = Object.entries(parsed.mcpServers ?? {})
          .map(([name, value]) => normalizeWorkBuddyConfigEntry(name, value as Record<string, unknown>, configPath))
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
        const entry = entries.find((item) => /workbuddy|wk-workbuddy|connector-proxy/i.test(item.name) && !item.disabled)
          ?? entries.find((item) => /^https?:\/\/127\.0\.0\.1|^https?:\/\/localhost/i.test(item.url) && !item.disabled)
          ?? entries.find((item) => /workbuddy|wk-workbuddy/i.test(item.name))
          ?? entries.find((item) => !item.disabled);
        if (entry) return { ok: true, data: entry };
        if (!emptyConfigPath) emptyConfigPath = configPath;
      } catch { /* try the next standard path */ }
    }
    return { ok: true, data: emptyConfigPath ? { sourcePath: emptyConfigPath, name: 'WorkBuddy', url: '', transport: 'streamableHttp', timeoutMs: 60000, headers: {}, empty: true } : null };
  });

  registerIpc('agents:getWorkBuddyStatus', async () => {
    const row = db.prepare(
      `SELECT cc.id, cc.name, cc.executable_path as endpoint, cc.args_json as argsJson,
              cc.secret_refs_json as secretRefsJson,
              cc.status, cc.detected_version as detectedVersion,
              ap.id as profileId
       FROM cli_connections cc LEFT JOIN agent_profiles ap ON ap.cli_connection_id = cc.id
       WHERE cc.adapter_type = 'workbuddy' ORDER BY cc.created_at DESC LIMIT 1`,
    ).get() as { id: string; name: string; endpoint: string; argsJson: string | null; secretRefsJson: string | null; status: string; detectedVersion: string | null; profileId: string | null } | undefined;
    if (!row) return { ok: true, data: { connected: false } };
    let config: Record<string, unknown> = {};
    try { config = row.argsJson ? JSON.parse(row.argsJson) : {}; } catch { /* ignore malformed legacy config */ }
    return { ok: true, data: { connected: row.status === 'compatible', connectionId: row.id, profileId: row.profileId, name: row.name, endpoint: row.endpoint, status: row.status, detectedVersion: row.detectedVersion, toolName: config.toolName ?? null, toolCount: Array.isArray(config.toolNames) ? config.toolNames.length : null, authConfigured: Boolean(config.neutralRelay || config.secretRef || row.secretRefsJson || (config.headers && Object.keys(config.headers as object).length > 0)) } };
  });

  registerIpc('agents:connectWorkBuddy', async (_event, input: { name: string; transport?: string; url: string; timeoutMs?: number; headers?: Record<string, string>; toolName?: string }) => {
    try {
      if (process.env.KLA_ENABLE_WORKBUDDY !== '1') {
        return { ok: false, requestId: '-', error: { code: 'WORKBUDDY_DISABLED', message: 'WorkBuddy 接入功能暂未启用，相关配置已保留，待后续版本恢复。', retryable: false } };
      }
      const url = String(input.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('WorkBuddy MCP 地址必须是 http(s) URL');
      const localNeutralRelay = isLocalNeutralRelayAddress(url);
      if (localNeutralRelay && !_neutralMcpRelay?.status().running) throw new Error('中立 MCP 服务尚未在 KLA 中启动，请先点击“启动中立 MCP 服务”');
      const effectiveUrl = localNeutralRelay ? _neutralMcpRelay!.status().url : url;
      const resolved = resolveWorkBuddyHeaders(effectiveUrl, input.headers);
      const inputHeaders = resolved.headers;
      const config = {
        transport: (input.transport === 'sse' ? 'sse' : 'streamableHttp') as 'sse' | 'streamableHttp',
        url: effectiveUrl,
        timeoutMs: Math.max(5000, Math.min(600000, Number(input.timeoutMs ?? 60000))),
        headers: inputHeaders,
        ...(resolved.neutralRelay ? { neutralRelay: true } : {}),
        ...(input.toolName?.trim() ? { toolName: input.toolName.trim() } : {}),
      };
      const client = new StreamableHttpMcpClient(config);
      const info = await client.initialize(AbortSignal.timeout(config.timeoutMs));
      await client.close();
      const existing = db.prepare("SELECT id FROM cli_connections WHERE adapter_type = 'workbuddy' LIMIT 1").get() as { id: string } | undefined;
      const connectionId = existing?.id ?? randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
      const previous = existing ? db.prepare("SELECT secret_refs_json as secretRefsJson FROM cli_connections WHERE id = ?").get(connectionId) as { secretRefsJson?: string | null } | undefined : undefined;
      let previousRefs: string[] = [];
      try {
        const parsed = previous?.secretRefsJson ? JSON.parse(previous.secretRefsJson) : [];
        if (Array.isArray(parsed)) previousRefs = parsed.filter((item): item is string => typeof item === 'string');
      } catch { /* ignore malformed legacy secret references */ }
      for (const ref of previousRefs) db.prepare('DELETE FROM secrets WHERE id = ? AND kind = \'workbuddy-mcp\'').run(ref);
      const persisted = persistMcpHeaders(db, resolved.neutralRelay ? {} : inputHeaders, previousRefs[0] ?? null);
      const storedConfig = { ...config, headers: persisted.headers, toolNames: info.tools.map((tool) => tool.name), ...(persisted.secretRef ? { secretRef: persisted.secretRef } : {}) };
      const now = new Date().toISOString();
      if (existing) {
        db.prepare(`UPDATE cli_connections SET name = ?, executable_path = ?, args_json = ?, strategy_id = 'mcp', detected_version = ?, status = 'compatible', updated_at = ? WHERE id = ?`)
          .run(input.name.trim() || 'WorkBuddy', effectiveUrl, JSON.stringify(storedConfig), info.serverInfo?.version ?? info.serverInfo?.name ?? 'MCP', now, connectionId);
      } else {
        db.prepare(`INSERT INTO cli_connections (id, name, adapter_type, executable_path, args_json, strategy_id, detected_version, status, trust_tier, capabilities_json, created_at, updated_at) VALUES (?, ?, 'workbuddy', ?, ?, 'mcp', ?, 'compatible', 'restricted', ?, ?, ?)`)
          .run(connectionId, input.name.trim() || 'WorkBuddy', effectiveUrl, JSON.stringify(storedConfig), info.serverInfo?.version ?? info.serverInfo?.name ?? 'MCP', JSON.stringify(['reasoning', 'file-read', 'file-write', 'search', 'network-access']), now, now);
      }
      db.prepare('UPDATE cli_connections SET secret_refs_json = ? WHERE id = ?').run(persisted.secretRef ? JSON.stringify([persisted.secretRef]) : null, connectionId);
      const profile = db.prepare('SELECT id FROM agent_profiles WHERE cli_connection_id = ?').get(connectionId) as { id: string } | undefined;
      if (profile) {
        db.prepare('UPDATE agent_profiles SET name = ?, enabled = 1, delegatable = 1, updated_at = ? WHERE id = ?').run(input.name.trim() || 'WorkBuddy', now, profile.id);
      } else {
        const profileId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
        db.prepare(`INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, cli_connection_id, enabled, delegatable, is_system_default, created_at, updated_at) VALUES (?, ?, 'custom.workbuddy', '1.0.0', 'external-cli', ?, 1, 1, 0, ?, ?)`)
          .run(profileId, input.name.trim() || 'WorkBuddy', connectionId, now, now);
      }
      return { ok: true, data: { connectionId, name: input.name.trim() || 'WorkBuddy', version: info.serverInfo?.version ?? null, tools: info.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })) } };
    } catch (error) {
      return { ok: false, requestId: '-', error: { code: 'WORKBUDDY_CONNECT_FAILED', message: error instanceof Error ? error.message : String(error), retryable: true } };
    }
  });

  registerIpc('agents:testWorkBuddy', async (_event, input: { connectionId?: string }) => {
    try {
      if (process.env.KLA_ENABLE_WORKBUDDY !== '1') {
        return { ok: true, data: { success: false, error: 'WorkBuddy 接入功能暂未启用', version: null, tools: [] } };
      }
      const row = input.connectionId
        ? db.prepare("SELECT executable_path as endpoint, args_json as argsJson FROM cli_connections WHERE id = ? AND adapter_type = 'workbuddy'").get(input.connectionId) as { endpoint: string; argsJson: string | null } | undefined
        : db.prepare("SELECT executable_path as endpoint, args_json as argsJson FROM cli_connections WHERE adapter_type = 'workbuddy' ORDER BY created_at DESC LIMIT 1").get() as { endpoint: string; argsJson: string | null } | undefined;
      if (!row) return { ok: false, requestId: '-', error: { code: 'NOT_FOUND', message: '尚未连接 WorkBuddy', retryable: false } };
      const rawConfig = row.argsJson ? JSON.parse(row.argsJson) as Record<string, unknown> : { transport: 'streamableHttp', url: row.endpoint };
      const configuredNeutral = rawConfig.neutralRelay === true || isLocalNeutralRelayAddress(row.endpoint);
      const relayUrl = configuredNeutral ? (_neutralMcpRelay?.status().url || row.endpoint) : row.endpoint;
      if (configuredNeutral && !_neutralMcpRelay?.status().running) throw new Error('中立 MCP 服务尚未在 KLA 中启动，请先启动服务后再测试');
      const resolved = resolveWorkBuddyHeaders(relayUrl, resolveMcpConfigSecrets(db, { ...rawConfig, url: relayUrl }).headers);
      const config = { ...resolveMcpConfigSecrets(db, { ...rawConfig, url: relayUrl }), url: relayUrl, headers: resolved.headers };
      const client = new StreamableHttpMcpClient(config);
      const info = await client.initialize(AbortSignal.timeout(Number(rawConfig.timeoutMs ?? 60000)));
      await client.close();
      return { ok: true, data: { success: true, version: info.serverInfo?.version ?? null, tools: info.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })) } };
    } catch (error) {
      return { ok: true, data: { success: false, error: error instanceof Error ? error.message : String(error), version: null, tools: [] } };
    }
  });

  registerIpc('agents:disconnectWorkBuddy', async () => {
    const rows = db.prepare("SELECT id, secret_refs_json as secretRefsJson FROM cli_connections WHERE adapter_type = 'workbuddy'").all() as Array<{ id: string; secretRefsJson?: string | null }>;
    for (const row of rows) {
      // Keep the profile/connection row so existing project instances retain a
      // stable identity. Disabling it prevents new group assignments while
      // allowing a later reconnect to re-use the same profile.
      db.prepare('UPDATE agent_profiles SET enabled = 0, updated_at = ? WHERE cli_connection_id = ?').run(new Date().toISOString(), row.id);
      try { for (const ref of (row.secretRefsJson ? JSON.parse(row.secretRefsJson) as string[] : [])) db.prepare('DELETE FROM secrets WHERE id = ? AND kind = \'workbuddy-mcp\'').run(ref); } catch { /* ignore malformed legacy refs */ }
      db.prepare("UPDATE cli_connections SET status = 'unknown', secret_refs_json = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    }
    return { ok: true };
  });

  // Neutral MCP relay: this is an independent loopback service that WorkBuddy
  // mounts as an MCP client. It is intentionally separate from TeamMcpServer,
  // which is KLA's internal team tool server.
  registerIpc('agents:startNeutralRelay', async () => {
    if (process.env.KLA_ENABLE_WORKBUDDY !== '1') {
      return { ok: false, error: { code: 'WORKBUDDY_DISABLED', message: 'WorkBuddy 中立 MCP 中继暂未启用，相关配置已保留。', retryable: false } };
    }
    if (!_neutralMcpRelay) _neutralMcpRelay = new NeutralMcpRelay();
    return { ok: true, data: await _neutralMcpRelay.start() };
  });
  registerIpc('agents:stopNeutralRelay', async () => {
    await _neutralMcpRelay?.stop();
    return { ok: true, data: { running: false, port: 0, url: '', token: '', taskCount: 0, pendingCount: 0 } };
  });
  registerIpc('agents:getNeutralRelayStatus', async () => ({ ok: true, data: _neutralMcpRelay?.status() ?? { running: false, port: 0, url: '', token: '', taskCount: 0, pendingCount: 0 } }));
  registerIpc('agents:enqueueNeutralRelayTask', async (_event, input: { instruction: string; projectId?: string; metadata?: Record<string, unknown> }) => {
    if (process.env.KLA_ENABLE_WORKBUDDY !== '1') {
      return { ok: false, error: { code: 'WORKBUDDY_DISABLED', message: 'WorkBuddy 中立 MCP 中继暂未启用，相关配置已保留。', retryable: false } };
    }
    if (!_neutralMcpRelay) _neutralMcpRelay = new NeutralMcpRelay();
    return { ok: true, data: _neutralMcpRelay.enqueue(input) };
  });
  registerIpc('agents:getNeutralRelayTask', async (_event, input: { taskId: string }) => ({ ok: true, data: _neutralMcpRelay?.getTask(input.taskId) ?? null }));
  registerIpc('agents:listNeutralRelayTasks', async () => ({ ok: true, data: _neutralMcpRelay?.listTasks() ?? [] }));

  registerIpc('meetings:saveRecording', async (_event, input: { projectId: string; meetingId: string; fileName: string; bytes: Uint8Array }) => {
    if (!input.bytes?.byteLength) throw new DatabaseError('VALIDATION_FAILED', '录音文件为空');
    if (input.bytes.byteLength > 2 * 1024 * 1024 * 1024) throw new DatabaseError('VALIDATION_FAILED', '录音文件超过 2GB 限制');
    await ensureEnterpriseProjectWorkspace({ projectId: input.projectId });
    const meetingRoot = getMeetingRoot(input.meetingId);
    const root = join(meetingRoot, 'recordings');
    await mkdir(root, { recursive: true });
    const fileName = safeFileName(input.fileName || 'meeting-audio.webm');
    const target = await nextAvailablePath(root, fileName);
    await writeFile(target, input.bytes);
    await writeFile(join(meetingRoot, 'meeting.yaml'), `schemaVersion: 1\nmeetingId: ${input.meetingId}\nprojectId: ${input.projectId}\n`, 'utf8');
    return { ok: true, data: { relativePath: normalize(target.slice(meetingRoot.length + 1)) } };
  });
  registerIpc('meetings:getRealtimeRecognitionUrl', async (_event, input?: { speakerContextId?: string }) => ({
    ok: true,
    data: await createTencentAsrSession({ ...(input?.speakerContextId ? { speakerContextId: input.speakerContextId } : {}) }, db),
  }));
  registerIpc('meetings:analyzeSpeakers', async (_event, input: {
    meetingName: string;
    projectName: string;
    knownPeople: string[];
    transcript: MeetingAgentTranscriptLine[];
    speakers: Array<Pick<MeetingSpeakerIdentity, 'clusterId' | 'label'>>;
  }) => {
    if (!_gateway) throw new DatabaseError('VALIDATION_FAILED', '会议智能体尚未初始化');
    if (!Array.isArray(input.transcript) || input.transcript.length > 1_200) throw new DatabaseError('VALIDATION_FAILED', '会议转写内容无效或过长');
    if (!Array.isArray(input.speakers) || input.speakers.length > 10) throw new DatabaseError('VALIDATION_FAILED', '说话人聚类数据无效');
    return { ok: true, data: await analyzeMeetingSpeakers(_gateway, input) };
  });
  registerIpc('meetings:refineSpeakers', async (_event, input: {
    meetingName: string;
    projectName: string;
    knownPeople: string[];
    transcript: MeetingAgentTranscriptLine[];
    speakers: Array<Pick<MeetingSpeakerIdentity, 'clusterId' | 'label'>>;
    identities: MeetingSpeakerIdentity[];
    message: string;
  }) => {
    if (!_gateway) throw new DatabaseError('VALIDATION_FAILED', '会议智能体尚未初始化');
    if (!input.message?.trim() || input.message.length > 2_000) throw new DatabaseError('VALIDATION_FAILED', '会议确认内容无效');
    if (!Array.isArray(input.identities) || input.identities.length > 10) throw new DatabaseError('VALIDATION_FAILED', '说话人身份数据无效');
    return { ok: true, data: await refineMeetingSpeakers(_gateway, input) };
  });
  registerIpc('meetings:generateMinutes', async (_event, input: {
    meetingName: string;
    projectName: string;
    transcript: MeetingAgentTranscriptLine[];
    speakers: MeetingSpeakerIdentity[];
    confirmations: string[];
  }) => {
    if (!_gateway) throw new DatabaseError('VALIDATION_FAILED', '会议智能体尚未初始化');
    if (!Array.isArray(input.transcript) || input.transcript.length > 1_200) throw new DatabaseError('VALIDATION_FAILED', '会议转写内容无效或过长');
    if (!Array.isArray(input.speakers) || input.speakers.length > 10) throw new DatabaseError('VALIDATION_FAILED', '说话人身份数据无效');
    return { ok: true, data: await generateMeetingMinutes(_gateway, input) };
  });
  registerIpc('meetings:exportFiles', async (event, input: {
    projectId: string;
    meetingId: string;
    meetingName: string;
    audioRelativePath: string;
    audioFileName: string;
    transcriptText: string;
  }) => {
    if (!input.transcriptText?.trim()) throw new DatabaseError('VALIDATION_FAILED', '会议转写文本为空');
    if (Buffer.byteLength(input.transcriptText, 'utf8') > 20 * 1024 * 1024) throw new DatabaseError('VALIDATION_FAILED', '会议转写文本超过 20MB 限制');
    await ensureEnterpriseProjectWorkspace({ projectId: input.projectId });
    const meetingRoot = getMeetingRoot(input.meetingId);
    const recordingsRoot = join(meetingRoot, 'recordings');
    const audioSource = resolveInside(meetingRoot, input.audioRelativePath);
    const recordingsPrefix = recordingsRoot.endsWith(sep) ? recordingsRoot : `${recordingsRoot}${sep}`;
    if (!audioSource.startsWith(recordingsPrefix)) throw new DatabaseError('VALIDATION_FAILED', '会议录音路径无效');
    await assertNoSymlink(audioSource);
    const audioInfo = await lstat(audioSource);
    if (!audioInfo.isFile()) throw new DatabaseError('VALIDATION_FAILED', '会议录音文件不存在');
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { title: '选择会议文件保存位置', properties: ['openDirectory', 'createDirectory'] };
    const selection = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths[0]) return { ok: true, data: { cancelled: true } };
    const exportRoot = await nextAvailablePath(selection.filePaths[0], `${safeFileName(input.meetingName || input.meetingId)}-会议文件`);
    await mkdir(exportRoot, { recursive: false });
    const audioName = safeFileName(input.audioFileName || basename(audioSource));
    const transcriptName = `${safeFileName(input.meetingName || input.meetingId)}-会议转写.txt`;
    await Promise.all([
      copyFile(audioSource, join(exportRoot, audioName)),
      writeFile(join(exportRoot, transcriptName), input.transcriptText, 'utf8'),
    ]);
    return { ok: true, data: { cancelled: false, directory: exportRoot } };
  });
  registerIpc('meetings:saveSharedKnowledge', async (_event, input: { projectId: string; meetingId: string; title: string; content: string }) => {
    if (!input.content?.trim()) throw new DatabaseError('VALIDATION_FAILED', '共享知识内容不能为空');
    const projectRoot = await ensureEnterpriseProjectWorkspace({ projectId: input.projectId });
    const root = join(projectRoot, 'original-files', 'meetings', safeFileName(input.meetingId));
    await mkdir(root, { recursive: true });
    const safeTitle = safeFileName(input.title || '会议确认');
    const target = await nextAvailablePath(root, `${safeFileName(input.meetingId)}-${safeTitle}.md`);
    const body = `# ${input.title || '会议确认'}\n\n- 来源会议：${input.meetingId}\n- 更新时间：${new Date().toISOString()}\n\n${input.content.trim()}\n`;
    await writeFile(target, body, 'utf8');
    const sharedRoot = join(projectRoot, 'original-files');
    const relativePath = normalize(target.slice(sharedRoot.length + 1)).replaceAll('\\', '/');
    const fileRepo = new FileRepository(db);
    const existing = fileRepo.getByPath('project', input.projectId, relativePath);
    const fileBuffer = Buffer.from(body, 'utf8');
    const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
    const storageRelPath = join('.runtime', 'versions', `${sha256.slice(0, 16)}-meeting.md`);
    if (existing) {
      fileRepo.createVersion({ fileId: existing.id, storageRelPath, size: fileBuffer.length, sha256, createdByType: 'system', createdById: 'meeting-agent', changeNote: 'meeting-confirmation' });
    } else {
      const file = fileRepo.create({ scopeType: 'project', scopeId: input.projectId, parentId: `meetings/${safeFileName(input.meetingId)}`, type: 'file', name: basename(target), normalizedPath: relativePath, mimeType: 'text/markdown', origin: 'artifact' });
      fileRepo.createVersion({ fileId: file.id, storageRelPath, size: fileBuffer.length, sha256, createdByType: 'system', createdById: 'meeting-agent', changeNote: 'meeting-confirmation' });
      fileRepo.markReady(file.id);
    }
    return { ok: true, data: { relativePath } };
  });
  registerIpc('agents:updateProfileSkills', async (_event, input: { profileId: string; enabledSkills: string[] }) => {
    const row = db.prepare('SELECT overrides_json FROM agent_profiles WHERE id = ?').get(input.profileId) as { overrides_json: string | null } | undefined;
    if (!row) return { ok: false, requestId: '-', error: { code: 'NOT_FOUND', message: 'Profile not found', retryable: false } };
    const overrides = row.overrides_json ? JSON.parse(row.overrides_json) : {};
    overrides.enabledSkills = input.enabledSkills;
    db.prepare('UPDATE agent_profiles SET overrides_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(overrides), new Date().toISOString(), input.profileId);
    return { ok: true };
  });
  registerIpc('agents:updateProfilePermissions', async (_event, input: { profileId: string; effectivePermissions: string[] }) => {
    const row = db.prepare('SELECT overrides_json FROM agent_profiles WHERE id = ?').get(input.profileId) as { overrides_json: string | null } | undefined;
    if (!row) return { ok: false, requestId: '-', error: { code: 'NOT_FOUND', message: 'Profile not found', retryable: false } };
    const overrides = row.overrides_json ? JSON.parse(row.overrides_json) : {};
    overrides.effectivePermissions = input.effectivePermissions;
    db.prepare('UPDATE agent_profiles SET overrides_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(overrides), new Date().toISOString(), input.profileId);
    return { ok: true };
  });
  registerIpc('agents:cloneProfile', async (_event, input: { profileId: string; name: string }) => {
    const source = db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(input.profileId) as Record<string, any> | undefined;
    if (!source) return { ok: false, requestId: '-', error: { code: 'NOT_FOUND', message: 'Source profile not found', retryable: false } };
    const newId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, model_profile_id, cli_connection_id, overrides_json, enabled, delegatable, is_system_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(newId, input.name, source.definition_id, source.definition_version, source.runtime_mode, source.model_profile_id, source.cli_connection_id, source.overrides_json, source.enabled, source.delegatable, now, now);
    return { ok: true, data: { id: newId, name: input.name, definitionId: source.definition_id, runtimeMode: source.runtime_mode, enabled: !!source.enabled, delegatable: !!source.delegatable } };
  });
  registerIpc('agents:startProcess', async (_event, input: { connectionId: string; instruction: string; projectId: string }) => {
    const window = BrowserWindow.fromWebContents(_event.sender);
    if (!window) return { ok: false, requestId: '-', error: { code: 'NO_WINDOW', message: 'No window', retryable: false } };

    const row = db.prepare('SELECT id, name, adapter_type as adapterType, executable_path as executablePath, args_json as argsJson, strategy_id as strategyId, detected_version as detectedVersion, status, trust_tier as trustTier FROM cli_connections WHERE id = ?').get(input.connectionId) as CliConnectionRow | undefined;
    if (!row) return { ok: false, requestId: '-', error: { code: 'NOT_FOUND', message: 'CLI connection not found', retryable: false } };

    const connection: import('@kunqing/agent-core').CliConnectionConfig = {
      id: row.id, name: row.name, adapterType: row.adapterType, executablePath: row.executablePath,
      args: row.argsJson ? JSON.parse(row.argsJson) : [], strategyId: row.strategyId ?? 'auto',
      detectedVersion: row.detectedVersion, status: row.status, trustTier: row.trustTier,
      capabilities: [], secretRefs: [],
    };

    const projectRoot = getProjectRoot(input.projectId);

    // 使用适配器策略构建参数，替代默认的 [instruction]
    const adapter = cliAgentRegistry.getAdapter(row.adapterType);
    let execArgs: string[] | undefined;
    if (adapter) {
      try {
        const evidence: VersionEvidence = {
          rawVersion: row.detectedVersion ?? '',
          semver: null,
          source: 'stdout',
        };
        const strategy = adapter.selectStrategy(evidence);
        if (strategy) {
          const spec = strategy.buildRun({
            executablePath: row.executablePath,
            instruction: input.instruction,
            args: connection.args,
            env: {},
            workspaceRoot: projectRoot,
            capabilities: strategy.capabilities,
          });
          execArgs = spec.args;
        }
      } catch {
        // 回退到默认 [instruction]
      }
    }

    try {
      const ctxBuilder = new ContextBuilder(db);
      const snapshot = ctxBuilder.build(input.projectId, row.id);
      await ctxBuilder.writeContextManifest(snapshot, projectRoot);
    } catch {
      // 非致命：CLI 仍可执行
    }

    // AC-EXT-06: 网络出站确认
    const caps: string[] = adapter && 'getCapabilities' in adapter ? (adapter as any).getCapabilities() : [];
    if (caps.includes('network-access') && row.trustTier !== 'trusted') {
      try {
        const { response } = await dialog.showMessageBox(window, {
          type: 'warning',
          title: '网络出站提示',
          message: `"${row.name}" (${row.adapterType}) 是一个网络型 CLI 智能体。`,
          detail: `它可能需要将上下文发送到网络。当前信任级别为「${row.trustTier === 'sandboxed' ? '沙箱' : '受限'}」。
是否允许此 CLI 运行？`,
          buttons: ['允许运行', '取消'],
          defaultId: 1,
          cancelId: 1,
        });
        if (response === 1) return { ok: true, data: { started: false, reason: '用户取消' } };
      } catch {
        // 对话框异常时继续执行
      }
    }

    cliExecutor.execute({ connection, instruction: input.instruction, ...(execArgs ? { args: execArgs } : {}), projectId: input.projectId, window, signal: undefined }).catch((err) => {
      getLogger().warn({ err, connectionId: input.connectionId }, 'CLI process execution error');
    });

    return { ok: true, data: { started: true } };
  });
  registerIpc('agents:cancelProcess', async (_event, input: { runId: string }) => {
    cliExecutor.cancelRun(input.runId);
    return { ok: true };
  });

  registerIpc('agents:upgradeProjectInstance', async (_event, input: { projectId: string; instanceId: string }) => {
    const instance = db.prepare('SELECT id, agent_profile_id as profileId, role, runtime_mode as runtimeMode FROM project_agent_instances WHERE id = ? AND project_id = ?').get(input.instanceId, input.projectId) as { id: string; profileId: string; role: string; runtimeMode: string } | undefined;
    if (!instance) return { ok: false, requestId: '-', error: { code: 'NOT_FOUND', message: '实例不存在', retryable: false } };

    const profile = db.prepare('SELECT id, definition_id as defId, definition_version as defVer FROM agent_profiles WHERE id = ?').get(instance.profileId) as { id: string; defId: string; defVer: string } | undefined;
    if (!profile) return { ok: false, requestId: '-', error: { code: 'NOT_FOUND', message: '关联 Profile 不存在', retryable: false } };

    const latestDef = db.prepare('SELECT version FROM agent_definitions WHERE id = ? ORDER BY version DESC LIMIT 1').get(profile.defId) as { version: string } | undefined;
    if (!latestDef) return { ok: true, data: { upgraded: false, reason: '无可用更新' } };
    if (latestDef.version === profile.defVer) return { ok: true, data: { upgraded: false, reason: '已是最新版本' } };

    const now = new Date().toISOString();
    db.prepare('UPDATE project_agent_instances SET definition_version = ?, updated_at = ? WHERE id = ?').run(latestDef.version, now, input.instanceId);
    return { ok: true, data: { upgraded: true, fromVersion: profile.defVer, toVersion: latestDef.version } };
  });
  registerIpc('agents:getWizardSnapshot', async () => {
    return { ok: true, data: agentConnectionService.snapshot };
  });
  registerIpc('agents:wizardStartManual', async (_event, input: { name: string; adapterType: string; executablePath: string }) => {
    try {
      const result = agentConnectionService.startManual(input.name, input.adapterType, input.executablePath);
      return { ok: true, data: result.snapshot };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'WIZARD_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('agents:wizardStartAuto', async (_event, input: { adapterType: string }) => {
    try {
      const result = await agentConnectionService.startAuto(input.adapterType);
      return { ok: true, data: result.snapshot };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'WIZARD_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('agents:wizardReadVersion', async () => {
    try {
      const result = await agentConnectionService.readVersion();
      return { ok: true, data: result.snapshot };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'WIZARD_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('agents:wizardProbeAuth', async () => {
    try {
      const result = await agentConnectionService.probeAuth();
      return { ok: true, data: result.snapshot };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'WIZARD_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('agents:wizardPrepareSmokeWorkspace', async () => {
    try {
      const result = await agentConnectionService.prepareSmokeWorkspace();
      return { ok: true, data: result.snapshot };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'WIZARD_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('agents:wizardRunSmokeTest', async () => {
    try {
      const result = await agentConnectionService.runSmokeTest();
      return { ok: true, data: result.snapshot };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'WIZARD_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('agents:wizardSave', async () => {
    try {
      const result = await agentConnectionService.save(db);
      return { ok: true, data: result.snapshot };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'WIZARD_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('agents:wizardCancel', async () => {
    agentConnectionService.reset();
    return { ok: true, data: agentConnectionService.snapshot };
  });
  registerIpc('agents:wizardSetExecutable', async (_event, input: { executablePath: string }) => {
    try {
      agentConnectionService.setExecutable(input.executablePath);
      return { ok: true, data: agentConnectionService.snapshot };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'WIZARD_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('agents:wizardSetTrustTier', async (_event, input: { tier: 'trusted' | 'sandboxed' | 'restricted' }) => {
    try {
      agentConnectionService.setTrustTier(input.tier);
      return { ok: true, data: agentConnectionService.snapshot };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'WIZARD_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('agents:wizardRetry', async () => {
    try {
      agentConnectionService.retry();
      return { ok: true, data: agentConnectionService.snapshot };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'WIZARD_ERROR', message: String(err), retryable: true } }; }
  });
};

const registerModelIpc = (db: ReturnType<typeof getDatabase>): void => {
  const saveProviderSecret = (providerId: string, providerType: string, apiKey: string): void => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage 不可用，无法加密保存 API Key');
    const existing = db.prepare('SELECT secret_ref as secretRef FROM model_providers WHERE id = ?').get(providerId) as { secretRef: string | null } | undefined;
    if (existing?.secretRef) db.prepare('DELETE FROM secrets WHERE id = ?').run(existing.secretRef);
    const secretRef = `secret-provider-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    db.prepare('INSERT INTO secrets (id, kind, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(secretRef, `provider-${providerType}`, safeStorage.encryptString(apiKey), now, now);
    db.prepare('UPDATE model_providers SET secret_ref = ? WHERE id = ?').run(secretRef, providerId);
  };

  registerIpc('models:listUnified', async () => {
    const data = db.prepare(
      `SELECT mp.id, mp.name, mp.model_id as modelId, mp.parameters_json as parametersJson,
              mp.declared_capabilities_json as declaredCapabilitiesJson,
              mp.verified_capabilities_json as verifiedCapabilitiesJson,
              prv.id as providerId, prv.type, prv.base_url as baseUrl, prv.status,
              CASE WHEN prv.secret_ref IS NULL THEN 0 ELSE 1 END as hasApiKey,
              CASE WHEN prv.id IN ('official-cmecloud-deepseek', 'official-cmecloud-glm') THEN 1 ELSE 0 END as isOfficial
       FROM model_profiles mp
       JOIN model_providers prv ON prv.id = mp.provider_id
       WHERE mp.enabled = 1
       ORDER BY mp.name`,
    ).all();
    return { ok: true, data };
  });
  registerIpc('models:saveUnified', async (_event, input: { id?: string; name: string; modelId: string; type: string; baseUrl?: string; apiKey?: string }) => {
    const name = input.name.trim();
    const modelId = input.modelId.trim();
    const type = input.type.trim();
    if (!name || !modelId || !type) throw new Error('模型名称、模型 ID 和类型为必填项');
    let profileId = input.id;
    let providerId: string;
    if (profileId) {
      const existing = db.prepare('SELECT provider_id as providerId FROM model_profiles WHERE id = ?').get(profileId) as { providerId: string } | undefined;
      if (!existing) throw new Error('模型配置不存在');
      providerId = existing.providerId;
      db.prepare('UPDATE model_profiles SET name = ?, model_id = ? WHERE id = ?').run(name, modelId, profileId);
      db.prepare('UPDATE model_providers SET type = ?, base_url = ?, status = ? WHERE id = ?')
        .run(type, input.baseUrl?.trim() || null, 'unknown', providerId);
    } else {
      const providerBaseUrl = input.baseUrl?.trim();
      const provider = new ModelProviderRepository(db).create({
        name: `model-${randomUUID().slice(0, 8)}`,
        type,
        ...(providerBaseUrl ? { baseUrl: providerBaseUrl } : {}),
        authType: 'api-key',
      });
      providerId = provider.id;
      profileId = new ModelProfileRepository(db).create({
        name,
        providerId,
        modelId,
        declaredCapabilitiesJson: JSON.stringify(['streaming']),
      }).id;
    }
    if (input.apiKey?.trim()) saveProviderSecret(providerId, type, input.apiKey.trim());
    const now = new Date().toISOString();
    for (const slot of ['reasoning', 'fast', 'embedding']) {
      db.prepare(
        `INSERT INTO model_slot_bindings (slot, model_profile_id, updated_at)
         SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM model_slot_bindings WHERE slot = ?)`,
      ).run(slot, profileId, now, slot);
    }
    return { ok: true, data: { id: profileId } };
  });
  registerIpc('models:testUnified', async (_event, input: { id: string }) => {
    const row = db.prepare('SELECT provider_id as providerId, model_id as modelId FROM model_profiles WHERE id = ?').get(input.id) as { providerId: string; modelId: string } | undefined;
    if (!row || !_gateway) return { ok: true, data: { success: false, latencyMs: 0, error: '模型网关未初始化' } };
    const startedAt = Date.now();
    try {
      const capabilities = await _gateway.testCapabilities(row.providerId, row.modelId);
      const success = Boolean(capabilities.streaming);
      new ModelProviderRepository(db).update(row.providerId, { status: success ? 'available' : 'error', lastCheckedAt: new Date().toISOString() });
      new ModelProfileRepository(db).updateVerification(input.id, Object.entries(capabilities).filter(([key, value]) => key !== 'error' && value).map(([key]) => key), new Date().toISOString());
      return { ok: true, data: { success, latencyMs: Date.now() - startedAt, capabilities, error: capabilities.error } };
    } catch (error) {
      return { ok: true, data: { success: false, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) } };
    }
  });
  registerIpc('models:deleteUnified', async (_event, input: { id: string }) => {
    const row = db.prepare('SELECT provider_id as providerId FROM model_profiles WHERE id = ?').get(input.id) as { providerId: string } | undefined;
    if (!row) return { ok: true };
    if (row.providerId === 'official-cmecloud-deepseek' || row.providerId === 'official-cmecloud-glm') {
      throw new Error('官方内置模型不可删除；如需替换，请在智能体管理中挂载其他模型。');
    }
    db.prepare('DELETE FROM model_slot_bindings WHERE model_profile_id = ?').run(input.id);
    db.prepare('UPDATE agent_profiles SET model_profile_id = NULL WHERE model_profile_id = ?').run(input.id);
    db.prepare('UPDATE project_agent_instances SET model_profile_id = NULL WHERE model_profile_id = ?').run(input.id);
    new ModelProfileRepository(db).delete(input.id);
    const provider = db.prepare('SELECT secret_ref as secretRef FROM model_providers WHERE id = ?').get(row.providerId) as { secretRef: string | null } | undefined;
    if (provider?.secretRef) db.prepare('DELETE FROM secrets WHERE id = ?').run(provider.secretRef);
    new ModelProviderRepository(db).delete(row.providerId);
    _gateway?.invalidateSlotProfiles();
    return { ok: true };
  });
  registerIpc('models:listProviders', async () => {
    const data = db.prepare('SELECT id, name, type, base_url as baseUrl, status FROM model_providers ORDER BY name').all();
    return { ok: true, data };
  });
  registerIpc('models:listProfiles', async () => {
    const data = db.prepare(
      `SELECT mp.id, mp.name, mp.provider_id as providerId, mp.model_id as modelId, mp.enabled,
              prv.name as providerName, prv.type as providerType,
              (SELECT GROUP_CONCAT(msb.slot, ',')
                 FROM model_slot_bindings msb
                WHERE msb.model_profile_id = mp.id) as boundSlots
       FROM model_profiles mp
       JOIN model_providers prv ON prv.id = mp.provider_id
       ORDER BY mp.name`,
    ).all();
    return { ok: true, data };
  });
  registerIpc('models:saveProvider', async (_event, input: { name: string; type: string; baseUrl?: string; authType?: string; apiKey?: string }) => {
    const repo = new ModelProviderRepository(db);
    let secretRef: string | undefined;
    if (input.apiKey && safeStorage.isEncryptionAvailable()) {
      const ciphertext = safeStorage.encryptString(input.apiKey);
      const ref = `secret-provider-${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      db.prepare('INSERT INTO secrets (id, kind, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(ref, `provider-${input.type}`, ciphertext, now, now);
      secretRef = ref;
    }
    const row = repo.create({ name: input.name, type: input.type, baseUrl: input.baseUrl, authType: input.authType ?? 'api-key', secretRef } as never);
    return { ok: true, data: row };
  });
  registerIpc('models:updateProvider', async (_event, input: { id: string; name?: string; type?: string; baseUrl?: string | null; authType?: string; apiKey?: string }) => {
    const repo = new ModelProviderRepository(db);
    const changes: Record<string, unknown> = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.type !== undefined) changes.type = input.type;
    if (input.baseUrl !== undefined) changes.baseUrl = input.baseUrl;
    if (input.authType !== undefined) changes.authType = input.authType;
    if (input.apiKey !== undefined) {
      const existing = db.prepare('SELECT secret_ref FROM model_providers WHERE id = ?').get(input.id) as { secret_ref: string | null } | undefined;
      if (existing?.secret_ref) {
        db.prepare('DELETE FROM secrets WHERE id = ?').run(existing.secret_ref);
      }
      if (input.apiKey) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('safeStorage 不可用，无法加密保存 API Key');
        }
        const ciphertext = safeStorage.encryptString(input.apiKey);
        const ref = `secret-provider-${randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        db.prepare('INSERT INTO secrets (id, kind, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(ref, `provider-${input.type ?? 'openai'}`, ciphertext, now, now);
        changes.secretRef = ref;
      } else {
        changes.secretRef = null;
      }
    }
    repo.update(input.id, changes as Parameters<typeof repo.update>[1]);
    return { ok: true, data: repo.getById(input.id) };
  });
  registerIpc('models:testProvider', async (_event, input: { providerId: string; modelId?: string }) => {
    if (!_gateway) return { ok: true, data: { success: false, latencyMs: 0, error: 'ModelGateway 未初始化' } };
    const start = Date.now();
    try {
      const caps = await _gateway.testCapabilities(input.providerId, input.modelId);
      const repo = new ModelProviderRepository(db);
      repo.update(input.providerId, { status: caps.streaming ? 'available' : 'error', lastCheckedAt: new Date().toISOString() });
      return { ok: true, data: { success: caps.streaming, latencyMs: Date.now() - start, capabilities: caps, error: caps.error ?? (caps.streaming ? undefined : '测试失败（无详细信息）') } };
    } catch (err) {
      return { ok: true, data: { success: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) } };
    }
  });
  registerIpc('models:saveProfile', async (_event, input: { id?: string; name: string; providerId: string; modelId: string }) => {
    const repo = new ModelProfileRepository(db);
    let profileId: string;
    if (input.id) {
      repo.update(input.id, { name: input.name, providerId: input.providerId, modelId: input.modelId });
      profileId = input.id;
    } else {
      const row = repo.create({ name: input.name, providerId: input.providerId, modelId: input.modelId });
      profileId = row.id;
    }
    return { ok: true, data: repo.getById(profileId) };
  });
  registerIpc('models:testCapabilities', async (_event, input: { profileId: string }) => {
    if (!_gateway) return { ok: true, data: { capabilities: ['streaming'], profileId: input.profileId } };
    const profile = new ModelProfileRepository(db).getById(input.profileId);
    const caps = await _gateway.testCapabilities(profile.providerId);
    const capsList = Object.entries(caps).filter(([k, v]) => k !== 'error' && v).map(([k]) => k);
    new ModelProfileRepository(db).updateVerification(input.profileId, capsList, new Date().toISOString());
    return { ok: true, data: { capabilities: capsList, profileId: input.profileId } };
  });
  registerIpc('models:deleteProfile', async (_event, input: { id: string }) => {
    new ModelProfileRepository(db).delete(input.id);
    _gateway?.invalidateSlotProfiles();
    return { ok: true };
  });
  registerIpc('models:deleteProvider', async (_event, input: { id: string }) => {
    db.prepare('DELETE FROM model_slot_bindings WHERE model_profile_id IN (SELECT id FROM model_profiles WHERE provider_id = ?)').run(input.id);
    db.prepare('DELETE FROM model_profiles WHERE provider_id = ?').run(input.id);
    new ModelProviderRepository(db).delete(input.id);
    _gateway?.invalidateSlotProfiles();
    return { ok: true };
  });
  registerIpc('models:setSlot', async (_event, input: { slot: string; modelProfileId: string }) => {
    db.prepare('INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)').run(input.slot, input.modelProfileId, new Date().toISOString());
    _gateway?.invalidateSlotProfiles();
    return { ok: true };
  });
};

const registerMemoryIpc = (db: ReturnType<typeof getDatabase>): void => {
  const repo = new MemoryRepository(db);
  const memory = new ConversationMemoryManager(db);
  registerIpc('memory:list', async (_event, input: { projectId: string; agentInstanceId: string; scope?: string; status?: string }) => {
    const data = repo.list(input.projectId, input.agentInstanceId, input.scope, input.status);
    return { ok: true, data };
  });
  registerIpc('memory:update', async (_event, input: { recordId: string; content?: string; confidence?: number }) => {
    const changes: { content?: string; confidence?: number } = {};
    if (input.content !== undefined) changes.content = input.content;
    if (input.confidence !== undefined) changes.confidence = input.confidence;
    repo.update(input.recordId, changes);
    const updated = repo.get(input.recordId);
    if (updated) await memory.syncAgentMemory(updated.projectId, updated.agentInstanceId);
    return { ok: true, data: updated };
  });
  registerIpc('memory:create', async (_event, input: { projectId: string; agentInstanceId: string; scope: 'short-term' | 'long-term'; type?: string; content: string; confidence?: number }) => {
    const data = repo.create({
      projectId: input.projectId,
      agentInstanceId: input.agentInstanceId,
      scope: input.scope,
      type: input.type?.trim() || 'manual',
      content: input.content.trim(),
      confidence: input.confidence ?? (input.scope === 'long-term' ? 1 : 0.8),
      ...(input.scope === 'short-term' ? { expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString() } : {}),
      sourceRefsJson: JSON.stringify({ source: 'manual-editor', visibility: 'agent' }),
    });
    await memory.syncAgentMemory(input.projectId, input.agentInstanceId);
    return { ok: true, data };
  });
  registerIpc('memory:remove', async (_event, input: { recordId: string }) => {
    const record = repo.get(input.recordId);
    repo.remove(input.recordId);
    if (record) await memory.syncAgentMemory(record.projectId, record.agentInstanceId);
    return { ok: true };
  });
};

/** 为旧版内置 SKILL.md 补齐 Codex frontmatter，同时保留既有正文。 */
const writeBuiltinSkill = async (path: string, content: string): Promise<void> => {
  try {
    const current = await readFile(path, 'utf8');
    if (/^---\r?\n[\s\S]*?^name:\s*.+$[\s\S]*?^description:\s*.+$[\s\S]*?^---\s*$/m.test(current)) return;
    const header = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0];
    await writeFile(path, `${header ?? ''}\n${current.trim()}\n`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(path, content, 'utf8');
  }
};

const writeManagedDefinitionFile = async (path: string, content: string, legacyContent: string | string[]): Promise<void> => {
  try {
    const current = await readFile(path, 'utf8');
    const normalized = (value: string): string => value.replace(/\r\n/g, '\n').trim();
    if (normalized(current) === normalized(content)) return;
    // 只迁移应用曾经安装的原始版本；用户一旦修改过就保留人工版本。
    const managedPreviousVersions = Array.isArray(legacyContent) ? legacyContent : [legacyContent];
    if (managedPreviousVersions.some((previous) => normalized(current) === normalized(previous))) {
      await writeFile(path, content, 'utf8');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(path, content, 'utf8');
  }
};

const registerKnowledgeIpc = (db: ReturnType<typeof getDatabase>): void => {
  const repo = new KnowledgeRepository(db);
  type KnowledgeScopeRequest = {
    projectId: string;
    scopeType?: 'project' | 'shared' | 'project-shared';
    scopeId?: string;
    resourceType?: 'group' | 'meeting' | 'operation';
    resourceId?: string;
  };
  const assertKnowledgeScopeAccess = (input: KnowledgeScopeRequest): void => {
    if (!input.scopeId || input.scopeType === 'shared' || input.scopeId === input.projectId) return;
    const resourceType = input.resourceType ?? 'group';
    const resourceId = assertProjectId(input.resourceId ?? input.projectId);
    const linkedProjectId = resolveAssociatedEnterpriseProjectId(db, resourceType, resourceId);
    if (!linkedProjectId || linkedProjectId !== input.scopeId) {
      throw new DatabaseError('VALIDATION_FAILED', '当前资源未关联该项目，无法访问项目知识');
    }
  };
  const sharedEnabled = (projectId: string): boolean => {
    return Boolean(projectId);
  };
  registerIpc('knowledge:listJobs', async (_event, input: { scopeType?: string; scopeId?: string; status?: string; projectId?: string }) => {
    if (input.scopeType === 'shared' && input.projectId && !sharedEnabled(input.projectId)) return { ok: true, data: [] };
    const data = repo.listJobs(input.scopeType, input.scopeId, input.status);
    return { ok: true, data };
  });
  registerIpc('knowledge:ingest', async (_event, input: { fileId: string }) => {
    const result = await knowledgeIngestForFile(db, input.fileId);
    return { ok: true, data: result };
  });
  const resolveWorkspaceKnowledgeScope = (input: KnowledgeScopeRequest) => {
    if (input.scopeType === 'shared') {
      return { scopeType: 'shared' as const, scopeId: 'shared-knowledge', workspaceType: 'enterprise' as const };
    }
    if (input.scopeType === 'project-shared') {
      const resourceType = input.resourceType ?? 'group';
      const resourceId = assertProjectId(input.resourceId ?? input.projectId);
      const linkedProjectId = resolveAssociatedEnterpriseProjectId(db, resourceType, resourceId);
      const requestedProjectId = assertProjectId(input.scopeId || '');
      if (!linkedProjectId || linkedProjectId !== requestedProjectId) {
        throw new DatabaseError('VALIDATION_FAILED', '当前群聊未关联该项目，无法处理项目工作区知识');
      }
      return { scopeType: 'project' as const, scopeId: linkedProjectId, workspaceType: 'enterprise-project' as const };
    }
    return { scopeType: 'project' as const, scopeId: assertProjectId(input.projectId), workspaceType: 'group' as const };
  };
  registerIpc('knowledge:startWorkspaceIngestion', async (_event, input: KnowledgeScopeRequest) => {
    const scope = resolveWorkspaceKnowledgeScope(input);
    const data = startBackgroundKnowledgeSync(db, _gateway, scope);
    return { ok: true, data };
  });
  registerIpc('knowledge:getWorkspaceIngestionStatus', async (_event, input: KnowledgeScopeRequest) => {
    const scope = resolveWorkspaceKnowledgeScope(input);
    return { ok: true, data: getBackgroundKnowledgeSyncStatus(scope) };
  });
  registerIpc('knowledge:retryJob', async (_event, input: { jobId: string }) => {
    const job = repo.getJob(input.jobId);
    if (!job) return { ok: true, data: null };
    repo.setJobStatus(job.id, 'queued');
    repo.setSourceStatus(job.sourceId, 'pending');
    return { ok: true, data: repo.getJob(job.id) };
  });
  registerIpc('knowledge:search', async (_event, input: { query: string; projectId?: string; scopeType?: string; scopeId?: string; limit?: number }) => {
    if (input.projectId && _gateway) await refreshKnowledgeBeforeSearch(db, _gateway, input.projectId);
    const data = input.projectId
      ? searchHybridKnowledge(db, input.query, input.projectId, input.limit ?? 20)
      : repo.search(input.query, input.scopeType, input.scopeId, input.limit ?? 50);
    return { ok: true, data };
  });
  registerIpc('knowledge:getGraph', async (_event, input: KnowledgeScopeRequest & { scopeType: 'project' | 'shared'; scopeId: string }) => {
    assertKnowledgeScopeAccess(input);
    if (input.scopeType === 'shared' && input.projectId && !sharedEnabled(input.projectId)) return { ok: true, data: { nodes: [], edges: [] } };
    const data = repo.getGraph(input.scopeType, input.scopeId);
    return { ok: true, data };
  });
  registerIpc('knowledge:getSourceDetail', async (_event, input: { fileId: string }) => {
    const detail = repo.getSourceDetail(input.fileId);
    return { ok: true, data: detail };
  });
  registerIpc('knowledge:getGraphProjection', async (_event, input: KnowledgeScopeRequest & { scopeType: 'project' | 'shared'; scopeId: string; scopeType2?: 'project' | 'shared' }) => {
    assertKnowledgeScopeAccess(input);
    if ((input.scopeType === 'shared' || input.scopeType2 === 'shared') && !sharedEnabled(input.projectId)) return { ok: true, data: null };
    const graph = repo.getGraph(input.scopeType, input.scopeId);
    const elements: unknown[] = [
      ...graph.nodes.map((n) => ({
        data: { id: n.id, label: n.canonicalName, nodeType: n.nodeType, summary: n.summary ?? undefined, confidence: n.confidence },
      })),
      ...graph.edges.map((e) => ({
        data: { id: e.id, source: e.sourceNodeId, target: e.targetNodeId, edgeType: e.edgeType, label: e.edgeType, confidence: e.confidence },
      })),
    ];
    const nodeTypes = [...new Set(graph.nodes.map((n) => n.nodeType))];
    const edgeTypes = [...new Set(graph.edges.map((e) => e.edgeType))];
    const projection: { schemaVersion: number; scope: { type: string; id: string }; graphVersion: string; elements: unknown[]; filters: { nodeTypes: string[]; edgeTypes: string[] }; constraints?: string } = {
      schemaVersion: 1,
      scope: { type: input.scopeType === 'shared' ? 'shared' : 'group', id: input.scopeId },
      graphVersion: new Date().toISOString(),
      elements,
      filters: { nodeTypes, edgeTypes },
    };
    if (graph.constraints) projection.constraints = graph.constraints;
    const graphRoot = getGraphRoot({ projectId: input.projectId, ...(input.scopeType2 ? { scopeType: input.scopeType2 } : {}) });
    const visDir = join(graphRoot, 'graph-visualization');
    await mkdir(visDir, { recursive: true });
    await writeFile(join(visDir, 'current.graph.json'), JSON.stringify(projection, null, 2));
    return { ok: true, data: projection };
  });
  registerIpc('knowledge:getNodeProvenance', async (_event, input: { targetType: string; targetId: string }) => {
    const data = repo.listProvenanceDetail(input.targetType, input.targetId);
    return { ok: true, data };
  });
  const wri = new WikiRepository(db);
  registerIpc('wiki:list', async (_event, input: KnowledgeScopeRequest & { scopeType: 'project' | 'shared'; scopeId: string }) => {
    assertKnowledgeScopeAccess(input);
    if (input.scopeType === 'shared' && !sharedEnabled(input.projectId)) return { ok: true, data: [] };
    const data = wri.list(input.scopeType, input.scopeId);
    return { ok: true, data };
  });
  registerIpc('wiki:get', async (_event, input: KnowledgeScopeRequest & { scopeType: 'project' | 'shared'; scopeId: string; slug: string }) => {
    assertKnowledgeScopeAccess(input);
    if (input.scopeType === 'shared' && input.projectId && !sharedEnabled(input.projectId)) return { ok: true, data: null };
    const data = wri.getBySlug(input.scopeType, input.scopeId, input.slug);
    return { ok: true, data };
  });
};

const registerSettingsIpc = (db: ReturnType<typeof getDatabase>): void => {
  const readSettingValue = (key: string, fallback: unknown): unknown => {
    const row = db.prepare('SELECT value_json as valueJson FROM settings WHERE key = ?').get(key) as { valueJson?: string } | undefined;
    if (!row?.valueJson) return fallback;
    try { return (JSON.parse(row.valueJson) as { value?: unknown }).value ?? fallback; } catch { return fallback; }
  };
  registerIpc('settings:getAll', async () => {
    try {
      const rows = db.prepare('SELECT key, value_json as v FROM settings').all() as Array<{ key: string; v: string }>;
      const data: Record<string, unknown> = { theme: 'professional', locale: 'zh-CN' };
      for (const row of rows) {
        try { data[row.key] = JSON.parse(row.v).value; } catch { /* skip malformed */ }
      }
      // 仅为新安装补齐默认权益，不覆盖已有用户的剩余额度或已消耗量。
      if (!Object.prototype.hasOwnProperty.call(data, 'operationsAvailableTokens')) {
        const now = new Date().toISOString();
        data.operationsAvailableTokens = 3_000_000;
        db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
          .run('operationsAvailableTokens', JSON.stringify({ value: 3_000_000 }), now);
      }
      if (!Object.prototype.hasOwnProperty.call(data, 'tokenUsageTotal')) {
        const now = new Date().toISOString();
        data.tokenUsageTotal = 0;
        db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
          .run('tokenUsageTotal', JSON.stringify({ value: 0 }), now);
      }
      const existingEnterpriseProjects = data.enterpriseProjects;
      if (!Object.prototype.hasOwnProperty.call(data, 'enterpriseProjects') || !Array.isArray(existingEnterpriseProjects) || existingEnterpriseProjects.length === 0) {
        const now = new Date().toISOString();
        const personalProject = {
          id: 'enterprise-personal',
          name: '个人项目',
          description: '用于承载尚未归入专项项目的个人群聊、操作平台与工作成果。',
          tokenUsed: 36_800,
          completedNodes: 3,
          totalNodes: 5,
          createdAt: now,
          updatedAt: now,
        };
        db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
          .run('enterpriseProjects', JSON.stringify({ value: [personalProject] }), now);
        data.enterpriseProjects = [personalProject];
      }
      syncEnterpriseProjectSettings(db, data.enterpriseProjects, data.enterpriseProjectAssociations ?? {});
      await ensureEnterpriseProjectWorkspaces(db);
      if (_fileWatcher) {
        for (const project of listEnterpriseProjects(db)) {
          _fileWatcher.addWatch(getEnterpriseProjectRoot(project.id), 'project', project.id);
        }
      }
      return { ok: true, data };
    } catch { return { ok: true, data: { theme: 'professional', locale: 'zh-CN' } }; }
  });
  registerIpc('settings:update', async (_event, input: Record<string, unknown>) => {
    try {
      const now = new Date().toISOString();
      for (const [key, value] of Object.entries(input)) {
        const existing = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
        if (existing) {
          db.prepare('UPDATE settings SET value_json = ?, updated_at = ? WHERE key = ?').run(JSON.stringify({ value }), now, key);
        } else {
          db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify({ value }), now);
        }
      }
      const projects = Object.prototype.hasOwnProperty.call(input, 'enterpriseProjects')
        ? input.enterpriseProjects
        : readSettingValue('enterpriseProjects', []);
      const associations = Object.prototype.hasOwnProperty.call(input, 'enterpriseProjectAssociations')
        ? input.enterpriseProjectAssociations
        : readSettingValue('enterpriseProjectAssociations', {});
      syncEnterpriseProjectSettings(db, projects, associations);
      await ensureEnterpriseProjectWorkspaces(db);
      if (_fileWatcher) {
        for (const project of listEnterpriseProjects(db)) {
          _fileWatcher.addWatch(getEnterpriseProjectRoot(project.id), 'project', project.id);
        }
      }
      return { ok: true, data: undefined };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'DB_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('settings:saveSecret', async (_event, input: { kind: string; value: string }) => {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return { ok: false, requestId: '-', error: { code: 'SAFE_STORAGE_UNAVAILABLE', message: 'safeStorage 不可用', retryable: false } };
      }
      const ciphertext = safeStorage.encryptString(input.value);
      const ref = `secret-${input.kind}-${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      db.prepare('INSERT INTO secrets (id, kind, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(ref, input.kind, ciphertext, now, now);
      return { ok: true, data: { secretRef: ref } };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'SECRET_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('settings:deleteSecret', async (_event, input: { secretRef: string }) => {
    try {
      db.prepare('DELETE FROM secrets WHERE id = ?').run(input.secretRef);
      return { ok: true, data: undefined };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'DB_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('settings:exportDiagnostics', async () => {
    try {
      const os = require('node:os');
      const pkg = require('../../package.json');
      const totalMem = os.totalmem();
      const diag = {
        version: pkg?.version || '0.1.0',
        platform: os.platform(),
        release: os.release(),
        totalMem: `${(totalMem / 1024 / 1024 / 1024).toFixed(1)} GB`,
        workspaceRoot: getStudioRoot(),
        dbSize: 'N/A',
        agentCount: (db.prepare('SELECT COUNT(*) as c FROM agent_profiles').get() as { c: number })?.c ?? 0,
        modelProviderCount: (db.prepare('SELECT COUNT(*) as c FROM model_providers').get() as { c: number })?.c ?? 0,
        projectCount: (db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number })?.c ?? 0,
        exportedAt: new Date().toISOString(),
      };
      getLogger().info({ diagnostics: diag }, '诊断信息已导出');
      return { ok: true, data: diag };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'DIAG_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('settings:scanSecrets', async () => {
    try {
      const rootPath = getStudioRoot();
      const logDir = join(rootPath, '.kstudio', 'logs');
      const result = runKeyScan(db, logDir);
      return { ok: true, data: result };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'SCAN_ERROR', message: String(err), retryable: false } }; }
  });
  registerIpc('settings:listSkills', async () => {
    try {
      const skills = db.prepare(
        `SELECT p.id, p.name, p.description, NULL as promptMd, p.manifest_json as manifestJson,
                p.enabled, CASE WHEN p.source = 'built-in' THEN 1 ELSE 0 END as isBuiltin,
                b.agent_definition_id as agentDefinitionId
         FROM skill_packages p
         LEFT JOIN agent_definition_skills b ON b.skill_id = p.id AND b.skill_version = p.version
         ORDER BY p.source = 'built-in' DESC, b.agent_definition_id, b.ordinal, p.name`,
      ).all() as Array<{ id: string; name: string; description: string; promptMd: string | null; manifestJson: string; enabled: boolean; isBuiltin: boolean; agentDefinitionId: string | null }>;
      const data = skills.map((s) => ({
        ...s,
        requiredCapabilities: (() => {
          try { return (JSON.parse(s.manifestJson || '{}') as { requiredTools?: string[] }).requiredTools ?? []; } catch { return []; }
        })(),
      }));
      return { ok: true, data };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'SKILLS_ERROR', message: String(err), retryable: false } }; }
  });
  registerIpc('settings:setSkillEnabled', async (_event, input: { skillId: string; enabled: boolean }) => {
    try {
      db.transaction(() => {
        const enabled = input.enabled ? 1 : 0;
        const legacy = db.prepare('SELECT name FROM skills WHERE id = ? OR name = ?').get(input.skillId, input.skillId) as { name: string } | undefined;
        db.prepare('UPDATE skills SET enabled = ? WHERE id = ?').run(enabled, input.skillId);
        db.prepare('UPDATE skill_packages SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled, new Date().toISOString(), input.skillId);
        if (legacy) db.prepare('UPDATE skill_packages SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled, new Date().toISOString(), legacy.name);
      })();
      return { ok: true };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'DB_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('settings:listTools', async () => ({ ok: true, data: await listBuiltinTools(db) }));
  registerIpc('settings:setToolEnabled', async (_event, input: { toolId: string; enabled: boolean }) => {
    setBuiltinToolEnabled(db, input.toolId, input.enabled);
    return { ok: true };
  });
  registerIpc('settings:listMcpServers', async () => {
    try {
      const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get('mcp_servers') as { value_json: string } | undefined;
      const data = row ? (JSON.parse(row.value_json).value ?? []) : [];
      return { ok: true, data };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'DB_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('settings:addMcpServer', async (_event, input: { name: string; transport: string; command?: string; url?: string }) => {
    try {
      const now = new Date().toISOString();
      const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get('mcp_servers') as { value_json: string } | undefined;
      const servers: Array<{ id: string; name: string; transport: string; command?: string; url?: string; enabled: boolean; status: string }> = row ? (JSON.parse(row.value_json).value ?? []) : [];
      const newServer: { id: string; name: string; transport: string; command?: string; url?: string; enabled: boolean; status: string } = {
        id: `mcp-${randomUUID().slice(0, 8)}`,
        name: input.name,
        transport: input.transport,
        enabled: true,
        status: 'disconnected',
      };
      if (input.command) newServer.command = input.command;
      if (input.url) newServer.url = input.url;
      servers.push(newServer);
      db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
        .run('mcp_servers', JSON.stringify({ value: servers }), now);
      return { ok: true, data: newServer };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'DB_ERROR', message: String(err), retryable: true } }; }
  });
  registerIpc('settings:setMcpServerEnabled', async (_event, input: { serverId: string; enabled: boolean }) => {
    try {
      const now = new Date().toISOString();
      const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get('mcp_servers') as { value_json: string } | undefined;
      if (!row) return { ok: false };
      const servers = JSON.parse(row.value_json).value ?? [];
      const idx = servers.findIndex((s: any) => s.id === input.serverId);
      if (idx >= 0) {
        servers[idx].enabled = input.enabled;
        db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
          .run('mcp_servers', JSON.stringify({ value: servers }), now);
      }
      return { ok: true };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'DB_ERROR', message: String(err), retryable: true } }; }
  });

  // Team MCP Server 信息
  registerIpc('teamMcp:getInfo', async () => {
    const server = _mcpServer;
    if (!server || !server.isRunning) {
      return { ok: true, data: { running: false, port: 0, token: '' } };
    }
    return { ok: true, data: { running: true, port: server.portNumber, token: server.bearerToken } };
  });
};

const registerOperationIpc = (db: ReturnType<typeof getDatabase>): void => {
  const manager = (): OperationSkillManager => {
    if (!_operationSkillManager) throw new DatabaseError('WORKSPACE_NOT_READY', '操作技能服务尚未初始化');
    return _operationSkillManager;
  };
  const linkedProjectFor = (platformId: string, requestedProjectId?: string): string | undefined => {
    const linkedProjectId = resolveAssociatedEnterpriseProjectId(db, 'operation', assertProjectId(platformId));
    if (requestedProjectId && linkedProjectId !== requestedProjectId) {
      throw new DatabaseError('VALIDATION_FAILED', '当前操作平台未关联该项目，无法读取项目工作区');
    }
    return linkedProjectId ?? undefined;
  };
  registerIpc('operations:syncPlatform', async (_event, input: {
    id: string; name: string; url: string; description?: string; agentName?: string; modelProfileId?: string; temperature?: number;
  }) => ({ ok: true, data: manager().syncPlatform(input) }));
  registerIpc('operations:ensureWorkspace', async (_event, input: { platformId: string; projectId?: string }) => {
    const projectId = linkedProjectFor(input.platformId, input.projectId);
    return { ok: true, data: await manager().ensureWorkspace(input.platformId, projectId) };
  });
  registerIpc('operations:showView', async (event, input: { platformId: string; bounds: Electron.Rectangle }) => {
    const host = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    return { ok: true, data: manager().showView(input.platformId, input.bounds, host) };
  });
  registerIpc('operations:getBrowserNavigation', async (_event, input: { platformId: string }) => ({
    ok: true, data: manager().getBrowserNavigation(input.platformId),
  }));
  registerIpc('operations:goBack', async (_event, input: { platformId: string }) => ({
    ok: true, data: manager().goBack(input.platformId),
  }));
  registerIpc('operations:goForward', async (_event, input: { platformId: string }) => ({
    ok: true, data: manager().goForward(input.platformId),
  }));
  registerIpc('operations:getCaptureSourceId', async (event) => {
    const host = BrowserWindow.fromWebContents(event.sender);
    if (!host) throw new Error('无法获取当前桌面窗口');
    return { ok: true, data: { sourceId: host.getMediaSourceId() } };
  });
  registerIpc('operations:hideView', async (_event, input?: { platformId?: string }) => {
    manager().hideView(input?.platformId);
    return { ok: true };
  });
  registerIpc('operations:beginRecording', async (event, input: { platformId: string }) => {
    const host = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    return { ok: true, data: await manager().beginRecording(input.platformId, host) };
  });
  registerIpc('operations:pauseRecording', async (_event, input: { recordingId: string; paused: boolean }) => {
    manager().pauseRecording(input.recordingId, input.paused);
    return { ok: true };
  });
  registerIpc('operations:stopRecording', async (_event, input: { recordingId: string }) => ({ ok: true, data: await manager().stopRecording(input.recordingId) }));
  registerIpc('operations:saveRecordingVideo', async (_event, input: { recordingId: string; bytes?: Uint8Array }) => ({
    ok: true, data: await manager().saveRecordingVideo(input.recordingId, input.bytes),
  }));
  registerIpc('operations:learnSkill', async (_event, input: { platformId: string; recordingId: string; name: string; description: string }) => ({
    ok: true, data: await manager().learnSkill(input),
  }));
  registerIpc('operations:replyLearning', async (_event, input: { skillId: string; content: string }) => {
    await manager().replyLearning(input.skillId, input.content);
    return { ok: true };
  });
  registerIpc('operations:getLearningStatus', async (_event, input: { skillId: string }) => ({ ok: true, data: manager().getLearningStatus(input.skillId) }));
  registerIpc('operations:getSkillRecording', async (_event, input: { skillId: string }) => ({ ok: true, data: await manager().getSkillRecording(input.skillId) }));
  registerIpc('operations:activateSkill', async (_event, input: { skillId: string }) => {
    return { ok: true, data: await manager().activateSkill(input.skillId) };
  });
  registerIpc('operations:setSkillEnabled', async (_event, input: { skillId: string; enabled: boolean }) => {
    manager().setSkillEnabled(input.skillId, input.enabled);
    return { ok: true };
  });
  registerIpc('operations:deleteSkill', async (_event, input: { skillId: string }) => {
    await manager().deleteSkill(input.skillId);
    return { ok: true };
  });
  registerIpc('operations:abandonSkill', async (_event, input: { skillId: string }) => {
    manager().abandonSkill(input.skillId);
    return { ok: true };
  });
  registerIpc('operations:listSkills', async (_event, input: { platformId: string; includeRevoked?: boolean }) => ({
    ok: true, data: manager().listSkills(input.platformId, input.includeRevoked),
  }));
  registerIpc('operations:executeSkill', async (_event, input: { skillId: string; ownerAgentId: string; parameters?: Record<string, unknown> }) => ({
    ok: true, data: await manager().executeSkill(input),
  }));
  registerIpc('operations:runInstruction', async (_event, input: { platformId: string; instruction: string; projectId?: string }) => {
    const projectId = linkedProjectFor(input.platformId, input.projectId);
    return { ok: true, data: await manager().runInstruction({ platformId: input.platformId, instruction: input.instruction, ...(projectId ? { projectId } : {}) }) };
  });
  registerIpc('operations:listConversation', async (_event, input: { platformId: string; limit?: number }) => ({
    ok: true, data: manager().listConversation(input.platformId, input.limit),
  }));
  registerIpc('operations:getRun', async (_event, input: { runId: string }) => ({ ok: true, data: manager().getRun(input.runId) }));
  registerIpc('operations:listRuns', async (_event, input: { platformId: string; limit?: number }) => ({ ok: true, data: manager().listRuns(input.platformId, input.limit) }));
  registerIpc('operations:cancelRun', async (_event, input: { runId: string }) => {
    manager().cancelRun(input.runId);
    return { ok: true };
  });
  registerIpc('operations:revokePlatform', async (_event, input: { platformId: string }) => {
    manager().revokePlatform(input.platformId);
    return { ok: true };
  });
};

const registerChannelIpc = (db: ReturnType<typeof getDatabase>): void => {
  const mgr = new ChannelManager(db);
  _channelManager = mgr;
  const runRepo = new AgentRunRepository(db);

  mgr.onEvent((event) => {
    const win = BrowserWindow.getAllWindows()[0];
    getLogger().debug({ type: event.type, channelId: event.channelId, winExists: !!win }, 'channel:event forwarding to renderer');
    if (win && !win.isDestroyed()) {
      win.webContents.send('channel:event', event);
    }

    // Handle channel.message: enqueue a run in the scheduler
    if (event.type === 'channel.message' && _scheduler) {
      const data = event.data as {
        projectId: string;
        externalConversationId: string;
        externalUserId: string;
        text: string;
        externalEventId: string;
      };
      if (data.projectId && data.text) {
        const leaderInstance = db.prepare(
          `SELECT id FROM project_agent_instances WHERE project_id = ? AND role = 'leader' LIMIT 1`,
        ).get(data.projectId) as { id: string } | undefined;
        if (leaderInstance) {
          try {
            // Find the user message we just created (the most recent one for this project with matching text)
            const userMsg = db.prepare(
              `SELECT id FROM messages WHERE project_id = ? AND sender_type = 'user' ORDER BY created_at DESC LIMIT 1`,
            ).get(data.projectId) as { id: string } | undefined;
            const triggerMessageId = userMsg?.id ?? '';

            const run = runRepo.create({
              projectId: data.projectId,
              agentInstanceId: leaderInstance.id,
              requestedByType: 'user',
              requestedById: data.externalUserId,
              instruction: data.text,
              triggerMessageId,
              modelProfileSnapshotJson: buildModelProfileSnapshot(db, leaderInstance.id),
            });
            _scheduler.enqueue({ runId: run.id, projectId: data.projectId, agentInstanceId: leaderInstance.id, instruction: data.text, triggerMessageId });
          } catch (err) {
            getLogger()?.error({ err, projectId: data.projectId, channelId: event.channelId }, 'Failed to enqueue run for channel message');
          }
        }
      }
    }

    // Handle channel.stop: cancel active runs in the scheduler
    if (event.type === 'channel.stop' && _scheduler) {
      const data = event.data as { projectId: string; runIds: string[] };
      if (data.projectId) {
        _scheduler.cancelProject(data.projectId);
      }
    }
  });

  registerIpc('channels:list', async () => {
    const rows = db.prepare('SELECT id, type, name, enabled, status, config_json as configJson, secret_ref as secretRef, last_connected_at as lastConnectedAt, last_error as lastError FROM channels ORDER BY type, name').all();
    return { ok: true, data: rows.map((r: any) => ({ ...r, enabled: !!r.enabled, configJson: r.configJson ? JSON.parse(r.configJson) : {} })) };
  });
  registerIpc('channels:save', async (_event, input: { id?: string; type: string; name: string; config: Record<string, unknown>; secret?: string }) => {
    const now = new Date().toISOString();
    // Keep a usable fallback when Electron safeStorage is unavailable (portable/dev builds).
    // The normal path still stores secrets encrypted and strips them from config_json.
    const rawConfig = { ...(input.config || {}) } as Record<string, unknown>;
    const canEncrypt = safeStorage.isEncryptionAvailable();
    const configJson = JSON.stringify(input.secret && !canEncrypt
      ? { ...rawConfig, app_secret: input.secret }
      : rawConfig);
    let secretRef: string | null = null;

    // Handle secret storage via safeStorage
    if (input.secret && canEncrypt) {
      const ciphertext = safeStorage.encryptString(input.secret);
      secretRef = `ch-secret-${randomUUID().slice(0, 8)}`;
      // Check if channel already has a secret_ref to update
      if (input.id) {
        const existing = db.prepare('SELECT secret_ref FROM channels WHERE id = ?').get(input.id) as { secret_ref: string | null } | undefined;
        if (existing?.secret_ref) {
          // Delete old secret
          db.prepare('DELETE FROM secrets WHERE id = ?').run(existing.secret_ref);
        }
      }
      db.prepare('INSERT INTO secrets (id, kind, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(secretRef, input.type, ciphertext, now, now);
    }

    if (input.id) {
      if (secretRef) {
        db.prepare('UPDATE channels SET name = ?, type = ?, config_json = ?, secret_ref = ?, updated_at = ? WHERE id = ?').run(input.name, input.type, configJson, secretRef, now, input.id);
      } else {
        db.prepare('UPDATE channels SET name = ?, type = ?, config_json = ?, updated_at = ? WHERE id = ?').run(input.name, input.type, configJson, now, input.id);
      }
      return { ok: true, data: { id: input.id, type: input.type, name: input.name, enabled: false, status: 'disconnected', secretRef } };
    }
    // Upsert: check for existing channel with same type+name
    const existing = db.prepare('SELECT id FROM channels WHERE type = ? AND name = ?').get(input.type, input.name) as { id: string } | undefined;
    if (existing) {
      if (secretRef) {
        db.prepare('UPDATE channels SET config_json = ?, secret_ref = ?, updated_at = ? WHERE id = ?').run(configJson, secretRef, now, existing.id);
      } else {
        db.prepare('UPDATE channels SET config_json = ?, updated_at = ? WHERE id = ?').run(configJson, now, existing.id);
      }
      return { ok: true, data: { id: existing.id, type: input.type, name: input.name, enabled: false, status: 'disconnected', secretRef } };
    }
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    if (secretRef) {
      db.prepare('INSERT INTO channels (id, type, name, config_json, secret_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, input.type, input.name, configJson, secretRef, now, now);
    } else {
      db.prepare('INSERT INTO channels (id, type, name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, input.type, input.name, configJson, now, now);
    }
    return { ok: true, data: { id, type: input.type, name: input.name, enabled: false, status: 'disconnected', secretRef } };
  });
  registerIpc('channels:test', async (_event, input: { channelId: string }) => {
    try {
      const result = await mgr.test(input.channelId);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: true, data: { success: false, message: String(err) } };
    }
  });
  registerIpc('channels:setEnabled', async (_event, input: { channelId: string; enabled: boolean }) => {
    const now = new Date().toISOString();
    if (input.enabled) {
      const row = db.prepare('SELECT last_test_result FROM channels WHERE id = ?').get(input.channelId) as { last_test_result: string | null } | undefined;
      if (!row) return { ok: false, requestId: '-', error: { code: 'NOT_FOUND', message: '渠道不存在', retryable: false } };
      if (row.last_test_result !== 'success') return { ok: false, requestId: '-', error: { code: 'CHANNEL_NOT_TESTED', message: '渠道未通过测试，无法启用', retryable: false } };
      db.prepare('UPDATE channels SET enabled = ?, status = ?, updated_at = ? WHERE id = ?').run(1, 'connecting', now, input.channelId);
      mgr.start(input.channelId).catch((err) => {
        getLogger()?.error({ err, channelId: input.channelId }, 'Failed to start channel');
      });
    } else {
      db.prepare('UPDATE channels SET enabled = ?, status = ?, updated_at = ? WHERE id = ?').run(0, 'disconnected', now, input.channelId);
      mgr.stop(input.channelId).catch(() => {});
    }
    return { ok: true };
  });
  registerIpc('channels:delete', async (_event, input: { channelId: string }) => {
    const row = db.prepare('SELECT secret_ref, enabled FROM channels WHERE id = ?').get(input.channelId) as { secret_ref: string | null; enabled: number } | undefined;
    if (!row) return { ok: false, requestId: '-', error: { code: 'NOT_FOUND', message: '渠道不存在', retryable: false } };
    // Stop if running
    if (row.enabled) {
      mgr.stop(input.channelId).catch(() => {});
    }
    if (row.secret_ref) {
      db.prepare('DELETE FROM secrets WHERE id = ?').run(row.secret_ref);
    }
    db.prepare('DELETE FROM channel_bindings WHERE channel_id = ?').run(input.channelId);
    db.prepare('DELETE FROM channels WHERE id = ?').run(input.channelId);
    return { ok: true };
  });
  registerIpc('channels:listBindings', async (_event, input: { channelId?: string }) => {
    return { ok: true, data: mgr.listBindings(input?.channelId) };
  });
  registerIpc('channels:previewConversation', async (_event, input: { channelId: string; externalConversationId: string }) => {
    const result = await mgr.previewConversation(input.channelId, input.externalConversationId.trim());
    if (!result.ok) return { ok: false, requestId: '-', error: { code: 'PREVIEW_FAILED', message: result.error ?? '校验失败', retryable: false } };
    return { ok: true, data: result.data };
  });
  registerIpc('channels:bind', async (_event, input: { channelId: string; externalConversationId: string; projectId: string; force?: boolean }) => {
    const result = await mgr.bindConversation(input.channelId, input.externalConversationId.trim(), input.projectId, input.force === true);
    if (!result.ok) {
      return { ok: false, requestId: '-', error: { code: result.error?.code ?? 'BIND_FAILED', message: result.error?.message ?? '绑定失败', retryable: result.error?.retryable ?? false } };
    }
    return { ok: true, data: result.data };
  });
  registerIpc('channels:unbind', async (_event, input: { channelId: string; externalConversationId: string }) => {
    await mgr.unbindConversation(input.channelId, input.externalConversationId.trim());
    return { ok: true };
  });
};

const registerMissingIpc = (db: ReturnType<typeof getDatabase>): void => {
  ipcMain.on('debug:preload', (_event, ...args: unknown[]) => {
    getLogger().debug({ args }, 'debug:preload from renderer');
  });
  registerIpc('app:search', async (_event, input: { query: string; limit?: number }) => {
    const data = new SearchRepository(db).search(input.query, input.limit);
    return { ok: true, data };
  });
  registerIpc('app:openExternal', async (_event, input: { url: string }) => {
    if (isSafeExternalUrl(input.url)) { await shell.openExternal(input.url); return { ok: true }; }
    throw new DatabaseError('VALIDATION_FAILED', '不允许打开非 HTTPS 外部链接');
  });
  registerIpc('workspace:list', async () => ({ ok: true, data: [] }));
};

const isSafeExternalUrl = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

const createWindow = (): void => {
  const preloadPath = join(__dirname, '../preload/index.cjs');
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'resources', 'branding', 'kla-app-icon.png')
    : join(__dirname, '../../resources/branding/kla-app-icon.png');

  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    icon: iconPath,
    width: 1720,
    height: 1040,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    backgroundColor: '#f6fbf9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = window.webContents.getURL();
    try {
      const current = new URL(currentUrl);
      const target = new URL(targetUrl);
      if (current.protocol === target.protocol && current.origin === target.origin) return;
    } catch { /* reject malformed navigation below */ }
    event.preventDefault();
    if (isSafeExternalUrl(targetUrl)) void shell.openExternal(targetUrl);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
};

// 注册 app-file:// 自定义协议（必须在 app ready 前调用）
protocol.registerSchemesAsPrivileged([
  { scheme: 'app-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.setName(PRODUCT_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APPLICATION_ID);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

app.whenReady().then(async () => {
  const initialRoot = join(app.getPath('documents'), 'K_Studio');
  const logger = getLogger(initialRoot);

  const defaultRoot = initialRoot;
  if (existsSync(join(defaultRoot, '.kstudio', 'workspace.json'))) {
    const acquired = await tryAcquireLock(defaultRoot);
    if (acquired) setStudioRoot(defaultRoot);
  }

  let _dbInitialized = false;
  let _dbInitializationPromise: Promise<void> | null = null;
  let _db: ReturnType<typeof getDatabase> | null = null;
  const ensureDb = (): ReturnType<typeof getDatabase> => {
    if (!_db) {
      const dbPath = join(getStudioRoot(), '.kstudio', 'k_studio.db');
      runMigrations(dbPath);
      _db = getDatabase(dbPath);
      logger.info({ workspaceId: getStudioRoot(), dbPath }, '数据库已初始化');
    }
    return _db;
  };

  registerIpc('app:getVersion', () => PRODUCT_DISPLAY_VERSION);
  registerIpc('app:setFullscreen', (event, input: { enabled?: boolean; presentationType?: 'html' | 'pptx' }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('无法获取当前应用窗口');
    const enabled = input?.enabled === true;
    const existingHandler = fullscreenInputHandlers.get(event.sender);
    if (existingHandler) event.sender.removeListener('before-input-event', existingHandler);
    fullscreenInputHandlers.delete(event.sender);
    const onBeforeInput = (inputEvent: Electron.Event, keyboard: Electron.Input): void => {
      if (keyboard.type !== 'keyDown' || !window.isFullScreen()) return;
      if (keyboard.key === 'Escape') {
        inputEvent.preventDefault();
        window.setFullScreen(false);
        event.sender.send('app:fullscreenExit');
        return;
      }
      const navigationKey = keyboard.key === 'ArrowUp' || keyboard.key === 'Up' || keyboard.code === 'ArrowUp'
        ? 'ArrowUp'
        : keyboard.key === 'ArrowDown' || keyboard.key === 'Down' || keyboard.code === 'ArrowDown'
          ? 'ArrowDown'
          : null;
      if (input.presentationType === 'pptx' && navigationKey) {
        event.sender.send('app:presentationKey', { key: navigationKey });
      }
    };
    if (enabled) {
      fullscreenInputHandlers.set(event.sender, onBeforeInput);
      event.sender.on('before-input-event', onBeforeInput);
    }
    window.setFullScreen(enabled);
    return { ok: true, data: { fullscreen: enabled } };
  });
  // 操作/运营能力访问：在 Main 进程校验，密钥只从加密 secrets 表读取，避免硬编码到渲染端。
  // 未配置密钥时 fail-closed（不通过）。密钥由部署方通过 settings:saveSecret(kind='operations-access-key') 写入。
  registerIpc('app:verifyOperationsAccess', (_event, input: { key?: string }) => {
    const supplied = String(input?.key ?? '').trim();
    if (!supplied) return { ok: true, data: { granted: false } };
    let stored = '';
    try {
      const row = ensureDb().prepare(
        'SELECT ciphertext FROM secrets WHERE kind = ? ORDER BY updated_at DESC LIMIT 1',
      ).get('operations-access-key') as { ciphertext: Buffer | string } | undefined;
      if (row && safeStorage.isEncryptionAvailable()) {
        stored = safeStorage.decryptString(row.ciphertext as Buffer).trim();
      }
    } catch {
      stored = '';
    }
    return { ok: true, data: { granted: stored.length > 0 && supplied === stored } };
  });
  registerIpc('app:bootstrap', async () => ({
    ok: true,
    data: { studioInitialized: existsSync(join(getStudioRoot(), '.kstudio', 'workspace.json')), version: PRODUCT_DISPLAY_VERSION, workspacePath: getStudioRoot() },
  }));

  registerWorkspaceIpc(ensureDb);

  registerIpc('studio:getStatus', async () => {
    const markerPath = join(getStudioRoot(), '.kstudio', 'workspace.json');
    const initialized = existsSync(markerPath);
    let marker: { workspaceId?: string; schemaVersion?: number } = {};
    if (initialized) {
      try { marker = JSON.parse(await readFile(markerPath, 'utf8')); } catch { /* ignore */ }
    }
    return { ok: true, data: { initialized, workspaceId: marker.workspaceId ?? '', schemaVersion: marker.schemaVersion ?? 0, rootPath: getStudioRoot() } };
  });
  registerIpc('studio:chooseAndInitialize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0];
    win?.focus();
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择 K_Studio 工作区根目录' });
    if (result.canceled || result.filePaths.length === 0) return { ok: true, data: null };
    setStudioRoot(result.filePaths[0]!);
    const { workspaceId, isNew } = await ensureStudioWorkspace();
    const acquired = await tryAcquireLock(result.filePaths[0]!);
    if (!acquired) throw new DatabaseError('STUDIO_WORKSPACE_LOCKED', '工作区已被其他进程占用');
    return { ok: true, data: { workspaceId, isNew, rootPath: result.filePaths[0] } };
  });
  registerIpc('studio:chooseAndOpenExisting', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0];
    win?.focus();
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择已有 K_Studio 工作区' });
    if (result.canceled || result.filePaths.length === 0) return { ok: true, data: null };
    const markerPath = join(result.filePaths[0]!, '.kstudio', 'workspace.json');
    if (!existsSync(markerPath)) throw new DatabaseError('STUDIO_WORKSPACE_INVALID', '所选目录不是有效的 K_Studio 工作区');
    setStudioRoot(result.filePaths[0]!);
    const acquired = await tryAcquireLock(result.filePaths[0]!);
    if (!acquired) throw new DatabaseError('STUDIO_WORKSPACE_LOCKED', '工作区已被其他进程占用');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { workspaceId: string };
    return { ok: true, data: { workspaceId: marker.workspaceId, rootPath: result.filePaths[0]!, isNew: false } };
  });
  registerIpc('studio:validate', async () => {
    const markerPath = join(getStudioRoot(), '.kstudio', 'workspace.json');
    if (!existsSync(markerPath)) return { ok: true, data: { valid: false, reason: '未找到 workspace.json' } };
    return { ok: true, data: { valid: true } };
  });
  registerIpc('studio:migrate', async () => ({ ok: true, data: { success: true } }));
  registerIpc('studio:backup', async () => {
    const dbPath = join(getStudioRoot(), '.kstudio', 'k_studio.db');
    const backupDir = join(getStudioRoot(), '.kstudio', 'backups');
    const backupPath = backupDatabase(dbPath, backupDir);
    return { ok: true, data: { backupPath } };
  });
  registerIpc('studio:backupList', async () => {
    const backupDir = join(getStudioRoot(), '.kstudio', 'backups');
    const entries = await listBackups(backupDir);
    return { ok: true, data: { entries } };
  });
  registerIpc('studio:backupRestore', async (_event, input: { backupPath: string }) => {
    const dbPath = join(getStudioRoot(), '.kstudio', 'k_studio.db');
    await restoreDatabase(dbPath, input.backupPath);
    return { ok: true, data: { success: true } };
  });
  registerIpc('studio:backupDelete', async (_event, input: { filename: string }) => {
    const backupDir = join(getStudioRoot(), '.kstudio', 'backups');
    await deleteBackup(backupDir, input.filename);
    return { ok: true, data: { success: true } };
  });

  const delayedRegisters = async (): Promise<void> => {
    const db = ensureDb();
    // Existing K_Studio workspaces also receive newly shipped official definitions.
    // A partially copied definition should not prevent the rest of the runtime
    // IPC handlers from coming online.
    try {
      await installAgentDefinitions(getStudioRoot());
    } catch (error) {
      getLogger().warn({ err: error }, 'Agent definitions install skipped; preserving existing workspace files');
    }
    if (ensureBochaApiKey(db)) {
      getLogger().info({ configured: true }, 'Bocha web search is configured');
    }
    ensureOfficialModelDefaults(db);
    await seedDefaultProfiles(db);
    const activeProjectIds = db.prepare("SELECT id FROM projects WHERE status != 'archived'").all() as Array<{ id: string }>;
    await Promise.all(activeProjectIds.map((project) => ensureProjectAgentFiles(db, project.id)));
    getLogger().info({ projectCount: activeProjectIds.length }, 'AgentIdentity: 群聊公开协作职责已同步');
    void ensureProfileAgentDefinitions(db).then(
      (count) => getLogger().info({ count }, 'AgentIdentity: Profile Definition 已同步'),
      (err) => getLogger().warn({ err }, 'AgentIdentity: Profile Definition 同步失败'),
    );
    const skillRegistry = new SkillRegistry(db);
    skillRegistry.seedBuiltinSkills();
    await skillRegistry.syncFromWorkspace();
    const workflowRegistry = new WorkflowRegistry(db);
    workflowRegistry.seedBuiltinWorkflows();
    registerDraftIpc(db);
    registerProjectIpc(db);
    // 演示群聊使用独立、可恢复的状态机；仅按群聊名称命中，不改变通用调度链路。
    _assetDemoScript = new AssetDemoScript(db, () => BrowserWindow.getAllWindows()[0]);
    registerIpc('asset-demo:labelSaved', async (_event, input: { projectId: string }) => {
      if (!_assetDemoScript) return { ok: true, data: { accepted: false, completed: false } };
      return { ok: true, data: _assetDemoScript.markLabelSaved(String(input?.projectId ?? '')) };
    });
    registerIpc('asset-demo:reset', async (_event, input: { projectId: string }) => {
      if (!_assetDemoScript) return { ok: true, data: { accepted: false } };
      return { ok: true, data: _assetDemoScript.reset(String(input?.projectId ?? '')) };
    });
    await _assetDemoScript.resumePending();
    registerMessageIpc(db);
    registerFileIpc(db);
    registerAgentIpc(db);
    registerModelIpc(db);
    registerMemoryIpc(db);
    registerKnowledgeIpc(db);
    registerSettingsIpc(db);
    _operationSkillManager = new OperationSkillManager(
      db,
      () => _gateway,
      (payload) => {
        const [primaryWindow] = BrowserWindow.getAllWindows();
        if (primaryWindow) broadcastEvent(primaryWindow, payload);
      },
    );
    registerOperationIpc(db);
    registerChannelIpc(db);
    registerMissingIpc(db);
  };

  registerIpc('app:ensureStudio', async () => {
    const root = getStudioRoot();
    getLogger().info({ root }, 'app:ensureStudio called');
    const studioRoot = root;
    const markerPath = join(studioRoot, '.kstudio', 'workspace.json');
    getLogger().debug({ markerPath, exists: existsSync(markerPath) }, 'app:ensureStudio marker');
    if (!existsSync(markerPath)) throw new DatabaseError('STUDIO_WORKSPACE_INVALID', 'K_Studio 尚未初始化');
    if (!_dbInitialized) {
      if (!_dbInitializationPromise) {
        _dbInitializationPromise = (async () => {
      getLogger().info({}, 'Initializing delayed registers');
      await delayedRegisters();
      _dbInitialized = true;
      const db = ensureDb();
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        _gateway = new ModelGateway(db as never);
        const toolRegistry = new ToolRegistry(db);
        const executor = createAgentExecutor(db, win, _gateway, undefined, toolRegistry, _operationSkillManager ?? undefined);
        _scheduler = new Scheduler(db, executor);
        executor.setScheduler(_scheduler);
        registerProjectTools(toolRegistry, db, _scheduler, _gateway);

        // 启动 Team MCP Server
        const mcpServer = new TeamMcpServer(toolRegistry, { role: 'external-cli', projectId: '', runId: '' });
        mcpServer.start().then((info) => {
          getLogger().info({ port: info.port }, 'Team MCP Server started');
        }).catch((err) => {
          getLogger().warn({ err }, 'Team MCP Server start failed');
        });
        _mcpServer = mcpServer;

        // Channel reply: when a run completes, send the result back to the external channel
        executor.onRunCompleted((_runId, projectId, resultMessageId, triggerMessageId) => {
          if (!_channelManager) return;
          try {
            // Get the agent's reply text from the result message
            const resultMsg = db.prepare(
              `SELECT content_json FROM messages WHERE id = ?`,
            ).get(resultMessageId) as { content_json: string } | undefined;
            if (!resultMsg) return;

            const content = JSON.parse(resultMsg.content_json);
            const text = typeof content.text === 'string' ? content.text : '';

            // Get the trigger message (user's original message) for channel context
            const triggerMsg = db.prepare(
              `SELECT content_json FROM messages WHERE id = ?`,
            ).get(triggerMessageId) as { content_json: string } | undefined;
            if (!triggerMsg) return;

            const triggerContent = JSON.parse(triggerMsg.content_json);
            const channelId = triggerContent.channelId as string | undefined;
            const externalConversationId = triggerContent.externalConversationId as string | undefined;
            if (channelId && externalConversationId && text) {
              _channelManager.send(channelId, { conversationId: externalConversationId }, { text }).catch(() => {});
            }
          } catch { /* ignore */ }
        });
        const recoveredCount = _scheduler.recoverInterruptedRuns();
        if (recoveredCount > 0) {
          logger?.info({ recoveredCount }, '应用启动: 已完成未完成 Run 恢复');
        }
        const recoveredIngestionCount = recoverInterruptedKnowledgeIngestions(db);
        if (recoveredIngestionCount > 0) {
          logger?.info({ recoveredIngestionCount }, '应用启动：已中断失去执行进程的知识入库任务');
        }
      }
      const memoryCleanup = startMemoryCleanup(db);
      app.on('before-quit', () => { memoryCleanup(); });
      ensureProjectWorkspace({ projectId: 'annual-finance', name: '年度财务报销审核' }).catch((err) => { logger?.warn({ err }, '种子项目目录创建失败'); });

      if (_channelManager) {
        _channelManager.startAll();
      }

      const watcher = new FileWatcher(db);
      await ensureEnterpriseProjectWorkspaces(db);
      const allProjects = new ProjectRepository(db).list();
      const groupRoots = allProjects.map((p: { id: string }) => ({ projectId: p.id, rootPath: getProjectRoot(p.id) }));
      const enterpriseProjectRoots = listEnterpriseProjects(db).map((p) => ({ projectId: p.id, rootPath: getEnterpriseProjectRoot(p.id) }));
      const projectRoots = [...groupRoots, ...enterpriseProjectRoots];
      watcher.start(studioRoot, projectRoots);
      _fileWatcher = watcher;
        })().catch((error) => {
          _dbInitializationPromise = null;
          throw error;
        });
      }
      await _dbInitializationPromise;
    }
    return { ok: true, data: { studioRoot } };
  });

  // 注册 app-file:// 只读协议（在窗口加载前完成注册）
  registerAppFileProtocol(() => _db);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('before-quit', async () => {
    _channelManager?.stopAll();
    _operationSkillManager?.dispose();
    await _neutralMcpRelay?.stop();
    await releaseLock(getStudioRoot());
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
