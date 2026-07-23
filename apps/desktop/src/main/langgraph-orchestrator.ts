import { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { StateGraph, END, Annotation } from '@langchain/langgraph';
import { ModelGateway } from './model-gateway';
import { MemoryManager } from './memory-manager';
import { ContextBuilder, type ContextSnapshot } from './context-builder';
import { createProjectTools, type ToolDefinition } from './agent-tools';
import { ToolRegistry } from './tool-registry';
import { AgentRunRepository } from '@kunqing/database';
import { getLogger } from './logger';
import { getProjectRoot } from './paths';
import { SkillRegistry } from './skill-registry';
import { buildModelProfileSnapshot } from './project-creator';
import type { Scheduler } from './scheduler';

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

## 回复格式
使用 Markdown 格式输出。`;

const KM_PROMPT = `你是知识管理员 (Knowledge Manager)。你负责管理项目知识库。

## 可用工具
你可以使用以下工具来获取信息：
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

// ─── Graph Node: 分析意图 ────────────────────────────────────────────────────
async function analyzeIntent(state: GraphState, config: any): Promise<Partial<GraphState>> {
  const ctx: ExecContext = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  sendProgress(ctx, '分析意图', 10);

  const messages = buildMessages(ctx, SYSTEM_PROMPT);
  const result = await ctx.gateway.generateText('reasoning', messages);

  const needsKM = result.trim().startsWith('NEED_KM');
  const responseText = needsKM ? result.replace(/^NEED_KM\s*\n?/, '').trim() : result;

  sendProgress(ctx, needsKM ? '准备委派' : '生成回复', needsKM ? 30 : 50);

  return {
    messages: [{ role: 'assistant', content: responseText }],
    needsKnowledgeManager: needsKM,
    finalResponse: needsKM ? '' : responseText,
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
      const kmResult = await ctx.gateway.generateText('fast', kmMessages);
      runRepo.setStatus(kmRun.id, 'completed');
      return { subAgentResult: kmResult, messages: [{ role: 'system', content: 'delegate: KM 同步回退完成' }] };
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

  const finalResult = await ctx.gateway.generateText('reasoning', messages);
  sendProgress(ctx, '生成最终回复', 90);
  return { finalResponse: finalResult, messages: [{ role: 'assistant', content: finalResult }] };
}

// ─── Graph Node: 输出结果 ────────────────────────────────────────────────────
async function respond(state: GraphState, config: any): Promise<Partial<GraphState>> {
  const { ctx } = config.configurable as { ctx: ExecContext };
  ctx.signal.throwIfAborted();

  const text = state.finalResponse;
  if (!text) return {};

  const agentMsgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
  const contentJson = JSON.stringify({ schemaVersion: 1, text, mentions: [], stagedUploadIds: [] });
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
  const regex = /(\w+(?::\w+)?)\s*\(\s*({[^}]*})\s*\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const [, name, argsJson] = match;
      if (name && argsJson) {
        calls.push({ name, args: JSON.parse(argsJson) });
      }
    } catch { /* skip invalid JSON args */ }
  }
  return calls;
}