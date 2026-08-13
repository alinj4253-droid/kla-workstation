import { Annotation, END, StateGraph } from '@langchain/langgraph';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './prompts.js';
import { extractToolCalls } from './tool-utils.js';
import type { IGraphContext, OrchestratorGraphState, ExecContextSnapshot, CLIDelegation, DelegatableAgentInfo } from './types.js';
import type { ModelMessage } from '@kunqing/model-core';

const MAX_TOOL_RETRIES = 3;

const OrchestratorAnnotation = Annotation.Root({
  projectId: Annotation<string>(),
  agentInstanceId: Annotation<string>(),
  runId: Annotation<string>(),
  instruction: Annotation<string>(),
  resolvedTask: Annotation<string>({
    value: (_a: string, b: string) => b,
    default: () => '',
  }),
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
  parallelDelegationApproved: Annotation<boolean>({
    value: (_a: boolean, b: boolean) => b,
    default: () => false,
  }),
  selfInstruction: Annotation<string>({
    value: (_a: string, b: string) => b,
    default: () => '',
  }),
  cliDelegations: Annotation<CLIDelegation[]>({
    value: (_a: CLIDelegation[], b: CLIDelegation[]) => b,
    default: () => [],
  }),
  recoveryCount: Annotation<number>({
    value: (_a: number, b: number) => b,
    default: () => 0,
  }),
  plannerHistory: Annotation<string[]>({
    value: (_a: string[], b: string[]) => b,
    default: () => [],
  }),
  materializationPass: Annotation<number>({
    value: (_a: number, b: number) => b,
    default: () => 0,
  }),
  reviewAttempted: Annotation<boolean>({
    value: (_a: boolean, b: boolean) => b,
    default: () => false,
  }),
  reviewPass: Annotation<boolean>({
    value: (_a: boolean, b: boolean) => b,
    default: () => false,
  }),
  reviewFindings: Annotation<string>({
    value: (_a: string, b: string) => b,
    default: () => '',
  }),
  draftArtifactPath: Annotation<string>({
    value: (_a: string, b: string) => b,
    default: () => '',
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

type RunTraceKind = 'plan' | 'reasoning' | 'handoff' | 'tool' | 'execution' | 'file' | 'warning';
type RunTraceStatus = 'running' | 'completed' | 'failed';
const activeTraceIdsByRun = new Map<string, Map<RunTraceKind, string>>();

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
  kind: RunTraceKind,
  title: string,
  status: RunTraceStatus,
  detail?: string,
): void {
  const activeForRun = activeTraceIdsByRun.get(ctx.runId) ?? new Map<RunTraceKind, string>();
  const activeId = activeForRun.get(kind);
  const traceId = activeId ?? `${ctx.runId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (status === 'running') {
    activeForRun.set(kind, traceId);
    activeTraceIdsByRun.set(ctx.runId, activeForRun);
  } else if (activeId) {
    activeForRun.delete(kind);
    if (activeForRun.size === 0) activeTraceIdsByRun.delete(ctx.runId);
  }
  const trace = {
    id: traceId,
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

// 工作树事件是增量发送的，按 run 保留已经发生的阶段，保证右侧看到完整链条；
// 轻量直答不会进入这里，因此不会凭空出现固定流程节点。
const checklistDetailsByRun = new Map<string, Partial<Record<'understand' | 'decompose' | 'delegate' | 'wait' | 'validate' | 'deliver', string>>>();

function sendOrchestratorChecklist(
  ctx: IGraphContext,
  phase: OrchestratorPhase,
  details: Partial<Record<'understand' | 'decompose' | 'delegate' | 'wait' | 'validate' | 'deliver', string>> = {},
): void {
  const accumulatedDetails = {
    ...(checklistDetailsByRun.get(ctx.runId) ?? {}),
    ...details,
  };
  if (phase === 'completed') checklistDetailsByRun.delete(ctx.runId);
  else checklistDetailsByRun.set(ctx.runId, accumulatedDetails);
  type ChecklistKey = 'understand' | 'decompose' | 'delegate' | 'wait' | 'validate' | 'deliver';
  type ChecklistStatus = 'pending' | 'in_progress' | 'completed';
  const statuses: Record<OrchestratorPhase, Record<ChecklistKey, ChecklistStatus>> = {
    analyzing: { understand: 'in_progress', decompose: 'pending', delegate: 'pending', wait: 'pending', validate: 'pending', deliver: 'pending' },
    delegating: { understand: 'completed', decompose: 'completed', delegate: 'in_progress', wait: 'pending', validate: 'pending', deliver: 'pending' },
    waiting: { understand: 'completed', decompose: 'completed', delegate: 'completed', wait: 'in_progress', validate: 'pending', deliver: 'pending' },
    validating: { understand: 'completed', decompose: 'completed', delegate: 'completed', wait: 'completed', validate: 'in_progress', deliver: 'pending' },
    delivering: { understand: 'completed', decompose: 'completed', delegate: 'completed', wait: 'completed', validate: 'completed', deliver: 'in_progress' },
    completed: { understand: 'completed', decompose: 'completed', delegate: 'completed', wait: 'completed', validate: 'completed', deliver: 'completed' },
  };
  const definitions: Array<{ id: string; key: ChecklistKey; title: string }> = [
    { id: 'orchestrator-understand', key: 'understand', title: '理解需求与交付边界' },
    { id: 'orchestrator-decompose', key: 'decompose', title: '拆解任务并确定执行顺序' },
    { id: 'orchestrator-delegate', key: 'delegate', title: '向合适的成员分配工作' },
    { id: 'orchestrator-wait', key: 'wait', title: '等待成员返回结果' },
    { id: 'orchestrator-validate', key: 'validate', title: '核对结果与剩余缺口' },
    { id: 'orchestrator-deliver', key: 'deliver', title: '向负责人交付最终结果' },
  ];
  const items = definitions
    .filter((definition) => accumulatedDetails[definition.key] !== undefined)
    .map((definition) => ({
      id: definition.id,
      title: definition.title,
      status: statuses[phase][definition.key],
      detail: accumulatedDetails[definition.key],
    }));
  const checklist = {
    items,
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

const CONTEXT_FOLLOW_UP_RE = /(上面|上述|前面|之前|刚才|这个|这些|这份|该内容|按此|基于此|把它|继续|接着|然后|另外|顺便|补充一下|再补充|发出来|发给我|直接发|发出文件|发个文件|把文件发|文件给我|导出(?:一下|出来)?|整理成文件|梳理成文件|整理成文档|梳理成文档)|^(?:那|那么)(?:帮我|请|就|再)/iu;
const DEFAULT_FILE_DELIVERY_RE = /(?:整理|梳理).{0,12}(?:成|为).{0,6}(?:文件|文档|报告)|(?:写|编写|撰写|起草).{0,80}(?:文件|文档|报告)|(?:发出|发送|发(?:个|一份)?|输出|生成|制作).{0,8}(?:文件|文档|报告)|(?:文件|文档|报告).{0,8}(?:发出|发送|给我)/iu;
const EXPLICIT_FILE_FORMAT_RE = /\b(?:html?|pdf|docx?|xlsx?|pptx?|md|markdown|txt|csv|json)\b|网页|幻灯片|演示文稿|表格|电子表格|Word\s*文档|PDF\s*文件/iu;
const DEFAULT_FORMAL_DOCUMENT_RE = /(?:写|编写|撰写|起草|整理|制作|生成).{0,24}(?:邀请函|通知函|公函|函件|通知书|公告|制度|手册|说明书)/iu;
const SHORT_EDIT_FOLLOW_UP_RE = /^(?:请)?(?:再|然后|另外|顺便)?(?:把|将)?(?:标题|内容|结果|方案|报告|文件|第[一二三四五六七八九十\d]+(?:部分|章|节))?.{0,24}(?:改成|改为|修改|调整|增加|加上|补充|删掉|删除|替换|保存|导出|发出|发送)/iu;
const CONVERSATION_STATUS_REFERENCE_RE = /(刚才|方才|之前|前面|上一步|上一轮|最近|现在|当前|目前)/u;
const CONVERSATION_STATUS_QUESTION_RE = /(?:做了|干了|完成了|处理了|执行了|发生了|生成了|产出了).{0,8}(?:什么|哪些|哪一项)|(?:进展|状态|情况).{0,8}(?:如何|怎样|怎么样|到哪|到哪里)|(?:做到|进行到).{0,8}(?:哪|哪里|什么阶段)|谁.{0,16}(?:做|完成|处理|生成|产出)(?:了|的)?|(?:完成|结束|处理完|做完)了?(?:吗|没有|没)|在做什么/u;
const CONVERSATION_STATUS_COMMAND_RE = /^(?:请|帮我|麻烦)?\s*(?:继续|接着|重新|重做|再做|执行|处理|修改|调整|整理|梳理|生成|制作|创建|发送|发出|导出|保存|补充|删除)|(?:把|将).{0,36}(?:修改|调整|整理|梳理|生成|制作|创建|发送|发出|导出|保存|补充|删除)|(?:继续|接着).{0,24}(?:任务|工作|处理|执行)/u;

/** 识别只询问最近对话或执行事实、并未要求继续工作的轻量追问。 */
export function isConversationStatusQuestion(raw: string): boolean {
  const text = instructionText(raw).replace(/\s+/g, ' ').trim();
  if (!text || text.length > 120) return false;
  return CONVERSATION_STATUS_REFERENCE_RE.test(text)
    && CONVERSATION_STATUS_QUESTION_RE.test(text)
    && !CONVERSATION_STATUS_COMMAND_RE.test(text);
}

function buildConversationStatusHistory(snapshot: ExecContextSnapshot, currentInstruction: string): string {
  const history = snapshot.messages
    .filter((message, index, all) => !(
      index === all.length - 1
      && message.role === 'user'
      && instructionText(message.content) === currentInstruction
    ))
    .slice(-16)
    .map((message) => `${message.role === 'user' ? '用户' : (message.senderName || '群聊成员')}：${instructionText(message.content).slice(0, 1_200)}`)
    .join('\n');
  return history || '没有可供核对的更早消息。';
}

export function needsConversationTaskResolution(raw: string): boolean {
  const task = instructionText(raw).replace(/\s+/g, ' ').trim();
  return CONTEXT_FOLLOW_UP_RE.test(task)
    || (task.length <= 120 && SHORT_EDIT_FOLLOW_UP_RE.test(task))
    || (task.length <= 160 && DEFAULT_FILE_DELIVERY_RE.test(task) && !EXPLICIT_FILE_FORMAT_RE.test(task));
}

export function requiresHtmlDeliverable(raw: string): boolean {
  const task = instructionText(raw);
  return /\bhtml?\b|网页文件|HTML成果文件|HTML 成果文件/iu.test(task)
    || ((DEFAULT_FILE_DELIVERY_RE.test(task) || DEFAULT_FORMAL_DOCUMENT_RE.test(task)) && !EXPLICIT_FILE_FORMAT_RE.test(task));
}

/**
 * 判断用户是否在要求一个可交付成果，而不只是要一段检索结果。
 * 这是完成守卫，不是固定工作流：后续由统筹规划器决定由谁、以什么方式产出。
 */
export function requiresArtifactDeliverable(raw: string): boolean {
  const task = instructionText(raw).replace(/\s+/g, ' ').trim();
  if (!task) return false;
  if (requiresHtmlDeliverable(task)) return true;
  const asksToCreate = /(?:写|编写|撰写|起草|整理|梳理|汇总|归纳|生成|制作|输出|导出|发布|交付|提交|发送|发出)/iu.test(task);
  const artifactNoun = /(?:文件|材料|文档|报告|方案|邀请函|通知函|公函|函件|通知书|公告|手册|说明书|白皮书|清单|表格|网页|页面|图表|演示文稿|PPT|邮件|脚本|代码|成果)/iu.test(task);
  const asksToSendExisting = /(?:把|将)?(?:上面|上述|前面|刚才|这份|该|最终)?(?:文件|材料|文档|报告|成果)(?:发|发送|发出|给我|交付|导出)/iu.test(task);
  return (asksToCreate && artifactNoun) || asksToSendExisting;
}

/** 材料类成果通常需要一次独立核验，但是否安排仍由统筹层结合成员和风险决定。 */
export function requiresQualityReview(raw: string): boolean {
  const task = instructionText(raw);
  return requiresArtifactDeliverable(task)
    && /(?:材料|报告|方案|邀请函|通知函|公函|函件|通知书|公告|制度|规则|规范|手册|说明书|白皮书|调研|分析|汇报|总结)/iu.test(task);
}

export function requiresMaterialReviewWorkflow(raw: string): boolean {
  const task = instructionText(raw);
  return requiresHtmlDeliverable(task)
    && /材料|文件|报告|文档|方案|邀请函|通知函|公函|函件|通知书|公告|总结|汇报|制度|规则|规范|手册|说明书|白皮书|分析|调研|梳理|整理/iu.test(task);
}

const KNOWLEDGE_EVIDENCE_GAP_RE = /(?:没有找到|未找到|找不到|暂无|没有可靠|无可靠)[\s\S]{0,512}(?:证据|资料|知识|文档|文件|结果)|知识库.{0,12}(?:缺口|为空|没有|无)|(?:当前无法完成|未能完成|失败).{0,20}(?:知识处理|知识检索|文件解析|文档解析)/iu;

/** completed Run 也可能只是明确汇报了知识缺口，不能被当作可交付证据。 */
export function isKnowledgeEvidenceMissing(raw: string): boolean {
  return KNOWLEDGE_EVIDENCE_GAP_RE.test(instructionText(raw));
}

export function applyDeliverableDefaults(resolvedTask: string, currentInstruction: string): string {
  const task = resolvedTask.trim() || instructionText(currentInstruction);
  if (!requiresHtmlDeliverable(`${currentInstruction}\n${task}`)) return task;
  if (/成果文件必须作为群聊附件发布/iu.test(task)) return task;
  return `${task}\n\n交付要求：生成一个内容完整、可直接打开的 HTML 文件，保存到 outputs/ 下并使用有意义的文件名；完成后必须把该成果文件作为群聊附件发布。群聊正式消息只保留简短结论和文件说明，不要粘贴 HTML 源码，不要发送临时文件。`;
}

function parsedResolvedTask(text: string): string | null {
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as { resolvedTask?: unknown };
    return typeof parsed.resolvedTask === 'string' && parsed.resolvedTask.trim().length >= 4
      ? parsed.resolvedTask.trim().slice(0, 8_000)
      : null;
  } catch {
    return null;
  }
}

export async function resolveConversationTask(
  ctx: IGraphContext,
  snapshot: ExecContextSnapshot,
  currentInstruction: string,
): Promise<string> {
  if (!needsConversationTaskResolution(currentInstruction)) {
    return applyDeliverableDefaults(currentInstruction, currentInstruction);
  }

  const candidates = snapshot.messages
    .filter((message, index, all) => !(index === all.length - 1 && message.role === 'user' && instructionText(message.content) === currentInstruction));
  // 多智能体的内部消息很容易挤掉真正的用户需求。还原任务时优先保留最近用户轮次，
  // 同时带少量群聊结果，既能继承需求链，也不会把整个群聊重新塞进模型。
  const selectedIndexes = new Set<number>();
  const takeLatest = (role: 'user' | 'assistant', limit: number): void => {
    let remaining = limit;
    for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
      if (candidates[index]?.role !== role) continue;
      selectedIndexes.add(index);
      remaining -= 1;
    }
  };
  takeLatest('user', 8);
  takeLatest('assistant', 4);
  const previousMessages = candidates.filter((_message, index) => selectedIndexes.has(index));
  if (previousMessages.length === 0) return applyDeliverableDefaults(currentInstruction, currentInstruction);
  const history = previousMessages.map((message) => `${message.role === 'user' ? '用户' : '群聊'}：${instructionText(message.content).slice(0, 1_200)}`).join('\n');

  try {
    const resolved = await ctx.services.generateText('fast', [
      {
        role: 'system',
        content: '你负责把多轮对话中的最后一句用户要求还原成一条独立、完整、可执行的任务。优先沿用用户此前明确提出和修订的要求，群聊回复只用于识别已有结果；不得让智能体的委派话术覆盖用户目标。只使用给出的对话事实，不猜测缺失内容；保留前文主题、范围、关键要求和已有成果。若最后一句要求“整理/梳理成文件”但未指定格式，默认交付单个 HTML 文件并在群聊中发送文件。只输出 JSON：{"resolvedTask":"完整任务"}。',
      },
      {
        role: 'user',
        content: `最近对话：\n${history}\n\n用户最后一句：\n${currentInstruction}`,
      },
    ]);
    const resolvedTask = parsedResolvedTask(resolved.text);
    if (resolvedTask) return applyDeliverableDefaults(resolvedTask, currentInstruction);
  } catch {
    // 模型解析失败时，保留最近用户主题并追加本轮要求，避免只转发一句失去指代的信息。
  }

  const previousUserTask = [...previousMessages].reverse().find((message) => message.role === 'user')?.content;
  const fallback = previousUserTask
    ? `${instructionText(previousUserTask)}\n\n本轮补充要求：${currentInstruction}`
    : currentInstruction;
  return applyDeliverableDefaults(fallback, currentInstruction);
}

function effectiveTask(state: GraphState, ctx: IGraphContext): string {
  return instructionText(state.resolvedTask || ctx.instruction);
}

export function isSimpleDirectTask(raw: string): boolean {
  const text = instructionText(raw).replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  if (!text || text.length > 180) return false;
  const asksLocalClock = /几点|时间|日期|星期几/u.test(text)
    && !/天气|气温|温度|分析|报告|文件|表格|图表|调研|研究|整理|汇总|方案|代码|网页|html/iu.test(text);
  return /^(你好|您好|嗨|hello|hi|help|开始|谢谢|感谢|收到|好的|ok|okay)[！!。.]?$/i.test(text)
    || asksLocalClock
    || /^(?:你是谁|你能做什么|你有哪些能力|有什么帮助)/i.test(text);
}

function needsFreshExternalInformation(raw: string): boolean {
  const text = instructionText(raw).replace(/\s+/g, ' ').trim();
  return /(?:今天|今日|现在|当前|实时|最新|近期).{0,18}(?:天气|气温|温度|降雨|空气质量|新闻|政策|市场|行情|价格|股价|汇率|路况)|(?:天气|气温|温度|降雨|空气质量|新闻|行情|股价|汇率).{0,18}(?:今天|今日|现在|当前|实时|最新)/iu.test(text);
}

function needsSpecialistWork(raw: string): boolean {
  const text = instructionText(raw);
  return needsFreshExternalInformation(text)
    || /文件|文档|邀请函|通知函|公函|函件|通知书|公告|知识库|知识图谱|原始资料|附件|上传|导入|检索|调研|研究|竞品|市场|行业|报告|方案|代码|编程|HTML|网页|图表|数据分析|生成文件|制作|撰写|起草|编写/i.test(text)
    || text.length > 260;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferExplicitNaturalDelegation(
  text: string,
  agents: DelegatableAgentInfo[],
): DelegatableAgentInfo | undefined {
  const candidates = agents.flatMap((agent) => {
    const name = escapeRegExp(agent.name);
    const pattern = new RegExp(`(?:我(?:先|现在|接下来)?|先|现在|接下来)?(?:安排|委派|交给|让|请)\\s*@?${name}.{0,36}(?:查|找|搜索|检索|调研|核对|核验|编写|起草|整理|生成|处理|完成|制作|验收|修改|返修|提供)`, 'iu');
    const match = pattern.exec(text);
    if (!match || /(?:无需|不用|不必|暂不)[^。！？\n]{0,12}$/.test(text.slice(Math.max(0, match.index - 16), match.index))) return [];
    return [{ agent, index: match.index }];
  });
  return candidates.sort((left, right) => left.index - right.index)[0]?.agent;
}

function chooseFallbackAgent<T extends { id: string; name: string; definitionId: string; runtimeMode: string }>(
  task: string,
  agents: T[],
): T | undefined {
  const text = instructionText(task);
  const score = (agent: T): number => {
    const identity = `${agent.definitionId} ${agent.name}`.toLocaleLowerCase();
    let value = /research|knowledge|external-cli/i.test(identity) ? 10 : 0;
    if (requiresArtifactDeliverable(text) && requiresQualityReview(text) && isMaterialWriterAgent(agent)) value += 90;
    if (requiresArtifactDeliverable(text) && /材料|报告|方案|文档|文件|网页|页面|整理|梳理|汇总/iu.test(text)
      && isMaterialWriterAgent(agent)) value += 70;
    if (/知识|文档|文件|知识库|图谱|入库/i.test(text) && /knowledge|知识/i.test(identity)) value += 30;
    if (/调研|研究|市场|行业|竞品|来源|核查/i.test(text) && /research|调研/i.test(identity)) value += 30;
    if (needsFreshExternalInformation(text) && /research|调研/i.test(identity)) value += 100;
    // 明确需要 HTML/网页成果时，优先选择具备实际文件生成能力的外部执行智能体。
    if (requiresHtmlDeliverable(text) && agent.runtimeMode === 'external-cli') value += 60;
    else if (/代码|编程|网页|脚本|文件生成/i.test(text) && agent.runtimeMode === 'external-cli') value += 35;
    return value;
  };
  return [...agents].sort((left, right) => score(right) - score(left))[0];
}

function chooseArtifactAgent<T extends { id: string; name: string; definitionId: string; runtimeMode: string }>(
  task: string,
  agents: T[],
): T | undefined {
  const materialWriter = agents.find((agent) => isMaterialWriterAgent(agent));
  if (materialWriter) return materialWriter;
  const executableAgents = agents.filter((agent) => (
    !isAcceptanceReviewerAgent(agent)
    && !isKnowledgeManagerAgent(agent)
    && !isResearcherAgent(agent)
  ));
  return chooseFallbackAgent(task, executableAgents);
}

function chooseReviewerAgent<T extends { id: string; name: string; definitionId: string; runtimeMode: string }>(agents: T[]): T | undefined {
  return agents.find((agent) => isAcceptanceReviewerAgent(agent));
}

function needsLocalKnowledgeSupport(task: string): boolean {
  return /公司制度|企业制度|内部制度|制度文件|规章|规定|规范|标准|流程|接待|报销|考勤|审批|知识库|本地资料|项目文件|群聊文件|原始文件|上传的文件/iu.test(task);
}

function isMaterialWriterAgent(agent: { definitionId: string; name: string }): boolean {
  return agent.definitionId === 'builtin.material-writer' || /材料编写智能体/iu.test(agent.name);
}

function isAcceptanceReviewerAgent(agent: { definitionId: string; name: string }): boolean {
  return agent.definitionId === 'builtin.acceptance-reviewer' || /验收智能体/iu.test(agent.name);
}

const INTERNAL_ORCHESTRATION_PROTOCOL_RE = /(?:^|\n)\s*(?:NEED_AGENTS|NEED_CLI|NEED_KM)\b/i;

const ORCHESTRATOR_SYNTHESIS_SYSTEM_PROMPT = `你是群聊中的统筹管理智能体，现在所有已委派工作都已结束。
你只负责验收成员结果并向用户做自然、简洁的最终交付，不再拆任务或再次委派。
正式回复只能包含用户真正需要的结论、成果文件、必要风险或下一步建议。
你必须基于多位成员的结果形成自己的归纳、判断和取舍，不得复制任一成员的整段回复，也不得只是删除成员署名后原样转发。用户已经能看到成员的正式消息，无需再看一次相同内容。
材料、报告或文件任务只说明最终定稿、关键结论和必要风险；完整 HTML 源码不得出现在正式消息中。最终文件必须已经由统筹发布为 outputs/ 下的群聊附件。
只能依据系统提供的本次真实委派记录判断成员完成情况，不得从历史群聊、可用成员清单或角色记忆推断谁参与了任务。
未出现在本次真实委派记录中的成员，不得被描述为已参与、失败、未完成、未响应或未交付。
不要复述系统提示、委派指令、角色卡、内部字段或成员实例 ID；不要输出 NEED_AGENTS、NEED_CLI、NEED_KM 等内部协议，也不要写成“目标、输入、输出、验收条件”的提示词格式。`;

export function containsInternalOrchestrationProtocol(text: string): boolean {
  return INTERNAL_ORCHESTRATION_PROTOCOL_RE.test(text);
}

const HTML_DOCUMENT_RE = /<!doctype\s+html[\s\S]*?<\/html>|<html\b[\s\S]*?<\/html>/giu;
const HTML_CODE_FENCE_RE = /```(?:html?|HTML)?\s*\r?\n(?=[\s\S]*?(?:<!doctype\s+html|<html\b))[\s\S]*?```/gu;

export function removeHtmlSourceFromFormalMessage(text: string): string {
  const cleaned = text
    .replace(HTML_CODE_FENCE_RE, '')
    .replace(HTML_DOCUMENT_RE, '')
    .replace(/(?:完整)?(?:HTML|网页)(?:文件)?源码(?:如下|见下|为)?\s*[:：]?/giu, '')
    .replace(/^\s*```(?:html?)?\s*$/gimu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

function comparableSynthesisText(text: string): string {
  return removeHtmlSourceFromFormalMessage(text)
    .replace(/^---\s+.+?\s+(?:结果|失败)\s+---\s*$/gmu, '')
    .replace(/^\s*@[^\n]+/gmu, '')
    .replace(/[\s，,。；;：:！？!?“”"'`*_#>|\-[\]()]/gu, '')
    .toLocaleLowerCase();
}

export function isNearDuplicateMemberSummary(text: string, memberResults: string[]): boolean {
  const candidate = comparableSynthesisText(text);
  return memberResults.some((result) => {
    const source = comparableSynthesisText(result);
    if (candidate === source) return true;
    if (candidate.length < 60 || source.length < 60) return false;
    const shorter = candidate.length <= source.length ? candidate : source;
    const longer = candidate.length > source.length ? candidate : source;
    return shorter.length / longer.length >= 0.72 && longer.includes(shorter);
  });
}

export function buildSafeSynthesisFallback(subAgentResult: string, instruction: string): string {
  const paths = [...`${subAgentResult}\n${instruction}`.matchAll(/\boutputs[\\/][^\s`'"<>|:*?]+?\.(?:html?|pdf|md|txt|json|csv|png|jpe?g|webp|gif|docx?|xlsx?|pptx?|zip)/gi)]
    .map((match) => match[0].replaceAll('\\', '/'));
  if (paths.length > 0) {
    return `我已核对本轮协作结果，最终成果文件已经发送：${[...new Set(paths)].map((path) => `\`${path}\``).join('、')}。`;
  }
  return '我已核对本轮协作结果，但现有返回没有形成可直接交付的独立结论；请以群聊中已经展示的成员结果为依据。';
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
  const cleanSummary = summary
    .replace(/^请你?(?:负责|完成|处理|执行)?[：:\s]*/u, '')
    .replace(/[。！？!?]+$/, '')
    .trim();
  const fallbackSummary = conciseTaskBrief(fallbackTask).replace(/[。！？!?]+$/, '');
  const taskSummary = cleanSummary && normalizeComparableTask(cleanSummary) !== normalizeComparableTask(fallbackSummary)
    ? cleanSummary
    : fallbackSummary;
  const delivery = /html/i.test(normalized)
    ? '整理好后把可直接打开的文件发回群里。'
    : /文件|文档|报告|成果/iu.test(normalized)
      ? '完成后把成果文件和必要说明发回群里。'
      : '完成后把关键结果发回群里。';
  return `${taskSummary}。${delivery}`;
}

function isKnowledgeManagerAgent(agent: { definitionId: string; name: string }): boolean {
  return agent.definitionId === 'builtin.knowledge-manager' || /知识管理|知识管理员/i.test(agent.name);
}

function isResearcherAgent(agent: { definitionId: string; name: string }): boolean {
  return agent.definitionId === 'builtin.researcher' || /资料调研|研究智能体|调研智能体/i.test(agent.name);
}

function normalizeComparableTask(value: string): string {
  return instructionText(value).replace(/[\s，,。；;：:！？!?“”"'`]/g, '').toLocaleLowerCase();
}

function safeRunSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, '').slice(-24) || Date.now().toString(36);
}

const CONTEXT_ONLY_WORK_PACKAGE_RE = /^(?:请)?(?:(?:把|将)(?:上面|上述|前面|之前|刚才|这个|这些|这份|该内容|它|结果|内容|文件)|继续|接着|然后|再补充|补充一下|发出来|发给我|直接发|发出文件|发个文件|导出一下).{0,60}$/iu;
const GENERIC_WORK_PACKAGE_RE = /^(?:请)?(?:完成|处理|执行|推进|继续)(?:一下|这项|这个|本项|整项|全部)?(?:任务|工作|需求|内容)?[。.!！]?$/iu;

function needsWorkPackageRepair(proposed: string, currentInstruction: string): boolean {
  const normalized = normalizeComparableTask(proposed);
  if (!normalized) return true;
  if (normalized === normalizeComparableTask(currentInstruction)) return true;
  return CONTEXT_ONLY_WORK_PACKAGE_RE.test(proposed.trim()) || GENERIC_WORK_PACKAGE_RE.test(proposed.trim());
}

function buildExecutableWorkPackage(
  agent: { definitionId: string; name: string; runtimeMode: string },
  proposed: string,
  resolvedTask: string,
  currentInstruction: string,
): string {
  if (!needsWorkPackageRepair(proposed, currentInstruction)) {
    return isKnowledgeManagerAgent(agent) ? buildKnowledgeManagerTask(proposed) : proposed;
  }

  if (isKnowledgeManagerAgent(agent)) return buildKnowledgeManagerTask(resolvedTask);
  if (isResearcherAgent(agent)) {
    return `请围绕以下完整任务完成公开资料调研、事实核验和来源整理，为统筹负责人提供可直接使用的证据与结论；不要转派知识归集工作：\n${resolvedTask}`;
  }
  if (agent.runtimeMode === 'external-cli') {
    return `请根据以下完整任务直接完成可交付成果。需要文件时在当前群聊工作区 outputs/ 下生成正式成果并返回文件，不要只回复路径或源码：\n${resolvedTask}`;
  }
  return `请根据以下完整任务完成你职责范围内的工作，返回可核验结果和已经生成的成果文件：\n${resolvedTask}`;
}

function applyReviewDraftBoundary(
  agent: { definitionId: string; name: string },
  task: string,
  instruction: string,
  runId: string,
): string {
  if (!isMaterialWriterAgent(agent) || !requiresQualityReview(task)) return instruction;
  const draftPath = `.runtime/review-drafts/${safeRunSegment(runId)}/material-draft.html`;
  if (instruction.includes(draftPath) && /不要(?:写入|发布).*outputs/iu.test(instruction)) return instruction;
  return `${instruction}\n\n成果控制：请使用 review:writeDraft 将候选成果写入 ${draftPath}。在独立验收通过前不要写入 outputs/、不要发布群聊附件，也不要粘贴完整 HTML 源码；返修时覆盖同一路径。`;
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
  resolvedTask: string,
): ModelMessage[] {
  const systemContent = [
    systemPrompt,
    `\n\n## 上下文快照 (${snapshot.snapshotChecksum})\n${snapshotText}`,
    memoryContext ? `\n\n## 记忆补充\n${memoryContext}` : '',
  ].join('');

  return [
    { role: 'system', content: systemContent },
    // 最近消息已在快照文本中带上来源和截断信息；当前轮只注入解析后的完整任务。
    {
      role: 'user',
      content: resolvedTask === instructionText(ctx.instruction)
        ? resolvedTask
        : `用户本轮原话：${instructionText(ctx.instruction)}\n\n结合最近对话后，本轮需要完成的完整任务：\n${resolvedTask}`,
    },
  ];
}

async function analyzeIntent(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  const currentInstruction = instructionText(ctx.instruction);
  const snapshot = await ctx.services.buildContextSnapshot(ctx.projectId, ctx.agentInstanceId, ctx.triggerMessageId);
  if (isConversationStatusQuestion(currentInstruction)) {
    sendProgress(ctx, '回顾最近对话', 60);
    const direct = await ctx.services.generateText('fast', [
      {
        role: 'system',
        content: '你只负责回答用户对最近群聊或执行情况的追问。严格依据给出的最近消息，区分“已经完成”“正在执行”“只是计划或委派”，不要把计划当作完成事实；信息不足时直接说明无法从现有消息确认。回答自然、简洁，不要重新执行任务、委派成员、调用工具、生成任务清单或输出内部协议。',
      },
      {
        role: 'user',
        content: `最近消息：\n${buildConversationStatusHistory(snapshot, currentInstruction)}\n\n用户现在问：\n${currentInstruction}`,
      },
    ]);
    const text = direct.text.trim() || '从现有消息里还无法确认刚才的具体执行情况。';
    return { resolvedTask: currentInstruction, messages: [{ role: 'assistant', content: text }], finalResponse: text, needsKnowledgeManager: false, needsCLIDelegation: false, artifacts: [] };
  }
  const task = await resolveConversationTask(ctx, snapshot, currentInstruction);
  if (isSimpleDirectTask(task)) {
    sendProgress(ctx, '直接回答', 45);
    sendTrace(ctx, 'reasoning', '判断为轻量问题，直接回答', 'completed');
    const direct = await ctx.services.generateText('fast', [
      { role: 'system', content: '只回答用户这条轻量问题，语气自然简洁。不要委派成员、调用工具或输出内部协议。' },
      { role: 'user', content: task },
    ]);
    const text = direct.text.trim() || '我可以继续帮你处理。';
    return { resolvedTask: task, messages: [{ role: 'assistant', content: text }], finalResponse: text, needsKnowledgeManager: false, needsCLIDelegation: false, artifacts: [] };
  }

  sendProgress(ctx, '分析意图', 10);
  sendTrace(ctx, 'reasoning', '分析用户目标与任务边界', 'running');
  sendOrchestratorChecklist(ctx, 'analyzing', {
    understand: conciseTaskBrief(task),
    decompose: '正在判断哪些工作可以并行，哪些工作需要等待前置结果。',
  });

  const snapshotText = ctx.services.renderSnapshotToText(snapshot);
  const memoryContext = ctx.services.buildMemoryContext(ctx.projectId, ctx.agentInstanceId, task);
  const messages = buildMessages(ctx, ORCHESTRATOR_SYSTEM_PROMPT, snapshot, snapshotText, memoryContext, task);
  const availableAgents = ctx.services.getProjectDelegatableAgents(ctx.projectId)
    .filter((agent) => agent.id !== ctx.agentInstanceId);
  const roster = availableAgents.map((agent) => (
    `- ${agent.id} | ${agent.name} | ${agent.definitionId} | ${agent.runtimeMode}\n  公开调度画像：${agent.coordinationProfile || agent.capabilities || '按公开角色定义和授权技能完成专属工作'}`
  )).join('\n');
  messages[0] = {
    role: 'system',
    content: `${messages[0]?.content ?? ORCHESTRATOR_SYSTEM_PROMPT}\n\n## 当前群聊可委派成员及公开职责\n${roster || '- 无可用成员'}\n这些是成员允许向统筹公开的职责、适合输入和交付边界，不包含其私有记忆或私有适应内容。成员清单已经由系统确认，不要再次调用工具查询。请根据完整目标、当前执行缺口、成员职责和工作依赖决定下一步，不要套用固定角色模板。`,
  };

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

  // New planners may return the structured adaptive decision directly. Keep
  // the legacy line protocol as a compatibility input, but normalize both to
  // the same executable work-package representation.
  const structuredPlan = parseAdaptivePlannerDecision(rawText);
  // 接受模型在 JSON 前后附带解释或把 JSON 放进 Markdown 代码块的情况，
  // 但只把包含调度字段的对象视为规划结果，避免把普通工具 JSON 误当成委派。
  const hasStructuredPlan = extractAdaptivePlannerJson(rawText) !== null;
  let initialSelfInstruction = '';
  let parallelDelegationApproved = false;
  if (hasStructuredPlan && structuredPlan.status === 'complete') {
    const initialCompletion = buildCompletionState(task, '', artifacts, [], availableAgents);
    if (initialCompletion.missing.length > 0 || needsFreshExternalInformation(task)) {
      // 模型可能把“已经找到资料”误判为完成。系统只纠正这个完成边界，
      // 下一步仍交给自适应规划器决定具体成员和方式。
      const freshInfoAgent = needsFreshExternalInformation(task)
        ? availableAgents.find((agent) => isResearcherAgent(agent))
        : undefined;
      const localKnowledgeAgent = !freshInfoAgent && needsLocalKnowledgeSupport(task)
        ? availableAgents.find((agent) => isKnowledgeManagerAgent(agent))
        : undefined;
      const firstAgent = freshInfoAgent ?? localKnowledgeAgent ?? chooseArtifactAgent(task, availableAgents);
      if (firstAgent) {
        rawText = `NEED_AGENTS\n${firstAgent.id}: ${firstAgent === freshInfoAgent
          ? `请查询并核实这个问题所需的最新公开信息，返回带时间和来源的简洁事实，供统筹智能体最终回答：\n${task}`
          : firstAgent === localKnowledgeAgent
            ? buildKnowledgeManagerTask(task)
            : `请根据完整任务和后续工作需要，先处理成果整理步骤并发布正式文件：\n${task}`}`;
      } else {
        rawText = 'NEED_CLI';
      }
    } else {
      // A planner's `complete` is only a control decision. At the initial
      // decision point no user-facing answer exists yet, so let the root
      // orchestrator produce it and then pass through the normal completion
      // decision instead of exposing the JSON/reason as a chat response.
      initialSelfInstruction = structuredPlan.userMessage
        || structuredPlan.reason
        || `请直接完成并自然回答用户的完整需求：${task}`;
    }
  }
  if (hasStructuredPlan && structuredPlan.status === 'delegate' && structuredPlan.assignments.length > 0) {
    const runnableAssignments = selectRunnableAssignmentBatch(structuredPlan.assignments);
    parallelDelegationApproved = runnableAssignments.length > 1
      && Boolean(runnableAssignments[0]?.parallelGroup)
      && runnableAssignments.every((assignment) => assignment.parallelGroup === runnableAssignments[0]?.parallelGroup);
    const normalizedAssignments = runnableAssignments.flatMap((assignment) => {
      const agent = resolvePlannerAgentReference(assignment.agentInstanceId, availableAgents);
      if (!agent) return [];
      return [{ ...assignment, agentInstanceId: agent.id }];
    });
    if (normalizedAssignments.length > 0) {
      rawText = `NEED_AGENTS\n${normalizedAssignments.map((assignment) => (
        `${assignment.agentInstanceId}: ${[assignment.objective, assignment.inputs, assignment.expectedDeliverable].filter(Boolean).join('\\n')}`
      )).join('\n')}`;
    }
  }

  needsKM = rawText.trim().startsWith('NEED_KM');
  let selfInstruction = initialSelfInstruction || (hasStructuredPlan && structuredPlan.status === 'self_execute'
    ? structuredPlan.selfInstruction || structuredPlan.reason || task
    : '');
  let needsCLI = !needsKM && /^(NEED_AGENTS|NEED_CLI)\b/.test(rawText.trim());
  let cleanText = needsKM
    ? rawText.replace(/^NEED_KM\s*\n?/, '').trim()
    : needsCLI
      ? rawText.replace(/^(NEED_AGENTS|NEED_CLI)\s*\n?/, '').trim()
      : (selfInstruction ? '' : rawText);

  if (needsKM) {
    const km = ctx.services.getKmInstance(ctx.projectId);
    if (km) {
      // 结构化委派协议是一行一个工作包；知识任务正文仍会在真正发送时保留分段。
      const knowledgeTask = cleanText ? `${cleanText}\n完整任务背景：${task}` : task;
      cleanText = `${km.id}: ${buildKnowledgeManagerTask(knowledgeTask).replace(/\s*\n\s*/g, ' ')}`;
      needsKM = false;
      needsCLI = true;
    }
  }

  // 模型有时会用自然语言说“我先安排某智能体处理”，却没有输出结构化委派。
  // 这种计划说明不能直接作为最终答复，必须落成一条真实的群聊委派消息。
  if (!needsKM && !needsCLI && !selfInstruction) {
    const explicitlyNamedAgent = inferExplicitNaturalDelegation(rawText, availableAgents);
    if (explicitlyNamedAgent) {
      cleanText = `${explicitlyNamedAgent.id}: ${task}`;
      needsCLI = true;
    }
  }

  // 模型漏掉委派协议时，只对明显的专业/复合任务做一次能力兜底；轻量问题已在上面直答。
  if (!needsKM && !needsCLI && !selfInstruction && needsSpecialistWork(task)) {
    const fallback = chooseFallbackAgent(task, availableAgents);
    if (fallback) {
      cleanText = `${fallback.id}: ${buildVisibleDelegationInstruction(task, task)}`;
      needsCLI = true;
    }
  }

  sendTrace(
    ctx,
    'reasoning',
    needsKM || needsCLI ? '任务已拆解，准备委派成员' : selfInstruction ? '当前缺少合适成员，统筹智能体准备接手' : '任务判断完成，准备直接回应',
    'completed',
    needsCLI ? '已形成可执行的成员分工' : undefined,
  );
  if (needsCLI) {
    const delegatedNames = cleanText.split('\n').map((line) => availableAgents.find((agent) => line.startsWith(`${agent.id}:`))?.name).filter(Boolean);
    sendOrchestratorChecklist(ctx, 'delegating', {
      understand: conciseTaskBrief(task),
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
    resolvedTask: task,
    messages: [{ role: 'assistant', content: finalText }],
    needsKnowledgeManager: needsKM,
    needsCLIDelegation: needsCLI,
    parallelDelegationApproved,
    finalResponse: needsKM || needsCLI || selfInstruction ? '' : finalText,
    selfInstruction,
    artifacts,
  };
}

const KM_TRIGGER_KEYWORDS = [
  '文件', '文档', '上传', '导入', '知识库', '知识图谱', '搜索', '查找',
  'file', 'doc', 'upload', 'import', 'knowledge', 'graph', 'search', 'find',
  'wiki', '图谱', '入库', '实体', '关系', '分析文档',
];

export function buildKnowledgeManagerTask(raw: string): string {
  const task = instructionText(raw)
    .replace(/@(?:用户|统筹管理智能体|知识管理智能体)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const searchTerms = new Set<string>();
  const focus: string[] = [];

  if (/来访|接待|招待|领导到访/i.test(task)) {
    ['来访', '接待', '招待', '领导来访', '公务接待', '陪同', '食宿', '车辆保障'].forEach((term) => searchTerms.add(term));
    focus.push('接待标准、接待级别、陪同人员、食宿安排、用车或车辆保障');
  }
  if (/邀请函|通知函|公函|函件|通知书/i.test(task)) {
    ['邀请函', '参访邀请函', '来访邀请', '函件模板', '历史邀请函', '落款'].forEach((term) => searchTerms.add(term));
    focus.push('可复用的邀请函模板、历史范例、称谓、正文结构、落款和必要字段');
  }
  if (/地址|地点|位置|到访地|参访地/i.test(task)) {
    ['公司地址', '办公地址', '参访地点', '公司全称', '导航地址'].forEach((term) => searchTerms.add(term));
    focus.push('具体公司名称、可直接使用的详细地址及其可靠出处；不要只返回园区或城市名称');
  }
  if (/请假|休假|考勤|审批/i.test(task)) {
    ['请假', '休假', '考勤', '审批', '申请流程', '审批权限'].forEach((term) => searchTerms.add(term));
    focus.push('适用人员、天数对应的审批人、提交时限和申请流程');
  }
  if (/差旅|报销|招待费|费用/i.test(task)) {
    ['差旅', '报销', '招待费', '费用标准', '审批'].forEach((term) => searchTerms.add(term));
    focus.push('适用范围、费用标准、审批链路和所需凭证');
  }
  for (const match of task.matchAll(/[\u4e00-\u9fffA-Za-z0-9]{2,12}(?:制度|规定|规则|标准|流程)/g)) {
    searchTerms.add(match[0]);
  }

  const terms = [...searchTerms];
  const genericQuestion = terms.length === 0
    ? `需要回答的问题：${conciseTaskBrief(task)}`
    : `检索主题与扩展词：${terms.join('、')}`;
  const extractionFocus = focus.length > 0
    ? `重点提取：${focus.join('；')}`
    : '重点提取：与问题直接相关的适用范围、条件、标准、责任人和办理流程';
  const templateRequirement = requiresMaterialReviewWorkflow(task)
    ? '同时检索可用的写作模板、历史范例、固定章节、必填字段、格式要求和审批/签章约定，整理成简洁的模板说明并标注来源；若确实找不到，明确写“未找到可用写作模板”。'
    : '';
  return [
    '请在当前群聊的本地知识和共享知识中完成专题检索，不检索其他群聊私有内容。',
    genericQuestion,
    extractionFocus,
    templateRequirement,
    '返回文件名称、条款原文或准确摘要、页码/章节等出处；区分制度原文与合理推断。没有证据时明确说明知识库缺口，不要自行补写规定。',
  ].filter(Boolean).join('\n');
}

export function buildResearchFallbackTask(raw: string): string {
  const task = instructionText(raw).replace(/\s+/g, ' ').trim();
  return [
    `知识管理智能体暂未在当前群聊知识库找到足够的本地依据。请补充完成以下任务：${task}`,
    '优先使用资料调研智能体可用的网页搜索和公开来源，检索与来访、参访、接待、招待及相关安排直接有关的资料、通行做法和可引用依据。',
    '把可引用事实、来源链接或出处、适用范围和不确定项分开整理；如果公开资料也不足，明确列出待确认项和可以安全采用的通用安排，不要把推测写成公司制度原文。',
  ].join('\n');
}

async function delegateToKM(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();

  const logger = ctx.services.getLogger();
  const task = effectiveTask(state, ctx);

  // Pre-filter: check if the instruction actually references knowledge-related content
  const instruction = task.toLowerCase();
  const hasKMContext = KM_TRIGGER_KEYWORDS.some((kw) => instruction.includes(kw));
  if (!hasKMContext) {
    logger.warn(`Orchestrator.delegateToKM: LLM hallucinated NEED_KM, instruction="${task.slice(0, 100)}"`);
    return {
      subAgentResult: '',
      messages: [{ role: 'system', content: `delegate: SKIPPED — 无需知识管理处理，指令为: ${task}` }],
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
  const delegationInstruction = buildKnowledgeManagerTask(task);
  const sent = await ctx.services.sendDelegationMessage({
    projectId: ctx.projectId,
    senderId: ctx.agentInstanceId,
    parentRunId: ctx.runId,
    rootTriggerMessageId: ctx.triggerMessageId,
    targetAgentInstanceId: kmInstance.id,
    targetAgentName: targetAgent?.name ?? '知识管理智能体',
    instruction: delegationInstruction,
    visibleInstruction: buildVisibleDelegationInstruction(delegationInstruction, task),
  });

  logger.info(`Orchestrator 已通过消息委派 KM (project=${ctx.projectId}, km=${kmInstance.id})`);

  return {
    subAgentResult: sent.childRunIds[0] ? '' : '知识管理智能体委派消息已发送，但没有创建执行任务',
    ...(sent.childRunIds[0] ? {
      cliDelegations: [{
        agentInstanceId: kmInstance.id,
        agentName: targetAgent?.name ?? '知识管理智能体',
        subRunId: sent.childRunIds[0],
        instruction: delegationInstruction,
        status: 'pending' as const,
        result: '任务已创建',
      }],
    } : { cliDelegations: [] }),
    messages: [{ role: 'system', content: `委派给知识管理员: ${task}` }],
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
  const plannerHistory = [...(state.plannerHistory ?? [])];
  const availableAgents = new Map(
    ctx.services.getProjectDelegatableAgents(ctx.projectId)
      .filter((agent) => agent.id !== ctx.agentInstanceId)
      .map((agent) => [agent.id, agent]),
  );
  const task = effectiveTask(state, ctx);
  const seenTargets = new Set<string>();
  const plannedAssignments: Array<{ targetAgent: DelegatableAgentInfo; instruction: string }> = [];

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const agentInstanceId = line.slice(0, colonIdx).trim();
    const instruction = line.slice(colonIdx + 1).trim();
    if (!agentInstanceId || !instruction) continue;
    const targetAgent = availableAgents.get(agentInstanceId);
    if (!targetAgent || seenTargets.has(agentInstanceId)) continue;
    seenTargets.add(agentInstanceId);

    plannedAssignments.push({ targetAgent, instruction });
  }

  // 模型偶尔会返回错误实例 ID 或不完整协议。专业任务不能因此静默结束，
  // 这里使用完整任务和成员能力选出一个兜底执行者继续推进。
  if (plannedAssignments.length === 0) {
    const fallback = chooseFallbackAgent(task, [...availableAgents.values()]);
    if (fallback) plannedAssignments.push({ targetAgent: fallback, instruction: task });
  }

  if (plannedAssignments.length === 0) {
    // No suitable member is a planning result, not a terminal failure. The
    // adaptive collection loop can let the orchestrator execute the missing
    // step with its own model/tools.
    sendTrace(ctx, 'reasoning', '当前没有匹配的成员，保留给统筹智能体自行补齐', 'completed');
    return { cliDelegations: [], subAgentResult: '' };
  }

  const executableAssignments = state.parallelDelegationApproved
    ? plannedAssignments
    : plannedAssignments.slice(0, 1);

  for (const { targetAgent, instruction } of executableAssignments) {
    const agentInstanceId = targetAgent.id;

    try {
      const executableInstruction = applyReviewDraftBoundary(
        targetAgent,
        task,
        buildExecutableWorkPackage(targetAgent, instruction, task, ctx.instruction),
        ctx.runId,
      );
      plannerHistory.push(`${targetAgent.id}:${normalizeComparableTask(executableInstruction).slice(0, 240)}`);
      const visibleInstruction = buildVisibleDelegationInstruction(executableInstruction, task);
      sendTrace(ctx, 'handoff', `委派任务给 ${targetAgent.name}`, 'running', visibleInstruction);
      const visibleDelegation = await ctx.services.sendDelegationMessage({
        projectId: ctx.projectId,
        senderId: ctx.agentInstanceId,
        parentRunId: ctx.runId,
        rootTriggerMessageId: ctx.triggerMessageId,
        targetAgentInstanceId: agentInstanceId,
        targetAgentName: targetAgent.name,
        instruction: executableInstruction,
        visibleInstruction,
      });
      const subRunId = visibleDelegation.childRunIds[0] ?? '';
      const toolResult = subRunId ? `已通过群聊消息委派给${targetAgent.name}` : `委派消息已发送，但未能创建${targetAgent.name}的执行任务`;

      delegations.push({
        agentInstanceId,
        agentName: targetAgent.name,
        subRunId,
        instruction: executableInstruction,
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
        instruction: buildExecutableWorkPackage(targetAgent, instruction, task, ctx.instruction),
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
  const workPackages = delegations
    .map((delegation) => `${delegation.agentName}：${conciseTaskBrief(delegation.instruction)}`)
    .join('；');
  sendOrchestratorChecklist(ctx, activeNames.length > 0 ? 'waiting' : 'delegating', {
    understand: conciseTaskBrief(task),
    decompose: workPackages || `${activeNames.join('、')}将按照统筹智能体生成的分工推进各自工作包。`,
    delegate: activeNames.length > 0 ? `已向${activeNames.join('、')}发出明确分工。` : '暂未形成有效委派。',
    ...(activeNames.length > 0 ? { wait: `正在等待${activeNames.join('、')}返回结果。` } : {}),
  });

  return {
    cliDelegations: delegations,
    plannerHistory: [...new Set(plannerHistory)].slice(-24),
    messages: [
      ...state.messages,
      { role: 'system', content: `CLI 委派完成: ${delegations.length} 个子任务已创建${errors.length ? '，错误: ' + errors.join('; ') : ''}` },
    ],
  };
}

const MAX_COLLECT_WAIT_MS = 4 * 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 500;
const MAX_RECOVERY_PASSES = 8;
const POST_TASK_KNOWLEDGE_PREFIX = 'KQ_POST_TASK_KNOWLEDGE_V1';

export function parseAcceptanceDecision(text: string): 'pass' | 'fail' | 'unknown' {
  const decisions = [...text.matchAll(/(?:^|\n)\s*验收结论\s*[:：]\s*(不通过|通过)\s*(?:$|\n)/gu)];
  const latest = decisions.at(-1)?.[1];
  return latest === '通过' ? 'pass' : latest === '不通过' ? 'fail' : 'unknown';
}

function parseCurrentAcceptanceDecision(text: string): 'pass' | 'fail' | 'unknown' {
  const decisions = [...text.matchAll(/(?:^|\n)\s*验收结论\s*[:：]\s*(不通过|通过)\s*(?:$|\n)/gu)];
  const latestDecision = decisions.at(-1);
  if (!latestDecision) return 'unknown';

  // A writer may overwrite the same review draft after a failed review. In
  // that case the old verdict no longer describes the current draft, even
  // though it remains in the root run history for traceability.
  const latestDraftIndex = Math.max(
    text.lastIndexOf('.runtime/review-drafts/'),
    text.lastIndexOf('.runtime\\review-drafts\\'),
  );
  if (latestDraftIndex > (latestDecision.index ?? -1)) return 'unknown';
  return latestDecision[1] === '通过' ? 'pass' : 'fail';
}

async function delegateAndWait(
  ctx: IGraphContext,
  agent: DelegatableAgentInfo,
  instruction: string,
  visibleInstruction: string,
  traceTitle: string,
): Promise<CLIDelegation> {
  sendTrace(ctx, 'handoff', traceTitle, 'running', visibleInstruction);
  try {
    const sent = await ctx.services.sendDelegationMessage({
      projectId: ctx.projectId,
      senderId: ctx.agentInstanceId,
      parentRunId: ctx.runId,
      rootTriggerMessageId: ctx.triggerMessageId,
      targetAgentInstanceId: agent.id,
      targetAgentName: agent.name,
      instruction,
      visibleInstruction,
    });
    let subRunId = sent.childRunIds[0] ?? '';
    if (!subRunId) {
      subRunId = ctx.services.createSubRun({
        projectId: ctx.projectId,
        agentInstanceId: agent.id,
        instruction,
        requestedByType: 'agent',
        requestedById: ctx.agentInstanceId,
        parentRunId: ctx.runId,
        modelProfileSnapshotJson: null,
      });
      ctx.services.addRunEvent(subRunId, 'run.anchor', { messageId: sent.messageId });
      ctx.services.enqueueRun({
        runId: subRunId,
        projectId: ctx.projectId,
        agentInstanceId: agent.id,
        instruction,
        triggerMessageId: ctx.triggerMessageId,
        modelProfileSnapshotJson: null,
      });
    }

    const deadline = Date.now() + MAX_COLLECT_WAIT_MS;
    while (Date.now() < deadline) {
      ctx.signal.throwIfAborted();
      const status = ctx.services.getRunStatus(subRunId);
      if (status.status === 'completed') {
        const result = status.resultMessageId ? ctx.services.getMessageContent(status.resultMessageId) ?? '' : '';
        sendTrace(ctx, 'handoff', `${agent.name}已完成`, 'completed', result.slice(0, 500));
        return { agentInstanceId: agent.id, agentName: agent.name, subRunId, instruction, status: 'completed', result };
      }
      if (['failed', 'cancelled', 'interrupted'].includes(status.status)) {
        const result = status.errorMessage ?? `${agent.name}任务状态为 ${status.status}`;
        sendTrace(ctx, 'handoff', `${agent.name}未完成`, 'failed', result);
        return { agentInstanceId: agent.id, agentName: agent.name, subRunId, instruction, status: 'failed', result };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    sendTrace(ctx, 'handoff', `${agent.name}等待超过 4 小时`, 'failed');
    return { agentInstanceId: agent.id, agentName: agent.name, subRunId, instruction, status: 'failed', result: '等待超过 4 小时' };
  } catch (error) {
    const result = error instanceof Error ? error.message : String(error);
    sendTrace(ctx, 'handoff', `${agent.name}任务安排失败`, 'failed', result);
    return { agentInstanceId: agent.id, agentName: agent.name, subRunId: '', instruction, status: 'failed', result };
  }
}

type MaterialReviewResult = {
  delegations: CLIDelegation[];
  summary: string;
  reviewPass: boolean;
  reviewFindings: string;
  draftArtifactPath: string;
  artifacts: Array<{ relativePath: string; content: string }>;
};

async function runMaterialReviewWorkflow(
  ctx: IGraphContext,
  task: string,
  initialSummary: string,
  initialDelegations: CLIDelegation[],
): Promise<MaterialReviewResult | null> {
  if (!requiresMaterialReviewWorkflow(task)) return null;
  const agents = ctx.services.getProjectDelegatableAgents(ctx.projectId).filter((agent) => agent.id !== ctx.agentInstanceId);
  const writer = agents.find(isMaterialWriterAgent);
  const reviewer = agents.find(isAcceptanceReviewerAgent);
  if (!writer || !reviewer) return null;

  const delegations = [...initialDelegations];
  const resultParts = [initialSummary].filter(Boolean);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const completedKnowledge = initialDelegations.find((delegation) => (
    delegation.status === 'completed' && isKnowledgeManagerAgent(agentById.get(delegation.agentInstanceId) ?? { definitionId: '', name: delegation.agentName })
  ));
  const knowledgeEvidenceMissing = Boolean(completedKnowledge && isKnowledgeEvidenceMissing(completedKnowledge.result));
  const hasTemplateGuidance = Boolean(completedKnowledge && /模板|范例|示例|固定章节|必填字段|未找到可用写作模板/iu.test(completedKnowledge.result));

  if (knowledgeEvidenceMissing) {
    const completedResearch = initialDelegations.find((delegation) => (
      delegation.status === 'completed' && isResearcherAgent(agentById.get(delegation.agentInstanceId) ?? { definitionId: '', name: delegation.agentName })
    ));
    const researcher = completedResearch ? undefined : agents.find(isResearcherAgent);
    if (researcher) {
      sendProgress(ctx, '本地知识不足，正在补充公开资料', 56);
      const research = await delegateAndWait(
        ctx,
        researcher,
        buildResearchFallbackTask(task),
        '本地知识暂时没有足够依据。请从公开资料补充可引用信息；仍不能确认的内容请整理为待确认项和通用建议。',
        `安排${researcher.name}补充公开依据与降级方案`,
      );
      delegations.push(research);
      resultParts.push(`--- ${research.agentName}公开资料补充 ---\n${research.result || '(无有效结果)'}`);
    } else if (!completedResearch) {
      resultParts.push('--- 证据降级说明 ---\n本地知识不足，当前也没有可用的资料调研智能体。材料必须以通用接待方案初稿交付，并把未经核实的信息明确标记为“待确认”，不得伪造公司制度。');
    }
  }

  if (!hasTemplateGuidance && !knowledgeEvidenceMissing) {
    const knowledgeAgent = agents.find(isKnowledgeManagerAgent);
    if (knowledgeAgent) {
      sendProgress(ctx, '检索材料证据与写作模板', 56);
      const knowledgeInstruction = `${buildKnowledgeManagerTask(task)}\n请把模板说明与内容证据分开整理，供材料编写和后续验收使用。`;
      const knowledge = await delegateAndWait(
        ctx,
        knowledgeAgent,
        knowledgeInstruction,
        '请检索这份材料需要的本地证据，并同时查找可用的写作模板、章节和必填字段；找不到模板时请明确说明。',
        `安排${knowledgeAgent.name}准备证据与模板说明`,
      );
      delegations.push(knowledge);
      resultParts.push(`--- ${knowledge.agentName}证据与模板说明 ---\n${knowledge.result || '(无有效结果)'}`);
    } else {
      resultParts.push('--- 模板说明 ---\n当前群聊没有知识管理智能体，未取得本地模板说明；材料编写智能体需要自行设计框架，验收仍须以可用证据为准。');
    }
  }

  const safeRunId = ctx.runId.replace(/[^a-zA-Z0-9-]/g, '').slice(-24) || Date.now().toString(36);
  const draftArtifactPath = `.runtime/review-drafts/${safeRunId}/material-draft.html`;
  const outputPath = `outputs/material-report-${safeRunId}.html`;
  const evidence = resultParts.join('\n\n').slice(0, 42_000);
  const evidenceFallbackGuidance = knowledgeEvidenceMissing
    ? '本地知识没有提供充分制度依据。请结合公开调研结果生成可执行的接待安排初稿；所有未经可靠来源确认的人员、时间、地点、预算、审批、食宿、用车和公司制度内容必须明确标为“待确认”或“建议”，并单列待确认清单，禁止把推测写成既定事实。'
    : '';
  let reviewFindings = '';

  for (let pass = 1; ; pass += 1) {
    ctx.signal.throwIfAborted();
    sendProgress(ctx, pass === 1 ? '编写材料待审稿' : `按验收意见进行第 ${pass - 1} 次返修`, Math.min(62 + pass * 4, 86));
    const writerInstruction = pass === 1
      ? `请完成以下材料写作任务。先列出文档框架并建立章节与证据的对应关系，再逐章节补充，最后生成完整 HTML 待审稿。知识管理结果中存在模板说明时必须遵循；明确没有模板时再自行设计。\n\n完整任务：\n${task}\n\n证据、调研结果与模板说明：\n${evidence}\n\n${evidenceFallbackGuidance}\n\n待审稿必须通过 review:writeDraft 写入 ${draftArtifactPath}。不要写入 outputs/，不要发布附件，不要在消息中粘贴 HTML 源码。`
      : `请根据验收意见返修同一份材料待审稿。逐项修正问题，保留证据充分且未被指出的内容，完成后通过 review:writeDraft 覆盖 ${draftArtifactPath}。不要写入 outputs/ 或发布附件。\n\n完整任务：\n${task}\n\n原始证据与模板说明：\n${evidence}\n\n${evidenceFallbackGuidance}\n\n上次验收意见：\n${reviewFindings.slice(0, 18_000)}`;
    const written = await delegateAndWait(
      ctx,
      writer,
      writerInstruction,
      pass === 1
        ? '证据和模板说明已经就绪。请先列出材料框架，再逐章编写完整待审稿并提交验收。'
        : `上次验收没有通过。请根据具体意见完成第 ${pass - 1} 次返修并重新提交待审稿。`,
      pass === 1 ? `安排${writer.name}编写待审稿` : `安排${writer.name}返修待审稿`,
    );
    delegations.push(written);
    resultParts.push(`--- ${written.agentName}${pass === 1 ? '待审稿' : `第 ${pass - 1} 次返修`} ---\n${written.result || '(无有效结果)'}`);
    if (written.status !== 'completed') {
      return { delegations, summary: resultParts.join('\n\n'), reviewPass: false, reviewFindings: written.result || '待审稿未完成', draftArtifactPath, artifacts: [] };
    }

    sendProgress(ctx, `进行第 ${pass} 次独立验收`, Math.min(70 + pass * 5, 90));
    const reviewerInstruction = `请独立验收材料待审稿 ${draftArtifactPath}。先读取完整文件，再按用户需求和模板说明建立验收项，并使用本地知识检索逐项核验关键事实、数字、制度条款、结论和来源。发现变造、无依据扩写、遗漏、模板不符或 HTML 不完整时必须判定不通过并给出可执行返修清单；全部关键项通过才可判定通过。若本地知识确实没有依据，允许交付明确标注为初稿的通用方案，但所有未证实内容必须标为“待确认”或“建议”并列入待确认清单；只要没有把推测冒充制度原文，且文件仍能支持用户继续推进工作，就不应仅因知识库为空而拒绝。\n\n完整任务：\n${task}\n\n已取得的证据与模板说明：\n${evidence}\n\n回复最后必须单独一行写“验收结论：通过”或“验收结论：不通过”。不要修改或发布文件。`;
    const reviewed = await delegateAndWait(
      ctx,
      reviewer,
      reviewerInstruction,
      `请对第 ${pass} 版待审稿进行独立验收，从知识库取证核对关键内容，并明确给出通过或返修结论。`,
      `安排${reviewer.name}进行第 ${pass} 次验收`,
    );
    delegations.push(reviewed);
    reviewFindings = reviewed.result || '验收智能体未返回明确结论';
    resultParts.push(`--- ${reviewed.agentName}第 ${pass} 次验收 ---\n${reviewFindings}`);
    if (reviewed.status !== 'completed') {
      return { delegations, summary: resultParts.join('\n\n'), reviewPass: false, reviewFindings, draftArtifactPath, artifacts: [] };
    }
    const decision = parseAcceptanceDecision(reviewFindings);
    if (decision === 'pass') {
      sendProgress(ctx, '验收通过，正在发布最终成果', 92);
      sendTrace(ctx, 'file', '验收通过，提升正式成果文件', 'running', outputPath);
      const promoted = await ctx.services.executeTool('review:promoteArtifact', {
        projectId: ctx.projectId,
        draftRelativePath: draftArtifactPath,
        outputRelativePath: outputPath,
      }, 'orchestrator', { runId: ctx.runId, projectId: ctx.projectId });
      if (!promoted.startsWith('验收通过的成果已发布到 ')) {
        reviewFindings = `验收已通过，但正式成果发布失败：${promoted}`;
        sendTrace(ctx, 'file', '正式成果文件发布失败', 'failed', promoted);
        return { delegations, summary: resultParts.join('\n\n'), reviewPass: false, reviewFindings, draftArtifactPath, artifacts: [] };
      }
      await ctx.services.createFileRecord(ctx.projectId, outputPath, '', ctx.agentInstanceId, ctx.runId, '验收通过后由统筹智能体发布');
      sendTrace(ctx, 'file', '正式成果文件已发布', 'completed', outputPath);
      resultParts.push(`--- 统筹管理智能体最终发布 ---\n验收已通过，正式成果文件位于 ${outputPath}。`);
      return {
        delegations,
        summary: resultParts.join('\n\n'),
        reviewPass: true,
        reviewFindings,
        draftArtifactPath,
        artifacts: [{ relativePath: outputPath, content: '经材料编写与独立验收通过的正式成果文件' }],
      };
    }
    sendTrace(ctx, 'warning', decision === 'unknown' ? '验收结论不明确，按不通过处理' : '材料验收未通过，准备返修', 'completed', reviewFindings.slice(0, 500));
  }
}

type AdaptivePlannerAssignment = {
  stepId?: string;
  agentInstanceId: string;
  objective: string;
  inputs?: string;
  expectedDeliverable?: string;
  visibleMessage?: string;
  dependsOn?: string[];
  parallelGroup?: string;
};

type AdaptivePlannerDecision = {
  status: 'delegate' | 'self_execute' | 'complete' | 'ask_user';
  reason: string;
  assignments: AdaptivePlannerAssignment[];
  selfInstruction?: string;
  userMessage?: string;
};

function extractAdaptivePlannerJson(raw: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed);
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const object = parsed as Record<string, unknown>;
        if ('status' in object || 'assignments' in object || 'selfInstruction' in object || 'userMessage' in object) {
          return object;
        }
      }
    } catch { /* try the next candidate */ }
  }
  return null;
}

function parseAdaptivePlannerDecision(raw: string): AdaptivePlannerDecision {
  const trimmed = raw.trim();
  const parsed = extractAdaptivePlannerJson(raw);
  if (parsed) {
    const status = ['delegate', 'self_execute', 'complete', 'ask_user'].includes(String(parsed.status))
      ? String(parsed.status) as AdaptivePlannerDecision['status']
      : 'complete';
    const assignments = Array.isArray(parsed.assignments)
      ? parsed.assignments.flatMap((item): AdaptivePlannerAssignment[] => {
        if (!item || typeof item !== 'object') return [];
        const entry = item as Record<string, unknown>;
        const agentInstanceId = String(entry.agentInstanceId ?? entry.agentId ?? '').trim();
        const objective = String(entry.objective ?? entry.instruction ?? '').trim();
        if (!agentInstanceId || !objective) return [];
        return [{
          ...(entry.stepId ? { stepId: String(entry.stepId).trim() } : {}),
          agentInstanceId,
          objective,
          ...(entry.inputs ? { inputs: String(entry.inputs) } : {}),
          ...(entry.expectedDeliverable ? { expectedDeliverable: String(entry.expectedDeliverable) } : {}),
          ...(entry.visibleMessage ? { visibleMessage: String(entry.visibleMessage) } : {}),
          ...(Array.isArray(entry.dependsOn)
            ? { dependsOn: entry.dependsOn.map((value) => String(value).trim()).filter(Boolean) }
            : {}),
          ...(entry.parallelGroup ? { parallelGroup: String(entry.parallelGroup).trim() } : {}),
        }];
      })
      : [];
    return {
      status: assignments.length > 0 ? 'delegate' : status,
      reason: String(parsed.reason ?? '').trim(),
      assignments,
      ...(parsed.selfInstruction ? { selfInstruction: String(parsed.selfInstruction) } : {}),
      ...(parsed.userMessage ? { userMessage: String(parsed.userMessage) } : {}),
    };
  }

  if (/^\s*(?:NEED_AGENTS|NEED_CLI)\b/i.test(trimmed)) {
    const assignments = trimmed.replace(/^\s*(?:NEED_AGENTS|NEED_CLI)\s*/i, '').split('\n').flatMap((line, index) => {
      const colon = line.indexOf(':');
      if (colon < 0) return [];
      const agentInstanceId = line.slice(0, colon).trim();
      const objective = line.slice(colon + 1).trim();
      return agentInstanceId && objective ? [{ stepId: `legacy-${index + 1}`, agentInstanceId, objective }] : [];
    });
    return { status: assignments.length > 0 ? 'delegate' : 'self_execute', reason: '', assignments };
  }
  if (/^\s*NO_RECOVERY\b/i.test(trimmed)) {
    return { status: 'self_execute', reason: '当前成员没有提供可执行的替代方案', assignments: [] };
  }
  return { status: 'complete', reason: trimmed, assignments: [] };
}

function resolvePlannerAgentReference<T extends { id: string; name: string }>(
  reference: string,
  agents: T[],
): T | undefined {
  const normalized = reference.trim().replace(/^@/u, '').toLocaleLowerCase();
  return agents.find((agent) => agent.id.toLocaleLowerCase() === normalized)
    ?? agents.find((agent) => agent.name.trim().toLocaleLowerCase() === normalized);
}

/**
 * A planning response may describe a small DAG, but only its current runnable
 * frontier may be scheduled. Multiple frontier nodes are accepted only when
 * the planner explicitly places them in the same parallel group. Otherwise we
 * conservatively start one node and replan after its real status is returned.
 */
function selectRunnableAssignmentBatch(
  assignments: AdaptivePlannerAssignment[],
): AdaptivePlannerAssignment[] {
  if (assignments.length <= 1) return assignments;

  const entries = assignments.map((assignment, index) => ({
    assignment,
    stepId: assignment.stepId?.trim() || `step-${index + 1}`,
  }));
  const pendingStepIds = new Set(entries.map((entry) => entry.stepId));
  const runnable = entries.filter((entry) => (
    (entry.assignment.dependsOn ?? []).every((dependency) => !pendingStepIds.has(dependency))
  ));
  const first = runnable[0];
  if (!first) return [];

  const parallelGroup = first.assignment.parallelGroup?.trim();
  if (!parallelGroup) return [first.assignment];
  return runnable
    .filter((entry) => entry.assignment.parallelGroup?.trim() === parallelGroup)
    .map((entry) => entry.assignment);
}

async function planAdaptiveNextStep(
  ctx: IGraphContext,
  task: string,
  availableEvidence: string,
  unresolved: CLIDelegation[],
  planningHistory: string[],
  round: number,
  completion?: CompletionState,
): Promise<AdaptivePlannerDecision> {
  const agents = ctx.services.getProjectDelegatableAgents(ctx.projectId)
    .filter((agent) => agent.id !== ctx.agentInstanceId);
  const roster = agents.map((agent) => (
    `- ${agent.id} | ${agent.name} | ${agent.runtimeMode}\n  公开调度画像：${agent.coordinationProfile || agent.capabilities || agent.definitionId}`
  )).join('\n');
  const gaps = unresolved.map((item) => (
    `- ${item.agentName}：${conciseTaskBrief(item.instruction)}；实际结果：${conciseTaskBrief(item.result)}`
  )).join('\n');
  const result = await ctx.services.generateText('reasoning', [
    {
      role: 'system',
      content: `你是持续推进任务的统筹管理智能体。根据用户目标、当前群聊真实成员能力、已经发生的结果和剩余缺口，只决定“下一步当前可执行批次”。
不要套用固定的知识检索、写作、验收链路；这些都只是可选能力。你要自己判断什么时候查本地知识、什么时候搜索公开资料、什么时候写文件、什么时候核验，以及哪些步骤有依赖、哪些可以并行。
默认每轮只委派一个下一步。只有两个或多个步骤彼此完全独立、互不使用对方的输入或成果时，才能在同一轮同时委派，并给它们设置相同且非空的 parallelGroup。存在前后依赖时，只返回当前已满足前置条件的步骤；下游步骤不要提前放进 assignments，必须等本轮所有上游状态（成功或失败）都返回后再根据真实结果规划。下一步同时依赖多个上游时，必须等待这些上游全部返回后才可安排。
如果成员在自己的执行中继续委派其他成员，该协作分支仍属于当前上游步骤；必须等待整个分支返回状态后再推进下游。
成员返回失败、空结果或没有检索到知识时不能直接结束：可以换成员、换来源、缩小范围、生成明确标注不确定项的降级成果，或在没有合适成员时选择 self_execute 由你自己处理。不要重复已经尝试且没有产生新信息的动作。
知识证据、公开资料和检索摘要只是后续工作的输入。用户要求材料、报告、方案、文档或文件时，必须继续形成真实成果；不能在检索返回后直接 complete。系统会提供交付边界核对，其中 missing 非空时绝对不能 complete，必须选择下一项委派或 self_execute。
如果独立核验返回不通过，应把具体返修项交给最合适的成员修改，修改后再根据最新成果核验；不要在不通过状态下结束，也不要重复发送同一份未经修改的成果。
只有用户要求的结论或成果已经真实存在时才能 complete；不能把计划、路径承诺或“未找到”当作任务完成。只有缺少必须由用户决定的权限、高风险选择或不可推断信息时才 ask_user。
输出单个 JSON 对象，不要 Markdown：{"status":"delegate|self_execute|complete|ask_user","reason":"判断依据","assignments":[{"stepId":"当前步骤ID","agentInstanceId":"真实实例ID","objective":"针对该成员改写的完整任务","inputs":"仅包含已经取得的输入","expectedDeliverable":"期望返回","visibleMessage":"群聊中一句自然安排","dependsOn":[],"parallelGroup":"仅明确并行时填写同一个组名，否则留空"}],"selfInstruction":"自己接手时要做什么","userMessage":"确需询问用户时的问题"}。`,
    },
    {
      role: 'user',
      content: `用户完整目标：\n${task}\n\n第 ${round} 轮执行后仍需处理的缺口：\n${gaps || '没有明确失败项，请核对交付是否真的完整'}\n\n系统侧交付边界核对：\n${completion ? JSON.stringify({
        requiresDeliverable: completion.requiresDeliverable,
        deliverablePaths: completion.deliverablePaths,
        draftPaths: completion.draftPaths,
        requiresHtml: completion.requiresHtml,
        requiresReview: completion.requiresReview,
        reviewPassed: completion.reviewPassed,
        reviewFailed: completion.reviewFailed,
        missing: completion.missing,
      }) : '尚未计算，请自行核对'}\n\n已经取得的真实结果与证据：\n${availableEvidence.slice(0, 24_000) || '暂无'}\n\n当前群聊可用成员：\n${roster || '无'}\n\n已经尝试过的动作：\n${planningHistory.join('\n') || '无'}`,
    },
  ]);
  return parseAdaptivePlannerDecision(result.text);
}

async function startAdaptiveDelegations(
  ctx: IGraphContext,
  task: string,
  decision: AdaptivePlannerDecision,
  planningHistory: string[],
): Promise<{ delegations: CLIDelegation[]; signatures: string[] }> {
  const availableAgents = ctx.services.getProjectDelegatableAgents(ctx.projectId)
    .filter((agent) => agent.id !== ctx.agentInstanceId);
  const attempted = new Set(planningHistory);
  const seenTargets = new Set<string>();
  const delegations: CLIDelegation[] = [];
  const signatures: string[] = [];

  const runnableAssignments = selectRunnableAssignmentBatch(decision.assignments);
  for (const assignment of runnableAssignments) {
    const agent = resolvePlannerAgentReference(assignment.agentInstanceId, availableAgents);
    if (!agent || seenTargets.has(agent.id)) continue;
    const proposed = [assignment.objective, assignment.inputs, assignment.expectedDeliverable]
      .filter(Boolean)
      .join('\n');
    const executableInstruction = applyReviewDraftBoundary(
      agent,
      task,
      buildExecutableWorkPackage(agent, proposed, task, task),
      ctx.runId,
    );
    const signature = `${agent.id}:${normalizeComparableTask(executableInstruction).slice(0, 240)}`;
    if (attempted.has(signature)) continue;
    seenTargets.add(agent.id);
    signatures.push(signature);
    const visibleInstruction = assignment.visibleMessage?.trim()
      ? assignment.visibleMessage.trim().slice(0, 220)
      : buildVisibleDelegationInstruction(executableInstruction, task);
    sendTrace(ctx, 'handoff', `安排 ${agent.name} 处理下一项工作`, 'running', visibleInstruction);
    try {
      const sent = await ctx.services.sendDelegationMessage({
        projectId: ctx.projectId,
        senderId: ctx.agentInstanceId,
        parentRunId: ctx.runId,
        rootTriggerMessageId: ctx.triggerMessageId,
        targetAgentInstanceId: agent.id,
        targetAgentName: agent.name,
        instruction: executableInstruction,
        visibleInstruction,
      });
      const subRunId = sent.childRunIds[0] ?? '';
      delegations.push({
        agentInstanceId: agent.id,
        agentName: agent.name,
        subRunId,
        instruction: executableInstruction,
        status: subRunId ? 'pending' : 'failed',
        result: subRunId ? '任务已创建' : '消息已发出，但没有创建执行任务',
      });
      sendTrace(ctx, 'handoff', `${agent.name}已接收下一项工作`, subRunId ? 'completed' : 'failed');
    } catch (error) {
      const result = error instanceof Error ? error.message : String(error);
      delegations.push({ agentInstanceId: agent.id, agentName: agent.name, subRunId: '', instruction: executableInstruction, status: 'failed', result });
      sendTrace(ctx, 'handoff', `${agent.name}任务安排失败`, 'failed', result);
    }
  }
  return { delegations, signatures };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeGeneratedHtml(text: string, task: string, evidence: string): string {
  const rawHtml = text.match(/<!doctype\s+html[\s\S]*?<\/html>/iu)?.[0]
    ?? text.match(/<html\b[\s\S]*?<\/html>/iu)?.[0];
  if (rawHtml) return rawHtml;
  const body = text.trim() || evidence.trim() || '暂无可整理内容。';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>任务成果</title>
  <style>
    body{margin:0;background:#f5f7fa;color:#1f2937;font-family:Arial,"Microsoft YaHei",sans-serif;line-height:1.75}
    main{max-width:960px;margin:0 auto;padding:48px 32px;background:#fff;min-height:100vh;box-sizing:border-box}
    h1{font-size:28px;margin:0 0 24px}h2{font-size:19px;margin:30px 0 12px}pre{white-space:pre-wrap;font:inherit;margin:0}
  </style>
</head>
<body><main><h1>任务成果</h1><h2>任务说明</h2><pre>${escapeHtml(task)}</pre><h2>整理内容</h2><pre>${escapeHtml(body)}</pre></main></body>
</html>`;
}

async function materializeByOrchestrator(
  ctx: IGraphContext,
  task: string,
  evidence: string,
): Promise<{ result: string; artifacts: Array<{ relativePath: string; content: string }> }> {
  sendProgress(ctx, '统筹智能体正在整理成果文件', 72);
  sendTrace(ctx, 'reasoning', '没有合适的成果整理智能体，统筹智能体接手该步骤', 'completed');
  sendTrace(ctx, 'execution', '正在根据知识证据生成 HTML 成果文件', 'running');
  const generated = await ctx.services.generateText('reasoning', [
    {
      role: 'system',
      content: '你现在负责补齐最终成果整理步骤。严格依据给出的任务和知识证据，生成一个结构清晰、移动端友好、内联 CSS、无外部 CDN 的完整 HTML 文档。不得编造证据或关键数据。只输出完整 HTML，不输出 Markdown 代码围栏、解释、路径或临时内容。',
    },
    {
      role: 'user',
      content: `完整任务：\n${task}\n\n知识管理智能体返回的证据：\n${evidence.slice(0, 36_000)}`,
    },
  ]);
  const html = normalizeGeneratedHtml(generated.text, task, evidence);
  const runSuffix = ctx.runId.replace(/[^a-zA-Z0-9-]/g, '').slice(-12) || Date.now().toString(36);
  const relativePath = `outputs/task-delivery-${runSuffix}.html`;
  const toolResult = await ctx.services.executeTool('publish_artifact', {
    projectId: ctx.projectId,
    relativePath,
    content: html,
    note: '统筹智能体在无合适成果整理成员时补齐最终交付',
  }, 'orchestrator', { runId: ctx.runId, projectId: ctx.projectId });
  if (!toolResult.startsWith('成果已发布到 ')) {
    sendTrace(ctx, 'execution', 'HTML 成果文件生成失败', 'failed', toolResult);
    return { result: `统筹智能体尝试补齐 HTML 成果，但发布失败：${toolResult}`, artifacts: [] };
  }
  await ctx.services.createFileRecord(ctx.projectId, relativePath, html, ctx.agentInstanceId, ctx.runId, '统筹智能体补齐最终交付');
  sendTrace(ctx, 'execution', 'HTML 成果文件已生成并发送', 'completed', relativePath);
  sendTrace(ctx, 'file', '发布成果文件', 'completed', relativePath);
  return {
    result: `统筹智能体已依据知识结果完成材料整理，成果文件位于 ${relativePath}。`,
    artifacts: [{ relativePath, content: '统筹智能体生成的 HTML 成果文件' }],
  };
}

async function selfExecuteAdaptiveStep(
  ctx: IGraphContext,
  task: string,
  evidence: string,
  instruction: string,
): Promise<{ result: string; artifacts: Array<{ relativePath: string; content: string }>; completed: boolean }> {
  const promotion = instruction.match(/待审稿\s+(\.runtime[\\/]review-drafts[\\/][^\s，。；;]+?\.html?).*?提升为\s+(outputs[\\/][^\s，。；;]+?\.html?)/iu);
  if (promotion?.[1] && promotion[2]) {
    const draftRelativePath = promotion[1].replaceAll('\\', '/');
    const outputRelativePath = promotion[2].replaceAll('\\', '/');
    sendTrace(ctx, 'file', '验收通过，正在发布最终成果文件', 'running', outputRelativePath);
    const promoted = await ctx.services.executeTool('review:promoteArtifact', {
      projectId: ctx.projectId,
      draftRelativePath,
      outputRelativePath,
    }, 'orchestrator', { runId: ctx.runId, projectId: ctx.projectId });
    if (promoted.startsWith('验收通过的成果已发布到 ')) {
      await ctx.services.createFileRecord(ctx.projectId, outputRelativePath, '', ctx.agentInstanceId, ctx.runId, '验收通过后由统筹智能体发布');
      sendTrace(ctx, 'file', '最终成果文件已发布', 'completed', outputRelativePath);
      return {
        result: `验收通过，最终成果文件已经发布到 ${outputRelativePath}。`,
        artifacts: [{ relativePath: outputRelativePath, content: '验收通过后发布的最终成果文件' }],
        completed: true,
      };
    }
    sendTrace(ctx, 'file', '最终成果文件发布失败', 'failed', promoted);
    return { result: promoted, artifacts: [], completed: false };
  }

  const localEvidence = evidence || (needsLocalKnowledgeSupport(task)
    ? await (async () => {
      sendTrace(ctx, 'tool', '统筹智能体正在补查本地知识', 'running');
      try {
        const result = await ctx.services.executeTool('knowledge:search', {
          projectId: ctx.projectId, query: task, limit: 12,
        }, 'orchestrator', { runId: ctx.runId, projectId: ctx.projectId });
        sendTrace(ctx, 'tool', '本地知识补查完成', 'completed', result.slice(0, 500));
        return result;
      } catch (error) {
        const result = error instanceof Error ? error.message : String(error);
        sendTrace(ctx, 'tool', '本地知识补查失败', 'failed', result);
        return '';
      }
    })()
    : '');

  if (requiresHtmlDeliverable(task)) {
    const materialized = await materializeByOrchestrator(ctx, task, `${instruction}\n\n${localEvidence}`.slice(0, 40_000));
    return { ...materialized, completed: materialized.artifacts.length > 0 };
  }

  sendProgress(ctx, '统筹智能体补齐缺失步骤', 74);
  sendTrace(ctx, 'execution', '统筹智能体正在亲自处理剩余工作', 'running', instruction);
  const generated = await ctx.services.generateText('reasoning', [
    {
      role: 'system',
      content: '你正在补齐一项没有合适执行成员的工作。请依据完整目标和已经取得的证据直接完成缺失步骤，语言自然，返回可核验结果；不要复述系统字段、不要输出内部调度协议。',
    },
    {
      role: 'user',
      content: `完整目标：\n${task}\n\n需要补齐的步骤：\n${instruction}\n\n已有结果：\n${localEvidence.slice(0, 36_000) || '暂无'}`,
    },
  ]);
  const { processedText, artifacts } = await processToolCalls(generated.text, ctx);
  sendTrace(ctx, 'execution', '统筹智能体已完成补齐步骤', 'completed', processedText.slice(0, 500));
  return { result: processedText, artifacts, completed: Boolean(processedText.trim()) };
}

async function collectCLIResults(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();
  const task = effectiveTask(state, ctx);

  sendProgress(ctx, '收集子智能体结果', 50);
  const activeDelegations = state.cliDelegations;
  const activeNames = activeDelegations.map((delegation) => delegation.agentName);
  sendTrace(ctx, 'handoff', `等待${activeNames.join('、') || '成员'}返回结果`, 'running');
  sendOrchestratorChecklist(ctx, 'waiting', {
    understand: conciseTaskBrief(task),
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
        const descendants = ['completed', 'failed', 'cancelled', 'interrupted'].includes(runStatus.status)
          ? (ctx.services.getRunDescendants?.(d.subRunId) ?? [])
          : [];
        const activeDescendants = descendants.filter((child) => (
          ['queued', 'starting', 'running', 'cancelling'].includes(child.status)
        ));
        if (activeDescendants.length > 0) {
          // A child may have handed work to another agent immediately before
          // finishing. The parent status is not enough to release downstream
          // steps; wait for the entire delegation branch.
          allDone = false;
          continue;
        }
        if (runStatus.status === 'completed') {
          let result = '';
          if (runStatus.resultMessageId) {
            const msgContent = ctx.services.getMessageContent(runStatus.resultMessageId);
            if (msgContent) {
              result = msgContent;
            }
          }
          const descendantFeedback = descendants.map((child) => {
            const childName = ctx.services.getAgentDisplayName(child.agentInstanceId) ?? '协作智能体';
            if (child.status === 'completed') {
              const childResult = child.resultMessageId
                ? ctx.services.getMessageContent(child.resultMessageId) ?? ''
                : '';
              return `${childName}协作结果：${childResult || '已完成，无文本结果'}`;
            }
            return `${childName}协作未完成：${child.errorMessage || child.status}`;
          });
          const branchFailed = descendants.some((child) => (
            ['failed', 'cancelled', 'interrupted'].includes(child.status)
          ));
          delegations[i] = {
            agentInstanceId: d.agentInstanceId,
            agentName: d.agentName,
            subRunId: d.subRunId,
            instruction: d.instruction,
            status: branchFailed ? 'failed' : 'completed',
            result: [result, ...descendantFeedback].filter(Boolean).join('\n\n'),
          };
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
  for (const d of delegations) {
    if (!d) continue;
    if (d.status === 'completed') {
      parts.push(`--- ${d.agentName || d.agentInstanceId} 结果 ---\n${d.result || '(无输出)'}`);
    } else {
      parts.push(`--- ${d.agentName || d.agentInstanceId} 失败 ---\n${d.result}`);
    }
  }

  const currentRoundSummary = parts.join('\n\n');
  const summary = [state.subAgentResult, currentRoundSummary].filter(Boolean).join('\n\n');
  const collectedArtifacts = [...state.artifacts];
  const availableAgents = ctx.services.getProjectDelegatableAgents(ctx.projectId)
    .filter((agent) => agent.id !== ctx.agentInstanceId);
  const delegatableById = new Map(availableAgents.map((agent) => [agent.id, agent]));
  const knowledgeEvidenceGaps = delegations.filter((delegation) => (
    delegation.status === 'completed'
    && isKnowledgeManagerAgent(delegatableById.get(delegation.agentInstanceId) ?? { definitionId: '', name: delegation.agentName })
    && isKnowledgeEvidenceMissing(delegation.result)
  ));
  const knowledgeGapIds = new Set(knowledgeEvidenceGaps.map((delegation) => delegation.subRunId || delegation.agentInstanceId));
  const successCount = delegations.filter((delegation) => (
    delegation.status === 'completed'
    && !knowledgeGapIds.has(delegation.subRunId || delegation.agentInstanceId)
  )).length;
  const failCount = delegations.filter((delegation) => delegation.status === 'failed').length + knowledgeEvidenceGaps.length;
  const completion = buildCompletionState(task, summary, collectedArtifacts, delegations, availableAgents);
  logger.info(`collectAgentResults: ${successCount} 成功, ${failCount} 失败 (共 ${delegations.length} 个子任务)`);
  sendTrace(ctx, 'handoff', `成员结果已全部返回：${successCount} 成功，${failCount} 失败`, failCount > 0 && successCount === 0 ? 'failed' : 'completed');
  if (knowledgeEvidenceGaps.length > 0) {
    sendTrace(ctx, 'warning', '本地知识没有返回可用证据，正在切换公开调研或降级交付方案', 'completed');
  }

  const failedDelegations = delegations.filter((delegation) => delegation.status === 'failed');
  for (const gap of knowledgeEvidenceGaps) {
    failedDelegations.push({
      ...gap,
      agentName: `${gap.agentName}证据检索`,
      status: 'failed',
      result: `${gap.result || '本地知识没有返回可用证据'}。需要改用公开调研、通用方案或明确标注待确认项的降级交付。`,
    });
  }
  for (const missing of completion.missing) {
    const isReviewGap = missing.includes('验收');
    failedDelegations.push({
      agentInstanceId: '',
      agentName: isReviewGap ? '成果验收' : '成果文件交付',
      subRunId: '',
      instruction: isReviewGap
        ? '独立核验已经生成的成果，明确给出通过或返修结论'
        : `基于已经取得的内容生成并发布最终${completion.requiresHtml ? ' HTML' : ''}成果文件`,
      status: 'failed',
      result: missing,
    });
  }
  if (completion.missing.length > 0) {
    sendTrace(ctx, 'warning', completion.missing.join('；'), 'failed');
  }
  const unresolved = [...failedDelegations];
  // 每一轮成员或统筹执行结果都必须回到同一个判断点。不存在
  // “单成员成功就直接转发”或“某一步完成就隐式结束”的旁路。
  const shouldPlanNextStep = true;
  if (shouldPlanNextStep) {
    const nextRound = (state.recoveryCount ?? 0) + 1;
    if (nextRound <= MAX_RECOVERY_PASSES) {
      sendProgress(ctx, '根据真实结果重新规划下一步', 58);
      sendTrace(ctx, 'reasoning', '检查缺口并选择下一项最合适的处理方式', 'running');
      const planningHistory = state.plannerHistory ?? [];
      const plannedDecision = await planAdaptiveNextStep(ctx, task, summary, unresolved, planningHistory, nextRound, completion);
      const decision = enforceCompletionBoundary(plannedDecision, completion, task, availableAgents, summary, ctx.runId);
      if (decision.status === 'complete' && unresolved.length === 0) {
        sendTrace(ctx, 'reasoning', '统筹智能体确认当前结果已经满足交付要求', 'completed');
        return {
          cliDelegations: delegations,
          recoveryCount: nextRound,
          plannerHistory: planningHistory,
          materializationPass: state.materializationPass ?? 0,
          subAgentResult: summary || '(无子任务结果)',
          messages: [
            ...state.messages,
            { role: 'system', content: `本轮执行完成: ${successCount} 个结果可用, ${failCount} 个结果不可用` },
          ],
          artifacts: collectedArtifacts,
        };
      } else {
        const planned = await startAdaptiveDelegations(ctx, task, decision, planningHistory);
        const nextHistory = [...planningHistory, ...planned.signatures].slice(-24);

        if (planned.delegations.length > 0) {
        sendTrace(ctx, 'reasoning', '下一步工作已经安排，等待实际结果返回', 'completed');
        sendOrchestratorChecklist(ctx, 'waiting', {
          decompose: planned.delegations.map((delegation) => `${delegation.agentName}：${conciseTaskBrief(delegation.instruction)}`).join('；'),
          delegate: `已安排${planned.delegations.map((delegation) => delegation.agentName).join('、')}处理当前缺口。`,
          wait: '等待本轮工作返回后再决定后续步骤，最长等待 4 小时。',
        });
        const recovered = await collectCLIResults({
          ...state,
          messages: [],
          cliDelegations: planned.delegations,
          recoveryCount: nextRound,
          plannerHistory: nextHistory,
          subAgentResult: summary,
          artifacts: collectedArtifacts,
        }, config);
        return {
          cliDelegations: [...delegations, ...(recovered.cliDelegations ?? [])],
          recoveryCount: recovered.recoveryCount ?? nextRound,
          plannerHistory: recovered.plannerHistory ?? nextHistory,
          materializationPass: recovered.materializationPass ?? state.materializationPass ?? 0,
          subAgentResult: recovered.subAgentResult || summary,
          messages: [...state.messages, ...(recovered.messages ?? [])],
          artifacts: recovered.artifacts ?? collectedArtifacts,
          ...(recovered.finalResponse ? { finalResponse: recovered.finalResponse } : {}),
        };
        }

        if (decision.status === 'ask_user') {
        return {
          cliDelegations: delegations,
          recoveryCount: nextRound,
          plannerHistory: nextHistory,
          subAgentResult: summary,
          finalResponse: decision.userMessage || '继续处理前需要你补充一个关键决定。',
          artifacts: collectedArtifacts,
        };
        }

        const selfInstruction = decision.selfInstruction || decision.reason || unresolved.map((item) => item.instruction).join('；') || task;
        const selfResult = await selfExecuteAdaptiveStep(ctx, task, summary, selfInstruction);
        const nextSummary = [summary, `--- 统筹智能体自行补齐 ---\n${selfResult.result}`].filter(Boolean).join('\n\n');
        const nextArtifacts = [...collectedArtifacts, ...selfResult.artifacts];
        const completionAfterSelf = buildCompletionState(task, nextSummary, nextArtifacts, delegations, availableAgents);
        if (selfResult.completed && completionAfterSelf.missing.length === 0) {
        return {
          cliDelegations: delegations,
          recoveryCount: nextRound,
          plannerHistory: nextHistory,
          subAgentResult: nextSummary,
          artifacts: nextArtifacts,
        };
        }
        if (selfResult.completed && nextRound < MAX_RECOVERY_PASSES) {
          const continued = await collectCLIResults({
            ...state,
            messages: [],
            cliDelegations: [],
            recoveryCount: nextRound,
            plannerHistory: nextHistory,
            subAgentResult: nextSummary,
            artifacts: nextArtifacts,
          }, config);
          return {
            ...continued,
            cliDelegations: [...delegations, ...(continued.cliDelegations ?? [])],
            subAgentResult: continued.subAgentResult || nextSummary,
            artifacts: continued.artifacts ?? nextArtifacts,
          };
        }
        if (nextRound >= MAX_RECOVERY_PASSES) {
        return {
          cliDelegations: delegations,
          recoveryCount: nextRound,
          plannerHistory: nextHistory,
          subAgentResult: nextSummary,
          finalResponse: selfResult.result || '当前步骤仍未形成可交付结果，请补充具备相应能力的成员后继续。',
          artifacts: nextArtifacts,
        };
        }
      }
    }
    sendTrace(ctx, 'warning', '多次尝试仍未补齐缺口，将基于已核实结果继续汇总', 'completed');
  }

  return {
    cliDelegations: delegations,
    recoveryCount: state.recoveryCount,
    plannerHistory: state.plannerHistory ?? [],
    materializationPass: state.materializationPass ?? 0,
    subAgentResult: summary || '(无子任务结果)',
    messages: [
      ...state.messages,
      { role: 'system', content: `子任务汇总完成: ${successCount} 成功, ${failCount} 失败` },
    ],
    artifacts: collectedArtifacts,
  };
}

async function executeOrchestratorStep(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();
  const task = effectiveTask(state, ctx);
  const instruction = state.selfInstruction?.trim() || task;
  const selfResult = await selfExecuteAdaptiveStep(ctx, task, state.subAgentResult, instruction);
  const summary = [state.subAgentResult, `--- 统筹智能体自行处理结果 ---\n${selfResult.result}`]
    .filter(Boolean)
    .join('\n\n');
  const artifacts = [...state.artifacts, ...selfResult.artifacts];

  // Re-enter the same root decision loop with an empty active delegation set.
  // Self execution is a worker step, not a terminal response shortcut.
  return collectCLIResults({
    ...state,
    messages: [],
    selfInstruction: '',
    cliDelegations: [],
    recoveryCount: state.recoveryCount ?? 0,
    subAgentResult: summary,
    artifacts,
  }, config);
}

export function shouldCurateKnowledge(state: GraphState): boolean {
  const task = instructionText(state.resolvedTask || state.instruction).replace(/\s+/g, ' ').trim();
  if (/归集|沉淀|复盘|知识文档|业务流程/i.test(task)) return true;
  const knowledgeWasAlreadyUsed = state.cliDelegations.some((delegation) => /知识管理|知识管理员/iu.test(delegation.agentName));
  if (knowledgeWasAlreadyUsed) return false;
  if (/代码|编程|脚本|网页|HTML|天气|时间/i.test(task) && !/业务|制度|流程|行业|市场|公司/i.test(task)) return false;
  const retrievalOnly = /检索|查找|查询|核对|确认|制度|规定|规则|审批|规格/i.test(task)
    && !/生成|制作|报告|方案|文档|总结|输出文件|调研报告/i.test(task);
  if (retrievalOnly) return false;
  const hasDeliverable = state.artifacts.length > 0
    || /outputs[\\/]/i.test(state.subAgentResult);
  return /报告|方案|分析|调研|研究|制度|业务|流程|行业|市场|公司/i.test(task)
    && (hasDeliverable || state.subAgentResult.length > 600);
}

function collectDeliverablePaths(text: string, artifacts: Array<{ relativePath: string }>): string[] {
  const paths = [...text.matchAll(/(?:^|[\s`'"])(outputs[\\/][^\s`'"<>|:*?]+?\.(?:html?|pdf|md|txt|json|csv|png|jpe?g|webp|gif|docx?|xlsx?|pptx?|zip))(?![\p{L}\p{N}_.-])/gimu)]
    .map((match) => match[1]?.replaceAll('\\', '/'))
    .filter((path): path is string => Boolean(path));
  return [...new Set([...artifacts.map((artifact) => artifact.relativePath.replaceAll('\\', '/')), ...paths])].slice(0, 30);
}

function collectConcreteDeliverablePaths(text: string, artifacts: Array<{ relativePath: string }>): string[] {
  const paths = collectDeliverablePaths(text, artifacts);
  if (artifacts.length > 0) return paths;
  // 只接受带有完成语义的路径，避免把“应该输出到 outputs/...”当成已交付。
  const completionSignal = /(?:已(?:经)?|完成|生成|保存|发布|交付|发送|发出|位于|路径(?:为|是)?)[^\n]{0,80}outputs[\\/]/iu;
  const attachmentSignal = /(?:成果文件|附件|ARTIFACT)\s*[:：]?[^\n]{0,80}outputs[\\/]|outputs[\\/][^\n]{0,120}(?:已发送|已发布|已交付)/iu;
  return completionSignal.test(text) || attachmentSignal.test(text) ? paths : [];
}

type CompletionState = {
  requiresDeliverable: boolean;
  deliverablePaths: string[];
  draftPaths: string[];
  requiresHtml: boolean;
  requiresReview: boolean;
  reviewPassed: boolean;
  reviewFailed: boolean;
  missing: string[];
};

function collectReviewDraftPaths(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|[\s`'"])(\.runtime[\\/]review-drafts[\\/][^\s`'"<>|:*?]+?\.html?)(?![\p{L}\p{N}_.-])/gimu)]
    .map((match) => match[1]?.replaceAll('\\', '/'))
    .filter((path): path is string => Boolean(path)))].slice(0, 20);
}

function buildCompletionState(
  task: string,
  evidence: string,
  artifacts: Array<{ relativePath: string; content: string }>,
  delegations: CLIDelegation[],
  availableAgents: DelegatableAgentInfo[],
): CompletionState {
  const agentById = new Map(availableAgents.map((agent) => [agent.id, agent]));
  const materialTask = requiresQualityReview(task);
  const delegatedDeliverablePaths = delegations.flatMap((delegation) => {
    if (delegation.status !== 'completed') return [];
    const agent = agentById.get(delegation.agentInstanceId);
    // For material/report work, retrieval and review outputs are supporting
    // evidence. They cannot satisfy the user's final deliverable even if a
    // member prints HTML or an outputs/ path in its text.
    if (materialTask && agent && (
      isKnowledgeManagerAgent(agent)
      || isResearcherAgent(agent)
      || isAcceptanceReviewerAgent(agent)
    )) return [];
    return collectConcreteDeliverablePaths(delegation.result, []);
  });
  const deliverablePaths = [...new Set([
    ...artifacts.map((artifact) => artifact.relativePath.replaceAll('\\', '/')),
    ...delegatedDeliverablePaths,
  ])].slice(0, 30);
  const draftPaths = collectReviewDraftPaths(evidence);
  const requiresDeliverable = requiresArtifactDeliverable(task);
  const requiresHtml = requiresHtmlDeliverable(task);
  const reviewerAvailable = Boolean(chooseReviewerAgent(availableAgents));
  const reviewDecision = parseCurrentAcceptanceDecision(evidence);
  const reviewPassed = reviewDecision === 'pass';
  const reviewFailed = reviewDecision === 'fail';
  const requiresReview = requiresQualityReview(task) && reviewerAvailable;
  const missing: string[] = [];
  if (requiresReview && reviewFailed) {
    missing.push('最近一次独立验收不通过，必须依据返修意见修改成果后重新验收');
  } else if (requiresReview && draftPaths.length > 0 && !reviewPassed) {
    missing.push('候选成果已经生成，但尚未完成独立验收');
  } else if (requiresReview && reviewPassed && deliverablePaths.length === 0 && draftPaths.length > 0) {
    missing.push('待审稿已经验收通过，但尚未提升并发布为正式成果文件');
  } else if (requiresReview && draftPaths.length === 0 && deliverablePaths.length === 0) {
    missing.push('用户要求的材料尚未形成可供独立验收的候选成果');
  } else if (requiresReview && deliverablePaths.length > 0 && !reviewPassed) {
    missing.push('成果文件已经生成，但尚未完成独立验收');
  } else if (requiresDeliverable && deliverablePaths.length === 0) {
    missing.push(requiresHtml ? '用户要求的 HTML 成果文件尚未真实生成并发布' : '用户要求的成果文件尚未真实生成并发布');
  }
  if (requiresHtml && deliverablePaths.length > 0 && !deliverablePaths.some((path) => /\.html?$/iu.test(path))) {
    missing.push('用户明确要求 HTML 文件，但当前结果没有 HTML 成果');
  }
  return {
    requiresDeliverable,
    deliverablePaths,
    draftPaths,
    requiresHtml,
    requiresReview,
    reviewPassed,
    reviewFailed,
    missing,
  };
}

function enforceCompletionBoundary(
  decision: AdaptivePlannerDecision,
  completion: CompletionState,
  task: string,
  agents: DelegatableAgentInfo[],
  evidence: string,
  runId: string,
): AdaptivePlannerDecision {
  if (decision.status !== 'complete' || completion.missing.length === 0) return decision;
  const reason = `当前结果仍缺少：${completion.missing.join('；')}。不能提前结束。`;
  const reviewer = completion.requiresReview
    && (completion.draftPaths.length > 0 || completion.deliverablePaths.length > 0)
    && !completion.reviewPassed
    && !completion.reviewFailed
    ? chooseReviewerAgent(agents)
    : undefined;
  const writer = chooseArtifactAgent(task, agents);
  const writerAlreadyProducedCurrentDraft = completion.draftPaths.length > 0 && !completion.reviewFailed;
  if (completion.reviewFailed && writer) {
    return {
      status: 'delegate',
      reason,
      assignments: [{
        agentInstanceId: writer.id,
        objective: `最近一次验收没有通过。请逐项落实返修意见，覆盖原待审稿，不要发布正式附件；修改完成后返回更新后的待审稿路径。\n完整任务：${task}\n待审稿：${completion.draftPaths.at(-1) ?? '请从已有结果确认'}\n验收意见和已有结果：\n${evidence.slice(-20_000)}`,
        expectedDeliverable: '完成返修的待审稿路径和逐项修改说明',
        visibleMessage: '验收发现了需要修正的内容，请按具体意见完成返修，完成后再复核。',
      }],
    };
  }
  if (reviewer) {
    return {
      status: 'delegate',
      reason,
      assignments: [{
        agentInstanceId: reviewer.id,
        objective: `当前核验批次的最近结果：${conciseTaskBrief(evidence.slice(-800))}\n独立核验当前候选成果，逐项核对用户要求和证据；通过时明确回复“验收结论：通过”，不通过时给出可执行的返修清单。\n完整任务：${task}\n待验收成果：${[...completion.draftPaths, ...completion.deliverablePaths].join('、')}\n已有证据与成员结果：\n${evidence.slice(-20_000)}`,
        expectedDeliverable: '明确的验收结论和必要的返修意见',
        visibleMessage: '成果已经生成，我请验收智能体独立核对关键内容；通过后再正式交付。',
      }],
    };
  }
  if (completion.reviewPassed && completion.draftPaths.length > 0 && completion.deliverablePaths.length === 0) {
    return {
      status: 'self_execute',
      reason,
      assignments: [],
      selfInstruction: `验收已经通过。请把待审稿 ${completion.draftPaths.at(-1)} 提升为 outputs/task-delivery-${safeRunSegment(runId)}.html，并作为最终成果发布。`,
    };
  }
  if (writer && !writerAlreadyProducedCurrentDraft) {
    return {
      status: 'delegate',
      reason,
      assignments: [{
        agentInstanceId: writer.id,
        objective: `当前补齐依据的最近结果：${conciseTaskBrief(evidence.slice(-800))}\n根据完整任务和已经取得的证据，完成用户要求的候选成果。若当前任务需要独立验收，请使用本次根任务的专属待审路径 .runtime/review-drafts/${safeRunSegment(runId)}/material-draft.html，不要发布正式附件；无需验收时再生成 outputs/ 正式成果。不要只返回源码。\n完整任务：${task}\n已有证据与成员结果：\n${evidence.slice(-24_000) || '暂无，请依据任务自行补齐必要内容并标注不确定项'}`,
        expectedDeliverable: completion.requiresReview ? '已保存的 HTML 待审稿路径' : completion.requiresHtml ? '已发布且可直接打开的 HTML 文件' : '已发布的正式成果文件',
        visibleMessage: '资料已经返回，接下来请把它整理成完整的候选成果。',
      }],
    };
  }
  return {
    status: 'self_execute',
    reason,
    assignments: [],
    selfInstruction: `请亲自补齐以下交付缺口：${completion.missing.join('；')}。依据当前已经取得的证据完成并发布成果，不要停留在检索摘要。`,
  };
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
    originalTask: effectiveTask(state, ctx).slice(0, 8_000),
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
  const task = effectiveTask(state, ctx);

  sendProgress(ctx, '汇总子智能体结果', 70);
  sendTrace(ctx, 'reasoning', '验收子任务结果并生成用户摘要', 'running');
  sendOrchestratorChecklist(ctx, 'validating', {
    understand: conciseTaskBrief(task),
    validate: '正在核对成员结论、交付物完整性与剩余风险。',
  });

  const verifiedDelegations = state.cliDelegations.filter((delegation) => Boolean(delegation.subRunId));
  const verifiedAgentNames = [...new Set(verifiedDelegations.map((delegation) => delegation.agentName).filter(Boolean))];
  const verifiedRoster = verifiedDelegations.length > 0
    ? verifiedDelegations.map((delegation) => `- ${delegation.agentName}：${delegation.status === 'completed' ? '已完成' : '执行失败'}`).join('\n')
    : '- 无主任务子智能体委派记录';
  const memberResults = verifiedDelegations
    .filter((delegation) => delegation.result.trim())
    .map((delegation) => delegation.result);
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: `${ORCHESTRATOR_SYNTHESIS_SYSTEM_PROMPT}\n\n本次真实委派成员仅限：${verifiedAgentNames.join('、') || '无'}。`,
    },
    {
      role: 'user',
      content: `用户本次完整需求：\n${task}\n\n系统核验的本次子任务记录：\n${verifiedRoster}\n\n实际返回结果：\n${state.subAgentResult || '(无有效结果)'}\n\n请直接给出最终交付，不评价未被委派的成员。`,
    },
  ];

  let finalResult = await ctx.services.generateText('reasoning', messages);
  let cleanedFinalText = removeHtmlSourceFromFormalMessage(finalResult.text);
  if (containsInternalOrchestrationProtocol(cleanedFinalText)
    || isNearDuplicateMemberSummary(cleanedFinalText, memberResults)
    || cleanedFinalText !== finalResult.text.trim()) {
    ctx.services.getLogger().warn(`Orchestrator.synthesize: 最终交付包含内部协议、HTML 源码或近似复制，正在重新归纳 (runId=${ctx.runId})`);
    sendTrace(ctx, 'warning', '最终交付需要重新归纳，正在去除重复内容与源码', 'running');
    finalResult = await ctx.services.generateText('reasoning', [
      { role: 'system', content: ORCHESTRATOR_SYNTHESIS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `用户本次完整需求：\n${task}\n\n成员执行结果：\n${state.subAgentResult || '(无有效结果)'}\n\n上一版交付因为近似复制成员原文、包含 HTML 源码或内部协议而被拒绝。请重新形成你自己的归纳：只保留最终判断、3-5 条高价值结论、真实成果附件说明和必要风险；不要逐段复述成员结果。`,
      },
    ]);
    cleanedFinalText = removeHtmlSourceFromFormalMessage(finalResult.text);
  }
  if (containsInternalOrchestrationProtocol(cleanedFinalText)
    || isNearDuplicateMemberSummary(cleanedFinalText, memberResults)) {
    finalResult = {
      ...finalResult,
      text: buildSafeSynthesisFallback(state.subAgentResult, task),
      toolCalls: [],
    };
  } else {
    finalResult = { ...finalResult, text: cleanedFinalText };
  }
  const knownAgentNames = ctx.services.getProjectDelegatableAgents(ctx.projectId).map((agent) => agent.name);
  const verifiedText = removeUnverifiedAgentFailureClaims(finalResult.text, verifiedAgentNames, knownAgentNames);
  finalResult = {
    ...finalResult,
    text: verifiedText || buildSafeSynthesisFallback(state.subAgentResult, task),
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
  const task = effectiveTask(state, ctx);

  const rawText = containsInternalOrchestrationProtocol(state.finalResponse)
    ? buildSafeSynthesisFallback(state.subAgentResult, task)
    : state.finalResponse;
  const text = removeHtmlSourceFromFormalMessage(rawText)
    || buildSafeSynthesisFallback(state.subAgentResult, task);
  if (!text) return {};

  const artifactLines = (state.artifacts ?? []).map(
    (a) => `成果文件：**${a.relativePath}**（已发送到群聊）`,
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
  const isLightweightResponse = isConversationStatusQuestion(ctx.instruction) || isSimpleDirectTask(task);

  if (!isLightweightResponse) {
    sendOrchestratorChecklist(ctx, 'delivering', {
      understand: conciseTaskBrief(task),
      deliver: '正在发送结论与成果文件。',
    });
  }
  const agentMsgId = await ctx.services.insertMessage(ctx.projectId, ctx.agentInstanceId, 'text', contentJson);
  if (!isLightweightResponse) {
    sendTrace(ctx, 'execution', '向用户提交最终结果', 'completed');
    sendOrchestratorChecklist(ctx, 'completed', {
      understand: conciseTaskBrief(task),
      deliver: '最终结果已经交付。',
    });
  }
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

  activeTraceIdsByRun.delete(ctx.runId);
  return {};
}

function routeAfterAnalyze(state: GraphState): string {
  if (state.needsKnowledgeManager) return 'delegateToKM';
  if (state.needsCLIDelegation) return 'delegateCLI';
  if (state.selfInstruction) return 'executeOrchestratorStep';
  if (state.subAgentResult) return 'synthesize';
  return 'respond';
}

function routeAfterDelegate(state: GraphState): string {
  if (state.cliDelegations.length > 0) return 'collectCLIResults';
  return state.subAgentResult ? 'synthesize' : 'respond';
}

function routeAfterCollect(state: GraphState): string {
  if (state.finalResponse) return 'respond';
  if (!state.subAgentResult) return 'respond';
  return 'synthesize';
}

function buildOrchestratorGraph() {
  const builder = new StateGraph(OrchestratorAnnotation)
    .addNode('analyzeIntent', analyzeIntent as any)
    .addNode('delegateToKM', delegateToKM as any)
    .addNode('delegateCLI', delegateCLI as any)
    .addNode('executeOrchestratorStep', executeOrchestratorStep as any)
    .addNode('collectCLIResults', collectCLIResults as any)
    .addNode('synthesize', synthesize as any)
    .addNode('respond', respond as any)
    .addEdge('__start__', 'analyzeIntent')
    .addConditionalEdges('analyzeIntent', routeAfterAnalyze, ['delegateToKM', 'delegateCLI', 'executeOrchestratorStep', 'synthesize', 'respond'])
    .addConditionalEdges('delegateToKM', routeAfterDelegate, ['collectCLIResults', 'synthesize', 'respond'])
    .addEdge('delegateCLI', 'collectCLIResults')
    .addConditionalEdges('executeOrchestratorStep', routeAfterCollect, ['synthesize', 'respond'])
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
      resolvedTask: '',
      triggerMessageId: ctx.triggerMessageId,
      messages: [],
      subAgentResult: '',
      finalResponse: '',
      needsKnowledgeManager: false,
      needsCLIDelegation: false,
      parallelDelegationApproved: false,
      selfInstruction: '',
      cliDelegations: [],
      recoveryCount: 0,
      plannerHistory: [],
      materializationPass: 0,
      reviewAttempted: false,
      reviewPass: false,
      reviewFindings: '',
      draftArtifactPath: '',
      knowledgeCurated: false,
      artifacts: [],
    };

    await _compiledOrchestrator.invoke(initialState, {
      configurable: { ctx },
      signal: ctx.signal,
    });

    logger.info(`Orchestrator StateGraph 完成 (runId=${ctx.runId})`);
  } catch (err) {
    checklistDetailsByRun.delete(ctx.runId);
    if (err instanceof DOMException && err.name === 'AbortError') {
      ctx.services.setRunStatus(ctx.runId, 'cancelled');
      return;
    }
    throw err;
  }
}
