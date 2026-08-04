import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { access, copyFile, lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { CodexCliAdapter, VersionEvidence } from '@kunqing/agent-core';
import { cliAgentRegistry } from './cli-agent-registry';
import { cliExecutor } from './cli-executor';
import { agentConnectionService } from './agent-connection-service';
import { ChannelManager } from './channel-manager';
import { runKeyScan } from './key-scanner';
import { checkVersionCompatibility } from './version-compatibility';
import { getDatabase, runMigrations, backupDatabase, restoreDatabase, listBackups, deleteBackup } from './db';
import { getLogger } from './logger';
import { getProjectRoot, getStudioRoot, setStudioRoot } from './paths';
import { addProjectAgents, createProject, safeFileName, seedDefaultProfiles, buildModelProfileSnapshot, ensureProjectAgentFiles } from './project-creator';
import { processMessageMentions } from './message-router';
import { normalizeAgentMessageContent, sanitizeAgentDisplayText } from './agent-collaboration';
import { ContextBuilder } from './context-builder';
import { SkillRegistry } from './skill-registry';
import { FileWatcher } from './file-watcher';
import { startMemoryCleanup } from './memory-cleanup';
import { MemoryManager as ConversationMemoryManager } from './memory-manager';
import { ModelGateway } from './model-gateway';
import { Scheduler } from './scheduler';
import { createAgentExecutor } from './agent-executor';
import { createPipelineContext } from './knowledge-pipeline-adapter';
import { runIngestionPipeline } from '@kunqing/knowledge-core';
import { registerAppFileProtocol } from './app-file-protocol';
import { TeamMcpServer } from './team-mcp-server';
import { ToolRegistry } from './tool-registry';
import { registerProjectTools } from './agent-tools';
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

type WorkspaceRequest = { projectId: string; relativePath?: string; scopeType?: 'project' | 'shared' };
type EnsureProjectRequest = { projectId: string; name: string };
type CreateFolderRequest = WorkspaceRequest & { name: string };

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_BATCH_BYTES = 500 * 1024 * 1024;

let _fileWatcher: FileWatcher | null = null;
let _scheduler: Scheduler | null = null;
let _gateway: ModelGateway | null = null;
let _channelManager: ChannelManager | null = null;
let _mcpServer: TeamMcpServer | null = null;

const getScopeRoot = async (input: { projectId: string; scopeType?: 'project' | 'shared' }): Promise<string> => {
  if (input.scopeType === 'shared') return join(getStudioRoot(), 'shared-knowledge', 'original-files');
  return getOriginalFilesRoot(input.projectId);
};
const getGraphRoot = (input: { projectId: string; scopeType?: 'project' | 'shared' }): string => {
  if (input.scopeType === 'shared') return join(getStudioRoot(), 'shared-knowledge');
  return getProjectRoot(input.projectId);
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

const ORCHESTRATOR_IDENTITY = `---
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
  - document-ingestion
  - entity-relation-extraction
  - provenance-validation
  - wiki-materialization
  - graph-projection
tools:
  - knowledge.search
  - knowledge.ingest
  - memory.writeOwn
memoryPolicy:
  shortTermTtlHours: 72
  longTermWrite: candidate-then-commit
`;

const KNOWLEDGE_IDENTITY = `---
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
tools:
  - knowledge.search
  - workspace.search
  - memory.writeOwn
memoryPolicy:
  shortTermTtlHours: 72
  longTermWrite: candidate-then-commit
`;

const RESEARCHER_IDENTITY = `---
schemaVersion: 1
definitionId: builtin.researcher
definitionVersion: 1.0.0
role: teammate
---

# 身份

你是当前群聊的资料调研智能体，负责信息检索、资料分析和事实核查。
`;

const installAgentDefinitions = async (root: string): Promise<void> => {
  const orchestratorDir = join(root, 'agent-definitions', 'built-in', 'builtin.orchestrator', '1.0.0');
  const knowledgeDir = join(root, 'agent-definitions', 'built-in', 'builtin.knowledge-manager', '1.0.0');
  const researcherDir = join(root, 'agent-definitions', 'built-in', 'builtin.researcher', '1.0.0');
  await mkdir(orchestratorDir, { recursive: true });
  await mkdir(knowledgeDir, { recursive: true });
  await mkdir(researcherDir, { recursive: true });

  // agent.yaml + IDENTITY
  await writeIfMissing(join(orchestratorDir, 'agent.yaml'), ORCHESTRATOR_DEF);
  await writeIfMissing(join(orchestratorDir, 'IDENTITY.template.md'), ORCHESTRATOR_IDENTITY);
  await writeIfMissing(join(knowledgeDir, 'agent.yaml'), KNOWLEDGE_DEF);
  await writeIfMissing(join(knowledgeDir, 'IDENTITY.template.md'), KNOWLEDGE_IDENTITY);
  await writeIfMissing(join(researcherDir, 'agent.yaml'), RESEARCHER_DEF);
  await writeIfMissing(join(researcherDir, 'IDENTITY.template.md'), RESEARCHER_IDENTITY);

  // prompts/system.md
  const orchPromptDir = join(orchestratorDir, 'prompts');
  const kmPromptDir = join(knowledgeDir, 'prompts');
  await mkdir(orchPromptDir, { recursive: true });
  await mkdir(kmPromptDir, { recursive: true });
  await writeIfMissing(join(orchPromptDir, 'system.md'), '你是统筹智能体 (Orchestrator)，一个多智能体系统的协调者。\n\n## 职责\n- 分析用户指令，判断是否需要动用子智能体（如知识管理员）\n- 如果用户询问项目知识、文档内容、搜索信息，回复 "NEED_KM" 作为第一行\n- 如果用户询问日常对话、代码编写、一般问题，直接回复\n- 收集子智能体的结果并进行汇总\n\n## 回复格式\n使用 Markdown 格式输出。');
  await writeIfMissing(join(kmPromptDir, 'system.md'), '你是知识管理员 (Knowledge Manager)。你负责管理项目知识库。\n\n## 可用工具\n- knowledge:search - 搜索知识库文档\n- workspace:readFile - 读取工作区文件\n- project:search - 跨项目搜索\n- knowledge:listGraph - 列出知识图谱\n- list_project_agents - 列出项目智能体\n- publish_artifact - 发布成果文件\n\n## 输出\n基于获取的信息，给出准确的回答。如果信息不足，明确告知用户。');

  // orchestrator skills
  const orchSkillsDir = join(orchestratorDir, 'skills');
  const teamSkillDir = join(orchSkillsDir, 'team-planning');
  const resultSkillDir = join(orchSkillsDir, 'result-synthesis');
  await mkdir(teamSkillDir, { recursive: true });
  await mkdir(resultSkillDir, { recursive: true });
  await writeIfMissing(join(teamSkillDir, 'SKILL.md'), '## 团队规划 (Team Planning)\n\n作为统筹智能体，你的核心职责是：\n1. 分析用户输入，判断是否需要动用子智能体\n2. 如果需要知识管理相关能力，明确回复 "NEED_KM" 作为首行\n3. 对于不需要子智能体的任务，直接规划回答策略\n4. 对复杂任务进行步骤拆解');
  await writeIfMissing(join(resultSkillDir, 'SKILL.md'), '## 结果汇总 (Result Synthesis)\n\n当收到子智能体的返回结果后：\n1. 仔细阅读子智能体的输出内容\n2. 提取关键信息，进行归纳总结\n3. 用清晰的结构化 Markdown 呈现最终回答\n4. 注明信息来源（如来自知识库查询）');

  // knowledge-manager skills
  const kmSkillsDir = join(knowledgeDir, 'skills');
  for (const skillId of ['document-ingestion', 'entity-relation-extraction', 'provenance-validation', 'wiki-materialization', 'graph-projection']) {
    const d = join(kmSkillsDir, skillId);
    await mkdir(d, { recursive: true });
  }
  await writeIfMissing(join(kmSkillsDir, 'document-ingestion', 'SKILL.md'), '## 文档导入 (Document Ingestion)\n\n负责将上传的文件解析为可处理的文本：\n1. 检查文件格式和大小\n2. 调用解析器提取文本内容\n3. 对过长文档进行分块处理\n4. 保存原始文件引用');
  await writeIfMissing(join(kmSkillsDir, 'entity-relation-extraction', 'SKILL.md'), '## 实体关系抽取 (Entity & Relation Extraction)\n\n从文档内容中提取结构化知识：\n1. 识别关键实体（人物、组织、概念、术语等）\n2. 抽取实体之间的关系\n3. 为每个实体和关系标注置信度\n4. 低置信度候选手动复核');
  await writeIfMissing(join(kmSkillsDir, 'provenance-validation', 'SKILL.md'), '## 来源溯源 (Provenance Validation)\n\n确保每个知识片段都有清晰来源：\n1. 记录每个实体/关系对应的原始文档位置\n2. 过滤低置信度（<0.65）的候选\n3. 将待复核候选写入 review 目录\n4. 支持来源回溯查询');
  await writeIfMissing(join(kmSkillsDir, 'wiki-materialization', 'SKILL.md'), '## Wiki 页面生成 (Wiki Materialization)\n\n基于知识图谱生成人类可读的 Wiki 页面：\n1. 为每个重要实体生成 Wiki 条目\n2. 包含实体摘要、关联关系和相关来源\n3. 使用 Markdown 格式输出\n4. 保存到工作区的 wiki 目录');
  await writeIfMissing(join(kmSkillsDir, 'graph-projection', 'SKILL.md'), '## 图谱可视化 (Graph Projection)\n\n生成适合前端渲染的图谱投影数据：\n1. 导出所有节点和边\n2. 为每个节点添加 label 和分组信息\n3. 生成 force-graph 格式的 JSON\n4. 保存到 knowledge/projection 目录');

  // researcher resources
  const resPromptDir = join(researcherDir, 'prompts');
  await mkdir(resPromptDir, { recursive: true });
  await writeIfMissing(join(resPromptDir, 'system.md'), '你是资料调研智能体，负责根据指令搜索知识库、分析信息并输出结构化调研报告。\n\n## 输出格式\n1. **调研摘要** — 关键发现概述\n2. **信息来源** — 引用来源 ID 和内容摘要\n3. **详细分析** — 按主题组织的信息\n4. **置信度评估** — 每个结论的可靠性标注\n\n## 限制\n- 不确定时明确告知而不是猜测');
  const resSkillsDir = join(researcherDir, 'skills');
  await mkdir(join(resSkillsDir, 'information-retrieval'), { recursive: true });
  await mkdir(join(resSkillsDir, 'source-analysis'), { recursive: true });
  await writeIfMissing(join(resSkillsDir, 'information-retrieval', 'SKILL.md'), '## 信息检索\n\n根据查询从知识库检索相关信息，对结果进行过滤和排序。');
  await writeIfMissing(join(resSkillsDir, 'source-analysis', 'SKILL.md'), '## 来源分析\n\n评估知识条目的可靠性和相关性，交叉验证多个来源的一致性。');
  await mkdir(join(researcherDir, 'evals'), { recursive: true });
  await writeIfMissing(join(researcherDir, 'evals', 'cases.yaml'), 'cases:\n  - id: research-basic-query\n    instruction: "搜索关于财务报销流程的信息"');

  // evals
  await mkdir(join(orchestratorDir, 'evals'), { recursive: true });
  await mkdir(join(knowledgeDir, 'evals'), { recursive: true });
  await writeIfMissing(join(orchestratorDir, 'evals', 'cases.yaml'), 'cases:\n  - name: direct-answer\n    input: "你好，今天天气怎么样？"\n    expected:\n      intent: "answer"\n      needsKM: false\n  - name: delegate-to-km\n    input: "帮我查一下项目文档中关于数据库设计的内容"\n    expected:\n      intent: "delegate"\n      needsKM: true');
  await writeIfMissing(join(knowledgeDir, 'evals', 'cases.yaml'), 'cases:\n  - name: document-ingestion\n    input: "上传一份 PDF 文档到知识库"\n    expected:\n      action: "ingest"\n  - name: graph-query\n    input: "列出项目中的知识图谱"\n    expected:\n      action: "query"');
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
    mkdir(join(root, 'group-chats'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'original-files'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'knowledge', 'graph'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'knowledge', 'wiki'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'graph-visualization'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', '.runtime', 'trash'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', '.runtime', 'versions'), { recursive: true }),
  ]);
  let workspaceId: string;
  if (isNew) {
    workspaceId = randomUUID();
    await writeFile(markerPath, JSON.stringify({ schemaVersion: 1, workspaceId, product: 'K_Studio', createdAt: new Date().toISOString() }, null, 2));
    await installAgentDefinitions(root);
  } else {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { workspaceId: string };
    workspaceId = marker.workspaceId;
  }
  return { workspaceId, isNew };
};

const ensureProjectWorkspace = async ({ projectId, name }: EnsureProjectRequest): Promise<string> => {
  await ensureStudioWorkspace();
  const projectRoot = getProjectRoot(projectId);
  await Promise.all([
    mkdir(join(projectRoot, 'agent-identities'), { recursive: true }),
    mkdir(join(projectRoot, 'agent-memories'), { recursive: true }),
    mkdir(join(projectRoot, 'original-files'), { recursive: true }),
    mkdir(join(projectRoot, 'knowledge', 'graph'), { recursive: true }),
    mkdir(join(projectRoot, 'knowledge', 'wiki'), { recursive: true }),
    mkdir(join(projectRoot, 'knowledge', 'review'), { recursive: true }),
    mkdir(join(projectRoot, 'graph-visualization', 'layouts'), { recursive: true }),
    mkdir(join(projectRoot, 'graph-visualization', 'exports'), { recursive: true }),
    mkdir(join(projectRoot, 'outputs'), { recursive: true }),
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

const registerWorkspaceIpc = (): void => {
  registerIpc('workspace:ensureProject', async (_event, input: EnsureProjectRequest) => {
    const root = await ensureProjectWorkspace(input);
    if (_fileWatcher) _fileWatcher.addWatch(getProjectRoot(input.projectId), 'project', input.projectId);
    return { ok: true };
  });

  registerIpc('workspace:openItem', async (_event, input: WorkspaceRequest) => {
    const root = await getOriginalFilesRoot(input.projectId);
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
    const st = input.scopeType ?? 'project';
    const scopeRoot = await getScopeRoot(input);
    let target: string;
    try {
      target = resolveInside(scopeRoot, input.relativePath);
      await access(target);
    } catch {
      if (st === 'project') {
        target = resolveInside(getProjectRoot(input.projectId), input.relativePath);
      } else {
        // For shared scope, only the scope root is valid
        throw new DatabaseError('NOT_FOUND', '文件不存在');
      }
    }
    await assertNoSymlink(target);
    const message = await shell.openPath(target);
    if (message) throw new Error(message);
    return { ok: true };
  });
};

const knowledgeIngestForFile = (db: ReturnType<typeof getDatabase>, fileId: string): unknown => {
  const fileRepo = new FileRepository(db);
  const file = fileRepo.getById(fileId);
  if (!file) return null;
  if (file.type !== 'file') return null;
  const repo = new KnowledgeRepository(db);
  const existing = file.currentVersionId ? repo.getSourceByFileAndVersion(fileId, file.currentVersionId) : repo.getSourceByFile(fileId);
  if (existing) {
    if (existing.status === 'ready') return existing;
    if (existing.status !== 'error') return existing;
    repo.setSourceStatus(existing.id, 'pending');
    const oldJob = repo.getJob(existing.id);
    if (oldJob) repo.setJobStatus(oldJob.id, 'queued');
    return existing;
  }
  const sourceInput: { scopeType: string; scopeId: string; fileId: string; versionId?: string } = {
    scopeType: file.scopeType,
    scopeId: file.scopeId,
    fileId: file.id,
  };
  if (file.currentVersionId) sourceInput.versionId = file.currentVersionId;
  const source = repo.createSource(sourceInput);
  const job = repo.createJob({ scopeType: file.scopeType, scopeId: file.scopeId, sourceId: source.id });
  repo.setSourceStatus(source.id, 'ingesting');
  repo.setJobStatus(job.id, 'running', { stage: 'parsing' });

  // Run the real ingestion pipeline asynchronously
  if (_gateway) {
    const root = file.scopeType === 'shared'
      ? join(getStudioRoot(), 'shared-knowledge', 'original-files')
      : getProjectRoot(file.scopeId);
    const fileNode = fileRepo.getById(fileId);
    if (fileNode) {
      const filePath = resolveInside(root, fileNode.normalizedPath);
      const ctx = createPipelineContext(db, _gateway, filePath, source.id, file.scopeType, file.scopeId);
      runIngestionPipeline(ctx).catch((err: unknown) => {
        getLogger().error({ err, fileId, sourceId: source.id }, '知识入库流水线异常');
      });
    }
  }

  return { source, job };
};

const registerFileIpc = (db: ReturnType<typeof getDatabase>): void => {
  const fileRepo = new FileRepository(db);

  registerIpc('workspace:listFiles', async (_event, input: WorkspaceRequest) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const directory = resolveInside(root, input.relativePath);
    await assertNoSymlink(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const result = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry) => {
      const entryPath = join(directory, entry.name);
      const info = await lstat(entryPath);
      const relativePath = join(normalizeRelativePath(input.relativePath), entry.name).replaceAll('\\', '/');
      const dbRow = entry.isDirectory() ? null : fileRepo.getByPath(st, sid, relativePath);
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
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const targetDirectory = resolveInside(root, input.relativePath);
    await assertNoSymlink(targetDirectory);
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { title: '导入到群聊用户原始文件', properties: ['openFile', 'multiSelections'] };
    const selection = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options);
    if (selection.canceled) return { cancelled: true, importedCount: 0 };
    const sources = await Promise.all(selection.filePaths.map(async (sourcePath) => ({ sourcePath, info: await lstat(sourcePath) })));
    if (sources.some(({ info }) => !info.isFile() || info.isSymbolicLink())) throw new DatabaseError('VALIDATION_FAILED', '只能导入普通文件');
    if (sources.some(({ info }) => info.size > MAX_FILE_BYTES)) throw new DatabaseError('VALIDATION_FAILED', '单个文件不能超过 100 MB');
    if (sources.reduce((total, { info }) => total + info.size, 0) > MAX_BATCH_BYTES) throw new DatabaseError('VALIDATION_FAILED', '单次导入总量不能超过 500 MB');
    const importedFileIds: string[] = [];
    for (const { sourcePath } of sources) {
      const destName = basename(sourcePath);
      const destination = await nextAvailablePath(targetDirectory, destName);
      await copyFile(sourcePath, destination);
      const storageRelPath = join('.runtime', 'versions', basename(destination));
      const { createHash } = await import('node:crypto');
      const { readFile: rf } = await import('node:fs/promises');
      const buf = await rf(destination);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const normalizedPath = join(normalizeRelativePath(input.relativePath), destName).replaceAll('\\', '/');
      const existing = fileRepo.getByPath(st, sid, normalizedPath);
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
        importedFileIds.push(existing.id);
      } else {
        const parentPath = normalizeRelativePath(input.relativePath);
        const file = fileRepo.create({
          scopeType: st,
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
        importedFileIds.push(file.id);
      }
    }
    importedFileIds.forEach((fid) => knowledgeIngestForFile(db, fid));
    return { cancelled: false, importedCount: sources.length };
  });

  registerIpc('workspace:createFolder', async (_event, input: CreateFolderRequest) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const parent = resolveInside(root, input.relativePath);
    await assertNoSymlink(parent);
    await mkdir(join(parent, validateFolderName(input.name)), { recursive: false });
    const parentPath = normalizeRelativePath(input.relativePath);
    const normalizedPath = join(parentPath, input.name).replaceAll('\\', '/');
    if (!fileRepo.existsByPath(st, sid, normalizedPath)) {
      fileRepo.create({
        scopeType: st,
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

  registerIpc('workspace:rename', async (_event, input: { projectId: string; relativePath: string; name: string; scopeType?: 'project' | 'shared' }) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const oldPath = resolveInside(root, input.relativePath);
    await assertNoSymlink(oldPath);
    const safeName = safeFileName(input.name);
    const newPath = join(dirname(oldPath), safeName);
    let conflict = false;
    try { await access(newPath); conflict = true; } catch { /* ok */ }
    if (conflict) return { ok: false, error: '目标文件或文件夹已存在' };
    await rename(oldPath, newPath);
    const oldNorm = normalizeRelativePath(input.relativePath);
    const newNorm = join(dirname(oldNorm), safeName).replaceAll('\\', '/');
    const file = fileRepo.getByPath(st, sid, oldNorm);
    if (file) {
      if (file.type === 'directory') {
        const children = db.prepare(
          "SELECT id, normalized_path FROM files WHERE scope_type = ? AND scope_id = ? AND normalized_path LIKE ?",
        ).all(st, sid, `${oldNorm}/%`) as { id: string; normalized_path: string }[];
        for (const child of children) {
          fileRepo.update(child.id, { normalizedPath: child.normalized_path.replace(oldNorm, newNorm) });
        }
      }
      fileRepo.update(file.id, { name: safeName, normalizedPath: newNorm });
    }
    return { ok: true };
  });

  registerIpc('workspace:move', async (_event, input: { projectId: string; sourcePaths: string[]; targetDir: string; scopeType?: 'project' | 'shared' }) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const targetNorm = normalizeRelativePath(input.targetDir);
    const targetPath = resolveInside(root, input.targetDir);
    await assertNoSymlink(targetPath);
    for (const src of input.sourcePaths) {
      const sourcePath = resolveInside(root, src);
      await assertNoSymlink(sourcePath);
      const safeName = safeFileName(basename(sourcePath));
      const destPath = join(targetPath, safeName);
      let conflict = false;
      try { await access(destPath); conflict = true; } catch { /* ok */ }
      if (conflict) return { ok: false, error: `目标已存在: ${safeName}` };
      await rename(sourcePath, destPath);
      const srcNorm = normalizeRelativePath(src);
      const destNorm = join(targetNorm, safeName).replaceAll('\\', '/');
      const file = fileRepo.getByPath(st, sid, srcNorm);
      if (file) {
        if (file.type === 'directory') {
          const children = db.prepare(
            "SELECT id, normalized_path FROM files WHERE scope_type = ? AND scope_id = ? AND normalized_path LIKE ?",
          ).all(st, sid, `${srcNorm}/%`) as { id: string; normalized_path: string }[];
          for (const child of children) {
            fileRepo.update(child.id, { normalizedPath: child.normalized_path.replace(srcNorm, destNorm) });
          }
        }
        fileRepo.update(file.id, { name: safeName, normalizedPath: destNorm });
      }
    }
    return { ok: true };
  });

  registerIpc('workspace:softDelete', async (_event, input: { projectId: string; paths: string[]; scopeType?: 'project' | 'shared' }) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const trashDir = join(root, '.runtime', 'trash');
    await mkdir(trashDir, { recursive: true });
    for (const src of input.paths) {
      const sourcePath = resolveInside(root, src);
      await assertNoSymlink(sourcePath);
      const ts = Date.now();
      const safeName = safeFileName(basename(sourcePath));
      const trashTarget = join(trashDir, `${ts}-${safeName}`);
      await rename(sourcePath, trashTarget);
      const norm = normalizeRelativePath(src);
      const file = fileRepo.getByPath(st, sid, norm);
      if (file) {
        if (file.type === 'directory') {
          const children = db.prepare(
            "SELECT id FROM files WHERE scope_type = ? AND scope_id = ? AND normalized_path LIKE ?",
          ).all(st, sid, `${norm}/%`) as { id: string }[];
          for (const child of children) fileRepo.softDelete(child.id);
        }
        fileRepo.softDelete(file.id);
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
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const normalizedInputPath = normalizeRelativePath(input.relativePath).replaceAll('\\', '/');
    const systemDirectories = ['agent-identities', 'agent-memories', 'knowledge', 'graph-visualization', 'outputs'];
    const isProjectSystemFile = st === 'project'
      && systemDirectories.some((directory) => normalizedInputPath === directory || normalizedInputPath.startsWith(`${directory}/`));
    const root = isProjectSystemFile ? getProjectRoot(input.projectId) : await getScopeRoot(input);
    const target = resolveInside(root, normalizedInputPath);
    await assertNoSymlink(target);
    const info = await lstat(target);
    if (!info.isFile()) return { ok: true, data: null };
    if (info.size > MAX_FILE_BYTES) return { ok: true, data: { error: '文件超出预览大小限制' } };
    const dbRow = fileRepo.getByPath(st, sid, normalizedInputPath);
    const fileId = dbRow?.id;
    const versionId = dbRow?.currentVersionId;
    const ext = basename(target).toLowerCase().split('.').pop() ?? '';
    const textExts = ['txt', 'md', 'json', 'csv', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sh', 'bat', 'ps1', 'py', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'svg'];
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'];
    if (textExts.includes(ext)) {
      const MAX_TEXT_BYTES = 10 * 1024 * 1024;
      let content = await readFile(target, { encoding: 'utf8', flag: 'r' });
      if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) return { ok: true, data: { error: '文本文件超出预览大小限制' } };
      if (ext === 'html' || ext === 'htm') {
        const appFileUrl = fileId ? `app-file://preview/${fileId}/${encodeURIComponent(basename(target))}` : undefined;
        return { ok: true, data: { kind: 'html' as const, content, appFileUrl, fileName: basename(target), size: info.size, fileId, versionId } };
      }
      return { ok: true, data: { kind: 'text' as const, content, mimeType: ext === 'md' ? 'text/markdown' : 'text/plain', fileName: basename(target), size: info.size, fileId, versionId } };
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
      const appFileUrl = fileId ? `app-file://file/${fileId}` : `app-file://version/${versionId}`;
      return { ok: true, data: { kind: 'pdf' as const, appFileUrl, fileName: basename(target), size: info.size, fileId, versionId } };
    }
    return { ok: true, data: { kind: 'unknown' as const, fileName: basename(target), size: info.size, mimeType: '', fileId, versionId } };
  });

  registerIpc('workspace:listSystemDirs', async (_event, input: { projectId: string }) => {
    const projectRoot = getProjectRoot(input.projectId);
    const systemDirs = [
      { name: '智能体身份', physicalName: 'agent-identities' },
      { name: '智能体记忆', physicalName: 'agent-memories' },
      { name: '原始文件', physicalName: 'original-files' },
      { name: '知识', physicalName: 'knowledge' },
      { name: '图谱可视化', physicalName: 'graph-visualization' },
      { name: '成果', physicalName: 'outputs' },
    ];
    const entries = [];
    for (const dir of systemDirs) {
      try {
        await access(join(projectRoot, dir.physicalName));
        entries.push({
          name: dir.name,
          physicalName: dir.physicalName,
          relativePath: dir.physicalName,
          kind: 'directory' as const,
          system: true,
          size: 0,
          modifiedAt: new Date().toISOString(),
        });
      } catch {
        // skip if directory doesn't exist yet
      }
    }
    return { ok: true, data: entries };
  });

  registerIpc('workspace:listProjectDir', async (_event, input: { projectId: string; relativePath: string }) => {
    const projectRoot = getProjectRoot(input.projectId);
    const directory = resolveInside(projectRoot, input.relativePath);
    await assertNoSymlink(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const result = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry) => {
      const entryPath = join(directory, entry.name);
      const info = await lstat(entryPath);
      return {
        name: entry.name,
        physicalName: entry.name,
        relativePath: join(input.relativePath, entry.name).replaceAll('\\', '/'),
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
  registerIpc('projects:list', async (_event, input: { status?: string; limit?: number; offset?: number }) => {
    const data = projectRepo.list(input.status, input.limit ?? 50, input.offset ?? 0);
    return { ok: true, data };
  });
  registerIpc('projects:create', async (event, input: { idempotencyKey: string; content: { schemaVersion?: number; text?: string; mentions?: unknown[]; stagedUploadIds?: string[] }; templateId?: string; requestedAgentProfileIds: string[] }) => {
    const result = await createProject(db, {
      idempotencyKey: input.idempotencyKey,
      content: input.content,
      ...(input.templateId ? { templateId: input.templateId } : {}),
      requestedAgentProfileIds: input.requestedAgentProfileIds,
    });
    if (result.ok && result.data?.id && _fileWatcher) {
      _fileWatcher.addWatch(getProjectRoot(result.data.id as string), 'project', result.data.id as string);
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
    const data = runs.map((run) => {
      const agent = db.prepare(
        `SELECT ap.name FROM project_agent_instances pai JOIN agent_profiles ap ON ap.id = pai.agent_profile_id WHERE pai.id = ?`,
      ).get(run.agentInstanceId) as { name: string } | undefined;
      const runEvents = runRepo.listEvents(run.id);
      const traces = runEvents
        .filter((event) => event.type === 'run.trace' && event.payloadJson)
        .map((event) => {
          try { return JSON.parse(event.payloadJson!) as Record<string, unknown>; } catch { return null; }
        })
        .filter((event): event is Record<string, unknown> => event !== null)
        .map((event) => ({
          ...event,
          ...(typeof event.title === 'string' ? { title: sanitizeAgentDisplayText(db, input.projectId, event.title) } : {}),
          ...(typeof event.detail === 'string' ? { detail: sanitizeAgentDisplayText(db, input.projectId, event.detail) } : {}),
        }));
      const checklistEvent = [...runEvents].reverse().find((event) => event.type === 'run.checklist' && event.payloadJson);
      const businessProcessEvent = [...runEvents].reverse().find((event) => event.type === 'run.business-process' && event.payloadJson);
      const anchorEvent = [...runEvents].reverse().find((event) => event.type === 'run.anchor' && event.payloadJson);
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
              ...(typeof row.title === 'string' ? { title: sanitizeAgentDisplayText(db, input.projectId, row.title) } : {}),
              ...(typeof row.detail === 'string' ? { detail: sanitizeAgentDisplayText(db, input.projectId, row.detail) } : {}),
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
        agentName: agent?.name ?? '智能体',
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
  registerIpc('messages:send', async (_event, input: { idempotencyKey: string; projectId: string; content: { text?: string; mentions?: Array<{ target: { scope: string; id: string } }> } }) => {
    const confirmedContentJson = normalizeAgentMessageContent(
      db,
      input.projectId,
      JSON.stringify(input.content),
      [],
      'local-user',
    );
    const confirmedContent = JSON.parse(confirmedContentJson) as typeof input.content;
    const data = messageRepo.createUserMessage(input.projectId, confirmedContentJson);
    if (input.content.text) {
      await conversationMemory.applyUserDirective(input.projectId, input.content.text, data.id);
    }
    if (_scheduler) {
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
  registerIpc('agents:listDefinitions', async () => {
    const data = db.prepare('SELECT id, version, kind, is_builtin as isBuiltin, installed_at as installedAt FROM agent_definitions ORDER BY id').all();
    return { ok: true, data };
  });
  registerIpc('agents:listProfiles', async () => {
    const data = db.prepare(
      `SELECT ap.id, ap.name, ap.definition_id as definitionId, ap.runtime_mode as runtimeMode,
              ap.enabled, ap.delegatable, ap.cli_connection_id as cliConnectionId,
              cc.name as cliConnectionName, cc.adapter_type as adapterType
       FROM agent_profiles ap
       LEFT JOIN cli_connections cc ON cc.id = ap.cli_connection_id
       ORDER BY ap.name`,
    ).all();
    return { ok: true, data: data.map((r: any) => ({ ...r, enabled: !!r.enabled, delegatable: !!r.delegatable })) };
  });
  registerIpc('agents:getProjectInstances', async (_event, input: { projectId: string }) => {
    await ensureProjectAgentFiles(db, input.projectId);
    const data = db.prepare(
      `SELECT pai.id, pai.project_id as projectId, ap.name as agentName, pai.role, pai.runtime_mode as runtimeMode
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.project_id = ? ORDER BY pai.ordinal`,
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
    db.prepare(`INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, cli_connection_id, enabled, delegatable, is_system_default, created_at, updated_at) VALUES (?, ?, ?, '1.0.0', 'external-cli', ?, 1, 1, 0, ?, ?)`)
      .run(profileId, input.name, `custom.${input.adapterType}`, id, now, now);
    return { ok: true, data: { id, name: input.name, adapterType: input.adapterType, executablePath: input.executablePath, status } };
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
  registerIpc('agents:updateProfileModel', async (_event, input: { profileId: string; modelProfileId: string }) => {
    db.prepare('UPDATE agent_profiles SET model_profile_id = ?, updated_at = ? WHERE id = ?').run(input.modelProfileId, new Date().toISOString(), input.profileId);
    return { ok: true };
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
  registerIpc('models:listProviders', async () => {
    const data = db.prepare('SELECT id, name, type, base_url as baseUrl, status FROM model_providers ORDER BY name').all();
    return { ok: true, data };
  });
  registerIpc('models:listProfiles', async () => {
    const data = db.prepare(
      `SELECT mp.id, mp.name, mp.provider_id as providerId, mp.model_id as modelId, mp.model_slot as modelSlot, mp.enabled,
              prv.name as providerName, prv.type as providerType
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
  registerIpc('models:saveProfile', async (_event, input: { id?: string; name: string; providerId: string; modelId: string; modelSlot?: string }) => {
    const repo = new ModelProfileRepository(db);
    let profileId: string;
    if (input.id) {
      const changes: Record<string, unknown> = { name: input.name, providerId: input.providerId, modelId: input.modelId };
      if (input.modelSlot !== undefined) changes.modelSlot = input.modelSlot;
      repo.update(input.id, changes as Parameters<typeof repo.update>[1]);
      profileId = input.id;
    } else {
      const row = repo.create({ name: input.name, providerId: input.providerId, modelId: input.modelId, modelSlot: input.modelSlot } as never);
      profileId = row.id;
    }
    // 同步更新 model_slot_bindings 表，确保 ModelGateway 能正确解析槽位
    if (input.modelSlot) {
      db.prepare('INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)').run(input.modelSlot, profileId, new Date().toISOString());
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
    return { ok: true };
  });
  registerIpc('models:deleteProvider', async (_event, input: { id: string }) => {
    db.prepare('DELETE FROM model_slot_bindings WHERE model_profile_id IN (SELECT id FROM model_profiles WHERE provider_id = ?)').run(input.id);
    db.prepare('DELETE FROM model_profiles WHERE provider_id = ?').run(input.id);
    new ModelProviderRepository(db).delete(input.id);
    return { ok: true };
  });
  registerIpc('models:setSlot', async (_event, input: { slot: string; modelProfileId: string }) => {
    db.prepare('INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)').run(input.slot, input.modelProfileId, new Date().toISOString());
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

const registerKnowledgeIpc = (db: ReturnType<typeof getDatabase>): void => {
  const repo = new KnowledgeRepository(db);
  const sharedEnabled = (projectId: string): boolean => {
    return Boolean(projectId);
  };
  registerIpc('knowledge:listJobs', async (_event, input: { scopeType?: string; scopeId?: string; status?: string; projectId?: string }) => {
    if (input.scopeType === 'shared' && input.projectId && !sharedEnabled(input.projectId)) return { ok: true, data: [] };
    const data = repo.listJobs(input.scopeType, input.scopeId, input.status);
    return { ok: true, data };
  });
  registerIpc('knowledge:ingest', async (_event, input: { fileId: string }) => {
    const result = knowledgeIngestForFile(db, input.fileId);
    return { ok: true, data: result };
  });
  registerIpc('knowledge:retryJob', async (_event, input: { jobId: string }) => {
    const job = repo.getJob(input.jobId);
    if (!job) return { ok: true, data: null };
    repo.setJobStatus(job.id, 'queued');
    repo.setSourceStatus(job.sourceId, 'pending');
    return { ok: true, data: repo.getJob(job.id) };
  });
  registerIpc('knowledge:search', async (_event, input: { query: string; projectId?: string; scopeType?: string; scopeId?: string; limit?: number }) => {
    const data = repo.search(input.query, input.scopeType, input.scopeId, input.limit ?? 50);
    return { ok: true, data };
  });
  registerIpc('knowledge:getGraph', async (_event, input: { scopeType: string; scopeId: string; projectId?: string }) => {
    if (input.scopeType === 'shared' && input.projectId && !sharedEnabled(input.projectId)) return { ok: true, data: { nodes: [], edges: [] } };
    const data = repo.getGraph(input.scopeType, input.scopeId);
    return { ok: true, data };
  });
  registerIpc('knowledge:getSourceDetail', async (_event, input: { fileId: string }) => {
    const detail = repo.getSourceDetail(input.fileId);
    return { ok: true, data: detail };
  });
  registerIpc('knowledge:getGraphProjection', async (_event, input: { scopeType: string; scopeId: string; projectId: string; scopeType2?: 'project' | 'shared' }) => {
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
  registerIpc('wiki:list', async (_event, input: { scopeType: string; scopeId: string; projectId: string }) => {
    if (input.scopeType === 'shared' && !sharedEnabled(input.projectId)) return { ok: true, data: [] };
    const data = wri.list(input.scopeType, input.scopeId);
    return { ok: true, data };
  });
  registerIpc('wiki:get', async (_event, input: { scopeType: string; scopeId: string; slug: string; projectId?: string }) => {
    if (input.scopeType === 'shared' && input.projectId && !sharedEnabled(input.projectId)) return { ok: true, data: null };
    const data = wri.getBySlug(input.scopeType, input.scopeId, input.slug);
    return { ok: true, data };
  });
};

const registerSettingsIpc = (db: ReturnType<typeof getDatabase>): void => {
  registerIpc('settings:getAll', async () => {
    try {
      const rows = db.prepare('SELECT key, value_json as v FROM settings').all() as Array<{ key: string; v: string }>;
      const data: Record<string, unknown> = { theme: 'system', locale: 'zh-CN' };
      for (const row of rows) {
        try { data[row.key] = JSON.parse(row.v).value; } catch { /* skip malformed */ }
      }
      return { ok: true, data };
    } catch { return { ok: true, data: { theme: 'system', locale: 'zh-CN' } }; }
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
        `SELECT s.id, s.name, s.description, s.prompt_md as promptMd,
                s.required_capabilities_json as requiredCapabilitiesJson,
                s.enabled, s.is_builtin as isBuiltin,
                a.agent_definition_id as agentDefinitionId
         FROM skills s
         LEFT JOIN agent_skills a ON a.skill_id = s.id
         ORDER BY a.ordinal`,
      ).all() as Array<{ id: string; name: string; description: string; promptMd: string | null; requiredCapabilitiesJson: string; enabled: boolean; isBuiltin: boolean; agentDefinitionId: string | null }>;
      const data = skills.map((s) => ({
        ...s,
        requiredCapabilities: JSON.parse(s.requiredCapabilitiesJson || '[]'),
      }));
      return { ok: true, data };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'SKILLS_ERROR', message: String(err), retryable: false } }; }
  });
  registerIpc('settings:setSkillEnabled', async (_event, input: { skillId: string; enabled: boolean }) => {
    try {
      db.prepare('UPDATE skills SET enabled = ? WHERE id = ?').run(input.enabled ? 1 : 0, input.skillId);
      return { ok: true };
    } catch (err) { return { ok: false, requestId: '-', error: { code: 'DB_ERROR', message: String(err), retryable: true } }; }
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
    const configJson = JSON.stringify(input.config || {});
    let secretRef: string | null = null;

    // Handle secret storage via safeStorage
    if (input.secret && safeStorage.isEncryptionAvailable()) {
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

  const window = new BrowserWindow({
    width: 1720,
    height: 1040,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    backgroundColor: '#f9f9fe',
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

  registerIpc('app:getVersion', () => app.getVersion());
  registerIpc('app:bootstrap', async () => ({
    ok: true,
    data: { studioInitialized: existsSync(join(getStudioRoot(), '.kstudio', 'workspace.json')), version: app.getVersion(), workspacePath: getStudioRoot() },
  }));

  registerWorkspaceIpc();

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

  const delayedRegisters = (): void => {
    const db = ensureDb();
    seedDefaultProfiles(db);
    const skillRegistry = new SkillRegistry(db);
    skillRegistry.seedBuiltinSkills();
    registerDraftIpc(db);
    registerProjectIpc(db);
    registerMessageIpc(db);
    registerFileIpc(db);
    registerAgentIpc(db);
    registerModelIpc(db);
    registerMemoryIpc(db);
    registerKnowledgeIpc(db);
    registerSettingsIpc(db);
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
      getLogger().info({}, 'Initializing delayed registers');
      delayedRegisters();
      _dbInitialized = true;
      const db = ensureDb();
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        _gateway = new ModelGateway(db as never);
        const toolRegistry = new ToolRegistry(db);
        const executor = createAgentExecutor(db, win, _gateway, undefined, toolRegistry);
        _scheduler = new Scheduler(db, executor);
        executor.setScheduler(_scheduler);
        registerProjectTools(toolRegistry, db, _scheduler);

        // 启动 Team MCP Server
        const mcpServer = new TeamMcpServer(toolRegistry, { role: 'external-cli', projectId: '', runId: '' });
        mcpServer.start().then((info) => {
          getLogger().info({ port: info.port }, 'Team MCP Server started');
        }).catch((err) => {
          getLogger().warn({ err }, 'Team MCP Server start failed');
        });
        _mcpServer = mcpServer;

        // Channel reply: when a run completes, send the result back to the external channel
        executor.onRunCompleted((_runId, projectId, resultMessageId) => {
          if (!_channelManager) return;
          try {
            // Check if the result message was triggered by a channel message
            const triggerMsg = db.prepare(
              `SELECT content_json FROM messages WHERE id = ?`,
            ).get(resultMessageId) as { content_json: string } | undefined;
            if (!triggerMsg) return;

            const content = JSON.parse(triggerMsg.content_json);
            const text = typeof content.text === 'string' ? content.text : '';

            // Find the user message that triggered this run (for channel context)
            const userMsg = db.prepare(
              `SELECT content_json FROM messages WHERE project_id = ? AND sender_type = 'user' ORDER BY created_at DESC LIMIT 1`,
            ).get(projectId) as { content_json: string } | undefined;
            if (!userMsg) return;

            const userContent = JSON.parse(userMsg.content_json);
            const channelId = userContent.channelId as string | undefined;
            const externalConversationId = userContent.externalConversationId as string | undefined;
            if (channelId && externalConversationId && text) {
              _channelManager.send(channelId, { conversationId: externalConversationId }, { text }).catch(() => {});
            }
          } catch { /* ignore */ }
        });
        const recoveredCount = _scheduler.recoverInterruptedRuns();
        if (recoveredCount > 0) {
          logger?.info({ recoveredCount }, '应用启动: 已完成未完成 Run 恢复');
        }
      }
      const memoryCleanup = startMemoryCleanup(db);
      app.on('before-quit', () => { memoryCleanup(); });
      ensureProjectWorkspace({ projectId: 'annual-finance', name: '年度财务报销审核' }).catch((err) => { logger?.warn({ err }, '种子项目目录创建失败'); });

      if (_channelManager) {
        _channelManager.startAll();
      }

      const watcher = new FileWatcher(db);
      watcher.onIngest = (fileId) => {
        try {
          knowledgeIngestForFile(db, fileId);
        } catch (err) {
          getLogger().error({ err, fileId }, 'Watcher 触发的知识入库失败');
        }
      };
      const allProjects = new ProjectRepository(db).list();
      const projectRoots = allProjects.map((p: { id: string }) => ({ projectId: p.id, rootPath: getProjectRoot(p.id) }));
      watcher.start(studioRoot, projectRoots);
      _fileWatcher = watcher;
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
    await releaseLock(getStudioRoot());
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
