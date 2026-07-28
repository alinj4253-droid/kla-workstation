import { Annotation, END, StateGraph } from '@langchain/langgraph';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './prompts.js';
import { extractToolCalls } from './tool-utils.js';
import type { IGraphContext, OrchestratorGraphState, ExecContextSnapshot, AgentRole } from './types.js';
import type { ModelMessage } from '@kunqing/model-core';

const MAX_TOOL_RETRIES = 3;

const OrchestratorAnnotation = Annotation.Root({
  projectId: Annotation<string>(),
  agentInstanceId: Annotation<string>(),
  runId: Annotation<string>(),
  instruction: Annotation<string>(),
  triggerMessageId: Annotation<string>(),
  messages: Annotation<ModelMessage[]>({
    value: (a: ModelMessage[], b: ModelMessage[]) => [...a, ...b],
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
  artifacts: Annotation<Array<{ relativePath: string; content: string }>>({
    value: (a: Array<{ relativePath: string; content: string }>, b: Array<{ relativePath: string; content: string }>) => [...a, ...b],
    default: () => [],
  }),
});

type GraphState = OrchestratorGraphState;

function sendProgress(ctx: IGraphContext, stage: string, progress: number): void {
  ctx.services.emitEvent({
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
}

async function executeToolCalls(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  ctx: IGraphContext,
): Promise<{ results: string[]; artifacts: Array<{ relativePath: string; content: string }> }> {
  const results: string[] = [];
  const artifacts: Array<{ relativePath: string; content: string }> = [];

  for (const call of calls) {
    try {
      const result = await ctx.services.executeTool(call.name, call.args, 'orchestrator', {
        runId: ctx.runId,
        projectId: ctx.projectId,
      });
      results.push(`[${call.name}] ${result}`);

      if (call.name === 'publish_artifact') {
        const { projectId, relativePath, content, note } = call.args as {
          projectId: string; relativePath: string; content: string; note?: string;
        };
        await ctx.services.createFileRecord(projectId, relativePath, content, ctx.agentInstanceId, ctx.runId, note);
        artifacts.push({ relativePath, content: content.slice(0, 200) });
      }
    } catch (err) {
      results.push(`[${call.name}] 执行失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { results, artifacts };
}

async function processToolCalls(
  text: string,
  ctx: IGraphContext,
): Promise<{ processedText: string; artifacts: Array<{ relativePath: string; content: string }> }> {
  const calls = extractToolCalls(text);
  if (calls.length === 0) return { processedText: text, artifacts: [] };

  const { results, artifacts } = await executeToolCalls(calls, ctx);
  const processedText = text + '\n\n---\n\n' + results.join('\n');
  return { processedText, artifacts };
}

function buildAiTools(ctx: IGraphContext, role: AgentRole): Record<string, { description: string; parameters: Record<string, unknown> }> {
  const defs = ctx.services.getToolDefinitions(role);
  return Object.fromEntries(defs.map((t) => [t.name, { description: t.description, parameters: t.parameters }]));
}

function buildMessages(
  ctx: IGraphContext,
  systemPrompt: string,
  snapshot: ExecContextSnapshot,
  snapshotText: string,
  memoryContext: string,
): ModelMessage[] {
  const systemContent = [
    systemPrompt,
    `\n\n## 上下文快照 (${snapshot.snapshotChecksum})\n${snapshotText}`,
    memoryContext ? `\n\n## 记忆补充\n${memoryContext}` : '',
  ].join('');

  return [
    { role: 'system', content: systemContent },
    ...snapshot.messages.map((m) => ({
      role: (m.role === 'user' || m.role === 'assistant' ? m.role : 'user') as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: ctx.instruction },
  ];
}

async function analyzeIntent(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  sendProgress(ctx, '分析意图', 10);

  const snapshot = await ctx.services.buildContextSnapshot(ctx.projectId, ctx.agentInstanceId, ctx.triggerMessageId);
  const snapshotText = ctx.services.renderSnapshotToText(snapshot);
  const memoryContext = ctx.services.buildMemoryContext(ctx.projectId, ctx.agentInstanceId);
  const messages = buildMessages(ctx, ORCHESTRATOR_SYSTEM_PROMPT, snapshot, snapshotText, memoryContext);
  const tools = buildAiTools(ctx, 'orchestrator');

  const result = await ctx.services.generateText('reasoning', messages, { tools });

  let needsKM: boolean;
  let rawText: string;
  let artifacts: Array<{ relativePath: string; content: string }> = [];

  if (result.toolCalls && result.toolCalls.length > 0) {
    const { results: toolResults, artifacts: toolArtifacts } = await executeToolCalls(result.toolCalls, ctx);
    artifacts = toolArtifacts;
    const toolResultText = toolResults.join('\n');
    rawText = result.text ? result.text + '\n\n---\n\n' + toolResultText : toolResultText;
  } else {
    rawText = result.text;
  }

  needsKM = rawText.trim().startsWith('NEED_KM');
  const cleanText = needsKM ? rawText.replace(/^NEED_KM\s*\n?/, '').trim() : rawText;

  const { processedText: finalText, artifacts: textArtifacts } = await processToolCalls(cleanText, ctx);
  artifacts = [...artifacts, ...textArtifacts];

  sendProgress(ctx, needsKM ? '准备委派' : '生成回复', needsKM ? 30 : 50);

  return {
    messages: [{ role: 'assistant', content: finalText }],
    needsKnowledgeManager: needsKM,
    finalResponse: needsKM ? '' : finalText,
    artifacts,
  };
}

const KM_TRIGGER_KEYWORDS = [
  '文件', '文档', '上传', '导入', '知识库', '知识图谱', '搜索', '查找',
  'file', 'doc', 'upload', 'import', 'knowledge', 'graph', 'search', 'find',
  'wiki', '图谱', '入库', '实体', '关系', '分析文档',
];

async function delegateToKM(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  const logger = ctx.services.getLogger();

  // Pre-filter: check if the instruction actually references knowledge-related content
  const instruction = ctx.instruction.toLowerCase();
  const hasKMContext = KM_TRIGGER_KEYWORDS.some((kw) => instruction.includes(kw));
  if (!hasKMContext) {
    logger.warn(`Orchestrator.delegateToKM: LLM hallucinated NEED_KM, instruction="${ctx.instruction.slice(0, 100)}"`);
    return {
      subAgentResult: '',
      messages: [{ role: 'system', content: `delegate: SKIPPED — 无需知识管理处理，指令为: ${ctx.instruction}` }],
    };
  }

  const kmInstance = ctx.services.getKmInstance(ctx.projectId);
  if (!kmInstance) {
    return { subAgentResult: '未找到知识管理员智能体实例', messages: [{ role: 'system', content: 'delegate: 未找到知识管理员' }] };
  }

  if (!kmInstance.profileEnabled) {
    logger.warn(`知识管理员已被禁用，跳过委派 (project=${ctx.projectId}, km=${kmInstance.id})`);
    return { subAgentResult: '知识管理员已被禁用，跳过知识处理', messages: [{ role: 'system', content: 'delegate: KM 已禁用' }] };
  }

  const subRunId = ctx.services.createSubRun({
    projectId: ctx.projectId,
    agentInstanceId: kmInstance.id,
    instruction: ctx.instruction,
    requestedByType: 'agent',
    requestedById: ctx.agentInstanceId,
    parentRunId: ctx.runId,
    modelProfileSnapshotJson: null,
  });

  ctx.services.addRunEvent(ctx.runId, 'delegate', {
    subRunId,
    agentInstanceId: kmInstance.id,
    instruction: ctx.instruction.slice(0, 200),
  });

  ctx.services.enqueueRun({
    runId: subRunId,
    projectId: ctx.projectId,
    agentInstanceId: kmInstance.id,
    instruction: ctx.instruction,
    triggerMessageId: ctx.triggerMessageId,
    modelProfileSnapshotJson: null,
  });

  sendProgress(ctx, '等待子智能体', 40);

  const pollTimeout = 120000;
  const deadline = Date.now() + pollTimeout;

  while (Date.now() < deadline) {
    ctx.signal.throwIfAborted();

    const run = ctx.services.getRunStatus(subRunId);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
      if (run.status !== 'completed') {
        const errMsg = run.errorMessage || `子 Run 状态: ${run.status}`;
        return { subAgentResult: `知识管理员执行未完成: ${errMsg}`, messages: [{ role: 'system', content: 'delegate: KM 未完成' }] };
      }

      let resultText = '';
      if (run.resultMessageId) {
        const messageContent = ctx.services.getMessageContent(run.resultMessageId);
        if (messageContent) {
          resultText = messageContent;
        }
      }

      if (!resultText) {
        resultText = '知识管理员已完成处理但未返回文本结果。';
      }

      logger.info(`异步委派 KM 完成 (subRun=${subRunId})`);
      return { subAgentResult: resultText, messages: [{ role: 'system', content: 'delegate: KM 异步返回结果' }] };
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`子 Run ${subRunId} 在 ${pollTimeout}ms 内未完成`);
}

async function synthesize(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  sendProgress(ctx, '汇总子智能体结果', 70);

  const snapshot = await ctx.services.buildContextSnapshot(ctx.projectId, ctx.agentInstanceId, ctx.triggerMessageId);
  const snapshotText = ctx.services.renderSnapshotToText(snapshot);
  const memoryContext = ctx.services.buildMemoryContext(ctx.projectId, ctx.agentInstanceId);
  const messages = buildMessages(ctx, ORCHESTRATOR_SYSTEM_PROMPT, snapshot, snapshotText, memoryContext);
  const assistantContent = state.messages.find((m) => m.role === 'assistant')?.content ?? '';
  messages.push({ role: 'assistant', content: assistantContent });

  if (state.subAgentResult) {
    messages.push({ role: 'user', content: `知识管理员返回了以下结果：\n\n${state.subAgentResult}\n\n请根据这些信息给出最终回复。` });
  } else {
    messages.push({ role: 'user', content: '请直接回复用户。' });
  }

  const tools = buildAiTools(ctx, 'orchestrator');
  const finalResult = await ctx.services.generateText('reasoning', messages, { tools });

  let artifacts: Array<{ relativePath: string; content: string }> = [];

  if (finalResult.toolCalls && finalResult.toolCalls.length > 0) {
    const { results: toolResults, artifacts: toolArtifacts } = await executeToolCalls(finalResult.toolCalls, ctx);
    artifacts = toolArtifacts;
    const toolResultText = toolResults.join('\n');
    const processedText = finalResult.text ? finalResult.text + '\n\n---\n\n' + toolResultText : toolResultText;
    const { processedText: finalText, artifacts: textArtifacts } = await processToolCalls(processedText, ctx);
    artifacts = [...artifacts, ...textArtifacts];
    sendProgress(ctx, '生成最终回复', 90);
    return { finalResponse: finalText, messages: [{ role: 'assistant', content: finalText }], artifacts };
  }

  const { processedText, artifacts: textArtifacts } = await processToolCalls(finalResult.text, ctx);
  sendProgress(ctx, '生成最终回复', 90);
  return { finalResponse: processedText, messages: [{ role: 'assistant', content: processedText }], artifacts };
}

async function respond(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  const text = state.finalResponse;
  if (!text) return {};

  const artifactLines = (state.artifacts ?? []).map(
    (a) => `📄 **${a.relativePath}** 已发布到工作区\n\`\`\`\n${a.content}\n\`\`\``,
  );
  const combinedText = artifactLines.length > 0 ? text + '\n\n---\n\n' + artifactLines.join('\n\n') : text;
  const contentJson = JSON.stringify({ schemaVersion: 1, text: combinedText, mentions: [], stagedUploadIds: [] });

  const agentMsgId = await ctx.services.insertMessage(ctx.projectId, ctx.agentInstanceId, 'text', contentJson);
  ctx.services.setResultMessage(ctx.runId, agentMsgId);

  ctx.services.emitEvent({
    type: 'run.status',
    projectId: ctx.projectId,
    run: { id: ctx.runId, agentId: ctx.agentInstanceId, status: 'completed' },
  });
  ctx.services.emitEvent({
    type: 'message.committed',
    projectId: ctx.projectId,
    messageId: agentMsgId,
    senderId: ctx.agentInstanceId,
    content: contentJson,
  });

  ctx.services.storeMemory(ctx.projectId, ctx.agentInstanceId, 'interaction', ctx.instruction.slice(0, 500), 0.6);
  ctx.services.consolidateMemory(ctx.projectId, ctx.agentInstanceId);
  ctx.services.extractLongTermMemory(ctx.projectId, ctx.agentInstanceId);

  return {};
}

function routeAfterAnalyze(state: GraphState): string {
  return state.needsKnowledgeManager ? 'delegateToKM' : 'respond';
}

function buildOrchestratorGraph() {
  const builder = new StateGraph(OrchestratorAnnotation)
    .addNode('analyzeIntent', analyzeIntent as any)
    .addNode('delegateToKM', delegateToKM as any)
    .addNode('synthesize', synthesize as any)
    .addNode('respond', respond as any)
    .addEdge('__start__', 'analyzeIntent')
    .addConditionalEdges('analyzeIntent', routeAfterAnalyze, ['delegateToKM', 'respond'])
    .addEdge('delegateToKM', 'synthesize')
    .addEdge('synthesize', 'respond')
    .addEdge('respond', END);

  return builder.compile();
}

let _compiledOrchestrator: ReturnType<typeof buildOrchestratorGraph> | null = null;

export async function runOrchestrator(ctx: IGraphContext): Promise<void> {
  const logger = ctx.services.getLogger();

  try {
    if (!_compiledOrchestrator) {
      _compiledOrchestrator = buildOrchestratorGraph();
    }

    const snapshot = await ctx.services.buildContextSnapshot(ctx.projectId, ctx.agentInstanceId, ctx.triggerMessageId);

    try {
      const projectRoot = ctx.services.getProjectRoot(ctx.projectId);
      await ctx.services.writeContextManifest(snapshot, projectRoot);
    } catch (err) {
      logger.warn(`写入 context-manifest.json 失败（非致命）`);
    }

    const initialState: OrchestratorGraphState = {
      projectId: ctx.projectId,
      agentInstanceId: ctx.agentInstanceId,
      runId: ctx.runId,
      instruction: ctx.instruction,
      triggerMessageId: ctx.triggerMessageId,
      messages: [],
      subAgentResult: '',
      finalResponse: '',
      needsKnowledgeManager: false,
      artifacts: [],
    };

    await _compiledOrchestrator.invoke(initialState, {
      configurable: { ctx },
      signal: ctx.signal,
    });

    logger.info(`Orchestrator StateGraph 完成 (runId=${ctx.runId})`);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      ctx.services.setRunStatus(ctx.runId, 'cancelled');
      return;
    }
    throw err;
  }
}
