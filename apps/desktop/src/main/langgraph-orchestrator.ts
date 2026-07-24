import { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { StateGraph, END, Annotation } from '@langchain/langgraph';
import { ModelGateway } from './model-gateway';
import { MemoryManager } from './memory-manager';
import { ContextBuilder, type ContextSnapshot } from './context-builder';
import { createProjectTools, type ToolDefinition } from './agent-tools';
import { ToolRegistry, type AgentRole } from './tool-registry';
import { AgentRunRepository, FileRepository } from '@kunqing/database';
import { getLogger } from './logger';
import { getProjectRoot } from './paths';
import { SkillRegistry } from './skill-registry';
import { buildModelProfileSnapshot } from './project-creator';
import type { Scheduler } from './scheduler';
import { hashContent } from '@kunqing/knowledge-core';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ─── State ───────────────────────────────────────────────────────────────────
const OrchestratorState = Annotation.Root({
  projectId: Annotation<string>(),
  agentInstanceId: Annotation<string>(),
  runId: Annotation<string>(),
  instruction: Annotation<string>(),
  triggerMessageId: Annotation<string>(),
  messages: Annotation<Array<{ role: string; content: string }>>({
    value: (a: Array<{ role: string; content: string }>, b: Array<{ role: string; content: string }>) => [...a, ...b],
    default: () => [],
  }),
  subAgentResult: Annotation<string>({
    value: (_a: string, b: string) => b,
    default: () => '',
  }),
  finalResponse: Annotation<string>({
    value: (_a: string, b: string) => b,
    default: () => '',
  }),
  needsKnowledgeManager: Annotation<boolean>({
    value: (_a: boolean, b: boolean) => b,
    default: () => false,
  }),
  _artifacts: Annotation<Array<{ relativePath: string; content: string }>>({
    value: (a: Array<{ relativePath: string; content: string }>, b: Array<{ relativePath: string; content: string }>) => [...a, ...b],
    default: () => [],
  }),
});

type GraphState = {
  projectId: string;
  agentInstanceId: string;
  runId: string;
  instruction: string;
  triggerMessageId: string;
  messages: Array<{ role: string; content: string }>;
  subAgentResult: string;
  finalResponse: string;
  needsKnowledgeManager: boolean;
  _artifacts: Array<{ relativePath: string; content: string }>;
};

// ─── Context ─────────────────────────────────────────────────────────────────
export type ExecContext = {
  db: Database.Database;
  gateway: ModelGateway;
  window: BrowserWindow;
  runId: string;
  projectId: string;
  agentInstanceId: string;
  instruction: string;
  triggerMessageId: string;
  signal: AbortSignal;
  memory: MemoryManager;
  tools: ToolDefinition[];
  toolRegistry: ToolRegistry;
  contextSnapshot: ContextSnapshot;
  contextBuilder: ContextBuilder;
  scheduler: Scheduler | undefined;
};

// ─── Prompts ─────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `你是统筹智能体 (Orchestrator)，一个多智能体系统的协调者。

## 职责
- 分析用户指令，判断是否需要动用子智能体（如知识管理员）
- 如果用户询问项目知识、文档内容、搜索信息，回复 "NEED_KM" 作为第一行
- 如果用户询问日常对话、代码编写、一般问题，直接回复
- 收集子智能体的结果并进行汇总

## 工具调用
你可以使用以下工具。需要调用工具时，请输出以下格式（不要用 Markdown 代码块包裹）：
publish_artifact({"projectId": "xxx", "relativePath": "path/to/file.md", "content": "文件内容", "note": "说明"})

每个工具调用占一行，可以同时调用多个工具。工具调用结果会自动添加到回复末尾。

## 回复格式
使用 Markdown 格式输出。`;

const KM_PROMPT = `你是知识管理员 (Knowledge Manager)。你负责管理项目知识库。

## 可用工具
你可以使用以下工具来获取信息。需要调用工具时，请输出以下格式（不要用 Markdown 代码块包裹）：
knowledge:search({"query": "关键词", "projectId": "xxx", "limit": 5})
publish_artifact({"projectId": "xxx", "relativePath": "path/to/file.md", "content": "文件内容", "note": "说明"})

每个工具调用占一行，可以同时调用多个工具。工具调用结果会自动添加到回复末尾。

可用工具列表：
- knowledge:search - 搜索知识库文档
- workspace:readFile - 读取工作区文件
- project:search - 跨项目搜索
- knowledge:listGraph - 列出知识图谱
- list_project_agents - 列出项目智能体
- publish_artifact - 发布成果文件

## 输出
基于获取的信息，给出准确的回答。如果信息不足，明确告知用户。`;

const MAX_TOOL_RETRIES = 3;

/** 发送进度事件到渲染进程 */
function sendProgress(ctx: ExecContext, stage: string, progress: number): void {
  if (!ctx.window || ctx.window.isDestroyed()) return;
  try {
    ctx.window.webContents.send('event:dispatch', {
      type: 'run.status',
      projectId: ctx.projectId,
      run: {
        id: ctx.runId,
        agentId: ctx.agentInstanceId,
        status: 'running',
        stage,
        progress,
      },
    });
  } catch { /* ignore */ }
}

/**
 * 执行工具调用列表（共享逻辑：执行 + publish_artifact 建文件记录）
 */
async function executeToolCalls(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  ctx: ExecContext,
  fileRepo: FileRepository,
): Promise<{ results: string[]; artifacts: Array<{ relativePath: string; content: string }> }> {
  const results: string[] = [];
  const artifacts: Array<{ relativePath: string; content: string }> = [];

  for (const call of calls) {
    try {
      // 执行工具
      const result = await ctx.toolRegistry.execute(call.name, call.args, { role: 'orchestrator', runId: ctx.runId, projectId: ctx.projectId });
      results.push(`[${call.name}] ${result}`);

      // publish_artifact: 额外创建 files + file_versions 记录
      if (call.name === 'publish_artifact') {
        const { projectId, relativePath, content, note } = call.args as {
          projectId: string; relativePath: string; content: string; note?: string;
        };
        const filePath = join(getProjectRoot(projectId), relativePath);
        const fileBuffer = await readFile(filePath);
        const sha256 = hashContent(fileBuffer.toString('utf8'));
        const size = fileBuffer.length;

        // 创建或更新 files 记录
        let file = fileRepo.getByPath('project', projectId, relativePath);
        if (!file) {
          file = fileRepo.create({
            scopeType: 'project',
            scopeId: projectId,
            type: 'file',
            name: relativePath.split('/').pop() ?? relativePath,
            normalizedPath: relativePath,
            origin: 'artifact',
          });
        }

        // 创建版本记录
        fileRepo.createVersion({
          fileId: file.id,
          storageRelPath: relativePath,
          size,
          sha256,
          createdByType: 'agent',
          createdById: ctx.agentInstanceId,
          runId: ctx.runId,
          changeNote: note ?? 'agent 发布成果',
        });

        artifacts.push({ relativePath, content: content.slice(0, 200) });
      }
    } catch (err) {
      results.push(`[${call.name}] 执行失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { results, artifacts };
}

/**
 * 处理模型输出中的工具调用：提取 → 执行 → 创建文件记录 → 返回结果文本
 * 返回 { processedText, artifacts }，其中 artifacts 是发布成果的消息列表
 */
async function processToolCalls(
  text: string,
  ctx: ExecContext,
  fileRepo: FileRepository,
): Promise<{ processedText: string; artifacts: Array<{ relativePath: string; content: string }> }> {
  const calls = extractToolCalls(text);
  if (calls.length === 0) return { processedText: text, artifacts: [] };

  const { results, artifacts } = await executeToolCalls(calls, ctx, fileRepo);
  const processedText = text + '\n\n---\n\n' + results.join('\n');
  return { processedText, artifacts };
}

/** 将 ToolRegistry 中的工具定义转为 AI SDK tools 格式 */
function buildAiTools(registry: ToolRegistry, role: AgentRole): Record<string, { description: string; parameters: Record<string, unknown> }> {
  const defs = registry.getDefinitionsForRole(role);
  return Object.fromEntries(defs.map((t) => [t.name, { description: t.description, parameters: t.parameters }]));
}

// ─── Graph Node: 分析意图 ────────────────────────────────────────────────────
async function analyzeIntent(state: GraphState, config: any): Promise<Partial<GraphState>> {
  const ctx: ExecContext = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  sendProgress(ctx, '分析意图', 10);

  const messages = buildMessages(ctx, SYSTEM_PROMPT);
  const tools = buildAiTools(ctx.toolRegistry, 'orchestrator');
  const result = await ctx.gateway.generateText('reasoning', messages, { tools });

  const fileRepo = new FileRepository(ctx.db);
  let needsKM: boolean;
  let rawText: string;
  let artifacts: Array<{ relativePath: string; content: string }> = [];

  // 优先处理原生 tool calls
  if (result.toolCalls && result.toolCalls.length > 0) {
    const { results: toolResults, artifacts: toolArtifacts } = await executeToolCalls(result.toolCalls, ctx, fileRepo);
    artifacts = toolArtifacts;
    const toolResultText = toolResults.join('\n');
    rawText = result.text ? result.text + '\n\n---\n\n' + toolResultText : toolResultText;
  } else {
    // 回退：从文本中正则提取
    rawText = result.text;
  }

  needsKM = rawText.trim().startsWith('NEED_KM');
  const cleanText = needsKM ? rawText.replace(/^NEED_KM\s*\n?/, '').trim() : rawText;

  // 即使有原生 tool calls，也再尝试从文本中提取额外的工具调用（如子智能体输出的）
  const { processedText: finalText, artifacts: textArtifacts } = await processToolCalls(cleanText, ctx, fileRepo);
  artifacts = [...artifacts, ...textArtifacts];

  sendProgress(ctx, needsKM ? '准备委派' : '生成回复', needsKM ? 30 : 50);

  return {
    messages: [{ role: 'assistant', content: finalText }],
    needsKnowledgeManager: needsKM,
    finalResponse: needsKM ? '' : finalText,
    _artifacts: artifacts,
  };
}

/**
 * 轮询子 Run 完成状态，支持超时和取消
 */
async function pollRunCompletion(
  runRepo: AgentRunRepository,
  runId: string,
  signal: AbortSignal,
  timeoutMs = 60000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    signal.throwIfAborted();

    const run = runRepo.getById(runId);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
      return run;
    }

    // yield 控制权让 Scheduler 有机会处理子 Run
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`子 Run ${runId} 在 ${timeoutMs}ms 内未完成`);
}

// ─── Graph Node: 委派知识管理员 ──────────────────────────────────────────────
async function delegateToKM(state: GraphState, config: any): Promise<Partial<GraphState>> {
  const ctx: ExecContext = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  const logger = getLogger();
  const runRepo = new AgentRunRepository(ctx.db);

  // 查找项目中的知识管理员实例
  const kmInstanceRow = ctx.db.prepare(
    `SELECT pai.id, pai.identity_rel_path as identityRelPath, ap.enabled as profileEnabled
     FROM project_agent_instances pai
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE pai.project_id = ? AND ap.definition_id = 'builtin.knowledge-manager' LIMIT 1`,
  ).get(ctx.projectId) as { id: string; identityRelPath: string | null; profileEnabled: number } | undefined;

  if (!kmInstanceRow) {
    return { subAgentResult: '未找到知识管理员智能体实例', messages: [{ role: 'system', content: 'delegate: 未找到知识管理员' }] };
  }

  // AC-SET-03: 禁用智能体不能被 Leader 委派
  if (!kmInstanceRow.profileEnabled) {
    logger?.warn({ projectId: ctx.projectId, kmInstanceId: kmInstanceRow.id }, 'delegateToKM: 知识管理员已被禁用，跳过委派');
    return { subAgentResult: '知识管理员已被禁用，跳过知识处理', messages: [{ role: 'system', content: 'delegate: KM 已禁用' }] };
  }

  // 创建子 Run
  const kmRun = runRepo.create({
    projectId: ctx.projectId,
    agentInstanceId: kmInstanceRow.id,
    requestedByType: 'agent',
    requestedById: ctx.agentInstanceId,
    instruction: ctx.instruction,
    parentRunId: ctx.runId,
    modelProfileSnapshotJson: buildModelProfileSnapshot(ctx.db, kmInstanceRow.id),
  });

  runRepo.addEvent(ctx.runId, 'delegate', {
    subRunId: kmRun.id,
    agentInstanceId: kmInstanceRow.id,
    instruction: ctx.instruction.slice(0, 200),
  });

  // 向调度器提交子 Run（异步执行）
  if (ctx.scheduler) {
    ctx.scheduler.enqueue({
      runId: kmRun.id,
      projectId: ctx.projectId,
      agentInstanceId: kmInstanceRow.id,
      instruction: ctx.instruction,
      triggerMessageId: ctx.triggerMessageId,
    });
  } else {
    // 回退：直接调用 KM 模型（同步）
    logger?.warn({ runId: ctx.runId }, 'Scheduler 未传入，使用同步回退模式');
    try {
      const kmMessages = buildMessages(ctx, KM_PROMPT);
      const kmTools = buildAiTools(ctx.toolRegistry, 'knowledge-manager');
      const kmResult = await ctx.gateway.generateText('fast', kmMessages, { tools: kmTools });
      runRepo.setStatus(kmRun.id, 'completed');
      return { subAgentResult: kmResult.text, messages: [{ role: 'system', content: 'delegate: KM 同步回退完成' }] };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      runRepo.setStatus(kmRun.id, 'failed', { errorCode: 'KM_ERROR', errorMessage: errMsg });
      return { subAgentResult: `知识管理员执行出错: ${errMsg}`, messages: [{ role: 'system', content: 'delegate: KM 出错' }] };
    }
  }

  sendProgress(ctx, '等待子智能体', 40);

  // 轮询等待子 Run 完成
  try {
    const completedRun = await pollRunCompletion(runRepo, kmRun.id, ctx.signal);
    if (completedRun.status !== 'completed') {
      const errMsg = completedRun.errorMessage || `子 Run 状态: ${completedRun.status}`;
      return { subAgentResult: `知识管理员执行未完成: ${errMsg}`, messages: [{ role: 'system', content: 'delegate: KM 未完成' }] };
    }

    // 读取结果消息
    let resultText = '';
    if (completedRun.resultMessageId) {
      const msgRow = ctx.db.prepare(
        'SELECT content_json as contentJson FROM messages WHERE id = ?',
      ).get(completedRun.resultMessageId) as { contentJson: string } | undefined;
      if (msgRow) {
        try { resultText = JSON.parse(msgRow.contentJson).text ?? msgRow.contentJson; } catch { resultText = msgRow.contentJson; }
      }
    }

    if (!resultText) {
      resultText = '知识管理员已完成处理但未返回文本结果。';
    }

    logger?.info({ subRunId: kmRun.id, resultLength: resultText.length }, 'Orchestrator: 异步委派 KM 完成');
    return { subAgentResult: resultText, messages: [{ role: 'system', content: 'delegate: KM 异步返回结果' }] };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      runRepo.setStatus(kmRun.id, 'cancelled');
      return { subAgentResult: '知识管理员任务已被取消', messages: [{ role: 'system', content: 'delegate: KM 已取消' }] };
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.warn({ err, subRunId: kmRun.id }, 'Orchestrator: 轮询 KM 子 Run 失败');
    return { subAgentResult: `等待知识管理员结果失败: ${errMsg}`, messages: [{ role: 'system', content: 'delegate: KM 轮询出错' }] };
  }
}

// ─── Graph Node: 汇总合成 ─────────────────────────────────────────────────────
async function synthesize(state: GraphState, config: any): Promise<Partial<GraphState>> {
  const { ctx } = config.configurable as { ctx: ExecContext };
  ctx.signal.throwIfAborted();

  sendProgress(ctx, '汇总子智能体结果', 70);

  const kmResult = state.subAgentResult;
  const messages = buildMessages(ctx, SYSTEM_PROMPT);
  messages.push({ role: 'assistant', content: state.messages.find((m: any) => m.role === 'assistant')?.content ?? '' });
  messages.push({ role: 'user', content: `知识管理员返回了以下结果：\n\n${kmResult}\n\n请根据这些信息给出最终回复。` });

  const tools = buildAiTools(ctx.toolRegistry, 'orchestrator');
  const finalResult = await ctx.gateway.generateText('reasoning', messages, { tools });
  const fileRepo = new FileRepository(ctx.db);

  let artifacts: Array<{ relativePath: string; content: string }> = [];

  // 优先处理原生 tool calls
  if (finalResult.toolCalls && finalResult.toolCalls.length > 0) {
    const { results: toolResults, artifacts: toolArtifacts } = await executeToolCalls(finalResult.toolCalls, ctx, fileRepo);
    artifacts = toolArtifacts;
    const toolResultText = toolResults.join('\n');
    const processedText = finalResult.text ? finalResult.text + '\n\n---\n\n' + toolResultText : toolResultText;
    const { processedText: finalText, artifacts: textArtifacts } = await processToolCalls(processedText, ctx, fileRepo);
    artifacts = [...artifacts, ...textArtifacts];
    sendProgress(ctx, '生成最终回复', 90);
    return { finalResponse: finalText, messages: [{ role: 'assistant', content: finalText }], _artifacts: artifacts };
  }

  // 回退：文本正则提取
  const { processedText, artifacts: textArtifacts } = await processToolCalls(finalResult.text, ctx, fileRepo);
  sendProgress(ctx, '生成最终回复', 90);
  return { finalResponse: processedText, messages: [{ role: 'assistant', content: processedText }], _artifacts: textArtifacts };
}

// ─── Graph Node: 输出结果 ────────────────────────────────────────────────────
async function respond(state: GraphState, config: any): Promise<Partial<GraphState>> {
  const { ctx } = config.configurable as { ctx: ExecContext };
  ctx.signal.throwIfAborted();

  const text = state.finalResponse;
  if (!text) return {};

  const agentMsgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
  let contentJson: string;

  // 如果有成果文件，合并到消息中
  const artifacts = state._artifacts ?? [];
  if (artifacts.length > 0) {
    const artifactLines = artifacts.map(
      (a) => `📄 **${a.relativePath}** 已发布到工作区\n\`\`\`\n${a.content}\n\`\`\``,
    );
    const combinedText = text + '\n\n---\n\n' + artifactLines.join('\n\n');
    contentJson = JSON.stringify({ schemaVersion: 1, text: combinedText, mentions: [], stagedUploadIds: [] });
  } else {
    contentJson = JSON.stringify({ schemaVersion: 1, text, mentions: [], stagedUploadIds: [] });
  }
  const now = new Date().toISOString();

  ctx.db.prepare(
    'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(agentMsgId, ctx.projectId, 'agent', ctx.agentInstanceId, 'text', contentJson, 'sent', now, now);

  new AgentRunRepository(ctx.db).setResultMessage(ctx.runId, agentMsgId);

  if (!ctx.window.isDestroyed()) {
    ctx.window.webContents.send('event:dispatch', {
      type: 'run.status',
      projectId: ctx.projectId,
      run: { id: ctx.runId, agentId: ctx.agentInstanceId, status: 'completed' },
    });
    ctx.window.webContents.send('event:dispatch', {
      type: 'message.committed',
      projectId: ctx.projectId,
      messageId: agentMsgId,
      senderId: ctx.agentInstanceId,
      content: contentJson,
    });
  }

  ctx.memory.storeShortTerm(ctx.projectId, ctx.agentInstanceId, 'interaction', ctx.instruction.slice(0, 500), 0.6);
  ctx.memory.consolidateShortTerm(ctx.projectId, ctx.agentInstanceId);
  ctx.memory.extractLongTerm(ctx.projectId, ctx.agentInstanceId);

  return {};
}

// ─── Router ───────────────────────────────────────────────────────────────────
function routeAfterAnalyze(state: GraphState): string {
  return state.needsKnowledgeManager ? 'delegateToKM' : 'respond';
}

// ─── Graph Builder ────────────────────────────────────────────────────────────
function buildOrchestratorGraph() {
  const builder = new StateGraph(OrchestratorState)
    .addNode('analyzeIntent', analyzeIntent as any)
    .addNode('delegateToKM', delegateToKM as any)
    .addNode('synthesize', synthesize as any)
    .addNode('respond', respond as any)
    .addEdge('__start__' as const, 'analyzeIntent')
    .addConditionalEdges('analyzeIntent', routeAfterAnalyze, ['delegateToKM', 'respond'] as const)
    .addEdge('delegateToKM', 'synthesize')
    .addEdge('synthesize', 'respond')
    .addEdge('respond', END);

  return builder.compile();
}

// ─── Public API ───────────────────────────────────────────────────────────────
let _compiledGraph: ReturnType<typeof buildOrchestratorGraph> | null = null;

export async function runOrchestrator(ctx: ExecContext): Promise<void> {
  const logger = getLogger();
  const runRepo = new AgentRunRepository(ctx.db);

  try {
    if (!_compiledGraph) {
      _compiledGraph = buildOrchestratorGraph();
    }

    // 构建上下文快照
    if (!ctx.contextSnapshot) {
      ctx.contextSnapshot = ctx.contextBuilder.build(
        ctx.projectId,
        ctx.agentInstanceId,
        ctx.triggerMessageId,
      );
    }

    // 写入 context-manifest.json 到项目工作区
    try {
      const projectRoot = getProjectRoot(ctx.projectId);
      await ctx.contextBuilder.writeContextManifest(ctx.contextSnapshot, projectRoot);
    } catch (err) {
      logger?.warn({ err, projectId: ctx.projectId }, '写入 context-manifest.json 失败（非致命）');
    }

    const initialState: GraphState = {
      projectId: ctx.projectId,
      agentInstanceId: ctx.agentInstanceId,
      runId: ctx.runId,
      instruction: ctx.instruction,
      triggerMessageId: ctx.triggerMessageId,
      messages: [],
      subAgentResult: '',
      finalResponse: '',
      needsKnowledgeManager: false,
      _artifacts: [],
    };

    await _compiledGraph.invoke(initialState, {
      configurable: { ctx },
      signal: ctx.signal,
    });

    logger?.info({ runId: ctx.runId, snapshotChecksum: ctx.contextSnapshot.snapshotChecksum }, 'Orchestrator StateGraph: 完成');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      runRepo.setStatus(ctx.runId, 'cancelled');
      return;
    }
    throw err;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** 从 DB 查询当前 agent 绑定的技能 prompt 文本 */
function buildSkillContext(db: Database.Database, agentInstanceId: string): string {
  const row = db.prepare(
    `SELECT ap.definition_id as definitionId, ap.definition_version as definitionVersion
     FROM project_agent_instances pai
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE pai.id = ?`,
  ).get(agentInstanceId) as { definitionId: string; definitionVersion: string } | undefined;

  if (!row) return '';

  const skillReg = new SkillRegistry(db);
  const skills = skillReg.listSkills(row.definitionId, row.definitionVersion);
  if (skills.length === 0) return '';

  return '\n\n## 可用技能\n' + skills.map((s) => s.promptMd ?? `- ${s.name}: ${s.description}`).join('\n\n');
}

function buildMessages(ctx: ExecContext, systemPrompt: string): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const snapshot = ctx.contextSnapshot;
  const snapshotContext = ctx.contextBuilder.renderToText(snapshot);

  const skillsContext = buildSkillContext(ctx.db, ctx.agentInstanceId);
  const memoryContext = ctx.memory.buildMemoryContext(ctx.projectId, ctx.agentInstanceId);
  const systemContent = [
    systemPrompt,
    skillsContext,
    `\n\n## 上下文快照 (${snapshot.snapshotChecksum})\n${snapshotContext}`,
    memoryContext ? `\n\n## 记忆补充\n${memoryContext}` : '',
  ].join('');

  return [
    { role: 'system', content: systemContent },
    ...snapshot.messages.map((m) => ({
      role: (m.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: ctx.instruction },
  ];
}

function extractToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  // 匹配模式: tool_name({...}) 或 tool_name( {...} )
  // 用栈式解析处理嵌套大括号
  const nameRegex = /(\w+(?::\w+)?)\s*\(\s*\{/g;
  let match;
  while ((match = nameRegex.exec(text)) !== null) {
    const name = match[1]!;
    const startIdx = match.index + match[0].length - 1; // 指向 '{'
    let depth = 1;
    let i = startIdx + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      if (depth > 0) i++;
    }
    if (depth === 0) {
      const jsonStr = text.slice(startIdx, i + 1);
      try {
        const args = JSON.parse(jsonStr) as Record<string, unknown>;
        calls.push({ name, args });
      } catch { /* skip invalid JSON */ }
    }
  }
  return calls;
}