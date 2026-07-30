import { Annotation, END, StateGraph } from '@langchain/langgraph';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './prompts.js';
import { extractToolCalls } from './tool-utils.js';
import type { IGraphContext, OrchestratorGraphState, ExecContextSnapshot, AgentRole, CLIDelegation } from './types.js';
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
  needsCLIDelegation: Annotation<boolean>({
    value: (_a: boolean, b: boolean) => b,
    default: () => false,
  }),
  cliDelegations: Annotation<CLIDelegation[]>({
    value: (a: CLIDelegation[], b: CLIDelegation[]) => [...a, ...b],
    default: () => [],
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

  // 链式上下文检测：如果当前 Run 是由子智能体 @mention 触发，直接从上下文读取子智能体结果
  const parentRunId = ctx.services.getParentRunId(ctx.runId);
  if (parentRunId) {
    // 尝试从触发消息中读取子智能体结果
    const triggerMessage = snapshot.messages.find((m) => {
      try {
        const parsed = JSON.parse(m.content);
        if (!parsed || !Array.isArray(parsed.mentions)) return false;
        return parsed.mentions.some((mt: { target: { scope: string; id: string } }) => mt.target?.id === ctx.agentInstanceId);
      } catch { return false; }
    });

    if (triggerMessage) {
      let subAgentText = '';
      try {
        const parsed = JSON.parse(triggerMessage.content);
        subAgentText = parsed.text ?? triggerMessage.content;
      } catch {
        subAgentText = triggerMessage.content;
      }

      sendProgress(ctx, '汇总子智能体结果', 50);
      return {
        messages: [{ role: 'system', content: `子智能体结果: ${subAgentText}` }],
        needsKnowledgeManager: false,
        needsCLIDelegation: false,
        finalResponse: '',
        subAgentResult: subAgentText,
        artifacts: [],
      };
    }
  }

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
  const needsCLI = !needsKM && rawText.trim().startsWith('NEED_CLI');
  const cleanText = needsKM
    ? rawText.replace(/^NEED_KM\s*\n?/, '').trim()
    : needsCLI
      ? rawText.replace(/^NEED_CLI\s*\n?/, '').trim()
      : rawText;

  const { processedText: finalText, artifacts: textArtifacts } = await processToolCalls(cleanText, ctx);
  artifacts = [...artifacts, ...textArtifacts];

  const stage = needsKM ? '准备委派' : needsCLI ? '准备 CLI 委派' : '生成回复';
  const progress = needsKM ? 30 : needsCLI ? 30 : 50;
  sendProgress(ctx, stage, progress);

  return {
    messages: [{ role: 'assistant', content: finalText }],
    needsKnowledgeManager: needsKM,
    needsCLIDelegation: needsCLI,
    finalResponse: needsKM || needsCLI ? '' : finalText,
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

  // 消息模式委派：发送消息 @知识管理员，然后结束当前 Run
  // KM 被 @mention 触发后自动执行，完成后 @回统筹智能体
  const mentions = [{
    target: { scope: 'instance', id: kmInstance.id } as const,
    label: kmInstance.id,
    start: 0,
    end: 0,
  }];

  const contentJson = JSON.stringify({
    schemaVersion: 1,
    text: ctx.instruction,
    mentions,
    stagedUploadIds: [],
  });

  // 通过 insertMessage 发送消息，它会自动触发 processMessageMentions 调度 KM
  await ctx.services.insertMessage(ctx.projectId, ctx.agentInstanceId, 'text', contentJson);

  logger.info(`Orchestrator 已通过消息委派 KM (project=${ctx.projectId}, km=${kmInstance.id})`);

  return {
    subAgentResult: '',
    messages: [{ role: 'system', content: `委派给知识管理员: ${ctx.instruction}` }],
  };
}

async function delegateCLI(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  const logger = ctx.services.getLogger();

  // 从 analyzeIntent 的 assistant 消息中解析 NEED_CLI 委派行
  const assistantMsg = state.messages.find((m) => m.role === 'assistant');
  if (!assistantMsg) {
    logger.warn('delegateCLI: 未找到 assistant 消息');
    return { subAgentResult: '' };
  }

  const lines = assistantMsg.content.split('\n').filter((l) => l.includes(':'));
  const delegations: CLIDelegation[] = [];
  const errors: string[] = [];

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const agentInstanceId = line.slice(0, colonIdx).trim();
    const instruction = line.slice(colonIdx + 1).trim();
    if (!agentInstanceId || !instruction) continue;

    try {
      const toolResult = await ctx.services.executeTool('delegate_tasks', {
        projectId: ctx.projectId,
        agentInstanceId,
        instruction,
        parentRunId: ctx.runId,
      }, 'orchestrator', { runId: ctx.runId, projectId: ctx.projectId });

      // 从工具返回中提取子 Run ID: "任务已委派给智能体 xxx，子 Run ID: <id>（深度 1）"
      const subRunMatch = toolResult.match(/子 Run ID: (\w+)/);
      const subRunId = subRunMatch ? subRunMatch[1]! : '';

      delegations.push({
        agentInstanceId,
        agentName: '',
        subRunId,
        instruction,
        status: subRunId ? 'pending' : 'failed',
        result: toolResult,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`委派给 ${agentInstanceId} 失败: ${errMsg}`);
      delegations.push({
        agentInstanceId,
        agentName: '',
        subRunId: '',
        instruction,
        status: 'failed',
        result: errMsg,
      });
    }
  }

  if (delegations.length === 0) {
    logger.warn('delegateCLI: 未解析出有效的委派行');
    return { subAgentResult: '', cliDelegations: [] };
  }

  logger.info(`delegateCLI: 已委派 ${delegations.length} 个子任务`);

  return {
    cliDelegations: delegations,
    messages: [
      ...state.messages,
      { role: 'system', content: `CLI 委派完成: ${delegations.length} 个子任务已创建${errors.length ? '，错误: ' + errors.join('; ') : ''}` },
    ],
  };
}

const MAX_COLLECT_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

async function collectCLIResults(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  sendProgress(ctx, '收集 CLI 子智能体结果', 50);

  const logger = ctx.services.getLogger();
  const delegations = [...state.cliDelegations];
  const deadline = Date.now() + MAX_COLLECT_WAIT_MS;

  logger.info(`collectCLIResults: 等待 ${delegations.length} 个子任务完成`);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 轮询所有子 Run 直到完成或超时
  let allDone = false;
  while (!allDone && Date.now() < deadline) {
    ctx.signal.throwIfAborted();
    allDone = true;

    for (let i = 0; i < delegations.length; i++) {
      const d = delegations[i];
      if (!d || d.status === 'completed' || d.status === 'failed') continue;

      try {
        const runStatus = ctx.services.getRunStatus(d.subRunId);
        if (runStatus.status === 'completed') {
          let result = '';
          if (runStatus.resultMessageId) {
            const msgContent = ctx.services.getMessageContent(runStatus.resultMessageId);
            if (msgContent) {
              result = msgContent;
            }
          }
          delegations[i] = { agentInstanceId: d.agentInstanceId, agentName: d.agentName, subRunId: d.subRunId, instruction: d.instruction, status: 'completed', result };
        } else if (['failed', 'cancelled', 'interrupted'].includes(runStatus.status)) {
          const errMsg = runStatus.errorMessage ?? `子任务 ${d.subRunId} 状态: ${runStatus.status}`;
          delegations[i] = { agentInstanceId: d.agentInstanceId, agentName: d.agentName, subRunId: d.subRunId, instruction: d.instruction, status: 'failed', result: errMsg };
        } else {
          allDone = false;
        }
      } catch {
        allDone = false;
      }
    }

    if (!allDone) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  // 超时未完成的标记为失败
  for (let i = 0; i < delegations.length; i++) {
    const d = delegations[i];
    if (d && (d.status === 'pending' || d.status === 'running')) {
      delegations[i] = { agentInstanceId: d.agentInstanceId, agentName: d.agentName, subRunId: d.subRunId, instruction: d.instruction, status: 'failed', result: '超时未完成' };
    }
  }

  // 汇总结果
  const parts: string[] = [];
  let hasSuccess = false;
  let hasFailure = false;
  for (const d of delegations) {
    if (!d) continue;
    if (d.status === 'completed') {
      hasSuccess = true;
      parts.push(`--- ${d.agentName || d.agentInstanceId} 结果 ---\n${d.result || '(无输出)'}`);
    } else {
      hasFailure = true;
      parts.push(`--- ${d.agentName || d.agentInstanceId} 失败 ---\n${d.result}`);
    }
  }

  const summary = parts.join('\n\n');

  const successCount = delegations.filter((d) => d && d.status === 'completed').length;
  const failCount = delegations.filter((d) => d && d.status === 'failed').length;
  logger.info(`collectCLIResults: ${successCount} 成功, ${failCount} 失败 (共 ${delegations.length} 个子任务)`);

  return {
    cliDelegations: delegations,
    subAgentResult: summary || '(无子任务结果)',
    messages: [
      ...state.messages,
      { role: 'system', content: `CLI 子任务汇总完成: ${successCount} 成功, ${failCount} 失败` },
    ],
  };
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
    messages.push({ role: 'user', content: `子智能体返回了以下结果：\n\n${state.subAgentResult}\n\n请根据这些信息给出最终回复。` });
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

  // 子智能体完成时 @回父智能体
  const mentions: Array<{ target: { scope: string; id: string }; label: string; start: number; end: number }> = [];
  const parentRunId = ctx.services.getParentRunId(ctx.runId);
  if (parentRunId) {
    const parentAgentId = ctx.services.getRunAgentInstanceId(parentRunId);
    if (parentAgentId) {
      mentions.push({
        target: { scope: 'instance', id: parentAgentId },
        label: parentAgentId,
        start: 0,
        end: 0,
      });
    }
  }

  const contentJson = JSON.stringify({ schemaVersion: 1, text: combinedText, mentions, stagedUploadIds: [] });

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
  if (state.needsKnowledgeManager) return 'delegateToKM';
  if (state.needsCLIDelegation) return 'delegateCLI';
  if (state.subAgentResult) return 'synthesize';
  return 'respond';
}

function routeAfterDelegate(state: GraphState): string {
  return state.subAgentResult ? 'synthesize' : 'respond';
}

function routeAfterCollect(state: GraphState): string {
  return state.subAgentResult ? 'synthesize' : 'respond';
}

function buildOrchestratorGraph() {
  const builder = new StateGraph(OrchestratorAnnotation)
    .addNode('analyzeIntent', analyzeIntent as any)
    .addNode('delegateToKM', delegateToKM as any)
    .addNode('delegateCLI', delegateCLI as any)
    .addNode('collectCLIResults', collectCLIResults as any)
    .addNode('synthesize', synthesize as any)
    .addNode('respond', respond as any)
    .addEdge('__start__', 'analyzeIntent')
    .addConditionalEdges('analyzeIntent', routeAfterAnalyze, ['delegateToKM', 'delegateCLI', 'respond'])
    .addConditionalEdges('delegateToKM', routeAfterDelegate, ['synthesize', 'respond'])
    .addEdge('delegateCLI', 'collectCLIResults')
    .addConditionalEdges('collectCLIResults', routeAfterCollect, ['synthesize', 'respond'])
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
      needsCLIDelegation: false,
      cliDelegations: [],
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
