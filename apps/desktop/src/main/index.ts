import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { access, copyFile, cp, lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
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
import { ingestKnowledgeFile, prepareKnowledgeIngestion } from './knowledge-ingestion';
import { recoverInterruptedKnowledgeIngestions, refreshKnowledgeBeforeSearch } from './knowledge-sync';
import { registerAppFileProtocol } from './app-file-protocol';
import { TeamMcpServer } from './team-mcp-server';
import { ToolRegistry } from './tool-registry';
import { registerProjectTools } from './agent-tools';
import { searchHybridKnowledge } from './hybrid-knowledge-search';
import { listBuiltinTools, setBuiltinToolEnabled } from './builtin-tool-catalog';
import { ensureBochaApiKey } from './bocha-web-search';
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

const ORCHESTRATOR_IDENTITY = `---
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
  - retrieve-knowledge
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
schemaVersion: 2
scope: definition
definitionId: builtin.knowledge-manager
definitionVersion: 1.0.0
---

# 身份

你是知识管理智能体，负责文档入库、实体关系提取、图谱构建、Wiki 生成，以及任务完成后的知识与经验归集。
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

const RESEARCHER_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.researcher
definitionVersion: 1.0.0
---

# 身份

你是资料调研智能体，负责信息检索、资料分析、来源评估和事实核查。明确区分事实、推断与未知信息，保留可核验来源，不得用猜测填补资料缺口。你直接完成负责人交给你的调研工作，不把任务转给知识管理智能体；只有被具体资料依赖阻塞时才请求其他成员。
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
  - document-authoring
tools:
  - skill.search
  - skill.load
  - workspace.read
  - review.writeDraft
  - memory.writeOwn
memoryPolicy:
  shortTermTtlHours: 72
  longTermWrite: candidate-then-commit
`;

const MATERIAL_WRITER_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.material-writer
definitionVersion: 1.0.0
---

# 身份

你是材料编写智能体，负责把已经取得的知识证据、调研结果和写作要求整理为完整材料。先列文档框架，再逐章节补充并统一校对；有模板说明时必须遵循，没有模板时再根据用途自行设计。你只提交待审稿，不得在验收通过前发布最终成果。
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
  - workspace.read
  - memory.writeOwn
memoryPolicy:
  shortTermTtlHours: 72
  longTermWrite: candidate-then-commit
`;

const ACCEPTANCE_REVIEWER_IDENTITY = `---
schemaVersion: 2
scope: definition
definitionId: builtin.acceptance-reviewer
definitionVersion: 1.0.0
---

# 身份

你是验收智能体，负责独立阅读材料待审稿，并使用当前群聊知识库证据核验需求覆盖、模板符合性、事实与数据真实性、来源可追溯性及文件完整性。存在变造、遗漏或无依据内容时必须判定不通过并提出明确返修项；全部关键项通过后才能允许统筹智能体发布成果。
`;

const ORCHESTRATOR_DEFINITION_PROMPT = `你是统筹管理智能体。核心职责是先从多轮对话中还原用户的完整目标，再转化为面向具体成员的可验收工作包，根据群聊成员的真实能力和依赖关系完成委派、等待、验收与汇总。

遇到“上面、这个、继续、修改、发出文件”等表达时必须继承此前的主题、范围、修订要求和已有结果，不得把最后一句孤立处理或直接作为知识检索 query。用户要求整理或梳理成文件但未指定格式时，默认交付一个 HTML 文件并在群聊发送；不粘贴源码，不发送临时文件。

你不得把用户原始需求不加拆解地转发给成员，也不得虚构未发生的委派、进度或成员结果。默认每次只安排当前一个步骤；只有完全独立、互不依赖对方输入或结果的步骤才可以并行。存在依赖时必须等上游成功或失败后再决定下游；下游依赖多个上游时等全部返回；成员继续委派产生的分支也必须完整返回。知识检索、公开调研、材料编写和验收都是按任务选择的能力，不是固定链路；成员失败后要根据剩余缺口换人、换来源、降级或亲自补齐，直到形成真实交付。正式群聊消息应使用自然的同事口吻，只在需要协作、关键节点、用户决策或最终交付时发送。`;

const LEGACY_ORCHESTRATOR_DEFINITION_PROMPT = '你是统筹智能体 (Orchestrator)，一个多智能体系统的协调者。\n\n## 职责\n- 分析用户指令，判断是否需要动用子智能体（如知识管理员）\n- 如果用户询问项目知识、文档内容、搜索信息，回复 "NEED_KM" 作为第一行\n- 如果用户询问日常对话、代码编写、一般问题，直接回复\n- 收集子智能体的结果并进行汇总\n\n## 回复格式\n使用 Markdown 格式输出。';

const KNOWLEDGE_DEFINITION_PROMPT = `你是知识管理智能体。你只处理当前群聊允许访问的资料、成果与知识库内容，输出必须保留来源和可验证关系。

原始文件新增、变化、删除或需要重新入库时使用 process-knowledge-files；基于知识库回答、核验或查找证据时使用 retrieve-knowledge。检索必须优先使用本地证据，不得把模型常识伪装成知识库内容。

任务完成后的知识归集应区分可复用知识、一次性任务记录和业务流程。只有确实存在可复用业务步骤时才输出业务流程，不得把智能体思考或运行轨迹当作业务流程。`;

const LEGACY_KNOWLEDGE_DEFINITION_PROMPT = '你是知识管理员 (Knowledge Manager)。你负责管理项目知识库。\n\n## 可用工具\n- knowledge:search - 搜索知识库文档\n- workspace:readFile - 读取工作区文件\n- project:search - 跨项目搜索\n- knowledge:listGraph - 列出知识图谱\n- list_project_agents - 列出项目智能体\n- publish_artifact - 发布成果文件\n\n## 输出\n基于获取的信息，给出准确的回答。如果信息不足，明确告知用户。';

const RESEARCHER_DEFINITION_PROMPT = `你是资料调研智能体。围绕负责人交给你的具体问题检索与分析资料，区分事实、推断和未知信息，并为重要结论提供可核验来源。资料不足时明确说明缺口，不得编造引用。需要公开网络资料时，先按需加载 web-search 技能并调用 web:search；网页资料必须保留 URL，不得把网页摘要伪装成本地知识。统筹负责人负责全局拆解和委派；你应先完成自己的调研，不要把任务转给知识管理智能体，只有被具体资料依赖阻塞时才正式 @ 请求对应成员。`;

const LEGACY_RESEARCHER_DEFINITION_PROMPT = '你是资料调研智能体，负责根据指令搜索知识库、分析信息并输出结构化调研报告。\n\n## 输出格式\n1. **调研摘要** — 关键发现概述\n2. **信息来源** — 引用来源 ID 和内容摘要\n3. **详细分析** — 按主题组织的信息\n4. **置信度评估** — 每个结论的可靠性标注\n\n## 限制\n- 不确定时明确告知而不是猜测';

const MATERIAL_WRITER_DEFINITION_PROMPT = `你是材料编写智能体。依据统筹提供的完整任务、知识证据、调研结果和模板说明，先设计章节框架，再逐章完成内容并统一校对。模板存在时必须遵循；没有模板时才自行设计。事实和数字不得超出证据。完整 HTML 待审稿只能通过 review.writeDraft 写入指定的 .runtime/review-drafts/ 路径，不得写入 outputs/ 或提前发布。返修时逐项处理验收意见。`;

const ACCEPTANCE_REVIEWER_DEFINITION_PROMPT = `你是验收智能体。读取指定待审稿，使用知识检索和来源溯源技能核对完整需求、模板、关键事实、数字、制度条款、引用、内部一致性与 HTML 完整性。证据不足、存在变造或遗漏时明确判定不通过并列出可执行返修项；全部关键项通过时才判定通过。回复最后必须单独写“验收结论：通过”或“验收结论：不通过”。你不能修改或发布文件。`;

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
  }
  const orchestratorDir = join(root, 'agent-definitions', 'built-in', 'builtin.orchestrator', '1.0.0');
  const knowledgeDir = join(root, 'agent-definitions', 'built-in', 'builtin.knowledge-manager', '1.0.0');
  const researcherDir = join(root, 'agent-definitions', 'built-in', 'builtin.researcher', '1.0.0');
  const materialWriterDir = join(root, 'agent-definitions', 'built-in', 'builtin.material-writer', '1.0.0');
  const acceptanceReviewerDir = join(root, 'agent-definitions', 'built-in', 'builtin.acceptance-reviewer', '1.0.0');
  await mkdir(orchestratorDir, { recursive: true });
  await mkdir(knowledgeDir, { recursive: true });
  await mkdir(researcherDir, { recursive: true });
  await mkdir(materialWriterDir, { recursive: true });
  await mkdir(acceptanceReviewerDir, { recursive: true });

  // agent.yaml + IDENTITY
  await writeIfMissing(join(orchestratorDir, 'agent.yaml'), ORCHESTRATOR_DEF);
  await writeManagedDefinitionFile(join(orchestratorDir, 'IDENTITY.template.md'), ORCHESTRATOR_IDENTITY, LEGACY_ORCHESTRATOR_IDENTITY);
  await writeIfMissing(join(knowledgeDir, 'agent.yaml'), KNOWLEDGE_DEF);
  await writeManagedDefinitionFile(join(knowledgeDir, 'IDENTITY.template.md'), KNOWLEDGE_IDENTITY, LEGACY_KNOWLEDGE_IDENTITY);
  await writeIfMissing(join(researcherDir, 'agent.yaml'), RESEARCHER_DEF);
  await writeManagedDefinitionFile(join(researcherDir, 'IDENTITY.template.md'), RESEARCHER_IDENTITY, LEGACY_RESEARCHER_IDENTITY);
  await writeIfMissing(join(materialWriterDir, 'agent.yaml'), MATERIAL_WRITER_DEF);
  await writeIfMissing(join(materialWriterDir, 'IDENTITY.template.md'), MATERIAL_WRITER_IDENTITY);
  await writeIfMissing(join(acceptanceReviewerDir, 'agent.yaml'), ACCEPTANCE_REVIEWER_DEF);
  await writeIfMissing(join(acceptanceReviewerDir, 'IDENTITY.template.md'), ACCEPTANCE_REVIEWER_IDENTITY);

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
  await writeManagedDefinitionFile(join(orchPromptDir, 'system.md'), ORCHESTRATOR_DEFINITION_PROMPT, LEGACY_ORCHESTRATOR_DEFINITION_PROMPT);
  await writeManagedDefinitionFile(join(kmPromptDir, 'system.md'), KNOWLEDGE_DEFINITION_PROMPT, LEGACY_KNOWLEDGE_DEFINITION_PROMPT);
  await writeManagedDefinitionFile(join(resPromptDir, 'system.md'), RESEARCHER_DEFINITION_PROMPT, LEGACY_RESEARCHER_DEFINITION_PROMPT);
  await writeIfMissing(join(writerPromptDir, 'system.md'), MATERIAL_WRITER_DEFINITION_PROMPT);
  await writeIfMissing(join(reviewerPromptDir, 'system.md'), ACCEPTANCE_REVIEWER_DEFINITION_PROMPT);

  // orchestrator skills
  const orchSkillsDir = join(orchestratorDir, 'skills');
  const teamSkillDir = join(orchSkillsDir, 'team-planning');
  const resultSkillDir = join(orchSkillsDir, 'result-synthesis');
  await mkdir(teamSkillDir, { recursive: true });
  await mkdir(resultSkillDir, { recursive: true });
  await writeIfMissing(join(teamSkillDir, 'SKILL.md'), '---\nname: team-planning\ndescription: 从完整的多轮业务目标拆出可验收工作包并选择合适成员；用于统筹智能体规划复杂协作任务。\n---\n\n# 团队规划\n\n1. 先还原多轮对话中的完整目标、交付物和约束，不把最后一句孤立处理。\n2. 默认一次只安排一个当前可执行步骤；只有完全独立的步骤才并行，并为同批步骤标记同一个 parallelGroup。\n3. 为每个步骤标记 stepId 和 dependsOn；有前置依赖时等上游成功或失败后再决定下游，成员自行转交的协作分支也算上游。\n4. 按能力拆分面向具体成员的工作包，不原样转发用户需求。\n5. 选择合适成员并通过正式群聊消息委派。\n6. 等待结果、检查缺口并继续调度。\n7. 整理或梳理成文件且未指定格式时，默认生成并发送正式 HTML 成果文件，不发送源码或临时文件。\n8. 当前成员没有能力完成必要步骤时，由统筹智能体使用可用工具亲自补齐并真实发布成果。');
  await writeIfMissing(join(resultSkillDir, 'SKILL.md'), '---\nname: result-synthesis\ndescription: 核对并汇总多个成员的结果形成统一交付；用于统筹智能体收口复杂任务。\n---\n\n# 结果汇总\n\n1. 按用户的完整多轮需求核对各工作包。\n2. 消除冲突和重复，缺失内容返回调度补齐。\n3. 优先把正式成果文件作为群聊附件发送，再给出简洁结论。\n4. 不发送 HTML 源码、临时文件或内部提示词。');

  // knowledge-manager skills
  const kmSkillsDir = join(knowledgeDir, 'skills');
  for (const skillId of ['process-knowledge-files', 'retrieve-knowledge', 'document-ingestion', 'entity-relation-extraction', 'provenance-validation', 'wiki-materialization', 'graph-projection']) {
    const d = join(kmSkillsDir, skillId);
    await mkdir(d, { recursive: true });
  }
  await writeIfMissing(join(kmSkillsDir, 'document-ingestion', 'SKILL.md'), '---\nname: document-ingestion\ndescription: 解析群聊文件、按语义切片并保留来源位置；用于文档进入知识库时。\n---\n\n# 文档导入\n\n检查文件后提取正文，按语义边界切片、去重，并保存原始文件与位置引用。');
  await writeIfMissing(join(kmSkillsDir, 'entity-relation-extraction', 'SKILL.md'), '---\nname: entity-relation-extraction\ndescription: 从资料中抽取带置信度和来源的实体关系；用于构建或更新知识图谱。\n---\n\n# 实体关系抽取\n\n识别实体和关系，附带置信度、来源片段和待复核标记。');
  await writeIfMissing(join(kmSkillsDir, 'provenance-validation', 'SKILL.md'), '---\nname: provenance-validation\ndescription: 核验知识结论与原始资料的一致性并保留溯源；用于知识入库和交付校验。\n---\n\n# 来源溯源\n\n逐项核验结论、原始文档和位置引用；低置信度内容进入复核区。');
  await writeIfMissing(join(kmSkillsDir, 'wiki-materialization', 'SKILL.md'), '---\nname: wiki-materialization\ndescription: 把知识图谱整理为可读且可溯源的 Wiki 文档；用于知识沉淀和经验归集。\n---\n\n# Wiki 生成\n\n生成包含摘要、关系和来源的 Markdown 页面，并保存到知识工作区。');
  await writeIfMissing(join(kmSkillsDir, 'graph-projection', 'SKILL.md'), '---\nname: graph-projection\ndescription: 将知识图谱投影为前端可视化数据；用于图谱预览或导出。\n---\n\n# 图谱投影\n\n导出节点、边、标签和分组，生成前端可消费的 JSON。');
  const processKnowledgeSkillDir = join(kmSkillsDir, 'process-knowledge-files');
  const retrieveKnowledgeSkillDir = join(kmSkillsDir, 'retrieve-knowledge');
  await writeIfMissing(join(processKnowledgeSkillDir, 'SKILL.md'), `---
name: process-knowledge-files
description: Incrementally process new, changed, or deleted files in a group chat into local chunks, summaries, keywords, tags, embeddings, graph entities, Wiki pages, and visualizations. Use when the knowledge manager needs to ingest or reconcile group files.
---

# Process knowledge files

1. Scan only the current group original-files directory and compare each file with the stored MD5 fingerprint.
2. Skip unchanged ready sources. Reprocess new or changed sources according to file type; use local OCR only when extracted text is absent or clearly insufficient.
3. Produce semantic chunks with source locations, a document summary, keywords, tags, local embeddings, entities, relationships, provenance, and Wiki pages.
4. Persist all records locally. Materialize knowledge/knowledge-index.json, knowledge/wiki/index.html, graph-visualization/knowledge-graph.json, and graph-visualization/knowledge-graph.html.
5. When a source is deleted or superseded, remove its chunks, vectors, provenance, source-only Wiki pages, and orphan graph data.
6. Report only meaningful completion statistics, failures, or items requiring review. Do not expose internal pipeline terminology to the user.

Read references/storage-schema.md when checking paths, lifecycle, or output contracts.`);
  await writeIfMissing(join(retrieveKnowledgeSkillDir, 'SKILL.md'), `---
name: retrieve-knowledge
description: Retrieve and synthesize cited evidence from local group and shared knowledge using full-text, vector, knowledge-graph, and Wiki RAG. Use when the knowledge manager needs to answer a question from processed files or verify a claim against local knowledge.
---

# Retrieve knowledge

1. Identify whether the question needs exact text, semantic similarity, entity relationships, Wiki synthesis, or a mixture.
2. Search the current group knowledge plus shared knowledge. Never read another group's private knowledge.
3. Fuse channel rankings, remove duplicate evidence, and prefer evidence with clear provenance.
4. Synthesize the smallest sufficient evidence set into a direct answer. Cite the source file and location for every key conclusion.
5. Never dump raw chunks, similarity scores, retrieval channels, or vector data into the user-facing response. Separate supported facts from inference and explicitly state gaps.
6. Do not modify the knowledge base during retrieval.

Read references/retrieval-policy.md when tuning channel choice or interpreting scores.`);
  await mkdir(join(processKnowledgeSkillDir, 'agents'), { recursive: true });
  await mkdir(join(processKnowledgeSkillDir, 'references'), { recursive: true });
  await mkdir(join(retrieveKnowledgeSkillDir, 'agents'), { recursive: true });
  await mkdir(join(retrieveKnowledgeSkillDir, 'references'), { recursive: true });
  await writeIfMissing(join(processKnowledgeSkillDir, 'agents', 'openai.yaml'), 'interface:\n  display_name: "知识文件处理"\n  short_description: "读取群聊原始文件，增量生成可追溯并可混合检索的本地知识资产"\n  default_prompt: "Use $process-knowledge-files to process new or changed group files into local knowledge."\npolicy:\n  allow_implicit_invocation: true\n');
  await writeIfMissing(join(retrieveKnowledgeSkillDir, 'agents', 'openai.yaml'), 'interface:\n  display_name: "混合知识检索"\n  short_description: "融合全文、向量、图谱和 Wiki，返回带来源的本地知识证据"\n  default_prompt: "Use $retrieve-knowledge to find cited evidence in the local group knowledge base."\npolicy:\n  allow_implicit_invocation: true\n');
  await writeIfMissing(join(processKnowledgeSkillDir, 'references', 'storage-schema.md'), '# 本地存储契约\n\n- `original-files/`: 只读原始输入。\n- `knowledge/knowledge-index.json`: 文档摘要、关键词和标签索引。\n- `knowledge/wiki/`: Wiki 页面及 `index.html`。\n- `graph-visualization/knowledge-graph.json`: 图谱投影。\n- `graph-visualization/knowledge-graph.html`: 离线可视化。\n- SQLite: 切片、向量、图谱、溯源和处理状态的权威数据。\n\n文件身份使用 MD5 做处理标记，同时保留 SHA-256 版本校验。源文件删除或新版本入库后必须回收旧来源数据。\n');
  await writeIfMissing(join(retrieveKnowledgeSkillDir, 'references', 'retrieval-policy.md'), '# 检索策略\n\n- 原文、编号、条款、代码：提高全文检索权重。\n- 原因、方案、相似问题、概括：提高向量和 Wiki 权重。\n- 人物、组织、依赖、影响、上下游：提高图谱权重。\n- 默认使用四路 RRF 融合；结果必须带来源，不以无来源模型常识冒充知识库结论。\n');

  // researcher resources
  const resSkillsDir = join(researcherDir, 'skills');
  const webSearchSkillDir = join(resSkillsDir, 'web-search');
  await mkdir(join(resSkillsDir, 'information-retrieval'), { recursive: true });
  await mkdir(join(resSkillsDir, 'source-analysis'), { recursive: true });
  await mkdir(join(webSearchSkillDir, 'agents'), { recursive: true });
  await writeIfMissing(join(resSkillsDir, 'information-retrieval', 'SKILL.md'), '---\nname: information-retrieval\ndescription: 检索、筛选和排序与任务相关的资料；用于资料调研和事实查找。\n---\n\n# 信息检索\n\n根据问题检索资料，保留出处并按相关性和可靠性排序。');
  await writeIfMissing(join(resSkillsDir, 'source-analysis', 'SKILL.md'), '---\nname: source-analysis\ndescription: 评估资料来源可靠性并进行交叉验证；用于事实核查和研究结论校验。\n---\n\n# 来源分析\n\n比较多个来源的一致性、时效性和利益关系，明确结论置信度。');
  await writeIfMissing(join(webSearchSkillDir, 'SKILL.md'), `---
name: web-search
description: Search current public web information through the built-in Bocha search tool, verify sources, and synthesize cited research. Use for current events, companies, markets, competitors, policies, products, statistics, or other questions that require external public sources rather than local group knowledge.
---

# Web Search

1. Turn the assigned research question into the smallest useful set of search queries.
2. Call \`web:search\` and refine the query when the first result set is insufficient.
3. Assess relevance, publication time, source authority, primary versus secondary status, and conflicts between sources.
4. Keep the URL, site name, and publication date for material claims. Separate verified facts, inference, and unknown information.
5. Synthesize the smallest sufficient evidence set instead of pasting raw result lists.

Never send group messages, role cards, memories, local file contents, credentials, personal data, or other private workspace information to the search API.`);
  await writeIfMissing(join(webSearchSkillDir, 'agents', 'openai.yaml'), 'interface:\n  display_name: "网页搜索"\n  short_description: "搜索公开网页资料并保留来源链接，帮助调研智能体核验事实"\n  default_prompt: "Use $web-search to find current public sources for this research question."\npolicy:\n  allow_implicit_invocation: true\n');

  // material writer + acceptance reviewer resources
  const writerSkillDir = join(materialWriterDir, 'skills', 'document-authoring');
  const reviewerSkillsDir = join(acceptanceReviewerDir, 'skills');
  const reviewerRetrieveDir = join(reviewerSkillsDir, 'retrieve-knowledge');
  const reviewerProvenanceDir = join(reviewerSkillsDir, 'provenance-validation');
  const reviewerAcceptanceDir = join(reviewerSkillsDir, 'deliverable-acceptance');
  await mkdir(writerSkillDir, { recursive: true });
  await mkdir(reviewerRetrieveDir, { recursive: true });
  await mkdir(reviewerProvenanceDir, { recursive: true });
  await mkdir(reviewerAcceptanceDir, { recursive: true });
  await writeIfMissing(join(writerSkillDir, 'SKILL.md'), '---\nname: document-authoring\ndescription: 基于证据和模板先搭建框架，再逐章写作并生成完整 HTML 待审稿。\n---\n\n# 材料编写\n\n识别读者与约束，先列章节框架和证据对应关系，再逐章写作、统一校对，并通过 review.writeDraft 提交待审稿。');
  await writeIfMissing(join(reviewerRetrieveDir, 'SKILL.md'), '---\nname: retrieve-knowledge\ndescription: 融合本地全文、向量、图谱和 Wiki 检索，返回带来源的精炼证据。\n---\n\n# 知识检索\n\n围绕待核验主张检索本地证据，综合来源、冲突和缺口，不原样堆砌切片。');
  await writeIfMissing(join(reviewerProvenanceDir, 'SKILL.md'), '---\nname: provenance-validation\ndescription: 核验材料主张与原始知识证据的一致性，识别变造、冲突和来源缺口。\n---\n\n# 来源溯源\n\n建立材料主张、知识证据和原始位置的对应关系；无法定位来源或限定条件被改变时判定不通过。');
  await writeIfMissing(join(reviewerAcceptanceDir, 'SKILL.md'), '---\nname: deliverable-acceptance\ndescription: 按需求、模板、证据和文件完整性验收待审稿，给出明确通过或不通过结论。\n---\n\n# 成果验收\n\n读取待审稿，逐项检查需求覆盖、模板、证据、口径与 HTML 完整性；不通过时输出可执行返修清单。');

  const packageMetadata = [
    [teamSkillDir, 'team-planning', ['list_project_agents', 'delegate_tasks']],
    [resultSkillDir, 'result-synthesis', []],
    [join(kmSkillsDir, 'document-ingestion'), 'document-ingestion', ['workspace:readFile']],
    [join(kmSkillsDir, 'entity-relation-extraction'), 'entity-relation-extraction', ['knowledge:search']],
    [join(kmSkillsDir, 'provenance-validation'), 'provenance-validation', ['workspace:readFile', 'knowledge:search']],
    [join(kmSkillsDir, 'wiki-materialization'), 'wiki-materialization', ['publish_artifact']],
    [join(kmSkillsDir, 'graph-projection'), 'graph-projection', ['knowledge:listGraph', 'publish_artifact']],
    [processKnowledgeSkillDir, 'process-knowledge-files', ['workspace:readFile', 'knowledge:ingest', 'local:ocr', 'local:embed']],
    [retrieveKnowledgeSkillDir, 'retrieve-knowledge', ['knowledge:search', 'knowledge:listGraph']],
    [join(resSkillsDir, 'information-retrieval'), 'information-retrieval', ['knowledge:search']],
    [join(resSkillsDir, 'source-analysis'), 'source-analysis', ['knowledge:search']],
    [webSearchSkillDir, 'web-search', ['web:search']],
    [writerSkillDir, 'document-authoring', ['skill:search', 'skill:load', 'workspace:readFile', 'review:writeDraft']],
    [reviewerRetrieveDir, 'retrieve-knowledge', ['knowledge:search', 'knowledge:listGraph']],
    [reviewerProvenanceDir, 'provenance-validation', ['workspace:readFile', 'knowledge:search']],
    [reviewerAcceptanceDir, 'deliverable-acceptance', ['workspace:readFile', 'knowledge:search', 'skill:load']],
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
  await writeIfMissing(join(orchestratorDir, 'evals', 'cases.yaml'), 'cases:\n  - name: direct-answer\n    input: "你好，今天天气怎么样？"\n    expected:\n      intent: "answer"\n      needsKM: false\n  - name: delegate-to-km\n    input: "帮我查一下项目文档中关于数据库设计的内容"\n    expected:\n      intent: "delegate"\n      needsKM: true');
  await writeIfMissing(join(knowledgeDir, 'evals', 'cases.yaml'), 'cases:\n  - name: document-ingestion\n    input: "上传一份 PDF 文档到知识库"\n    expected:\n      action: "ingest"\n  - name: graph-query\n    input: "列出项目中的知识图谱"\n    expected:\n      action: "query"');
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
      const systemRoot = st === 'shared'
        ? join(getStudioRoot(), 'shared-knowledge')
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
      }
    }
    // 文件导入只登记原始文件；知识处理在智能体实际检索时按需完成。
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
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const normalizedInputPath = normalizeRelativePath(input.relativePath).replaceAll('\\', '/');
    const systemDirectories = ['agent-identities', 'agent-memories', 'knowledge', 'graph-visualization', 'outputs'];
    const isSystemFile = systemDirectories.some(
      (directory) => normalizedInputPath === directory || normalizedInputPath.startsWith(`${directory}/`),
    );
    const root = isSystemFile
      ? (st === 'shared' ? join(getStudioRoot(), 'shared-knowledge') : getProjectRoot(input.projectId))
      : await getScopeRoot(input);
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

const writeManagedDefinitionFile = async (path: string, content: string, legacyContent: string): Promise<void> => {
  try {
    const current = await readFile(path, 'utf8');
    const normalized = (value: string): string => value.replace(/\r\n/g, '\n').trim();
    if (normalized(current) === normalized(content)) return;
    // 只迁移应用曾经安装的原始版本；用户一旦修改过就保留人工版本。
    if (normalized(current) === normalized(legacyContent)) await writeFile(path, content, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(path, content, 'utf8');
  }
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
    const result = await knowledgeIngestForFile(db, input.fileId);
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
    if (input.projectId && _gateway) await refreshKnowledgeBeforeSearch(db, _gateway, input.projectId);
    const data = input.projectId
      ? searchHybridKnowledge(db, input.query, input.projectId, input.limit ?? 20)
      : repo.search(input.query, input.scopeType, input.scopeId, input.limit ?? 50);
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

  const delayedRegisters = async (): Promise<void> => {
    const db = ensureDb();
    if (ensureBochaApiKey(db)) {
      getLogger().info({ configured: true }, 'Bocha web search is configured');
    }
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
    void skillRegistry.syncFromWorkspace().then((count) => getLogger().info({ count }, 'SkillRegistry: 工作区技能同步完成'));
    const workflowRegistry = new WorkflowRegistry(db);
    workflowRegistry.seedBuiltinWorkflows();
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
      await delayedRegisters();
      _dbInitialized = true;
      const db = ensureDb();
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        _gateway = new ModelGateway(db as never);
        const toolRegistry = new ToolRegistry(db);
        const executor = createAgentExecutor(db, win, _gateway, undefined, toolRegistry);
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
