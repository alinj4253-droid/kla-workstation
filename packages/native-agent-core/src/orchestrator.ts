import { Annotation, END, StateGraph } from '@langchain/langgraph';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './prompts.js';
import { extractToolCalls } from './tool-utils.js';
import type { IGraphContext, OrchestratorGraphState, ExecContextSnapshot, CLIDelegation } from './types.js';
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
    value: (_a: CLIDelegation[], b: CLIDelegation[]) => b,
    default: () => [],
  }),
  knowledgeCurated: Annotation<boolean>({
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

      if (call.name === 'publish_artifact' && result.startsWith('成果已发布到 ')) {
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

function sendTrace(
  ctx: IGraphContext,
  kind: 'plan' | 'reasoning' | 'handoff' | 'tool' | 'execution' | 'file' | 'warning',
  title: string,
  status: 'running' | 'completed' | 'failed',
  detail?: string,
): void {
  const trace = {
    id: `${ctx.runId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    title,
    status,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
    at: new Date().toISOString(),
  };
  ctx.services.addRunEvent(ctx.runId, 'run.trace', trace);
  ctx.services.emitEvent({ type: 'run.trace', projectId: ctx.projectId, runId: ctx.runId, agentId: ctx.agentInstanceId, trace });
}

type OrchestratorPhase = 'analyzing' | 'delegating' | 'waiting' | 'validating' | 'delivering' | 'completed';

function sendOrchestratorChecklist(
  ctx: IGraphContext,
  phase: OrchestratorPhase,
  details: Partial<Record<'understand' | 'decompose' | 'delegate' | 'wait' | 'validate' | 'deliver', string>> = {},
): void {
  const order: OrchestratorPhase[] = ['analyzing', 'delegating', 'waiting', 'validating', 'delivering', 'completed'];
  const phaseIndex = order.indexOf(phase);
  const statusFor = (completedAt: number, activeAt: number): 'pending' | 'in_progress' | 'completed' => {
    if (phase === 'completed' || phaseIndex >= completedAt) return 'completed';
    return phaseIndex === activeAt ? 'in_progress' : 'pending';
  };
  const checklist = {
    items: [
      { id: 'orchestrator-understand', title: '理解需求与交付边界', status: statusFor(1, 0), ...(details.understand ? { detail: details.understand } : {}) },
      { id: 'orchestrator-decompose', title: '拆解任务并确定执行顺序', status: statusFor(1, 0), ...(details.decompose ? { detail: details.decompose } : {}) },
      { id: 'orchestrator-delegate', title: '向合适的成员分配工作', status: statusFor(2, 1), ...(details.delegate ? { detail: details.delegate } : {}) },
      { id: 'orchestrator-wait', title: '等待成员返回可验收结果', status: statusFor(3, 2), ...(details.wait ? { detail: details.wait } : {}) },
      { id: 'orchestrator-validate', title: '验收并汇总成员成果', status: statusFor(4, 3), ...(details.validate ? { detail: details.validate } : {}) },
      { id: 'orchestrator-deliver', title: '向负责人交付最终结果', status: statusFor(5, 4), ...(details.deliver ? { detail: details.deliver } : {}) },
    ],
    updatedAt: new Date().toISOString(),
  };
  ctx.services.addRunEvent(ctx.runId, 'run.checklist', checklist);
  ctx.services.emitEvent({
    type: 'run.checklist',
    projectId: ctx.projectId,
    runId: ctx.runId,
    agentId: ctx.agentInstanceId,
    checklist,
  });
}

function instructionText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    if (typeof parsed.text === 'string') return parsed.text.trim();
  } catch { /* use raw instruction */ }
  return raw.trim();
}

export function isSimpleDirectTask(raw: string): boolean {
  const text = instructionText(raw).replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  if (!text || text.length > 180) return false;
  const asksCurrentFact = /天气|气温|温度|几点|时间|日期|星期几/u.test(text)
    && !/分析|报告|文件|表格|图表|调研|研究|整理|汇总|方案|代码|网页|html/iu.test(text);
  return /^(你好|您好|嗨|hello|hi|help|开始|继续|谢谢|感谢|收到|好的|ok|okay)[！!。.]?$/i.test(text)
    || asksCurrentFact
    || /^(?:你是谁|你能做什么|你有哪些能力|有什么帮助)/i.test(text);
}

function needsSpecialistWork(raw: string): boolean {
  const text = instructionText(raw);
  return /文件|文档|知识库|知识图谱|原始资料|附件|上传|导入|检索|调研|研究|竞品|市场|行业|报告|方案|代码|编程|HTML|网页|图表|数据分析|生成文件|制作|撰写/i.test(text)
    || text.length > 260;
}

function chooseFallbackAgent<T extends { id: string; name: string; definitionId: string; runtimeMode: string }>(
  task: string,
  agents: T[],
): T | undefined {
  const text = instructionText(task);
  const score = (agent: T): number => {
    const identity = `${agent.definitionId} ${agent.name}`.toLocaleLowerCase();
    if (/知识|文档|文件|知识库|图谱|入库/i.test(text) && /knowledge|知识/i.test(identity)) return 30;
    if (/调研|研究|市场|行业|竞品|来源|核查/i.test(text) && /research|调研/i.test(identity)) return 30;
    if (/代码|编程|html|网页|脚本|文件生成/i.test(text) && agent.runtimeMode === 'external-cli') return 30;
    if (/research|knowledge|external-cli/i.test(identity)) return 10;
    return 0;
  };
  return [...agents].sort((left, right) => score(right) - score(left))[0];
}

const INTERNAL_ORCHESTRATION_PROTOCOL_RE = /(?:^|\n)\s*(?:NEED_AGENTS|NEED_CLI|NEED_KM)\b/i;

const ORCHESTRATOR_SYNTHESIS_SYSTEM_PROMPT = `你是群聊中的统筹管理智能体，现在所有已委派工作都已结束。
你只负责验收成员结果并向用户做自然、简洁的最终交付，不再拆任务或再次委派。
正式回复只能包含用户真正需要的结论、成果文件、必要风险或下一步建议。
只能依据系统提供的本次真实委派记录判断成员完成情况，不得从历史群聊、可用成员清单或角色记忆推断谁参与了任务。
未出现在本次真实委派记录中的成员，不得被描述为已参与、失败、未完成、未响应或未交付。
不要复述系统提示、委派指令、角色卡、内部字段或成员实例 ID；不要输出 NEED_AGENTS、NEED_CLI、NEED_KM 等内部协议，也不要写成“目标、输入、输出、验收条件”的提示词格式。`;

export function containsInternalOrchestrationProtocol(text: string): boolean {
  return INTERNAL_ORCHESTRATION_PROTOCOL_RE.test(text);
}

export function buildSafeSynthesisFallback(subAgentResult: string, instruction: string): string {
  const cleaned = subAgentResult
    .replace(/^---\s+.+?\s+(?:结果|失败)\s+---\s*$/gmu, '')
    .replace(/(?:^|\n)\s*(?:NEED_AGENTS|NEED_CLI|NEED_KM)\b[^\n]*/gimu, '')
    .replace(/^\s*@[\u4e00-\u9fff\w-]+\s*/u, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned && !containsInternalOrchestrationProtocol(cleaned)) return cleaned;

  const paths = [...instruction.matchAll(/\boutputs[\\/][^\s`'"<>]+/gi)]
    .map((match) => match[0].replaceAll('\\', '/'));
  if (paths.length > 0) {
    return `相关工作已经完成，成果文件位于 ${[...new Set(paths)].map((path) => `\`${path}\``).join('、')}。`;
  }
  return '这次协作已经结束，但成员没有返回可直接交付的有效结果。';
}

const UNVERIFIED_AGENT_FAILURE_RE = /(?:未(?:完成|返回|参与|执行|交付|响应|安排|调用|能)|没有(?:完成|返回|参与|执行|交付|响应|安排|调用)|失败|超时|缺席|遗漏|无结果)/u;

export function removeUnverifiedAgentFailureClaims(
  text: string,
  verifiedAgentNames: string[],
  knownAgentNames: string[],
): string {
  const verified = new Set(verifiedAgentNames.map((name) => name.trim().toLocaleLowerCase()).filter(Boolean));
  const unverified = knownAgentNames
    .map((name) => name.trim())
    .filter((name) => name && !verified.has(name.toLocaleLowerCase()));
  if (unverified.length === 0 || !UNVERIFIED_AGENT_FAILURE_RE.test(text)) return text;

  const cleaned = text.split('\n').map((line) => {
    const segments = line.match(/[^。！？!?；;]+[。！？!?；;]?/gu) ?? [line];
    return segments.filter((segment) => {
      if (!UNVERIFIED_AGENT_FAILURE_RE.test(segment)) return true;
      const normalized = segment.toLocaleLowerCase();
      return !unverified.some((name) => normalized.includes(name.toLocaleLowerCase()));
    }).join('').trimEnd();
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

function buildVisibleDelegationInstruction(instruction: string, fallbackTask: string): string {
  const normalized = instruction
    .replace(/^(?:NEED_AGENTS|NEED_CLI|NEED_KM)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const goalMatch = normalized.match(/(?:^|[。；;])\s*目标[:：]\s*(.*?)(?=(?:输入|输出|验收条件)[:：]|$)/i);
  const quotedTask = normalized.match(/(?:开始)?(?:执行|完成)(?:用户任务)?[“"]([^”"]+)[”"]/i)?.[1];
  let summary = quotedTask
    ? `请完成“${quotedTask}”`
    : goalMatch?.[1]?.trim() || normalized || fallbackTask;
  summary = summary
    .replace(/^完成用户任务[“"]?/i, '请完成')
    .replace(/[”"]?[。；;]?\s*(?:输入|输出|验收条件)[:：][\s\S]*$/i, '')
    .replace(/[，,]?\s*(?:严禁|禁止)再?回复[\s\S]*$/i, '')
    .trim();
  if (!/^请/.test(summary)) summary = `请${summary}`;
  if (summary.length > 180) {
    const shortSentence = summary.slice(0, 180).replace(/[，,；;：:]?[^，,。；;！？!?]{0,36}$/, '');
    summary = shortSentence.length >= 60 ? shortSentence : `${summary.slice(0, 176)}...`;
  }
  const delivery = /html/i.test(normalized)
    ? '完成后把可直接打开的 HTML 文件和关键结论发回来。'
    : '完成后把结果和成果文件发回来。';
  return `这部分交给你：${summary.replace(/[。！？!?]+$/, '')}。${delivery}`;
}

function conciseTaskBrief(task: string): string {
  const normalized = task.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 260) return normalized;
  const sentence = normalized.slice(0, 260).replace(/[，,；;]?[^，,。；;！？!?]{0,48}$/, '').trim();
  return `${sentence.length >= 120 ? sentence : normalized.slice(0, 256)}…`;
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

  const task = instructionText(ctx.instruction);
  if (isSimpleDirectTask(task)) {
    sendProgress(ctx, '直接回答', 45);
    sendTrace(ctx, 'reasoning', '判断为轻量问题，直接回答', 'completed');
    const direct = await ctx.services.generateText('fast', [
      { role: 'system', content: '只回答用户这条轻量问题，语气自然简洁。不要委派成员、调用工具或输出内部协议。' },
      { role: 'user', content: task },
    ]);
    const text = direct.text.trim() || '我可以继续帮你处理。';
    return { messages: [{ role: 'assistant', content: text }], finalResponse: text, needsKnowledgeManager: false, needsCLIDelegation: false, artifacts: [] };
  }

  sendProgress(ctx, '分析意图', 10);
  sendTrace(ctx, 'reasoning', '分析用户目标与任务边界', 'running');
  sendOrchestratorChecklist(ctx, 'analyzing', {
    understand: conciseTaskBrief(instructionText(ctx.instruction)),
    decompose: '正在判断哪些工作可以并行，哪些工作需要等待前置结果。',
  });

  const snapshot = await ctx.services.buildContextSnapshot(ctx.projectId, ctx.agentInstanceId, ctx.triggerMessageId);
  const snapshotText = ctx.services.renderSnapshotToText(snapshot);
  const memoryContext = ctx.services.buildMemoryContext(ctx.projectId, ctx.agentInstanceId);
  const messages = buildMessages(ctx, ORCHESTRATOR_SYSTEM_PROMPT, snapshot, snapshotText, memoryContext);
  const availableAgents = ctx.services.getProjectDelegatableAgents(ctx.projectId)
    .filter((agent) => agent.id !== ctx.agentInstanceId);
  const roster = availableAgents.map((agent) => (
    `- ${agent.id} | ${agent.name} | ${agent.definitionId} | ${agent.runtimeMode}`
  )).join('\n');
  messages[0] = {
    role: 'system',
    content: `${messages[0]?.content ?? ORCHESTRATOR_SYSTEM_PROMPT}\n\n## 当前群聊可委派成员\n${roster || '- 无可用成员'}\n成员清单已经由系统确认，不要再次调用工具查询。请根据任务目标、成员能力和工作依赖自行决定分工，不要套用固定角色模板。`,
  };

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

  const result = await ctx.services.generateText('reasoning', messages);

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
  let needsCLI = !needsKM && /^(NEED_AGENTS|NEED_CLI)\b/.test(rawText.trim());
  let cleanText = needsKM
    ? rawText.replace(/^NEED_KM\s*\n?/, '').trim()
    : needsCLI
      ? rawText.replace(/^(NEED_AGENTS|NEED_CLI)\s*\n?/, '').trim()
      : rawText;

  if (needsKM) {
    const km = ctx.services.getKmInstance(ctx.projectId);
    if (km) {
      cleanText = `${km.id}: ${cleanText || instructionText(ctx.instruction)}`;
      needsKM = false;
      needsCLI = true;
    }
  }

  // 模型漏掉委派协议时，只对明显的专业/复合任务做一次能力兜底；轻量问题已在上面直答。
  if (!needsKM && !needsCLI && needsSpecialistWork(task)) {
    const fallback = chooseFallbackAgent(task, availableAgents);
    if (fallback) {
      cleanText = `${fallback.id}: ${buildVisibleDelegationInstruction(task, task)}`;
      needsCLI = true;
    }
  }

  sendTrace(
    ctx,
    'reasoning',
    needsKM || needsCLI ? '任务已拆解，准备委派成员' : '任务判断完成，准备直接回应',
    'completed',
    needsCLI ? '已形成可执行的成员分工' : undefined,
  );
  if (needsCLI) {
    const delegatedNames = cleanText.split('\n').map((line) => availableAgents.find((agent) => line.startsWith(`${agent.id}:`))?.name).filter(Boolean);
    sendOrchestratorChecklist(ctx, 'delegating', {
      understand: conciseTaskBrief(instructionText(ctx.instruction)),
      decompose: `已根据任务目标和成员能力形成 ${delegatedNames.length} 个工作包。`,
      delegate: delegatedNames.length > 0 ? `准备安排：${delegatedNames.join('、')}` : '正在匹配合适的成员。',
    });
  }

  const { processedText: finalText, artifacts: textArtifacts } = await processToolCalls(cleanText, ctx);
  artifacts = [...artifacts, ...textArtifacts];

  const stage = needsKM ? '准备知识处理' : needsCLI ? '拆分并委派子任务' : '生成回复';
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

  const targetAgent = ctx.services.getProjectDelegatableAgents(ctx.projectId)
    .find((agent) => agent.id === kmInstance.id);
  const delegationInstruction = `目标：${instructionText(ctx.instruction)}。\n输入：群聊工作区中的相关文件和知识。\n输出：知识处理结果、图谱/Wiki 状态及可验收摘要。\n验收条件：明确成功/失败项、来源和剩余风险。`;
  await ctx.services.sendDelegationMessage({
    projectId: ctx.projectId,
    senderId: ctx.agentInstanceId,
    parentRunId: ctx.runId,
    rootTriggerMessageId: ctx.triggerMessageId,
    targetAgentInstanceId: kmInstance.id,
    targetAgentName: targetAgent?.name ?? '知识管理智能体',
    instruction: delegationInstruction,
    visibleInstruction: buildVisibleDelegationInstruction(delegationInstruction, instructionText(ctx.instruction)),
  });

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

  // 从 analyzeIntent 的 assistant 消息中解析结构化智能体委派行。
  const assistantMsg = state.messages.find((m) => m.role === 'assistant');
  if (!assistantMsg) {
    logger.warn('delegateCLI: 未找到 assistant 消息');
    return { subAgentResult: '' };
  }

  const lines = assistantMsg.content.split('\n').filter((l) => l.includes(':'));
  const delegations: CLIDelegation[] = [];
  const errors: string[] = [];
  const availableAgents = new Map(
    ctx.services.getProjectDelegatableAgents(ctx.projectId)
      .filter((agent) => agent.id !== ctx.agentInstanceId)
      .map((agent) => [agent.id, agent]),
  );
  const task = instructionText(ctx.instruction);
  const seenTargets = new Set<string>();

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const agentInstanceId = line.slice(0, colonIdx).trim();
    const instruction = line.slice(colonIdx + 1).trim();
    if (!agentInstanceId || !instruction) continue;
    const targetAgent = availableAgents.get(agentInstanceId);
    if (!targetAgent || seenTargets.has(agentInstanceId)) continue;
    seenTargets.add(agentInstanceId);

    try {
      const visibleInstruction = buildVisibleDelegationInstruction(instruction, task);
      sendTrace(ctx, 'handoff', `委派任务给 ${targetAgent.name}`, 'running', visibleInstruction);
      const visibleDelegation = await ctx.services.sendDelegationMessage({
        projectId: ctx.projectId,
        senderId: ctx.agentInstanceId,
        parentRunId: ctx.runId,
        rootTriggerMessageId: ctx.triggerMessageId,
        targetAgentInstanceId: agentInstanceId,
        targetAgentName: targetAgent.name,
        instruction,
        visibleInstruction,
      });
      const subRunId = visibleDelegation.childRunIds[0] ?? '';
      const toolResult = subRunId ? `已通过群聊消息委派给${targetAgent.name}` : `委派消息已发送，但未能创建${targetAgent.name}的执行任务`;

      delegations.push({
        agentInstanceId,
        agentName: targetAgent.name,
        subRunId,
        instruction,
        status: subRunId ? 'pending' : 'failed',
        result: toolResult,
      });
      sendTrace(ctx, 'handoff', `已委派给 ${targetAgent.name}`, subRunId ? 'completed' : 'failed', toolResult);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`委派给 ${agentInstanceId} 失败: ${errMsg}`);
      delegations.push({
        agentInstanceId,
        agentName: targetAgent.name,
        subRunId: '',
        instruction,
        status: 'failed',
        result: errMsg,
      });
      sendTrace(ctx, 'handoff', `委派给 ${targetAgent.name} 失败`, 'failed', errMsg);
    }
  }

  if (delegations.length === 0) {
    logger.warn('delegateCLI: 未解析出有效的委派行');
    return { subAgentResult: '', cliDelegations: [] };
  }

  logger.info(`delegateCLI: 已委派 ${delegations.length} 个子任务`);

  const activeNames = delegations.map((delegation) => delegation.agentName);
  sendOrchestratorChecklist(ctx, activeNames.length > 0 ? 'waiting' : 'delegating', {
    understand: conciseTaskBrief(task),
    decompose: `${activeNames.join('、')}将按照统筹智能体生成的分工推进各自工作包。`,
    delegate: activeNames.length > 0 ? `已向${activeNames.join('、')}发出明确分工。` : '暂未形成有效委派。',
    ...(activeNames.length > 0 ? { wait: `正在等待${activeNames.join('、')}返回结果。` } : {}),
  });

  return {
    cliDelegations: delegations,
    messages: [
      ...state.messages,
      { role: 'system', content: `CLI 委派完成: ${delegations.length} 个子任务已创建${errors.length ? '，错误: ' + errors.join('; ') : ''}` },
    ],
  };
}

const MAX_COLLECT_WAIT_MS = 4 * 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 500;
const POST_TASK_KNOWLEDGE_PREFIX = 'KQ_POST_TASK_KNOWLEDGE_V1';

async function collectCLIResults(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  sendProgress(ctx, '收集子智能体结果', 50);
  const activeDelegations = state.cliDelegations;
  const activeNames = activeDelegations.map((delegation) => delegation.agentName);
  sendTrace(ctx, 'handoff', `等待${activeNames.join('、') || '成员'}返回结果`, 'running');
  sendOrchestratorChecklist(ctx, 'waiting', {
    understand: conciseTaskBrief(instructionText(ctx.instruction)),
    wait: `正在等待${activeNames.join('、') || '成员'}完成各自的工作包，最长等待 4 小时。`,
  });

  const logger = ctx.services.getLogger();
  const delegations = [...state.cliDelegations];
  const deadline = Date.now() + MAX_COLLECT_WAIT_MS;

  logger.info(`collectAgentResults: 等待 ${activeDelegations.length} 个子任务完成`);

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
  logger.info(`collectAgentResults: ${successCount} 成功, ${failCount} 失败 (共 ${delegations.length} 个子任务)`);
  sendTrace(ctx, 'execution', `子任务收集完成：${successCount} 成功，${failCount} 失败`, failCount > 0 && successCount === 0 ? 'failed' : 'completed');

  return {
    cliDelegations: delegations,
    subAgentResult: summary || '(无子任务结果)',
    messages: [
      ...state.messages,
      { role: 'system', content: `子任务汇总完成: ${successCount} 成功, ${failCount} 失败` },
    ],
  };
}

function collectDeliverablePaths(text: string, artifacts: Array<{ relativePath: string }>): string[] {
  const paths = [...text.matchAll(/(?:^|[\s`'"])(outputs[\\/][^\s`'"<>|:*?]+)/gim)]
    .map((match) => match[1]?.replaceAll('\\', '/'))
    .filter((path): path is string => Boolean(path));
  return [...new Set([...artifacts.map((artifact) => artifact.relativePath.replaceAll('\\', '/')), ...paths])].slice(0, 30);
}

async function curateKnowledge(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();
  if (state.knowledgeCurated || !state.subAgentResult.trim()) return { knowledgeCurated: true };

  const km = ctx.services.getKmInstance(ctx.projectId);
  if (!km?.profileEnabled) {
    sendTrace(ctx, 'warning', '未找到可用的知识管理智能体，跳过知识归集', 'completed');
    return { knowledgeCurated: true };
  }
  const kmAgent = ctx.services.getProjectDelegatableAgents(ctx.projectId).find((agent) => agent.id === km.id);
  const kmName = kmAgent?.name ?? '知识管理智能体';
  const payload = {
    originalTask: instructionText(ctx.instruction).slice(0, 8_000),
    teamResults: state.subAgentResult.slice(0, 40_000),
    deliverables: collectDeliverablePaths(state.subAgentResult, state.artifacts),
  };
  const instruction = `${POST_TASK_KNOWLEDGE_PREFIX}\n${JSON.stringify(payload)}`;
  const visibleInstruction = '主体工作已经完成。请归集这次协作中可复用的知识与经验，形成知识文档；再判断是否存在值得复用的业务流程，适用时梳理流程，不适用就说明原因。';

  sendProgress(ctx, '归集知识与业务经验', 68);
  sendTrace(ctx, 'handoff', `安排${kmName}归集知识与业务经验`, 'running');
  try {
    const delegation = await ctx.services.sendDelegationMessage({
      projectId: ctx.projectId,
      senderId: ctx.agentInstanceId,
      parentRunId: ctx.runId,
      rootTriggerMessageId: ctx.triggerMessageId,
      targetAgentInstanceId: km.id,
      targetAgentName: kmName,
      instruction,
      visibleInstruction,
    });
    let subRunId = delegation.childRunIds[0] ?? '';
    if (!subRunId) {
      subRunId = ctx.services.createSubRun({
        projectId: ctx.projectId,
        agentInstanceId: km.id,
        instruction,
        requestedByType: 'agent',
        requestedById: ctx.agentInstanceId,
        parentRunId: ctx.runId,
        modelProfileSnapshotJson: null,
      });
      ctx.services.addRunEvent(subRunId, 'run.anchor', { messageId: delegation.messageId });
      ctx.services.enqueueRun({
        runId: subRunId,
        projectId: ctx.projectId,
        agentInstanceId: km.id,
        instruction,
        triggerMessageId: ctx.triggerMessageId,
        modelProfileSnapshotJson: null,
      });
    }

    const deadline = Date.now() + MAX_COLLECT_WAIT_MS;
    let result = '';
    let failed = '';
    while (Date.now() < deadline) {
      ctx.signal.throwIfAborted();
      const status = ctx.services.getRunStatus(subRunId);
      if (status.status === 'completed') {
        if (status.resultMessageId) result = ctx.services.getMessageContent(status.resultMessageId) ?? '';
        break;
      }
      if (['failed', 'cancelled', 'interrupted'].includes(status.status)) {
        failed = status.errorMessage ?? `知识归集任务状态为 ${status.status}`;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (result) {
      sendTrace(ctx, 'handoff', `${kmName}已完成知识与业务经验归集`, 'completed');
      return {
        knowledgeCurated: true,
        subAgentResult: `${state.subAgentResult}\n\n--- ${kmName}知识归集结果 ---\n${result}`,
      };
    }
    sendTrace(ctx, 'warning', `${kmName}未返回可用的知识归集结果`, 'failed', failed || '等待超过 4 小时');
  } catch (error) {
    sendTrace(ctx, 'warning', '知识归集任务未能完成', 'failed', error instanceof Error ? error.message : String(error));
  }
  return { knowledgeCurated: true };
}

async function synthesize(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  sendProgress(ctx, '汇总子智能体结果', 70);
  sendTrace(ctx, 'reasoning', '验收子任务结果并生成用户摘要', 'running');
  sendOrchestratorChecklist(ctx, 'validating', {
    understand: conciseTaskBrief(instructionText(ctx.instruction)),
    validate: '正在核对成员结论、交付物完整性与剩余风险。',
  });

  const verifiedDelegations = state.cliDelegations.filter((delegation) => Boolean(delegation.subRunId));
  const verifiedAgentNames = [...new Set(verifiedDelegations.map((delegation) => delegation.agentName).filter(Boolean))];
  const verifiedRoster = verifiedDelegations.length > 0
    ? verifiedDelegations.map((delegation) => `- ${delegation.agentName}：${delegation.status === 'completed' ? '已完成' : '执行失败'}`).join('\n')
    : '- 无主任务子智能体委派记录';
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: `${ORCHESTRATOR_SYNTHESIS_SYSTEM_PROMPT}\n\n本次真实委派成员仅限：${verifiedAgentNames.join('、') || '无'}。`,
    },
    {
      role: 'user',
      content: `用户本次需求：\n${instructionText(ctx.instruction)}\n\n系统核验的本次子任务记录：\n${verifiedRoster}\n\n实际返回结果：\n${state.subAgentResult || '(无有效结果)'}\n\n请直接给出最终交付，不评价未被委派的成员。`,
    },
  ];

  let finalResult = await ctx.services.generateText('reasoning', messages);
  if (containsInternalOrchestrationProtocol(finalResult.text)) {
    ctx.services.getLogger().warn(`Orchestrator.synthesize: 拒绝提交内部调度协议 (runId=${ctx.runId})`);
    sendTrace(ctx, 'warning', '汇总内容包含内部调度信息，正在重新整理', 'running');
    finalResult = await ctx.services.generateText('reasoning', [
      { role: 'system', content: ORCHESTRATOR_SYNTHESIS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `用户原始需求：\n${instructionText(ctx.instruction)}\n\n成员执行结果：\n${state.subAgentResult || '(无有效结果)'}\n\n请直接给出最终交付。`,
      },
    ]);
  }
  if (containsInternalOrchestrationProtocol(finalResult.text)) {
    finalResult = {
      ...finalResult,
      text: buildSafeSynthesisFallback(state.subAgentResult, ctx.instruction),
      toolCalls: [],
    };
  }
  const knownAgentNames = ctx.services.getProjectDelegatableAgents(ctx.projectId).map((agent) => agent.name);
  const verifiedText = removeUnverifiedAgentFailureClaims(finalResult.text, verifiedAgentNames, knownAgentNames);
  finalResult = {
    ...finalResult,
    text: verifiedText || buildSafeSynthesisFallback(state.subAgentResult, ctx.instruction),
  };
  sendTrace(ctx, 'reasoning', '结果验收与汇总完成', 'completed');

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

  const text = containsInternalOrchestrationProtocol(state.finalResponse)
    ? buildSafeSynthesisFallback(state.subAgentResult, ctx.instruction)
    : state.finalResponse;
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
      const parentAgentName = ctx.services.getAgentDisplayName(parentAgentId) ?? '负责智能体';
      mentions.push({
        target: { scope: 'instance', id: parentAgentId },
        label: parentAgentName,
        start: 0,
        end: parentAgentName.length + 1,
      });
    }
  }

  const deliveryText = mentions[0] ? `@${mentions[0].label}\n\n${combinedText}` : combinedText;
  const contentJson = JSON.stringify({ schemaVersion: 1, text: deliveryText, mentions, stagedUploadIds: [] });

  sendOrchestratorChecklist(ctx, 'delivering', {
    understand: conciseTaskBrief(instructionText(ctx.instruction)),
    deliver: '正在发送结论与成果文件。',
  });
  const agentMsgId = await ctx.services.insertMessage(ctx.projectId, ctx.agentInstanceId, 'text', contentJson);
  sendTrace(ctx, 'execution', '向用户提交最终结果', 'completed');
  sendOrchestratorChecklist(ctx, 'completed', {
    understand: conciseTaskBrief(instructionText(ctx.instruction)),
    deliver: '最终结果已经交付。',
  });
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
  return state.subAgentResult ? 'curateKnowledge' : 'respond';
}

function routeAfterCuration(state: GraphState): string {
  return state.subAgentResult ? 'synthesize' : 'respond';
}

function buildOrchestratorGraph() {
  const builder = new StateGraph(OrchestratorAnnotation)
    .addNode('analyzeIntent', analyzeIntent as any)
    .addNode('delegateToKM', delegateToKM as any)
    .addNode('delegateCLI', delegateCLI as any)
    .addNode('collectCLIResults', collectCLIResults as any)
    .addNode('curateKnowledge', curateKnowledge as any)
    .addNode('synthesize', synthesize as any)
    .addNode('respond', respond as any)
    .addEdge('__start__', 'analyzeIntent')
    .addConditionalEdges('analyzeIntent', routeAfterAnalyze, ['delegateToKM', 'delegateCLI', 'synthesize', 'respond'])
    .addConditionalEdges('delegateToKM', routeAfterDelegate, ['synthesize', 'respond'])
    .addEdge('delegateCLI', 'collectCLIResults')
    .addConditionalEdges('collectCLIResults', routeAfterCollect, ['curateKnowledge', 'respond'])
    .addConditionalEdges('curateKnowledge', routeAfterCuration, ['synthesize', 'respond'])
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
      knowledgeCurated: false,
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
