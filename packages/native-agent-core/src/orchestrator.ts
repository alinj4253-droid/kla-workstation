import { Annotation, END, StateGraph } from '@langchain/langgraph';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './prompts.js';
import { extractToolCalls } from './tool-utils.js';
import type { IGraphContext, OrchestratorGraphState, OrchestratorMacroPlan, ExecContextSnapshot, CLIDelegation, DelegatableAgentInfo, CollaborationMode } from './types.js';
import type { ModelMessage } from '@kunqing/model-core';

const MAX_TOOL_RETRIES = 3;

function coordinationGenerationOptions(mode: CollaborationMode | undefined, maxOutputTokens: number) {
  return mode === 'fast'
    ? { thinking: false, thinkingLevel: 'none' as const, maxOutputTokens }
    : { thinking: true, thinkingLevel: 'minimal' as const, maxOutputTokens };
}

function plannerGenerationOptions(ctx: IGraphContext, maxOutputTokens: number) {
  // Delegation-only groups need a routing decision, not a long expert answer.
  // Keep expert quality for child agents while avoiding expensive root reasoning.
  if (ctx.delegationOnly) return { thinking: false, thinkingLevel: 'none' as const, maxOutputTokens };
  return coordinationGenerationOptions(ctx.collaborationMode, maxOutputTokens);
}

const conciseGenerationOptions = (maxOutputTokens: number) => ({
  thinking: false,
  thinkingLevel: 'none' as const,
  maxOutputTokens,
});

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
  fireAndForgetDelegation: Annotation<boolean>({
    value: (_a: boolean, b: boolean) => b,
    default: () => false,
  }),
  delegationNotes: Annotation<Array<{ agentInstanceId: string; visibleMessage: string }>>({
    value: (_a, b) => b,
    default: () => [],
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
  macroPlan: Annotation<OrchestratorMacroPlan | null>({
    value: (_a: OrchestratorMacroPlan | null, b: OrchestratorMacroPlan | null) => b,
    default: () => null,
  }),
  activeStageId: Annotation<string>({
    value: (_a: string, b: string) => b,
    default: () => '',
  }),
  stageAttempts: Annotation<Record<string, number>>({
    value: (_a: Record<string, number>, b: Record<string, number>) => b,
    default: () => ({}),
  }),
  awaitingUser: Annotation<{ question: string; missingFields: string[] } | null>({
    value: (_a: { question: string; missingFields: string[] } | null, b: { question: string; missingFields: string[] } | null) => b,
    default: () => null,
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
      if (call.name === 'delegate_tasks') {
        const agentInstanceId = typeof call.args.agentInstanceId === 'string' ? call.args.agentInstanceId : '';
        const instruction = typeof call.args.instruction === 'string' ? call.args.instruction.trim() : '';
        const agent = ctx.services.getProjectDelegatableAgents(ctx.projectId).find((item) => item.id === agentInstanceId);
        if (!agent || !instruction) {
          results.push('[delegate_tasks] 委派失败：没有找到有效的目标智能体或任务内容。');
          continue;
        }
        const delegated = await delegateAndWait(
          ctx,
          agent,
          instruction,
          `请${agent.name}处理：${instruction.slice(0, 180)}`,
          `安排${agent.name}处理下一项工作`,
        );
        results.push(`[delegate_tasks] ${agent.name}${delegated.status === 'completed' ? '已返回结果' : '未能完成'}：${delegated.result || '无文本结果'}`);
        continue;
      }
      const result = await ctx.services.executeTool(call.name, call.args, 'orchestrator', {
        runId: ctx.runId,
        projectId: ctx.projectId,
      });
      results.push(`[${call.name}] ${result}`);

      if (call.name === 'publish_artifact' && result.startsWith('成果已发布到 ')) {
        const { relativePath, content, note } = call.args as {
          projectId: string; relativePath: string; content: string; note?: string;
        };
        await ctx.services.createFileRecord(ctx.projectId, relativePath, content, ctx.agentInstanceId, ctx.runId, note);
        artifacts.push({ relativePath, content: content.slice(0, 200) });
      }
      if (call.name === 'temp:promote') {
        const promotedPath = result.match(/TEMP_PROMOTED:\s*[^\n]+?\s*->\s*(outputs\/[^\s]+)/iu)?.[1];
        if (promotedPath) {
          // The temp tool has copied and verified the file.  Registering it
          // here creates the clickable artifact message without trusting any
          // path that appeared only in model prose.
          await ctx.services.createFileRecord(ctx.projectId, promotedPath, '', ctx.agentInstanceId, ctx.runId, '临时任务文件经统筹确认后发布');
          artifacts.push({ relativePath: promotedPath, content: '系统确认的临时文件提升成果' });
        }
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

/**
 * A single independent delegation is a handoff, not a coordination workflow.
 * Keep the work tree quiet in that case; the actual @ message and the final
 * coordinator summary are sufficient user-visible feedback.  A parallel batch
 * or multiple delegates still gets the full tree.
 */
function requiresCoordinationView(state: Pick<GraphState, 'cliDelegations' | 'parallelDelegationApproved'>): boolean {
  if (state.parallelDelegationApproved) return true;
  return (state.cliDelegations ?? []).length !== 1;
}

function instructionText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    if (typeof parsed.text === 'string') return parsed.text.trim();
  } catch { /* use raw instruction */ }
  return raw.trim();
}

const CONTEXT_FOLLOW_UP_RE = /(上面|上述|前面|之前|刚才|这个(?!(?:群|话|聊|频道|窗口|会话))|这些|这份|该内容|按此|基于此|把它|继续|接着|然后|另外|顺便|补充一下|再补充|发出来|发给我|直接发|发出文件|发个文件|把文件发|文件给我|导出(?:一下|出来)?|整理成文件|梳理成文件|整理成文档|梳理成文档)|^(?:那|那么)(?:帮我|请|就|再)/iu;
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
  const policy = deriveTaskDeliveryPolicy(raw);
  return policy.artifact === 'required' && policy.format === 'html';
}

export type TaskDeliveryPolicy = {
  artifact: 'required' | 'forbidden' | 'optional';
  format: string | null;
  reviewRequired: boolean;
};

const FORBIDDEN_ARTIFACT_RE = /(?:不要|无需|不需要|不必|禁止|避免|不得)(?:再|额外)?(?:创建|生成|制作|输出|导出|发送|发出|交付|提供|保存)?[^。；;，,\n]{0,10}(?:文件|材料|文档|报告|方案|网页|页面|附件|成果)|不(?:再|额外)?(?:创建|生成|制作|输出|导出|发送|发出|交付|提供|保存)[^。；;，,\n]{0,10}(?:文件|材料|文档|报告|方案|网页|页面|附件|成果)|(?:只|仅)(?:需要|要)?(?:输出|给出|返回)?(?:文字|文本|结论|回答|答复|回复)[^。；;\n]{0,24}(?:不要|无需|不需要|不必|不得|不(?:再|额外)?(?:创建|生成|制作|输出|导出|发送|发出|交付|提供|保存))[^。；;\n]{0,10}(?:文件|材料|文档|报告|方案|网页|附件|成果)/iu;
const NON_DELIVERABLE_ARTIFACT_CLAUSE_RE = /(?:不要|无需|不需要|不必|禁止|避免|不得|不(?:再|额外)?(?:创建|生成|制作|输出|导出|发送|发出|交付|提供|保存))[^。；;，,\n]{0,18}(?:临时|中间|过程|草稿|候选|源码)[^。；;，,\n]{0,18}(?:文件|材料|文档|报告|方案|网页|页面|附件|成果)?/giu;

export function deriveTaskDeliveryPolicy(raw: string): TaskDeliveryPolicy {
  const task = instructionText(raw).replace(/\s+/g, ' ').trim();
  const artifactPolicyText = task.replace(NON_DELIVERABLE_ARTIFACT_CLAUSE_RE, ' ');
  const artifactForbidden = FORBIDDEN_ARTIFACT_RE.test(artifactPolicyText);
  const explicitFormat = task.match(/\b(html?|pdf|docx?|xlsx?|pptx?|md|markdown|txt|csv|json)\b|网页文件|幻灯片|演示文稿|电子表格|Word\s*文档|PDF\s*文件/iu)?.[0]?.toLocaleLowerCase() ?? null;
  const asksToCreate = /(?:写|编写|撰写|起草|整理|梳理|汇总|归纳|生成|制作|输出|导出|发布|交付|提交|发送|发出)/iu.test(task);
  const artifactNoun = /(?:文件|材料|文档|报告|方案|邀请函|通知函|公函|函件|通知书|公告|手册|说明书|白皮书|清单|表格|网页|页面|图表|演示文稿|PPT|邮件|脚本|代码|成果)/iu.test(task);
  const asksToSendExisting = /(?:把|将)?(?:上面|上述|前面|刚才|这份|该|最终)?(?:文件|材料|文档|报告|成果)(?:发|发送|发出|给我|交付|导出)/iu.test(task);
  const required = !artifactForbidden && ((asksToCreate && artifactNoun) || asksToSendExisting);
  const defaultHtml = required
    && !explicitFormat
    && (DEFAULT_FILE_DELIVERY_RE.test(task) || DEFAULT_FORMAL_DOCUMENT_RE.test(task));
  const format = required
    ? (explicitFormat?.startsWith('htm') || explicitFormat === '网页文件' ? 'html' : explicitFormat) ?? (defaultHtml ? 'html' : null)
    : null;
  const explicitReview = /(?:独立)?(?:验收|审核|审查|复核|核验|校验|事实核查|证据核对)|确保(?:准确|无误|合规)|不得(?:变造|编造)/iu.test(task);
  const highRiskArtifact = /(?:合同|协议|法律|法务|合规|监管|审计|财务|税务|招投标|投标|安全规范|医疗|用药|人事处分|正式制度|对外公告)/iu.test(task);
  return {
    artifact: artifactForbidden ? 'forbidden' : required ? 'required' : 'optional',
    format,
    reviewRequired: required && (explicitReview || highRiskArtifact),
  };
}

/**
 * 判断用户是否在要求一个可交付成果，而不只是要一段检索结果。
 * 这是完成守卫，不是固定工作流：后续由统筹规划器决定由谁、以什么方式产出。
 */
export function requiresArtifactDeliverable(raw: string): boolean {
  return deriveTaskDeliveryPolicy(raw).artifact === 'required';
}

/**
 * 独立验收是风险守卫，不是材料任务的默认链路。
 * 普通报告、方案和脑暴只有在用户明确要求审核，或内容属于高风险领域时才强制验收。
 */
export function requiresQualityReview(raw: string): boolean {
  return deriveTaskDeliveryPolicy(raw).reviewRequired;
}

export function requiresMaterialReviewWorkflow(raw: string): boolean {
  const task = instructionText(raw);
  return requiresHtmlDeliverable(task) && requiresQualityReview(task);
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
    ], conciseGenerationOptions(900));
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
  // 只有时钟语境词紧邻时间词才视为本地时钟问题，避免“时间点/时间段”等普通词误命中。
  const asksLocalClock = /(?:现在|当前|此刻|今天|今日|北京时间).{0,8}(?:几点|时间|日期|星期几|周几)|(?:现在)?几点了|(?:今天|今日)(?:是)?(?:几号|星期几|周几)/u.test(text)
    && !/天气|气温|温度|分析|报告|文件|表格|图表|调研|研究|整理|汇总|方案|代码|网页|html/iu.test(text);
  const actionOrLookup = /(?:查询|查找|检索|搜索|读取|审阅|比较|核对|检查|依据|根据|生成|制作|整理|梳理|写|编写|撰写|导出|发送|上传|下载|登录|点击|执行|调用|处理|安排|任务|报告|文件|文档|方案|网页|html)/iu;
  const lightweightQuestion = text.length <= 120
    && /[？?]/u.test(text)
    && /^(?:请问|什么|为什么|怎么|如何|能否|是否|可以|介绍|解释|请解释|请介绍|谁|你|你们|咱|我们|聊聊|说说|讲讲|告诉我|评价|怎么看|觉得)/u.test(text)
    && !actionOrLookup.test(text);
  // 简短寒暄或自我介绍类陈述（不含任何动作/交付词）也直接回答。
  const casualStatement = text.length <= 60
    && /^(?:你是谁|你叫什么|你叫什么名字|你能做什么|你有哪些能力|有什么帮助|大家好|辛苦了|早上好|下午好|晚上好|晚安|哈喽|嘿)/iu.test(text)
    && !actionOrLookup.test(text);
  return /^(你好|您好|嗨|hello|hi|help|开始|谢谢|感谢|收到|好的|ok|okay)[！!。.]?$/i.test(text)
    || asksLocalClock
    || lightweightQuestion
    || casualStatement;
}

export function resolveLocalDateTimeAnswer(raw: string, now = new Date()): string | null {
  const text = instructionText(raw).replace(/\s+/g, ' ').trim();
  const asksDate = /(?:今天|今日|当前日期|现在日期).{0,8}(?:几号|日期|星期几|周几)|(?:今天|今日)(?:是)?(?:几号|星期几|周几)/u.test(text);
  const asksTime = /(?:现在|当前|此刻|北京时间).{0,8}(?:几点|时间)|(?:现在)?几点了/u.test(text);
  if (!asksDate && !asksTime) return null;
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(now);
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  if (asksDate && asksTime) return `现在是 ${date} ${time}（北京时间）。`;
  if (asksDate) return `今天是 ${date}。`;
  return `现在是 ${time}（北京时间）。`;
}

function needsFreshExternalInformation(raw: string): boolean {
  const text = instructionText(raw).replace(/\s+/g, ' ').trim();
  return /(?:今天|今日|现在|当前|实时|最新|近期).{0,18}(?:天气|气温|温度|降雨|空气质量|新闻|政策|市场|行情|价格|股价|汇率|路况)|(?:天气|气温|温度|降雨|空气质量|新闻|行情|股价|汇率).{0,18}(?:今天|今日|现在|当前|实时|最新)/iu.test(text);
}

export function weatherRequestMissingLocation(raw: string): boolean {
  const text = instructionText(raw).replace(/\s+/g, ' ').trim();
  if (!/(?:天气|气温|温度|降雨|空气质量)/u.test(text)) return false;
  const explicitLocation = /(?:北京|上海|天津|重庆|香港|澳门|台北|广州|深圳|杭州|南京|苏州|成都|武汉|西安|长沙|郑州|青岛|厦门|福州|合肥|昆明|贵阳|南宁|海口|三亚|哈尔滨|长春|沈阳|大连|济南|石家庄|太原|兰州|西宁|银川|乌鲁木齐|拉萨)|[\u4e00-\u9fff]{2,10}(?:省|市|县|区|州|旗)/u.test(text);
  return !explicitLocation;
}

export function resolvePendingWeatherClarification(snapshot: ExecContextSnapshot, currentInstruction: string): string | null {
  const current = instructionText(currentInstruction).trim();
  if (!current || current.length > 30 || /[？?]/u.test(current)) return null;
  const previous = snapshot.messages.filter((message, index, all) => !(
    index === all.length - 1 && message.role === 'user' && instructionText(message.content) === current
  ));
  const lastAssistant = [...previous].reverse().find((message) => message.role === 'assistant');
  if (!lastAssistant || !/(?:哪个|哪一个).{0,8}(?:城市|地区).{0,8}天气|天气.{0,8}(?:城市|地区)/u.test(instructionText(lastAssistant.content))) return null;
  const originalWeatherTask = [...previous].reverse().find((message) => (
    message.role === 'user' && /(?:天气|气温|温度|降雨|空气质量)/u.test(instructionText(message.content))
  ));
  if (!originalWeatherTask) return null;
  return `${instructionText(originalWeatherTask.content)}\n查询地点：${current}`;
}

function needsSpecialistWork(raw: string): boolean {
  const text = instructionText(raw);
  return needsOperationPlatformSupport(text)
    || needsFreshExternalInformation(text)
    || /文件|文档|邀请函|通知函|公函|函件|通知书|公告|知识库|知识图谱|原始资料|附件|上传|导入|检索|调研|研究|竞品|市场|行业|报告|方案|代码|编程|HTML|网页|图表|数据分析|生成文件|制作|撰写|起草|编写/i.test(text)
    || text.length > 260;
}

/**
 * 判定一段未能解析成功的文本是否是统筹规划器的结构化决策残片
 * （通常是输出 token 上限把 JSON 在中途截断）。这类残片绝不能
 * 当作自然语言答复直接发给用户。
 */
function looksLikeTruncatedPlannerJson(raw: string): boolean {
  const text = raw.trim();
  if (!text.startsWith('{')) return false;
  return /"(?:status|assignments|macroPlan|selfInstruction|userMessage)"\s*:/.test(text);
}

/**
 * 操作平台任务必须优先进入绑定平台的操作智能体。平台名称是用户可选的，
 * 因此除了“通过某平台”这类显式表达，也识别登录、页面流程和表单操作语义；
 * “网页搜索”仍属于公开调研，不会被误判为平台操作。
 */
function needsOperationPlatformSupport(raw: string): boolean {
  const text = instructionText(raw).replace(/\s+/g, ' ').trim();
  if (!text || /网页搜索|网络搜索|搜索网页|公开资料|互联网检索/iu.test(text)) return false;
  return /(?:通过|在|打开|进入|登录|登陆|退出|点击|填写|提交|查询|查看|读取|下载|录入|审批|流程|表单|门户|页面).{0,24}(?:平台|系统|网站|网页|页面|流程|表单|记录|合同|数据|内容)|(?:平台|系统|网站|网页|门户)\s*(?:中|里|上)?\s*(?:登录|登陆|查询|查看|填写|提交|点击|操作|处理)|(?:登录|登陆|点击|填写|提交|查询|查看).{0,24}(?:页面|按钮|流程|表单|记录)/iu.test(text);
}

function isOperationAgent<T extends { id: string; name: string; definitionId: string; runtimeMode: string }>(agent: T): boolean {
  return agent.definitionId.startsWith('operation-agent-') || /操作智能体/i.test(agent.name);
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
    // 模型不一定会使用“安排/委派”前缀，也常直接输出
    // “成员名称 请进入/点击/读取……”。这仍然是可执行委派，不能当成最终答复。
    const action = '(?:查|找|搜索|检索|调研|核对|核验|编写|起草|整理|生成|处理|完成|制作|验收|修改|返修|提供|进入|打开|登录|登陆|点击|读取|查看|获取|执行|提交|填写|下载|返回)';
    const patterns = [
      new RegExp(`(?:我(?:先|现在|接下来)?|先|现在|接下来)?(?:安排|委派|交给|让|请)\\s*@?${name}(?=\\s|[：:,，。！？!?]|$).{0,48}${action}`, 'iu'),
      new RegExp(`@?${name}\\s*(?:请|需要|负责|继续|先)?\\s*${action}`, 'iu'),
      new RegExp(`@?${name}\\s*[:：]\\s*.+${action}`, 'iu'),
    ];
    const match = patterns
      .map((pattern) => pattern.exec(text))
      .filter((candidate): candidate is RegExpExecArray => Boolean(candidate))
      .sort((left, right) => left.index - right.index)[0];
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
    if (isOperationAgent(agent)) {
      // A platform task belongs to the matching operation agent. Prefer an
      // explicit platform-name match when the public coordination profile is
      // available, then keep a smaller generic score for platform verbs.
      const publicProfile = String((agent as T & { coordinationProfile?: string }).coordinationProfile ?? '');
      if (needsOperationPlatformSupport(text)) value += 220;
      if (publicProfile && text && publicProfile.toLocaleLowerCase().includes(text.toLocaleLowerCase())) value += 40;
      const platformTerms = publicProfile.match(/绑定平台：([^（；。]+)/u)?.[1]?.trim();
      if (platformTerms && text.includes(platformTerms)) value += 240;
    }
    if (isLocalExecutorAgent(agent)) value += 25;
    if (isLocalExecutorAgent(agent) && (needsKnowledgeIngestion(text) || needsLocalKnowledgeSupport(text)
      || needsFreshExternalInformation(text) || requiresArtifactDeliverable(text)
      || /调研|研究|分析|核验|资料|报告|方案|文档|文件/iu.test(text))) value += 100;
    if (requiresArtifactDeliverable(text) && requiresQualityReview(text) && isMaterialWriterAgent(agent)) value += 90;
    if (requiresArtifactDeliverable(text) && /材料|报告|方案|文档|文件|网页|页面|整理|梳理|汇总/iu.test(text)
      && isMaterialWriterAgent(agent)) value += 70;
    if (needsKnowledgeIngestion(text) && isKnowledgeManagerAgent(agent)) value += 110;
    if (needsLocalKnowledgeSupport(text) && isMaterialWriterAgent(agent)) value += 85;
    if (!needsKnowledgeIngestion(text) && isKnowledgeManagerAgent(agent)) value -= 70;
    if (/调研|研究|市场|行业|竞品|来源|核查/i.test(text) && /research|调研/i.test(identity)) value += 30;
    if (needsFreshExternalInformation(text) && /research|调研/i.test(identity)) value += 100;
    // 明确需要 HTML/网页成果时，优先选择具备实际文件生成能力的外部执行智能体。
    if (requiresHtmlDeliverable(text) && agent.runtimeMode === 'external-cli') value += 60;
    else if (/代码|编程|网页|脚本|文件生成/i.test(text) && agent.runtimeMode === 'external-cli') value += 35;
    return value;
  };
  return [...agents].sort((left, right) => score(right) - score(left))[0];
}

function chooseFixedPaperWorkflowStep<T extends { id: string; name: string; definitionId: string; runtimeMode: string }>(
  task: string,
  agents: T[],
  _evidence: string,
  plannerHistory: string[] = [],
): { agent: T; objective: string } | undefined {
  const text = instructionText(task).toLocaleLowerCase();
  if (!/(?:邮箱|邮件)/u.test(text) || !/论文/u.test(text) || !/kimi/u.test(text) || !/codebuddy/u.test(text)) return undefined;
  const find = (predicate: (agent: T) => boolean) => agents.find(predicate);
  const mailbox = find((agent) => /邮箱秘书|邮件秘书/u.test(`${agent.name} ${agent.definitionId}`));
  const local = find((agent) => isLocalExecutorAgent(agent));
  const kimi = find((agent) => /kimi(?:\s|-)?code|custom\.kimi/iu.test(`${agent.name} ${agent.definitionId}`));
  const reviewer = find((agent) => /codebuddy/iu.test(`${agent.name} ${agent.definitionId}`));
  const attempted = (agent: T | undefined): boolean => Boolean(agent && plannerHistory.some((signature) => signature.startsWith(`${agent.id}:`)));
  // This demonstration is an ordered handoff, not a content-validation
  // workflow. A completed child run advances the cursor to the next member;
  // the child's wording must never decide whether a required step is skipped.
  if (mailbox && !attempted(mailbox)) {
    return { agent: mailbox, objective: '获取邮箱信息和相关邮件附件清单，返回邮件正文摘要及附件名称。' };
  }
  if (local && !attempted(local)) {
    return { agent: local, objective: '依据邮件信息和附件清单写出完整论文纲要。' };
  }
  if (kimi && !attempted(kimi)) {
    return { agent: kimi, objective: '依据论文需求和纲要完成代码，实现并返回真实代码文件及验证结果。' };
  }
  if (reviewer && !attempted(reviewer)) {
    return { agent: reviewer, objective: '验收 Kimi 的代码成果和论文纲要，返回明确验收结论。' };
  }
  return undefined;
}

function isFixedPaperWorkflowTask(task: string): boolean {
  const text = instructionText(task).toLocaleLowerCase();
  return /(?:邮箱|邮件)/u.test(text) && /论文/u.test(text) && /kimi/u.test(text) && /codebuddy/u.test(text)
    && /(?:代码|anomaly_detection|写代码)/iu.test(text);
}

function chooseArtifactAgent<T extends { id: string; name: string; definitionId: string; runtimeMode: string }>(
  task: string,
  agents: T[],
): T | undefined {
  const operationAgent = agents.find(isOperationAgent);
  if (operationAgent && needsOperationPlatformSupport(task)) return operationAgent;
  const localExecutor = agents.find((agent) => isLocalExecutorAgent(agent));
  if (localExecutor) return localExecutor;
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

function needsKnowledgeIngestion(task: string): boolean {
  return /知识化|入库|OCR|标准化|切片|向量化?|知识图谱|Wiki|解析.{0,8}(?:文件|文档)|处理.{0,8}(?:原始文件|上传文件|文档)|更新.{0,8}(?:知识库|图谱)|新增.{0,8}(?:原始文件|上传文件)|删除.{0,8}(?:原始文件|来源)/iu.test(instructionText(task));
}

function isMaterialWriterAgent(agent: { definitionId: string; name: string }): boolean {
  return agent.definitionId === 'builtin.material-writer' || /材料编写智能体/iu.test(agent.name);
}

function isLocalExecutorAgent(agent: { definitionId: string; name: string }): boolean {
  return agent.definitionId === 'builtin.local-executor' || /本地执行智能体/iu.test(agent.name);
}

function isAcceptanceReviewerAgent(agent: { definitionId: string; name: string }): boolean {
  return agent.definitionId === 'builtin.acceptance-reviewer' || /验收智能体/iu.test(agent.name);
}

function alignAgentWithTask<T extends { definitionId: string; name: string }>(
  selected: T,
  task: string,
  agents: T[],
): T {
  if (isKnowledgeManagerAgent(selected) && !needsKnowledgeIngestion(task)) {
    return agents.find((agent) => isMaterialWriterAgent(agent)) ?? selected;
  }
  return selected;
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

/**
 * Model-facing planning uses JSON, but the same response can occasionally be
 * routed to the chat renderer.  Keep this boundary deliberately narrow: only
 * objects carrying orchestration fields are treated as internal.  A normal
 * business JSON response (for example a list of records) must remain visible.
 */
const INTERNAL_ORCHESTRATION_JSON_KEYS = new Set([
  'assignments', 'macroPlan', 'activeStageId', 'stageSatisfied', 'selfInstruction',
  'missingFields', 'agentInstanceId', 'agentId', 'dependsOn', 'parallelGroup',
  'expectedDeliverable', 'visibleMessage', 'subtasks', 'delegations', 'toolCalls',
  'sandboxRelativePath',
]);

function parseInternalOrchestrationObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    const keys = Object.keys(object);
    const hasStrongKey = keys.some((key) => INTERNAL_ORCHESTRATION_JSON_KEYS.has(key));
    const status = typeof object.status === 'string' ? object.status : '';
    const hasPlannerPair = ['delegate', 'self_execute', 'complete', 'ask_user'].includes(status)
      && ('reason' in object || 'userMessage' in object || 'assignments' in object || 'selfInstruction' in object || 'summary' in object);
    const hasLocalPlanShape = typeof object.summary === 'string' && Array.isArray(object.items);
    const isArtifactProposal = object.type === 'artifact.proposed';
    return hasStrongKey || hasPlannerPair || hasLocalPlanShape || isArtifactProposal ? object : null;
  } catch {
    return null;
  }
}

function internalObjectFallback(object: Record<string, unknown>): string {
  // A planner may include a user-facing clarification in userMessage.  It is
  // safe to retain that sentence; all other planner fields stay internal.
  for (const key of ['userMessage', 'finalResponse', 'answer', 'message']) {
    const value = object[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function replaceInternalJsonBlock(_whole: string, json: string): string {
  const object = parseInternalOrchestrationObject(json.trim());
  return object ? internalObjectFallback(object) : _whole;
}

/**
 * Normalize text at the user-visible boundary.  This is intentionally not a
 * generic Markdown/JSON stripper: valid JSON requested by a user is retained,
 * while planner envelopes and legacy routing protocols are removed or reduced
 * to their explicit userMessage fallback.
 */
export function sanitizeUserFacingResponse(input: string): string {
  if (!input) return '';
  let text = input.trim();

  // Whole-response planner objects are the most common leakage shape.
  const wholeObject = parseInternalOrchestrationObject(text);
  if (wholeObject) return internalObjectFallback(wholeObject);

  // Remove fenced planner JSON while retaining an explicit clarification if
  // one was supplied.  Other fenced JSON is ordinary user content.
  text = text.replace(/```json\s*([\s\S]*?)```/giu, replaceInternalJsonBlock);

  // Also handle a planner object appended after a natural-language sentence.
  // The candidate is accepted only when JSON.parse succeeds and the object has
  // known orchestration fields, so ordinary braces in prose are untouched.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    const object = parseInternalOrchestrationObject(candidate);
    if (object) {
      const prefix = text.slice(0, firstBrace).trimEnd();
      const suffix = text.slice(lastBrace + 1).trimStart();
      const fallback = internalObjectFallback(object);
      text = [prefix, fallback, suffix].filter(Boolean).join('\n\n');
    }
  }

  // Legacy line protocols and explicit internal narration should never reach
  // the chat, but keep normal numbered business lists intact.
  text = text
    .replace(/^\s*(?:NEED_AGENTS|NEED_CLI|NEED_KM|NO_RECOVERY)\b[^\n]*$/gimu, '')
    .replace(/^\s*临时文件已由系统保存：[^\n]*$/gimu, '')
    .replace(/^\s*(?:我的)?(?:执行清单|工具调用(?:结果)?|内部(?:执行)?(?:步骤|思考|推理)|调度(?:决策|协议)|系统(?:提示|字段))\s*[:：]?\s*$/gimu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

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

function buildVisibleDelegationInstruction(
  instruction: string,
  fallbackTask: string,
  options?: { visibleMessage?: string; directTask?: string },
): string {
  // 规划器给出的 visibleMessage 是最自然的群聊话术，直接透传。
  const plannerNote = (options?.visibleMessage ?? '').replace(/\s+/g, ' ').trim();
  if (plannerNote) {
    return plannerNote.length > 240 ? `${plannerNote.slice(0, 236)}…` : plannerNote;
  }
  // 单成员简单委派：直接转达用户请求，不再附带流程话术尾巴。
  const directTask = (options?.directTask ?? '').replace(/\s+/g, ' ').trim();
  if (directTask) {
    const cleanedDirect = directTask
      .replace(/@(?:用户|统筹管理智能体)\s*/g, '')
      .replace(/^(?:那|那么|帮我|麻烦你?|请你?)[，,]?\s*/u, '')
      .trim();
    const userFacing = cleanedDirect || directTask;
    return userFacing.length > 240 ? `${userFacing.slice(0, 236)}…` : userFacing;
  }
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
    .replace(/^(?:以下)?(?:内部知识读取任务|增量知识化任务)[：:\s]*/u, '')
    .replace(/[。！？!?]+$/, '')
    .trim();
  const fallbackSummary = conciseTaskBrief(fallbackTask).replace(/[。！？!?]+$/, '');
  const taskSummary = cleanSummary && normalizeComparableTask(cleanSummary) !== normalizeComparableTask(fallbackSummary)
    ? cleanSummary
    : fallbackSummary;
  const delivery = requiresArtifactDeliverable(taskSummary)
    ? /html/i.test(taskSummary)
      ? '整理好后把可直接打开的文件发回群里。'
      : '完成后把成果文件和必要说明发回群里。'
    : '完成后把关键结果发回群里。';
  // Work packages may already contain an explicit delivery clause. Avoid
  // appending the same visible instruction twice when the planner narrated it.
  const normalizedSummary = taskSummary.replace(/[。！？!?]+$/u, '').trim();
  const normalizedDelivery = delivery.replace(/[。！？!?]+$/u, '').trim();
  return normalizedSummary.endsWith(normalizedDelivery)
    ? `${normalizedSummary}。`
    : `${normalizedSummary}。${delivery}`;
}

function buildFixedDelegationInstruction(task: string, workItem: string): string {
  const item = conciseTaskBrief(workItem || task).replace(/\s+/g, ' ').trim();
  return `请执行当前任务项：${item || '完成统筹分配的任务'}。完成后返回真实结果。`;
}

function isKnowledgeManagerAgent(agent: { definitionId: string; name: string }): boolean {
  return agent.definitionId === 'builtin.knowledge-manager' || /知识管理|知识管理员/i.test(agent.name);
}

function buildDelegationPlanNote(
  plannedAssignments: Array<{ targetAgent: { name: string }; instruction: string }>,
  parallel: boolean,
): string {
  const items = plannedAssignments.map((assignment, index) => {
    const brief = conciseTaskBrief(assignment.instruction);
    return `${index + 1}. ${assignment.targetAgent.name}：${brief.length > 120 ? `${brief.slice(0, 116)}…` : brief}`;
  });
  if (items.length === 0) return '';
  const closing = parallel ? '各项相互独立，将并行推进。' : '各项存在先后依赖，将按序推进。';
  return `这个任务需要几位成员配合，我先拆解如下：\n${items.join('\n')}\n${closing}`;
}

function isResearcherAgent(agent: { definitionId: string; name: string }): boolean {
  return agent.definitionId === 'builtin.researcher' || /资料调研|研究智能体|调研智能体/i.test(agent.name);
}

function normalizeComparableTask(value: string): string {
  return instructionText(value).replace(/[\s，,。；;：:！？!?“”"'`]/g, '').toLocaleLowerCase();
}

function plannerAssignmentSignature(
  agentId: string,
  objective: string,
  stepId?: string,
  stageId?: string,
): string {
  const normalizedStage = normalizeComparableTask(stageId ?? '') || '-';
  const rawStep = normalizeComparableTask(stepId ?? '');
  const normalizedStep = /^legacy-?\d*$/u.test(rawStep) ? '-' : rawStep || '-';
  if (normalizedStage !== '-' || normalizedStep !== '-') {
    return `${agentId}:${normalizedStage}:${normalizedStep}`;
  }
  const normalizedObjective = normalizeComparableTask(objective).slice(0, 800);
  return `${agentId}:${normalizedStage}:${normalizedStep}:${normalizedObjective}`;
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
    if (isLocalExecutorAgent(agent)) return buildLocalExecutorTask(proposed);
    if (isKnowledgeManagerAgent(agent)) return buildKnowledgeManagerTask(proposed);
    if (isMaterialWriterAgent(agent)) return buildMaterialWriterKnowledgeTask(proposed);
    return proposed;
  }

  if (isLocalExecutorAgent(agent)) return buildLocalExecutorTask(resolvedTask);
  if (isKnowledgeManagerAgent(agent)) return buildKnowledgeManagerTask(resolvedTask);
  if (isMaterialWriterAgent(agent)) return buildMaterialWriterKnowledgeTask(resolvedTask);
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
  mode: CollaborationMode = 'expert',
): string {
  const assignmentCreatesArtifact = requiresArtifactDeliverable(instruction)
    || /(?:待审稿|候选稿|返修|改稿|编写|撰写|起草|生成|制作).{0,24}(?:报告|方案|材料|文档|文件|HTML|网页|邀请函|公函)/iu.test(instruction);
  const needsDraft = assignmentCreatesArtifact && (
    requiresQualityReview(task)
    || (mode !== 'expert' && requiresArtifactDeliverable(task))
  );
  if (!isMaterialWriterAgent(agent) || !needsDraft) return instruction;
  const draftFileName = 'draft.html';
  if (instruction.includes('temp:save') && instruction.includes(draftFileName)) return instruction;
  if (mode === 'fast') {
    return `${instruction}\n\n快速协同成果控制：一次性完成整篇文档，并使用 temp:save 保存为 ${draftFileName}。只填写文件名，不填写路径；不要自行验收或返修，不要写入 outputs/、发布群聊附件或粘贴完整 HTML 源码；统筹智能体会直接处理这份真实临时文件。`;
  }
  if (mode === 'balanced') {
    return `${instruction}\n\n均衡协同成果控制：在当前环节内完成结构与证据自检后，一次性生成整篇文档，并使用 temp:save 保存为 ${draftFileName}。只填写文件名，不填写路径；不要重复改稿，不要写入 outputs/、发布群聊附件或粘贴完整 HTML 源码；如任务需要独立验收，统筹最多安排一次。`;
  }
  return `${instruction}\n\n成果控制：请使用 temp:save 将候选成果保存为 ${draftFileName}。只填写文件名，不填写路径；在独立验收通过前不要写入 outputs/、不要发布群聊附件，也不要粘贴完整 HTML 源码；返修时覆盖同一文件名。`;
}

function conciseTaskBrief(task: string): string {
  const normalized = task.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 260) return normalized;
  const sentence = normalized.slice(0, 260).replace(/[，,；;]?[^，,。；;！？!?]{0,48}$/, '').trim();
  return `${sentence.length >= 120 ? sentence : normalized.slice(0, 256)}…`;
}

// 独立闭环交付指令：简单单委派时成员自己就能把最终结果交给用户，
// 统筹成功时保持零输出，不再出现「成员 @ 统筹、统筹再总结」的额外
// 往返。该指令进入成员 Run 的委派消息（群聊可见话术仍保持简洁），
// 成员按其约定直接面向用户交付，只有复杂协作才回传统筹。
const INDEPENDENT_DELIVERY_DIRECTIVE = [
  '本轮为独立闭环交付：完成后直接在群聊面向用户给出最终结论、关键证据和真实成果文件。',
  '需要文件交付时由你直接核验并提升为 outputs 正式成果；不要 @ 统筹管理智能体，不要等待统筹验收、总结或追问。',
].join('');

// 成员执行侧用同一指令标记识别独立闭环委派：这类 Run 的最终回复
// 就是给用户的交付，交付路由不再 @ 委派方转交。
export function isIndependentDeliveryInstruction(instruction: string): boolean {
  return instruction.includes(INDEPENDENT_DELIVERY_DIRECTIVE);
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
    const memoryContext = ctx.services.buildMemoryContext(ctx.projectId, ctx.agentInstanceId, currentInstruction);
    const direct = await ctx.services.generateText('fast', [
      {
        role: 'system',
        content: [
          '你只负责回答用户对最近群聊或执行情况的追问。严格依据给出的最近消息，区分“已经完成”“正在执行”“只是计划或委派”，不要把计划当作完成事实；信息不足时直接说明无法从现有消息确认。回答自然、简洁，不要重新执行任务、委派成员、调用工具、生成任务清单或输出内部协议。',
          ...(memoryContext ? [`\n\n## 记忆补充\n${memoryContext}`] : []),
        ].join(''),
      },
      {
        role: 'user',
        content: `最近消息：\n${buildConversationStatusHistory(snapshot, currentInstruction)}\n\n用户现在问：\n${currentInstruction}`,
      },
    ], conciseGenerationOptions(900));
    const text = sanitizeUserFacingResponse(direct.text.trim()) || '从现有消息里还无法确认刚才的具体执行情况。';
    return { resolvedTask: currentInstruction, messages: [{ role: 'assistant', content: text }], finalResponse: text, needsKnowledgeManager: false, needsCLIDelegation: false, artifacts: [] };
  }
  const task = resolvePendingWeatherClarification(snapshot, currentInstruction)
    ?? await resolveConversationTask(ctx, snapshot, currentInstruction);
  if (weatherRequestMissingLocation(task)) {
    const question = '你想查询哪个城市或地区的天气？';
    const macroPlan: OrchestratorMacroPlan = {
      goal: task,
      completionCriteria: ['地点和日期范围已经明确', '天气信息带有观测或预报时间与可靠来源', '向用户给出简洁、可行动的天气答复'],
      stages: [
        { id: 'clarify-location', objective: '补齐天气查询地点', completionCriteria: ['取得明确城市或地区'], dependsOn: [], status: 'blocked' },
        { id: 'fetch-weather', objective: '查询指定地点当天的天气', completionCriteria: ['取得带时间和来源的天气结果'], dependsOn: ['clarify-location'], status: 'pending' },
        { id: 'answer-weather', objective: '归纳天气并回答用户', completionCriteria: ['回答温度、天气状况和必要提醒'], dependsOn: ['fetch-weather'], status: 'pending' },
      ],
    };
    ctx.services.addRunEvent(ctx.runId, 'run.macro-plan', { plan: macroPlan });
    ctx.services.saveTaskPlan?.({
      projectId: ctx.projectId,
      rootRunId: ctx.runId,
      triggerMessageId: ctx.triggerMessageId,
      resolvedGoal: task,
      complexity: 'missing-input',
      status: 'waiting-user',
      completionCriteria: macroPlan.completionCriteria,
      nodes: macroPlan.stages.map((planStage) => ({
        id: planStage.id,
        title: planStage.objective,
        objective: planStage.objective,
        completionCriteria: planStage.completionCriteria,
        dependsOn: planStage.dependsOn,
        executionMode: planStage.id === 'clarify-location' ? 'wait-user' as const : 'serial' as const,
        status: planStage.id === 'clarify-location' ? 'waiting-user' as const : 'pending' as const,
      })),
    });
    sendTrace(ctx, 'reasoning', '天气查询还缺少地点，先向用户确认', 'completed');
    return {
      resolvedTask: task,
      messages: [{ role: 'assistant', content: question }],
      finalResponse: question,
      needsKnowledgeManager: false,
      needsCLIDelegation: false,
      macroPlan,
      activeStageId: 'clarify-location',
      awaitingUser: { question, missingFields: ['location'] },
      artifacts: [],
    };
  }
  const localDateTimeAnswer = resolveLocalDateTimeAnswer(task);
  if (localDateTimeAnswer) {
    sendTrace(ctx, 'reasoning', '使用系统时钟回答日期时间问题', 'completed');
    return {
      resolvedTask: task,
      messages: [{ role: 'assistant', content: localDateTimeAnswer }],
      finalResponse: localDateTimeAnswer,
      needsKnowledgeManager: false,
      needsCLIDelegation: false,
      artifacts: [],
    };
  }
  if (isSimpleDirectTask(task)) {
    sendProgress(ctx, '直接回答', 45);
    sendTrace(ctx, 'reasoning', '判断为轻量问题，直接回答', 'completed');
    const memoryContext = ctx.services.buildMemoryContext(ctx.projectId, ctx.agentInstanceId, task);
    const direct = await ctx.services.generateText('fast', [
      {
        role: 'system',
        content: [
          '只回答用户这条轻量问题，语气自然简洁。不要委派成员、调用工具或输出内部协议。',
          ...(memoryContext ? [`\n\n## 记忆补充\n${memoryContext}`] : []),
        ].join(''),
      },
      { role: 'user', content: task },
    ], conciseGenerationOptions(700));
    const text = sanitizeUserFacingResponse(direct.text.trim()) || '我可以继续帮你处理。';
    return { resolvedTask: task, messages: [{ role: 'assistant', content: text }], finalResponse: text, needsKnowledgeManager: false, needsCLIDelegation: false, artifacts: [] };
  }

  sendProgress(ctx, '分析意图', 10);
  sendTrace(ctx, 'reasoning', '分析用户目标与任务边界', 'running');
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
    content: `${messages[0]?.content ?? ORCHESTRATOR_SYSTEM_PROMPT}\n\n## 当前日期\n${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n## 当前群聊可委派成员及公开职责\n${roster || '- 无可用成员'}\n这些是成员允许向统筹公开的职责、适合输入和交付边界，不包含其私有记忆或私有适应内容。成员清单已经由系统确认，不要再次调用工具查询。先还原用户目标，再输出 complexity：simple、complex 或 missing-input。simple 只直答或转发给一个可独立闭环的成员；complex 必须先拆成完整业务 TODO，再依据注册表分配成员。请根据完整目标、当前执行缺口、成员职责和工作依赖决定下一步，不要套用固定角色模板。复杂任务第一次输出的 JSON 还必须包含 macroPlan：{goal,completionCriteria,stages:[{id,objective,completionCriteria,dependsOn}]}，以及 activeStageId 和 stageSatisfied。宏观阶段按业务依赖描述目标，不预先写死成员，也不能把多结果、多依赖任务压成一个笼统阶段。${ctx.collaborationMode === 'fast'
      ? '\n\n## 快速协同约束\n目标是用最少必要动作解决当前需求。能直接回答或自行完成就不要委派；确有能力缺口时，当前批次只委派 1 名最必要成员。整棵任务树禁止调用验收智能体、独立验收、复验、返修循环、任务后知识归集和分身；不因流程完整额外增加知识检索、公开调研或文件环节。材料需要文件时一次生成完整稿，由统筹直接提升并发布。取得足以回答或交付的真实结果后立即结束。'
      : ctx.collaborationMode === 'balanced'
        ? '\n\n## 均衡协同约束\n只保留会实际影响结果的必要步骤；能直接完成就不要增加成员。当前批次最多委派 2 名彼此独立的成员，有依赖时必须串行等待，每个阶段最多两次调度判断。材料一次生成完整稿。仅在用户明确要求或高风险成果确有必要时安排验收；整棵任务树由统筹、专业智能体和分身共享 1 次验收额度，使用后不得再调用验收智能体、验收分身或复验。不得因精简流程省略真实成果发布等完成边界。'
        : ''}`,
  };

  const result = await ctx.services.generateText(
    ctx.delegationOnly ? 'fast' : 'reasoning',
    messages,
    plannerGenerationOptions(ctx, ctx.delegationOnly ? 1_000 : 2_200),
  );

  let needsKM: boolean;
  let rawText: string;
  let artifacts: Array<{ relativePath: string; content: string }> = [];
  // 规划器为各委派目标给出的自然可见话术，随 state 传给委派节点。
  let plannerDelegationNotes: Array<{ agentInstanceId: string; visibleMessage: string }> = [];

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
  let macroPlan = structuredPlan.macroPlan ?? fallbackMacroPlan(task, structuredPlan.assignments);
  if (structuredPlan.complexity === 'complex' && macroPlan.stages.length < 2 && !isFixedPaperWorkflowTask(task)) {
    macroPlan = ensureComplexBusinessPlan(task, macroPlan);
  }
  const activeStageId = structuredPlan.activeStageId
    || structuredPlan.assignments.find((assignment) => assignment.stageId)?.stageId
    || macroPlan.stages.find((stage) => stage.status === 'active')?.id
    || macroPlan.stages[0]?.id
    || '';
  ctx.services.addRunEvent(ctx.runId, 'run.macro-plan', { plan: macroPlan });
  let initialSelfInstruction = '';
  let initialUserQuestion = '';
  let parallelDelegationApproved = false;
  // 简单问答型单委派标记：成员自己的回复就是最终答案，统筹委派后
  // 直接结束，不监听等待、不做归纳总结。只有「直接结构化规划」路径
  // 才允许置位——纠偏、兜底、KM 前置等转换路径的成员输出多为中间
  // 产物，统筹仍需继续收集处理。
  let fireAndForgetDelegation = false;
  if (hasStructuredPlan && structuredPlan.status === 'complete') {
    const initialCompletion = buildCompletionState(task, '', artifacts, [], availableAgents, ctx.collaborationMode ?? 'expert');
    if (initialCompletion.missing.length > 0 || needsFreshExternalInformation(task) || needsOperationPlatformSupport(task)) {
      // 模型可能把“已经找到资料”误判为完成。系统只纠正这个完成边界，
      // 下一步仍交给自适应规划器决定具体成员和方式。
       const operationAgent = availableAgents.find((agent) => isOperationAgent(agent) && needsOperationPlatformSupport(task));
       const localExecutor = availableAgents.find((agent) => isLocalExecutorAgent(agent));
      const freshInfoAgent = !localExecutor && needsFreshExternalInformation(task)
        ? availableAgents.find((agent) => isResearcherAgent(agent))
        : undefined;
      const localKnowledgeAgent = !freshInfoAgent && needsLocalKnowledgeSupport(task)
        ? availableAgents.find((agent) => isMaterialWriterAgent(agent))
        : undefined;
       const firstAgent = operationAgent ?? localExecutor ?? freshInfoAgent ?? localKnowledgeAgent ?? chooseArtifactAgent(task, availableAgents);
      if (firstAgent) {
        rawText = `NEED_AGENTS\n${firstAgent.id}: ${firstAgent === localExecutor
          ? buildLocalExecutorTask(task)
          : firstAgent === freshInfoAgent
          ? `请查询并核实这个问题所需的最新公开信息，返回带时间和来源的简洁事实，供统筹智能体最终回答：\n${task}`
          : firstAgent === localKnowledgeAgent
            ? buildMaterialWriterKnowledgeTask(task)
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
    parallelDelegationApproved = ctx.collaborationMode !== 'fast'
      && runnableAssignments.length > 1
      && Boolean(runnableAssignments[0]?.parallelGroup)
      && runnableAssignments.every((assignment) => assignment.parallelGroup === runnableAssignments[0]?.parallelGroup);
    const assignmentLimit = ctx.collaborationMode === 'fast' ? 1 : ctx.collaborationMode === 'balanced' ? 2 : runnableAssignments.length;
    const normalizedAssignments = runnableAssignments.slice(0, assignmentLimit).flatMap((assignment) => {
      const agent = resolvePlannerAgentReference(assignment.agentInstanceId, availableAgents);
      if (!agent || (ctx.collaborationMode === 'fast' && isAcceptanceReviewerAgent(agent))) return [];
      return [{ ...assignment, agentInstanceId: agent.id }];
    });
    if (normalizedAssignments.length > 0) {
      // 规划器的 visibleMessage 是面向群聊的自然话术，随 state 传给委派节点。
      plannerDelegationNotes = normalizedAssignments
        .map((assignment) => ({ agentInstanceId: assignment.agentInstanceId, visibleMessage: (assignment.visibleMessage ?? '').trim() }))
        .filter((note) => note.visibleMessage.length > 0);
      rawText = `NEED_AGENTS\n${normalizedAssignments.map((assignment) => (
        `${assignment.agentInstanceId}: ${[assignment.objective, assignment.inputs, assignment.expectedDeliverable]
          .filter(Boolean)
          .map((part) => String(part).replace(/\s+/g, ' ').trim())
          .join('；')}`
      )).join('\n')}`;
      // 简单单委派闭环判定：仅一个可直接执行的工作包、非并行批次、
      // 非多轮承接指令，且成员可以独立把结果交给用户——要么任务本身
      // 没有交付物要求（成员回复即最终答案），要么成员具备独立交付
      // 能力（本地执行智能体可直接把成果提升为 outputs 正式成果）。
      // 此时统筹 @ 完成员即转入静默守望，成功时零输出结束。多包串行、
      // 承接续作以及需要统筹验收提升成果的成员（如材料编写智能体）
      // 仍需等待收集并完成后续归纳、发布或推进。
      const soleDeliverer = normalizedAssignments.length === 1
        ? availableAgents.find((agent) => agent.id === normalizedAssignments[0]?.agentInstanceId)
        : undefined;
      const soleDelivererClosesLoop = soleDeliverer ? isLocalExecutorAgent(soleDeliverer) : false;
      if (normalizedAssignments.length === 1
        && !parallelDelegationApproved
        && canFireAndForget(macroPlan, normalizedAssignments[0], { parallelDelegationApproved })
        && (!requiresArtifactDeliverable(task) || soleDelivererClosesLoop)
        && (!requiresArtifactDeliverable(currentInstruction) || soleDelivererClosesLoop)
        && !needsConversationTaskResolution(currentInstruction)
        && !needsConversationTaskResolution(task)) {
        fireAndForgetDelegation = true;
      }
    }
  }
  if (hasStructuredPlan && structuredPlan.status === 'ask_user') {
    initialUserQuestion = structuredPlan.userMessage || '继续处理前需要你补充一项关键信息。';
    rawText = initialUserQuestion;
  }

  // Start a new fixed collaboration chain from the mailbox step. Historical
  // chat/memory evidence must not satisfy a fresh run and skip required nodes.
  const fixedPaperStep = chooseFixedPaperWorkflowStep(task, availableAgents, '');
  if (fixedPaperStep) {
    rawText = `NEED_AGENTS\n${fixedPaperStep.agent.id}: ${fixedPaperStep.objective}`;
    initialSelfInstruction = '';
    initialUserQuestion = '';
  }

  needsKM = rawText.trim().startsWith('NEED_KM');
  let selfInstruction = initialSelfInstruction || (hasStructuredPlan && structuredPlan.status === 'self_execute'
    ? structuredPlan.selfInstruction || structuredPlan.reason || task
    : '');
  let needsCLI = !initialUserQuestion && !needsKM && /^(NEED_AGENTS|NEED_CLI)\b/.test(rawText.trim());

  let cleanText = needsKM
    ? rawText.replace(/^NEED_KM\s*\n?/, '').trim()
    : needsCLI
      ? rawText.replace(/^(NEED_AGENTS|NEED_CLI)\s*\n?/, '').trim()
      : (selfInstruction ? '' : rawText);

  // In delegation-only groups the orchestrator may answer lightweight
  // conversation, but it must never perform concrete work itself. Convert
  // planner self-execution/completion mistakes into one real member handoff.
  if (ctx.delegationOnly && !initialUserQuestion && !needsKM && !needsCLI && selfInstruction) {
    const fallback = chooseFallbackAgent(task, availableAgents);
    if (fallback) {
      cleanText = `${fallback.id}: ${buildVisibleDelegationInstruction(task, selfInstruction)}`;
      needsCLI = true;
      selfInstruction = '';
    } else {
      selfInstruction = '';
      cleanText = '当前群聊没有可用的专业执行智能体，暂时无法处理该具体任务。';
    }
  }

  if (needsKM) {
    const available = ctx.services.getProjectDelegatableAgents(ctx.projectId).filter((agent) => agent.id !== ctx.agentInstanceId);
    const knowledgeTask = cleanText ? `${cleanText}\n完整任务背景：${task}` : task;
    const localExecutor = available.find((agent) => isLocalExecutorAgent(agent));
    const target = localExecutor ?? (needsKnowledgeIngestion(knowledgeTask)
      ? available.find((agent) => isKnowledgeManagerAgent(agent))
      : available.find((agent) => isMaterialWriterAgent(agent)));
    if (target) {
      const instruction = isLocalExecutorAgent(target)
        ? buildLocalExecutorTask(knowledgeTask)
        : isKnowledgeManagerAgent(target)
        ? buildKnowledgeManagerTask(knowledgeTask)
        : buildMaterialWriterKnowledgeTask(knowledgeTask);
      cleanText = `${target.id}: ${instruction.replace(/\s*\n\s*/g, ' ')}`;
      needsKM = false;
      needsCLI = true;
    }
  }

  // 模型有时会用自然语言说“我先安排某智能体处理”，却没有输出结构化委派。
  // 这种计划说明不能直接作为最终答复，必须落成一条真实的群聊委派消息。
  if (!needsKM && !needsCLI && !selfInstruction) {
    const explicitlyNamedAgent = inferExplicitNaturalDelegation(rawText, availableAgents);
    if (explicitlyNamedAgent) {
      cleanText = `${explicitlyNamedAgent.id}: ${rawText}`;
      needsCLI = true;
    }
  }

  // 模型漏掉委派协议时，只对明显的专业/复合任务做一次能力兜底；轻量问题已在上面直答。
  // 规划器的结构化决策若因输出截断而解析失败，残片同样不能当作自然语言
  // 答复直出给用户，一并走能力兜底重新落成真实委派。
  const plannerFragment = looksLikeTruncatedPlannerJson(rawText);
  if (!needsKM && !needsCLI && !selfInstruction && (needsSpecialistWork(task) || plannerFragment)) {
    const fallback = chooseFallbackAgent(task, availableAgents);
    if (fallback) {
      cleanText = `${fallback.id}: ${buildVisibleDelegationInstruction(task, task)}`;
      needsCLI = true;
    } else if (plannerFragment) {
      // 群内没有可委派成员时，至少不能把截断残片原样发给用户，
      // 转由统筹智能体自行接手作答。
      selfInstruction = `请直接完成并自然回答用户的完整需求：${task}`;
      cleanText = '';
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
    // 只有存在多个工作包或后续阶段依赖时才公开协调工作树；
    // 单一成员可独立完成的任务仅保留实际 @ 委派消息。
    const showCoordinationView = macroPlan.stages.length > 1
      || delegatedNames.length > 1
      || Boolean(parallelDelegationApproved);
    if (showCoordinationView) {
      sendOrchestratorChecklist(ctx, 'delegating', {
        understand: conciseTaskBrief(task),
        decompose: `已根据任务目标和成员能力形成 ${delegatedNames.length} 个工作包。`,
        delegate: delegatedNames.length > 0 ? `准备安排：${delegatedNames.join('、')}` : '正在匹配合适的成员。',
      });
    }
  }

  const { processedText: finalText, artifacts: textArtifacts } = await processToolCalls(cleanText, ctx);
  artifacts = [...artifacts, ...textArtifacts];

  const stage = needsKM ? '准备知识处理' : needsCLI ? '拆分并委派子任务' : '生成回复';
  const progress = needsKM ? 30 : needsCLI ? 30 : 50;
  sendProgress(ctx, stage, progress);

  const persistAsComplex = structuredPlan.complexity === 'complex'
    || structuredPlan.complexity === 'missing-input'
    || macroPlan.stages.length > 1;
  if (persistAsComplex) {
    const assignmentsByStage = new Map(structuredPlan.assignments.map((assignment) => [
      assignment.stageId || assignment.stepId || '',
      assignment,
    ]));
    ctx.services.saveTaskPlan?.({
      projectId: ctx.projectId,
      rootRunId: ctx.runId,
      triggerMessageId: ctx.triggerMessageId,
      resolvedGoal: macroPlan.goal || task,
      complexity: initialUserQuestion || structuredPlan.complexity === 'missing-input' ? 'missing-input' : 'complex',
      status: needsCLI ? 'running' : initialUserQuestion ? 'waiting-user' : 'planned',
      completionCriteria: macroPlan.completionCriteria,
      nodes: macroPlan.stages.map((planStage) => {
        const assignment = assignmentsByStage.get(planStage.id);
        const assigned = assignment ? resolvePlannerAgentReference(assignment.agentInstanceId, availableAgents) : undefined;
        return {
          id: planStage.id,
          title: planStage.objective,
          objective: planStage.objective,
          ...(assignment?.inputs ? { inputs: [assignment.inputs] } : {}),
          ...(assignment?.expectedDeliverable ? { expectedResult: assignment.expectedDeliverable } : {}),
          completionCriteria: planStage.completionCriteria,
          dependsOn: planStage.dependsOn,
          executionMode: assignment?.parallelGroup ? 'parallel' as const : 'serial' as const,
          ...(assigned ? { assignedAgentId: assigned.id } : {}),
          status: planStage.status === 'satisfied'
            ? 'completed' as const
            : assigned && planStage.id === activeStageId && needsCLI
              ? 'assigned' as const
              : planStage.status === 'blocked'
                ? 'blocked' as const
                : planStage.id === activeStageId
                  ? 'ready' as const
                  : 'pending' as const,
        };
      }),
    });
  }

  return {
    resolvedTask: task,
    messages: [{ role: 'assistant', content: finalText }],
    needsKnowledgeManager: needsKM,
    needsCLIDelegation: needsCLI,
    parallelDelegationApproved,
    fireAndForgetDelegation,
    delegationNotes: plannerDelegationNotes,
    finalResponse: needsKM || needsCLI || selfInstruction ? '' : finalText,
    selfInstruction,
    macroPlan,
    activeStageId,
    stageAttempts: activeStageId ? { [activeStageId]: 1 } : {},
    awaitingUser: initialUserQuestion
      ? { question: initialUserQuestion, missingFields: structuredPlan.missingFields ?? [] }
      : null,
    artifacts,
  };
}

export function buildKnowledgeManagerTask(raw: string): string {
  const task = instructionText(raw)
    .replace(/@(?:用户|统筹管理智能体|知识管理智能体)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [
    '请只执行当前群聊授权范围内的增量知识化，不执行知识检索、整文读取、模板查找或材料编写。',
    `任务背景：${conciseTaskBrief(task)}`,
    '检查个人、已关联项目和企业工作区的 original-files；未关联项目时跳过项目层。只处理新增、变更和未完成来源，并停用已删除来源。',
    '按文件类型完成 OCR、标准化正文、切片、摘要、关键词、标签、向量、实体关系、图谱、Wiki、入库和溯源；相同 MD5 复用处理结果但保留独立来源。',
    '只返回处理数量、状态、失败文件和人工复核项。若任务实际要求查询、阅读或写材料，说明知识化已完成并交回统筹，不要越权回答。',
  ].join('\n');
}

export function buildLocalExecutorTask(raw: string): string {
  const task = instructionText(raw)
    .replace(/@(?:用户|统筹管理智能体|本地执行智能体|知识管理智能体|资料调研智能体|材料编写智能体|验收智能体)\s*/g, '')
    .trim();
  const taskContext = task.length <= 16_000
    ? task
    : `${task.slice(0, 7_000)}\n……中间上下文已压缩……\n${task.slice(-8_500)}`;
  return [
    `用户请求：\n${taskContext}`,
    '请闭环完成：知识化、内部知识检索、公开资料调研、模板复用、材料编写和成果验收都是你已挂载的内部能力，按当前目标需要哪个用哪个，不要拆回给统筹，也不要委派给已融合的旧专业角色。',
    '只做必要环节：无文件变化不重复知识化，无外部事实需求不网页搜索，无文件交付要求不创建材料；需要文件时通过系统工具真实保存，按当前协同档位完成内部核验和必要返修，再提升为 outputs 正式成果。',
    '最后返回业务结论、关键来源、明确风险和真实成果文件；除缺少用户不可推断的关键输入外，不以内部步骤失败为由提前停止。',
  ].join('\n');
}

export function buildMaterialWriterKnowledgeTask(raw: string): string {
  const task = instructionText(raw)
    .replace(/@(?:用户|统筹管理智能体|知识管理智能体|材料编写智能体)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const artifactInstruction = requiresArtifactDeliverable(task)
    ? '完成检索后继续按用户目标编写完整 HTML 待审稿，通过 temp:save 使用文件名 draft.html 保存到当前任务的个人工作区临时目录；不要等待知识管理智能体提供证据或模板，也不要填写路径。'
    : '综合证据形成可直接交给统筹的精炼答案，保留文件、页码、章节或位置来源，不原样堆砌切片。';
  const templateInstruction = requiresArtifactDeliverable(task) || /模板|版式|格式|样式/iu.test(task)
    ? '先使用 template:list 发现相关模板，需要时用 template:read 连续读取到 READ_COMPLETE: true；确认没有可用模板时再自行设计结构。'
    : '本任务没有材料格式或模板要求，不调用模板工具。';
  const taskContext = task.length <= 6_000
    ? task
    : `${task.slice(0, 2_000)}\n……中间背景已压缩……\n${task.slice(-3_900)}`;
  return [
    `请完成以下内部知识读取任务：${taskContext}`,
    '在当前群聊个人知识、已关联项目知识和企业知识中检索；未关联项目时跳过项目层，禁止读取其他群聊或未关联项目内容。',
    '先把业务问题改写为一至三个可执行检索问题，补充必要同义词和业务关联词，禁止把用户原话机械转发为唯一检索词。',
    templateInstruction,
    '没有明确文件指向时使用 knowledge:search 做 RAG；点名文件、依据某文件、审阅整份文件或逐条比较时使用 knowledge:readDocument 连续读取到 READ_COMPLETE: true。',
    artifactInstruction,
  ].join('\n');
}

export function buildResearchFallbackTask(raw: string): string {
  const task = instructionText(raw).replace(/\s+/g, ' ').trim();
  return [
    `材料编写智能体暂未在当前群聊知识库找到足够的本地依据。请补充完成以下任务：${task}`,
    '优先使用资料调研智能体可用的网页搜索和公开来源，检索与来访、参访、接待、招待及相关安排直接有关的资料、通行做法和可引用依据。',
    '把可引用事实、来源链接或出处、适用范围和不确定项分开整理；如果公开资料也不足，明确列出待确认项和可以安全采用的通用安排，不要把推测写成公司制度原文。',
  ].join('\n');
}

async function delegateToKM(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();
  const logger = ctx.services.getLogger();
  const task = effectiveTask(state, ctx);
  const agents = ctx.services.getProjectDelegatableAgents(ctx.projectId).filter((agent) => agent.id !== ctx.agentInstanceId);
  const ingestion = needsKnowledgeIngestion(task);
  const localExecutor = agents.find((agent) => isLocalExecutorAgent(agent));
  const targetAgent = localExecutor ?? (ingestion
    ? agents.find((agent) => isKnowledgeManagerAgent(agent))
    : agents.find((agent) => isMaterialWriterAgent(agent)));
  if (!targetAgent) {
    const roleName = ingestion ? '知识管理智能体' : '材料编写智能体';
    logger.warn(`Orchestrator.delegateToKM: 未找到${roleName} (project=${ctx.projectId})`);
    return { subAgentResult: `未找到${roleName}`, messages: [{ role: 'system', content: `delegate: 未找到${roleName}` }] };
  }
  const delegationInstruction = isLocalExecutorAgent(targetAgent)
    ? buildLocalExecutorTask(task)
    : ingestion
    ? buildKnowledgeManagerTask(task)
    : buildMaterialWriterKnowledgeTask(task);
  const sent = await ctx.services.sendDelegationMessage({
    projectId: ctx.projectId,
    senderId: ctx.agentInstanceId,
    parentRunId: ctx.runId,
    rootTriggerMessageId: ctx.triggerMessageId,
    targetAgentInstanceId: targetAgent.id,
    targetAgentName: targetAgent.name,
    instruction: delegationInstruction,
    visibleInstruction: ctx.delegationOnly
      ? buildFixedDelegationInstruction(task, delegationInstruction)
      : buildVisibleDelegationInstruction(delegationInstruction, task, { directTask: task }),
  });
  logger.info(`Orchestrator 已委派${targetAgent.name} (project=${ctx.projectId}, target=${targetAgent.id})`);
  return {
    subAgentResult: sent.childRunIds[0] ? '' : `${targetAgent.name}委派消息已发送，但没有创建执行任务`,
    ...(sent.childRunIds[0] ? {
      cliDelegations: [{
        agentInstanceId: targetAgent.id,
        agentName: targetAgent.name,
        subRunId: sent.childRunIds[0],
        instruction: delegationInstruction,
        status: 'pending' as const,
        result: '任务已创建',
      }],
    } : { cliDelegations: [] }),
    messages: [{ role: 'system', content: `委派给${targetAgent.name}: ${task}` }],
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
    const selectedAgent = availableAgents.get(agentInstanceId);
    if (!selectedAgent) continue;
    const targetAgent = alignAgentWithTask(selectedAgent, instruction, [...availableAgents.values()]);
    if (seenTargets.has(targetAgent.id)
      || (ctx.collaborationMode === 'fast' && isAcceptanceReviewerAgent(targetAgent) && !isFixedPaperWorkflowTask(task))) continue;
    seenTargets.add(targetAgent.id);

    plannedAssignments.push({ targetAgent, instruction });
  }

  // 模型偶尔会返回错误实例 ID 或不完整协议。专业任务不能因此静默结束，
  // 这里使用完整任务和成员能力选出一个兜底执行者继续推进。
  if (plannedAssignments.length === 0) {
    const fallbackCandidates = [...availableAgents.values()].filter((agent) => (
      ctx.collaborationMode !== 'fast' || !isAcceptanceReviewerAgent(agent)
    ));
    const fallback = chooseFallbackAgent(task, fallbackCandidates);
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
    ? plannedAssignments.slice(0, ctx.collaborationMode === 'balanced' ? 2 : undefined)
    : plannedAssignments.slice(0, 1);

  // A complex task exposes its stable business TODO once. Subsequent planner
  // rounds update node state without reposting the same checklist.
  const planAlreadyAnnounced = (ctx.services.getRunEvents?.(ctx.runId) ?? [])
    .some((event) => event.type === 'run.business-plan-announced');
  if (!planAlreadyAnnounced && (state.macroPlan?.stages.length ?? 0) > 1 && ctx.services.sendOrchestratorNote) {
    const todoText = state.macroPlan!.stages
      .map((planStage, index) => `${index + 1}. ${planStage.objective}`)
      .join('\n');
    try {
      await ctx.services.sendOrchestratorNote({
        projectId: ctx.projectId,
        senderId: ctx.agentInstanceId,
        runId: ctx.runId,
        rootTriggerMessageId: ctx.triggerMessageId,
        text: `我已按目标和结果依赖拆分本次任务：\n${todoText}`,
      });
      ctx.services.addRunEvent(ctx.runId, 'run.business-plan-announced', { stages: state.macroPlan!.stages.length });
    } catch {
      // Visible planning is useful but must not block actual execution.
    }
  }

  // 复杂需求：多位成员协作时，先把拆解出的子需求清单发到群聊，
  // 再逐条 @ 委派。清单基于规划出的完整分工，不暴露内部协议。
  if (plannedAssignments.length > 1 && ctx.services.sendOrchestratorNote) {
    const plannedNoteText = buildDelegationPlanNote(plannedAssignments, Boolean(state.parallelDelegationApproved));
    if (plannedNoteText) {
      try {
        await ctx.services.sendOrchestratorNote({
          projectId: ctx.projectId,
          senderId: ctx.agentInstanceId,
          runId: ctx.runId,
          rootTriggerMessageId: ctx.triggerMessageId,
          text: plannedNoteText,
        });
      } catch {
        // 清单消息只是协调展示，失败不阻塞委派本身。
      }
    }
  }
  const delegationNotes = state.delegationNotes ?? [];
  const findPlannerNote = (agentId: string): string =>
    delegationNotes.find((note) => note.agentInstanceId === agentId)?.visibleMessage ?? '';
  // 独立闭环交付最终标记：仅当实际委派的成员确认可独立交付时保留，
  // 否则在返回值中撤销 analyzeIntent 的预判，恢复统筹监听收集。
  let fireAndForgetConfirmed = false;

  for (const { targetAgent, instruction } of executableAssignments) {
    const agentInstanceId = targetAgent.id;

    // 独立闭环交付复核：analyzeIntent 标记过单成员可闭环，但实际委派
    // 对象可能因对齐或兜底而变化。交付物任务只有本地执行智能体（能
    // 直接把成果提升为 outputs 正式成果）可以独立闭环，其他成员仍需
    // 统筹验收，此时撤销标记并恢复监听收集。
    const independentDelivery = Boolean(state.fireAndForgetDelegation)
      && executableAssignments.length === 1
      && canFireAndForget(state.macroPlan, state.activeStageId ? { stageId: state.activeStageId } : {}, state)
      && (!requiresArtifactDeliverable(task) || isLocalExecutorAgent(targetAgent));
    if (independentDelivery) fireAndForgetConfirmed = true;

    try {
      if (state.activeStageId) {
        ctx.services.updateTaskNode?.(ctx.runId, state.activeStageId, {
          status: 'assigned',
          assignedAgentId: targetAgent.id,
        });
      }
      const executableInstruction = independentDelivery
        ? `${applyReviewDraftBoundary(
          targetAgent,
          task,
          buildExecutableWorkPackage(targetAgent, instruction, task, ctx.instruction),
          ctx.runId,
          ctx.collaborationMode ?? 'expert',
        )}\n\n${INDEPENDENT_DELIVERY_DIRECTIVE}`
        : applyReviewDraftBoundary(
          targetAgent,
          task,
          buildExecutableWorkPackage(targetAgent, instruction, task, ctx.instruction),
          ctx.runId,
          ctx.collaborationMode ?? 'expert',
        );
      plannerHistory.push(plannerAssignmentSignature(targetAgent.id, instruction));
      // 可见消息：优先规划器话术；仅当用户本轮原话可以直接转发时才直达
      // 用户请求，多轮承接或上下文已增强的委派仍用工作包摘要保留关键信息。
      const plannerNote = findPlannerNote(targetAgent.id);
      const canRelayUserRequest = !needsConversationTaskResolution(ctx.instruction);
      const visibleInstruction = ctx.delegationOnly
        ? buildFixedDelegationInstruction(task, instruction)
        : buildVisibleDelegationInstruction(executableInstruction, task, {
        ...(plannerNote ? { visibleMessage: plannerNote } : {}),
        ...(!plannerNote && plannedAssignments.length === 1 && canRelayUserRequest ? { directTask: task } : {}),
      });
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
      if (state.activeStageId) {
        ctx.services.updateTaskNode?.(ctx.runId, state.activeStageId, {
          status: subRunId ? 'running' : 'failed',
          assignedAgentId: targetAgent.id,
        });
      }
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
      if (state.activeStageId) ctx.services.updateTaskNode?.(ctx.runId, state.activeStageId, { status: 'failed', assignedAgentId: targetAgent.id });
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
  // 单成员任务走最短路径：群聊只显示 @ 委派消息，只有多方协作才展示
  // 拆解和等待等协调节点。
  if (requiresCoordinationView({ ...state, cliDelegations: delegations })) {
    sendOrchestratorChecklist(ctx, activeNames.length > 0 ? 'waiting' : 'delegating', {
      understand: conciseTaskBrief(task),
      decompose: workPackages || `${activeNames.join('、')}将按照统筹智能体生成的分工推进各自工作包。`,
      delegate: activeNames.length > 0 ? `已向${activeNames.join('、')}发出明确分工。` : '暂未形成有效委派。',
      ...(activeNames.length > 0 ? { wait: `正在等待${activeNames.join('、')}返回结果。` } : {}),
    });
  }

  return {
    cliDelegations: delegations,
    fireAndForgetDelegation: fireAndForgetConfirmed,
    plannerHistory: [...new Set(plannerHistory)].slice(-24),
    messages: [
      ...state.messages,
      { role: 'system', content: `CLI 委派完成: ${delegations.length} 个子任务已创建${errors.length ? '，错误: ' + errors.join('; ') : ''}` },
    ],
  };
}

const MAX_COLLECT_WAIT_MS = 4 * 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 500;
// The four-hour run timeout is the real execution boundary. This higher guard
// only stops a malformed planner from producing an endless recovery loop.
const MAX_RECOVERY_PASSES = 32;
const FAST_MAX_RECOVERY_PASSES = 4;
const BALANCED_MAX_RECOVERY_PASSES = 8;
export function collaborationRecoveryPassLimit(mode: CollaborationMode = 'expert'): number {
  if (mode === 'fast') return FAST_MAX_RECOVERY_PASSES;
  if (mode === 'balanced') return BALANCED_MAX_RECOVERY_PASSES;
  return MAX_RECOVERY_PASSES;
}
function maxRecoveryPasses(ctx: IGraphContext): number {
  return collaborationRecoveryPassLimit(ctx.collaborationMode ?? 'expert');
}
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
    const subRunId = sent.childRunIds[0] ?? '';
    if (!subRunId && isAcceptanceReviewerAgent(agent) && collaborationReviewLimit(ctx.collaborationMode ?? 'expert') !== Number.POSITIVE_INFINITY) {
      const message = ctx.collaborationMode === 'fast'
        ? '快速协同禁止创建验收任务。'
        : '均衡协同的验收任务必须经过整棵任务树的全局额度检查，不能通过备用路径重复创建。';
      sendTrace(ctx, 'handoff', `${agent.name}任务未创建`, 'failed', message);
      return {
        agentInstanceId: agent.id,
        agentName: agent.name,
        subRunId: '',
        instruction,
        status: 'failed',
        result: message,
      };
    }
    if (!subRunId) {
      const message = '委派未创建：该任务被全局额度、权限或幂等规则拦截。';
      sendTrace(ctx, 'handoff', `${agent.name}任务未创建`, 'failed', message);
      return {
        agentInstanceId: agent.id,
        agentName: agent.name,
        subRunId: '',
        instruction,
        status: 'failed',
        result: message,
      };
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

  const safeRunId = ctx.runId.replace(/[^a-zA-Z0-9-]/g, '').slice(-24) || Date.now().toString(36);
  const draftArtifactPath = 'draft.html';
  const outputPath = `outputs/material-report-${safeRunId}.html`;
  const evidence = resultParts.join('\n\n').slice(0, 42_000);
  const evidenceFallbackGuidance = '若授权知识中没有充分依据，仍应形成可推进的初稿，但所有未经可靠来源确认的事实必须标为“待确认”或“建议”并单列清单，禁止把推测写成公司制度。';
  let reviewFindings = '';

  for (let pass = 1; ; pass += 1) {
    ctx.signal.throwIfAborted();
    sendProgress(ctx, pass === 1 ? '编写材料待审稿' : `按验收意见进行第 ${pass - 1} 次返修`, Math.min(62 + pass * 4, 86));
    const writerInstruction = pass === 1
      ? `请完成以下材料写作任务。你负责自行检索个人、关联项目和企业知识，明确文件时完整读取正文，并使用 template:list/template:read 发现和读取实际模板；确认没有可用模板时再自行设计。先列出文档框架并建立章节与证据对应关系，再逐章节补充，最后生成完整 HTML 候选稿。\n\n完整任务：\n${task}\n\n已经取得的其他成员结果：\n${evidence}\n\n${evidenceFallbackGuidance}\n\n候选稿必须通过 temp:save 保存为文件名 ${draftArtifactPath}。不要填写路径，不要写入 outputs/，不要发布附件，不要在消息中粘贴 HTML 源码。`
      : `请根据验收意见返修同一份材料候选稿。自行复查所需知识、明确来源文件和实际模板，逐项修正问题，保留证据充分且未被指出的内容，完成后通过 temp:save 覆盖文件名 ${draftArtifactPath}。不要填写路径，不要写入 outputs/ 或发布附件。\n\n完整任务：\n${task}\n\n已经取得的其他成员结果：\n${evidence}\n\n${evidenceFallbackGuidance}\n\n上次验收意见：\n${reviewFindings.slice(0, 18_000)}`;
    const written = await delegateAndWait(
      ctx,
      writer,
      writerInstruction,
      pass === 1
        ? '请自行检索知识、读取明确文件和实际模板，先列出材料框架，再逐章编写完整待审稿并提交验收。'
        : `上次验收没有通过。请根据具体意见完成第 ${pass - 1} 次返修并重新提交待审稿。`,
      pass === 1 ? `安排${writer.name}编写待审稿` : `安排${writer.name}返修待审稿`,
    );
    delegations.push(written);
    resultParts.push(`--- ${written.agentName}${pass === 1 ? '待审稿' : `第 ${pass - 1} 次返修`} ---\n${written.result || '(无有效结果)'}`);
    if (written.status !== 'completed') {
      return { delegations, summary: resultParts.join('\n\n'), reviewPass: false, reviewFindings: written.result || '待审稿未完成', draftArtifactPath, artifacts: [] };
    }

    sendProgress(ctx, `进行第 ${pass} 次独立验收`, Math.min(70 + pass * 5, 90));
    const reviewerInstruction = `请独立验收当前任务的真实临时候选稿。先调用 temp:list 确认文件名 ${draftArtifactPath} 存在，再用 temp:read 完整读取；之后使用 template:list/template:read 独立读取实际模板，使用 knowledge:search 检索三层知识；明确来源文件时使用 knowledge:readDocument 连续读取完整正文。按用户需求建立验收项，逐项核验关键事实、数字、制度条款、结论、来源和模板要求。发现变造、无依据扩写、遗漏、模板不符或 HTML 不完整时必须判定不通过并给出可执行返修清单；全部关键项通过才可判定通过。若本地知识确实没有依据，允许交付明确标注为初稿的通用方案，但所有未证实内容必须标为“待确认”或“建议”并列入待确认清单。\n\n完整任务：\n${task}\n\n已经取得的其他成员结果：\n${evidence}\n\n回复最后必须单独一行写“验收结论：通过”或“验收结论：不通过”。不要修改或发布文件。`;
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
      const promoted = await ctx.services.executeTool('temp:promote', {
        projectId: ctx.projectId,
        runId: ctx.runId,
        fileName: draftArtifactPath,
        outputName: outputPath.slice('outputs/'.length),
      }, 'orchestrator', { runId: ctx.runId, projectId: ctx.projectId });
      if (!promoted.startsWith('TEMP_PROMOTED:')) {
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
  stageId?: string;
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
  complexity?: 'simple' | 'complex' | 'missing-input';
  reason: string;
  assignments: AdaptivePlannerAssignment[];
  selfInstruction?: string;
  userMessage?: string;
  macroPlan?: OrchestratorMacroPlan;
  activeStageId?: string;
  stageSatisfied?: boolean;
  missingFields?: string[];
};

/** A macro plan is complete only when every declared business stage is
 * satisfied. Pending/active/blocked stages are real remaining work; they must
 * not be hidden by an optimistic model `complete` response. */
export function hasUnmetMacroStages(plan: OrchestratorMacroPlan | null | undefined): boolean {
  return Boolean(plan?.stages.some((stage) => stage.status !== 'satisfied'));
}

export function canCompleteMacroPlan(
  plan: OrchestratorMacroPlan | null | undefined,
  stageId?: string,
  stageSatisfied = false,
): boolean {
  if (!plan || plan.stages.length === 0) return true;
  if (!stageSatisfied) return plan.stages.every((stage) => stage.status === 'satisfied');
  const targetId = stageId || plan.stages.find((stage) => stage.status === 'active')?.id;
  return plan.stages.every((stage) => stage.status === 'satisfied' || stage.id === targetId);
}

/** Independent delivery is valid only when this assignment closes the
 * declared macro plan. A single assignment in a multi-stage plan is still an
 * intermediate result and must return to the coordinator. */
export function canFireAndForget(
  plan: OrchestratorMacroPlan | null | undefined,
  assignment: { stageId?: string } | undefined,
  state: Pick<OrchestratorGraphState, 'parallelDelegationApproved'>,
): boolean {
  if (state.parallelDelegationApproved || !assignment) return false;
  if (!plan || plan.stages.length === 0) return true;
  const unsatisfied = plan.stages.filter((stage) => stage.status !== 'satisfied');
  const targetId = assignment.stageId || plan.stages.find((stage) => stage.status === 'active')?.id;
  // The delegated stage must be the only remaining macro stage. In
  // particular, an active stage followed by pending downstream stages is not
  // an independent delivery even when it is the only current assignment.
  const allowed = unsatisfied.length === 1 && unsatisfied[0]?.id === targetId;
  return allowed;
}

function normalizeMacroPlan(value: unknown, task: string): OrchestratorMacroPlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const stages = Array.isArray(source.stages)
    ? source.stages.flatMap((item, index) => {
      if (!item || typeof item !== 'object') return [];
      const entry = item as Record<string, unknown>;
      const objective = formatStructuredPlannerValue(entry.objective ?? entry.name);
      if (!objective) return [];
      const id = formatStructuredPlannerValue(entry.id ?? `stage-${index + 1}`) || `stage-${index + 1}`;
      const completionCriteria = Array.isArray(entry.completionCriteria)
        ? entry.completionCriteria.map((criterion) => String(criterion).trim()).filter(Boolean)
        : [];
      const dependsOn = Array.isArray(entry.dependsOn)
        ? entry.dependsOn.map((dependency) => String(dependency).trim()).filter(Boolean)
        : [];
      return [{ id, objective, completionCriteria, dependsOn, status: index === 0 ? 'active' as const : 'pending' as const }];
    })
    : [];
  if (stages.length === 0) return undefined;
  return {
    goal: formatStructuredPlannerValue(source.goal ?? task) || task,
    completionCriteria: Array.isArray(source.completionCriteria)
      ? source.completionCriteria.map((criterion) => String(criterion).trim()).filter(Boolean)
      : [],
    stages,
  };
}

function fallbackMacroPlan(task: string, assignments: AdaptivePlannerAssignment[]): OrchestratorMacroPlan {
  const stageObjectives = assignments.length > 0
    ? assignments.map((assignment) => assignment.objective)
    : [requiresArtifactDeliverable(task) ? '取得任务所需输入并形成可交付成果' : '取得回答所需信息并形成准确答复'];
  const stageIds = stageObjectives.map((_objective, index) => (
    assignments[index]?.stageId || assignments[index]?.stepId || `stage-${index + 1}`
  ));
  return {
    goal: task,
    completionCriteria: requiresArtifactDeliverable(task)
      ? ['用户要求的内容完整', '正式成果文件已经生成并可在群聊中打开', '关键事实与来源不存在已知冲突']
      : ['关键问题已经得到直接回答', '时效性信息带有必要的时间与来源'],
    stages: stageObjectives.map((objective, index) => ({
      id: stageIds[index]!,
      objective,
      completionCriteria: assignments[index]?.expectedDeliverable ? [assignments[index]!.expectedDeliverable!] : [],
      dependsOn: assignments[index]?.dependsOn ?? (index > 0 ? [stageIds[index - 1]!] : []),
      status: index === 0 ? 'active' : 'pending',
    })),
  };
}

/** A complex task may still be collapsed by a model into one broad action.
 * Keep the model's business objective, but restore a minimal result-dependency
 * boundary so execution evidence and final delivery cannot be conflated. */
function ensureComplexBusinessPlan(task: string, plan: OrchestratorMacroPlan): OrchestratorMacroPlan {
  const first = plan.stages[0];
  const firstId = first?.id || 'establish-result-basis';
  return {
    goal: plan.goal || task,
    completionCriteria: plan.completionCriteria,
    stages: [
      {
        id: firstId,
        objective: first?.objective || '取得完成用户目标所需的有效输入和阶段结果',
        completionCriteria: first?.completionCriteria.length ? first.completionCriteria : ['取得可供后续使用的真实结果或证据'],
        dependsOn: first?.dependsOn ?? [],
        status: 'active',
      },
      {
        id: 'integrate-and-deliver',
        objective: '整合阶段结果并形成满足用户完成标准的最终交付',
        completionCriteria: plan.completionCriteria.length ? plan.completionCriteria : ['完整回答用户目标', '交付内容与真实执行结果一致'],
        dependsOn: [firstId],
        status: 'pending',
      },
    ],
  };
}

function updateMacroPlan(plan: OrchestratorMacroPlan | null | undefined, decision: AdaptivePlannerDecision): OrchestratorMacroPlan | null {
  if (!plan) return decision.macroPlan ?? null;
  const requestedStage = decision.activeStageId
    || decision.assignments.find((assignment) => assignment.stageId)?.stageId
    || plan.stages.find((stage) => stage.status === 'active')?.id;
  const completedStageId = decision.stageSatisfied ? requestedStage : undefined;
  let nextActivated = false;
  return {
    ...plan,
    stages: plan.stages.map((stage) => {
      if (stage.id === completedStageId) return { ...stage, status: 'satisfied' as const };
      if (stage.id === requestedStage && !decision.stageSatisfied) return { ...stage, status: 'active' as const };
      if (decision.stageSatisfied && !nextActivated && stage.status === 'pending'
        && stage.dependsOn.every((dependency) => dependency === completedStageId || plan.stages.some((item) => item.id === dependency && item.status === 'satisfied'))) {
        nextActivated = true;
        return { ...stage, status: 'active' as const };
      }
      return stage;
    }),
  };
}

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

export function formatStructuredPlannerValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(formatStructuredPlannerValue).filter(Boolean).join('；');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => {
        const formatted = formatStructuredPlannerValue(child);
        return formatted ? `${key}：${formatted}` : '';
      })
      .filter(Boolean)
      .join('；');
  }
  return String(value).trim();
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
        const agentInstanceId = formatStructuredPlannerValue(entry.agentInstanceId ?? entry.agentId);
        const objective = formatStructuredPlannerValue(entry.objective ?? entry.instruction);
        if (!agentInstanceId || !objective) return [];
        return [{
          ...(entry.stepId ? { stepId: formatStructuredPlannerValue(entry.stepId) } : {}),
          ...(entry.stageId ? { stageId: formatStructuredPlannerValue(entry.stageId) } : {}),
          agentInstanceId,
          objective,
          ...(entry.inputs ? { inputs: formatStructuredPlannerValue(entry.inputs) } : {}),
          ...(entry.expectedDeliverable ? { expectedDeliverable: formatStructuredPlannerValue(entry.expectedDeliverable) } : {}),
          ...(entry.visibleMessage ? { visibleMessage: formatStructuredPlannerValue(entry.visibleMessage) } : {}),
          ...(Array.isArray(entry.dependsOn)
            ? { dependsOn: entry.dependsOn.map((value) => String(value).trim()).filter(Boolean) }
            : {}),
          ...(entry.parallelGroup ? { parallelGroup: formatStructuredPlannerValue(entry.parallelGroup) } : {}),
        }];
      })
      : [];
    const macroPlan = normalizeMacroPlan(parsed.macroPlan, formatStructuredPlannerValue(parsed.reason));
    return {
      status: assignments.length > 0 ? 'delegate' : status,
      ...(['simple', 'complex', 'missing-input'].includes(String(parsed.complexity))
        ? { complexity: String(parsed.complexity) as 'simple' | 'complex' | 'missing-input' }
        : {}),
      reason: formatStructuredPlannerValue(parsed.reason),
      assignments,
      ...(parsed.selfInstruction ? { selfInstruction: formatStructuredPlannerValue(parsed.selfInstruction) } : {}),
      ...(parsed.userMessage ? { userMessage: formatStructuredPlannerValue(parsed.userMessage) } : {}),
      ...(macroPlan ? { macroPlan } : {}),
      ...(parsed.activeStageId ? { activeStageId: formatStructuredPlannerValue(parsed.activeStageId) } : {}),
      ...(typeof parsed.stageSatisfied === 'boolean' ? { stageSatisfied: parsed.stageSatisfied } : {}),
      ...(Array.isArray(parsed.missingFields)
        ? { missingFields: parsed.missingFields.map((field) => String(field).trim()).filter(Boolean) }
        : {}),
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
  macroPlan?: OrchestratorMacroPlan | null,
  activeStageId?: string,
): Promise<AdaptivePlannerDecision> {
  const agents = ctx.services.getProjectDelegatableAgents(ctx.projectId)
    .filter((agent) => agent.id !== ctx.agentInstanceId);
  const roster = agents.map((agent) => (
    `- ${agent.id} | ${agent.name} | ${agent.runtimeMode}\n  公开调度画像：${agent.coordinationProfile || agent.capabilities || agent.definitionId}`
  )).join('\n');
  const gaps = unresolved.map((item) => (
    `- ${item.agentName}：${conciseTaskBrief(item.instruction)}；实际结果：${conciseTaskBrief(item.result)}`
  )).join('\n');
  const taskSummary = (ctx.services.getRunEvents?.(ctx.runId) ?? [])
    .filter((event) => event.type === 'run.task-summary' && event.payload)
    .slice(-6)
    .map((event) => {
      const payload = event.payload ?? {};
      return `- ${String(payload.stage ?? '当前阶段')}：${String(payload.summary ?? '')}`;
    })
    .filter((line) => !line.endsWith('：'))
    .join('\n');
  const modeDirective = ctx.collaborationMode === 'fast'
    ? '\n快速协同：本轮只允许一个不可缺少的当前动作；整棵任务树禁止调用验收智能体、复验、返修循环、分身和非必要知识归集。能直接回答、交付或由统筹自行补齐就不要委派。'
    : ctx.collaborationMode === 'balanced'
      ? '\n均衡协同：本轮最多安排两个彼此独立的必要动作；同一阶段最多两次调度判断。材料只编写一次；整棵任务树共享一次验收额度，任何成员已经发起验收后都不得再安排验收智能体、验收分身或复验。'
      : '';
  const evidenceLimit = ctx.collaborationMode === 'fast' ? 4_000 : ctx.collaborationMode === 'balanced' ? 7_000 : 12_000;
  const result = await ctx.services.generateText('reasoning', [
    {
      role: 'system',
      content: `你是持续推进任务的统筹管理智能体。根据用户目标、当前群聊真实成员能力、已经发生的结果和剩余缺口，只决定“下一步当前可执行批次”。
宏观阶段计划在任务开始时已经确定，目标和阶段顺序保持稳定；你只能更新当前阶段是否满足，并在当前阶段内灵活换成员、换查询、补证据或自行处理。不要因为一次反馈重写整个宏观计划。当前阶段满足后才进入下一个阶段。
不要套用固定的知识检索、写作、验收链路；这些都只是可选能力。你要自己判断什么时候查本地知识、什么时候搜索公开资料、什么时候写文件、什么时候核验，以及哪些步骤有依赖、哪些可以并行。
默认每轮只委派一个下一步。只有两个或多个步骤彼此完全独立、互不使用对方的输入或成果时，才能在同一轮同时委派，并给它们设置相同且非空的 parallelGroup。存在前后依赖时，只返回当前已满足前置条件的步骤；下游步骤不要提前放进 assignments，必须等本轮所有上游状态（成功或失败）都返回后再根据真实结果规划。下一步同时依赖多个上游时，必须等待这些上游全部返回后才可安排。
如果成员在自己的执行中继续委派其他成员，该协作分支仍属于当前上游步骤；必须等待整个分支返回状态后再推进下游。
成员返回失败、空结果或没有检索到知识时不能直接结束：可以换成员、换来源、缩小范围、生成明确标注不确定项的降级成果，或在没有合适成员时选择 self_execute 由你自己处理。不要重复已经尝试且没有产生新信息的动作。
知识证据、公开资料和检索摘要只是后续工作的输入。用户要求材料、报告、方案、文档或文件时，必须继续形成真实成果；不能在检索返回后直接 complete。系统会提供交付边界核对，其中 missing 非空时绝对不能 complete，必须选择下一项委派或 self_execute。
独立核验不是固定步骤。核验不通过后的处理必须服从当前协同模式：专家模式可返修后复验；均衡模式记录唯一一次验收意见后不再调用验收智能体或复验，并按模式交付边界处理；快速模式不进入独立验收。
只有用户要求的结论或成果已经真实存在时才能 complete；不能把计划、路径承诺或“未找到”当作任务完成。只有缺少必须由用户决定的权限、高风险选择或不可推断信息时才 ask_user。
输出单个 JSON 对象，不要 Markdown：{"complexity":"simple|complex|missing-input","status":"delegate|self_execute|complete|ask_user","reason":"判断依据","activeStageId":"宏观阶段ID","stageSatisfied":false,"assignments":[{"stepId":"当前微观步骤ID","stageId":"所属宏观阶段ID","agentInstanceId":"真实实例ID","objective":"针对该成员改写的完整任务","inputs":"仅包含已经取得的输入","expectedDeliverable":"期望返回","visibleMessage":"群聊中一句自然安排","dependsOn":[],"parallelGroup":"仅明确并行时填写同一个组名，否则留空"}],"selfInstruction":"自己接手时要做什么","userMessage":"确需询问用户时的问题","missingFields":[]}。${modeDirective}`,
    },
    {
      role: 'user',
      content: `用户完整目标：\n${task}\n\n当前日期：${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n稳定宏观阶段计划（不得重写）：\n${macroPlan ? JSON.stringify(macroPlan) : '尚无宏观计划，请围绕完整目标继续'}\n当前宏观阶段：${activeStageId || '按计划中首个未满足阶段判断'}\n\n第 ${round} 轮执行后仍需处理的缺口：\n${gaps || '没有明确失败项，请核对交付是否真的完整'}\n\n系统侧交付边界核对：\n${completion ? JSON.stringify({
        requiresDeliverable: completion.requiresDeliverable,
        deliverablePaths: completion.deliverablePaths,
        draftPaths: completion.draftPaths,
        requiresHtml: completion.requiresHtml,
        requiresReview: completion.requiresReview,
        reviewPassed: completion.reviewPassed,
        reviewFailed: completion.reviewFailed,
        missing: completion.missing,
      }) : '尚未计算，请自行核对'}\n\n已经取得的真实结果与证据：\n${availableEvidence.slice(0, evidenceLimit) || '暂无'}\n\n跨轮任务摘要（只含已发生的结果，不含隐藏思维）：\n${taskSummary || '暂无'}\n\n当前群聊可用成员：\n${roster || '无'}\n\n已经尝试过的动作：\n${planningHistory.join('\n') || '无'}`,
    },
  ], coordinationGenerationOptions(ctx.collaborationMode, 1_800));
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

  const assignmentLimit = ctx.collaborationMode === 'fast' ? 1 : ctx.collaborationMode === 'balanced' ? 2 : decision.assignments.length;
  const reviewerAlreadyAttempted = availableAgents.some((agent) => (
    isAcceptanceReviewerAgent(agent)
    && planningHistory.some((signature) => signature.startsWith(`${agent.id}:`))
  ));
  // 邮箱秘书是一次性的“输入采集”节点。它返回邮件和附件清单后，
  // 后续缺口属于附件读取/编写/验收阶段，绝不能因为最终成果尚未
  // 生成而再次调用邮箱秘书。以规划历史按实例 ID 做根任务级去重，
  // 避免模型重新规划时重复发送同一封委派。
  const mailboxAlreadyAttempted = new Set(
    availableAgents
      .filter((agent) => /邮箱秘书/u.test(agent.name) || /邮箱秘书/u.test(agent.capabilities ?? ''))
      .filter((agent) => planningHistory.some((signature) => signature.startsWith(`${agent.id}:`)))
      .map((agent) => agent.id),
  );
  const runnableAssignments = selectRunnableAssignmentBatch(decision.assignments)
    .filter((assignment) => {
      const agent = resolvePlannerAgentReference(assignment.agentInstanceId, availableAgents);
      if (!agent || !isAcceptanceReviewerAgent(agent)) return true;
      if (ctx.collaborationMode === 'fast' && !isFixedPaperWorkflowTask(task)) return false;
      if (ctx.collaborationMode === 'balanced' && reviewerAlreadyAttempted) return false;
      return true;
    })
    .filter((assignment) => {
      const agent = resolvePlannerAgentReference(assignment.agentInstanceId, availableAgents);
      return !agent || !mailboxAlreadyAttempted.has(agent.id);
    })
    .slice(0, assignmentLimit);
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
      ctx.collaborationMode ?? 'expert',
    );
    const signature = plannerAssignmentSignature(
      agent.id,
      proposed || executableInstruction,
      assignment.stepId,
      assignment.stageId,
    );
    if (attempted.has(signature)) continue;
    seenTargets.add(agent.id);
    signatures.push(signature);
    const visibleInstruction = ctx.delegationOnly
      ? buildFixedDelegationInstruction(task, proposed || assignment.objective || task)
      : buildVisibleDelegationInstruction(
        assignment.visibleMessage?.trim() || executableInstruction,
        task,
      );
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
  const outputName = `task-delivery-${runSuffix}.html`;
  const tempResult = await ctx.services.executeTool('temp:save', {
    projectId: ctx.projectId,
    runId: ctx.runId,
    fileName: 'draft.html',
    content: html,
  }, 'orchestrator', { runId: ctx.runId, projectId: ctx.projectId });
  if (!tempResult.startsWith('TEMP_SAVED:')) {
    sendTrace(ctx, 'execution', 'HTML 候选成果保存失败', 'failed', tempResult);
    return { result: `统筹智能体尝试补齐 HTML 候选成果，但临时文件保存失败：${tempResult}`, artifacts: [] };
  }
  const toolResult = await ctx.services.executeTool('temp:promote', {
    projectId: ctx.projectId,
    runId: ctx.runId,
    fileName: 'draft.html',
    outputName,
  }, 'orchestrator', { runId: ctx.runId, projectId: ctx.projectId });
  if (!toolResult.startsWith('TEMP_PROMOTED:')) {
    sendTrace(ctx, 'execution', 'HTML 成果文件发布失败', 'failed', toolResult);
    return { result: `统筹智能体已生成候选稿，但正式发布失败：${toolResult}`, artifacts: [] };
  }
  const relativePath = `outputs/${outputName}`;
  await ctx.services.createFileRecord(ctx.projectId, relativePath, '', ctx.agentInstanceId, ctx.runId, '统筹智能体在无合适成果整理成员时补齐最终交付');
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
  const tempPromotion = instruction.match(/(?:临时文件|文件名|fileName)\s*(?:[:：=]\s*)?([\p{L}\p{N}._ -]+?\.html?)\b[\s\S]*?(?:提升|复制|发布)[\s\S]*?outputs[\\/]([\p{L}\p{N}._ -]+?\.html?)/iu);
  if (tempPromotion?.[1]) {
    const fileName = tempPromotion[1].trim();
    const outputName = (tempPromotion[2] ?? fileName).trim();
    sendTrace(ctx, 'file', '正在将真实临时文件发布为正式成果', 'running', `outputs/${outputName}`);
    const promoted = await ctx.services.executeTool('temp:promote', {
      projectId: ctx.projectId,
      runId: ctx.runId,
      fileName,
      outputName,
    }, 'orchestrator', { runId: ctx.runId, projectId: ctx.projectId });
    if (promoted.startsWith('TEMP_PROMOTED:')) {
      const publishedOutputPath = `outputs/${outputName}`;
      await ctx.services.createFileRecord(ctx.projectId, publishedOutputPath, '', ctx.agentInstanceId, ctx.runId, '临时任务文件经统筹确认后发布');
      sendTrace(ctx, 'file', '最终成果文件已发布', 'completed', publishedOutputPath);
      return { result: `正式成果文件已经发布到 ${publishedOutputPath}。`, artifacts: [{ relativePath: publishedOutputPath, content: '系统确认的临时文件提升成果' }], completed: true };
    }
    sendTrace(ctx, 'file', '最终成果文件发布失败', 'failed', promoted);
    return { result: promoted, artifacts: [], completed: false };
  }
  const promotion = instruction.match(/待审稿\s+(\.runtime[\\/]review-drafts[\\/][^\s，。；;]+?\.html?).*?提升为\s+(outputs[\\/][^\s，。；;]+?\.html?)/iu);
  if (promotion?.[1] && promotion[2]) {
    const draftRelativePath = promotion[1].replaceAll('\\', '/');
    const outputRelativePath = promotion[2].replaceAll('\\', '/');
    const publishReason = ctx.collaborationMode === 'fast'
      ? '快速协同完整稿已就绪，正在发布最终成果文件'
      : ctx.collaborationMode === 'balanced' && !/验收已经通过/iu.test(instruction)
        ? '均衡协同单次验收已结束，正在发布成果文件'
        : '验收通过，正在发布最终成果文件';
    sendTrace(ctx, 'file', publishReason, 'running', outputRelativePath);
    const promoted = await ctx.services.executeTool('review:promoteArtifact', {
      projectId: ctx.projectId,
      draftRelativePath,
      outputRelativePath,
    }, 'orchestrator', { runId: ctx.runId, projectId: ctx.projectId });
    if (promoted.startsWith('验收通过的成果已发布到 ')) {
      const publishedOutputPath = promoted.slice('验收通过的成果已发布到 '.length).trim() || outputRelativePath;
      const publishNote = ctx.collaborationMode === 'fast'
        ? '快速协同一次性完整稿由统筹智能体发布'
        : ctx.collaborationMode === 'balanced'
          ? '均衡协同在单次验收额度内由统筹智能体发布'
          : '验收通过后由统筹智能体发布';
      await ctx.services.createFileRecord(ctx.projectId, publishedOutputPath, '', ctx.agentInstanceId, ctx.runId, publishNote);
      sendTrace(ctx, 'file', '最终成果文件已发布', 'completed', publishedOutputPath);
      return {
        result: ctx.collaborationMode === 'fast'
          ? `快速协同完整稿已经发布到 ${publishedOutputPath}。`
          : ctx.collaborationMode === 'balanced' && !/验收已经通过/iu.test(instruction)
            ? `均衡协同已在单次验收额度内完成交付，成果文件已经发布到 ${publishedOutputPath}；最终汇报需保留验收意见中的风险。`
            : `验收通过，最终成果文件已经发布到 ${publishedOutputPath}。`,
        artifacts: [{
          relativePath: publishedOutputPath,
          content: ctx.collaborationMode === 'fast'
            ? '快速协同一次性生成的最终成果文件'
            : ctx.collaborationMode === 'balanced'
              ? '均衡协同验收流程结束后发布的最终成果文件'
              : '验收通过后发布的最终成果文件',
        }],
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
  if (requiresCoordinationView(state)) {
    sendOrchestratorChecklist(ctx, 'waiting', {
      understand: conciseTaskBrief(task),
      wait: `正在等待${activeNames.join('、') || '成员'}完成各自的工作包，最长等待 4 小时。`,
    });
  }

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
  if (state.activeStageId && delegations.length > 0) {
    const nodeCompleted = delegations.every((delegation) => delegation.status === 'completed');
    ctx.services.updateTaskNode?.(ctx.runId, state.activeStageId, {
      status: nodeCompleted ? 'completed' : 'failed',
      ...(delegations.find((delegation) => delegation.result)?.subRunId
        ? { artifacts: ctx.services.getRunArtifacts?.(delegations.find((delegation) => delegation.result)!.subRunId, true) ?? [] }
        : {}),
    });
  }
  // Persist a compact, user-visible handoff record for the next planner
  // round. This is deliberately separate from long-term memory and excludes
  // hidden reasoning or the full message transcript.
  if (delegations.length > 0) {
    ctx.services.addRunEvent(ctx.runId, 'run.task-summary', {
      stage: state.activeStageId || '当前阶段',
      summary: currentRoundSummary.slice(0, 6_000),
      status: delegations.every((item) => item.status === 'completed') ? 'completed' : 'partial',
      sources: delegations.map((item) => ({
        agent: item.agentName || item.agentInstanceId,
        runId: item.subRunId,
        status: item.status,
      })),
    });
  }
  const collectedArtifacts = [...state.artifacts];
  for (const delegation of delegations) {
    if (!delegation.subRunId) continue;
    for (const artifact of ctx.services.getRunArtifacts?.(delegation.subRunId, true) ?? []) {
      if (collectedArtifacts.some((existing) => existing.relativePath === artifact.relativePath)) continue;
      collectedArtifacts.push({ relativePath: artifact.relativePath, content: '子任务已由系统验证并发布的成果文件' });
    }
  }
  const availableAgents = ctx.services.getProjectDelegatableAgents(ctx.projectId)
    .filter((agent) => agent.id !== ctx.agentInstanceId);
  const delegatableById = new Map(availableAgents.map((agent) => [agent.id, agent]));
  const knowledgeEvidenceGaps = delegations.filter((delegation) => (
    delegation.status === 'completed'
    && isMaterialWriterAgent(delegatableById.get(delegation.agentInstanceId) ?? { definitionId: '', name: delegation.agentName })
    && isKnowledgeEvidenceMissing(delegation.result)
  ));
  const knowledgeGapIds = new Set(knowledgeEvidenceGaps.map((delegation) => delegation.subRunId || delegation.agentInstanceId));
  const successCount = delegations.filter((delegation) => (
    delegation.status === 'completed'
    && !knowledgeGapIds.has(delegation.subRunId || delegation.agentInstanceId)
  )).length;
  const failCount = delegations.filter((delegation) => delegation.status === 'failed').length + knowledgeEvidenceGaps.length;
  const completion = buildCompletionState(
    task,
    summary,
    collectedArtifacts,
    delegations,
    availableAgents,
    ctx.collaborationMode ?? 'expert',
  );
  logger.info(`collectAgentResults: ${successCount} 成功, ${failCount} 失败 (共 ${delegations.length} 个子任务)`);
  sendTrace(ctx, 'handoff', `成员结果已全部返回：${successCount} 成功，${failCount} 失败`, failCount > 0 && successCount === 0 ? 'failed' : 'completed');
  if (knowledgeEvidenceGaps.length > 0) {
    sendTrace(ctx, 'warning', '内部知识检索没有返回可用证据，正在切换公开调研或降级交付方案', 'completed');
  }

  const failedDelegations = delegations.filter((delegation) => delegation.status === 'failed');
  for (const gap of knowledgeEvidenceGaps) {
    failedDelegations.push({
      ...gap,
      agentName: `${gap.agentName}证据检索`,
      status: 'failed',
      result: `${gap.result || '内部知识检索没有返回可用证据'}。需要改用公开调研、通用方案或明确标注待确认项的降级交付。`,
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
  // 一个独立成员已经返回可用结果时，不再额外调用一次“下一步规划器”。
  // 直接进入统筹汇总，避免单人任务被拖成多轮机械调度；有缺口、依赖
  // 或多个成员时仍沿用完整的自适应 loop。
  if (delegations.length === 1
    && delegations[0]?.status === 'completed'
    && !isFixedPaperWorkflowTask(task)
    && !requiresCoordinationView({ ...state, cliDelegations: delegations })
    && canCompleteMacroPlan(state.macroPlan, state.activeStageId, true)
    && completion.missing.length === 0) {
    return {
      cliDelegations: delegations,
      recoveryCount: state.recoveryCount,
      plannerHistory: state.plannerHistory ?? [],
      macroPlan: state.macroPlan ?? null,
      activeStageId: state.activeStageId ?? '',
      stageAttempts: state.stageAttempts ?? {},
      materializationPass: state.materializationPass ?? 0,
      subAgentResult: summary || '(无子任务结果)',
      messages: state.messages,
      artifacts: collectedArtifacts,
    };
  }
  // 每一轮成员或统筹执行结果都必须回到同一个判断点。不存在
  // “单成员成功就直接转发”或“某一步完成就隐式结束”的旁路。
  const shouldPlanNextStep = true;
  if (shouldPlanNextStep) {
    const nextRound = (state.recoveryCount ?? 0) + 1;
    if (nextRound <= maxRecoveryPasses(ctx)) {
      sendProgress(ctx, '根据真实结果重新规划下一步', 58);
      sendTrace(ctx, 'reasoning', '检查缺口并选择下一项最合适的处理方式', 'running');
      const planningHistory = state.plannerHistory ?? [];
      const fixedStep = chooseFixedPaperWorkflowStep(task, availableAgents, '', planningHistory);
      if (isFixedPaperWorkflowTask(task) && !fixedStep) {
        // The fixed demonstration ends after the single CodeBuddy handoff.
        // Do not run completion validation or adaptive recovery here; the
        // coordinator only summarizes the five completed handoffs.
        sendTrace(ctx, 'handoff', '固定五步链路已完成，统筹智能体开始汇总交付', 'completed');
        return {
          cliDelegations: delegations,
          recoveryCount: nextRound,
          plannerHistory: planningHistory,
          macroPlan: state.macroPlan ?? null,
          activeStageId: '',
          stageAttempts: state.stageAttempts ?? {},
          materializationPass: state.materializationPass ?? 0,
          subAgentResult: summary || '(固定链路已完成)',
          messages: state.messages,
          artifacts: collectedArtifacts,
        };
      }
      const plannedDecision = fixedStep
        ? {
          status: 'delegate' as const,
          reason: '按用户指定的固定任务链路继续',
          activeStageId: state.activeStageId || '',
          stageSatisfied: false,
          assignments: [{
            stepId: `fixed-${nextRound}`,
            stageId: state.activeStageId || 'current',
            agentInstanceId: fixedStep.agent.id,
            objective: fixedStep.objective,
            inputs: summary.slice(-6000),
            expectedDeliverable: '完成当前固定链路节点并返回真实结果',
            dependsOn: [],
            visibleMessage: fixedStep.objective,
          }],
          selfInstruction: '',
          userMessage: '',
          missingFields: [],
        }
        : await planAdaptiveNextStep(
          ctx, task, summary, unresolved, planningHistory, nextRound, completion,
          state.macroPlan, state.activeStageId,
        );
      let decision = fixedStep
        ? plannedDecision
        : enforceCompletionBoundary(
          plannedDecision,
          completion,
          task,
          availableAgents,
          summary,
          ctx.runId,
          ctx.collaborationMode ?? 'expert',
        );
      if (ctx.delegationOnly && (decision.status === 'self_execute' || decision.status === 'complete')) {
        const fallback = chooseFallbackAgent(task, availableAgents);
        if (fallback) {
          decision = {
            ...decision,
            status: 'delegate',
            reason: '该群聊的具体任务必须交给成员执行',
            assignments: [{
              stepId: `delegated-${nextRound}`,
              stageId: decision.activeStageId || state.activeStageId || 'current',
              agentInstanceId: fallback.id,
              objective: task,
              inputs: summary.slice(-4000),
              expectedDeliverable: '完成该具体任务并返回真实结果',
              dependsOn: [],
              visibleMessage: buildVisibleDelegationInstruction(task, task),
            }],
            selfInstruction: '',
          };
        }
      }
      // A planner's complete decision is allowed to satisfy the current
      // active stage only after the host-side completion boundary is clear.
      // This advances a one-stage plan to completion while preserving pending
      // downstream stages for the next loop.
      const stageAwareDecision = decision.status === 'complete' && completion.missing.length === 0
        ? { ...decision, stageSatisfied: true }
        : decision;
      const nextMacroPlan = updateMacroPlan(state.macroPlan, stageAwareDecision);
      const nextActiveStageId = decision.activeStageId
        || nextMacroPlan?.stages.find((stage) => stage.status === 'active')?.id
        || state.activeStageId
        || '';
      const nextStageAttempts = {
        ...(state.stageAttempts ?? {}),
        ...(nextActiveStageId ? { [nextActiveStageId]: (state.stageAttempts?.[nextActiveStageId] ?? 0) + 1 } : {}),
      };
      ctx.services.addRunEvent(ctx.runId, 'run.macro-plan', { plan: nextMacroPlan });
      const macroPlanComplete = canCompleteMacroPlan(nextMacroPlan, undefined, false);
      if (stageAwareDecision.status === 'complete' && unresolved.length === 0 && macroPlanComplete) {
        sendTrace(ctx, 'reasoning', '统筹智能体确认当前结果已经满足交付要求', 'completed');
        return {
          cliDelegations: delegations,
          recoveryCount: nextRound,
          plannerHistory: planningHistory,
          macroPlan: nextMacroPlan,
          activeStageId: '',
          stageAttempts: nextStageAttempts,
          materializationPass: state.materializationPass ?? 0,
          subAgentResult: summary || '(无子任务结果)',
          messages: [
            ...state.messages,
            { role: 'system', content: `本轮执行完成: ${successCount} 个结果可用, ${failCount} 个结果不可用` },
          ],
          artifacts: collectedArtifacts,
        };
      } else {
        const planned = await startAdaptiveDelegations(ctx, task, stageAwareDecision, planningHistory);
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
          macroPlan: nextMacroPlan,
          activeStageId: nextActiveStageId,
          stageAttempts: nextStageAttempts,
          subAgentResult: summary,
          artifacts: collectedArtifacts,
        }, config);
        return {
          cliDelegations: [...delegations, ...(recovered.cliDelegations ?? [])],
          recoveryCount: recovered.recoveryCount ?? nextRound,
          plannerHistory: recovered.plannerHistory ?? nextHistory,
          macroPlan: recovered.macroPlan ?? nextMacroPlan,
          activeStageId: recovered.activeStageId ?? nextActiveStageId,
          stageAttempts: recovered.stageAttempts ?? nextStageAttempts,
          materializationPass: recovered.materializationPass ?? state.materializationPass ?? 0,
          subAgentResult: recovered.subAgentResult || summary,
          messages: [...state.messages, ...(recovered.messages ?? [])],
          artifacts: recovered.artifacts ?? collectedArtifacts,
          ...(recovered.finalResponse ? { finalResponse: recovered.finalResponse } : {}),
        };
        }

        if (stageAwareDecision.status === 'ask_user') {
        return {
          cliDelegations: delegations,
          recoveryCount: nextRound,
          plannerHistory: nextHistory,
          macroPlan: nextMacroPlan,
          activeStageId: nextActiveStageId,
          stageAttempts: nextStageAttempts,
          awaitingUser: {
            question: decision.userMessage || '继续处理前需要你补充一个关键决定。',
            missingFields: decision.missingFields ?? [],
          },
          subAgentResult: summary,
          finalResponse: decision.userMessage || '继续处理前需要你补充一个关键决定。',
          artifacts: collectedArtifacts,
        };
        }

        const selfInstruction = stageAwareDecision.selfInstruction || stageAwareDecision.reason || unresolved.map((item) => item.instruction).join('；') || task;
        if (ctx.delegationOnly) {
          return {
            cliDelegations: delegations,
            recoveryCount: nextRound,
            plannerHistory: nextHistory,
            macroPlan: nextMacroPlan,
            activeStageId: nextActiveStageId,
            stageAttempts: nextStageAttempts,
            subAgentResult: summary,
            finalResponse: '当前群聊没有可用的专业执行智能体，暂时无法完成该具体任务。',
            artifacts: collectedArtifacts,
          };
        }
        const selfResult = await selfExecuteAdaptiveStep(ctx, task, summary, selfInstruction);
        const nextSummary = [summary, `--- 统筹智能体自行补齐 ---\n${selfResult.result}`].filter(Boolean).join('\n\n');
        const nextArtifacts = [...collectedArtifacts, ...selfResult.artifacts];
        const completionAfterSelf = buildCompletionState(
          task,
          nextSummary,
          nextArtifacts,
          delegations,
          availableAgents,
          ctx.collaborationMode ?? 'expert',
        );
        const selfCompletedPlan = selfResult.completed && completionAfterSelf.missing.length === 0
          ? updateMacroPlan(nextMacroPlan, {
            status: 'complete',
            reason: '统筹已完成当前阶段',
            assignments: [],
            activeStageId: nextActiveStageId,
            stageSatisfied: true,
          })
          : nextMacroPlan;
        if (selfResult.completed && completionAfterSelf.missing.length === 0 && !hasUnmetMacroStages(selfCompletedPlan)) {
        return {
          cliDelegations: delegations,
          recoveryCount: nextRound,
          plannerHistory: nextHistory,
          macroPlan: selfCompletedPlan,
          activeStageId: '',
          stageAttempts: nextStageAttempts,
          subAgentResult: nextSummary,
          artifacts: nextArtifacts,
        };
        }
        if (selfResult.completed && nextRound < maxRecoveryPasses(ctx)) {
          const continued = await collectCLIResults({
            ...state,
            messages: [],
            cliDelegations: [],
            recoveryCount: nextRound,
            plannerHistory: nextHistory,
            macroPlan: selfCompletedPlan,
            activeStageId: selfCompletedPlan?.stages.find((stage) => stage.status === 'active')?.id ?? nextActiveStageId,
            stageAttempts: nextStageAttempts,
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
        if (nextRound >= maxRecoveryPasses(ctx)) {
        return {
          cliDelegations: delegations,
          recoveryCount: nextRound,
          plannerHistory: nextHistory,
          macroPlan: nextMacroPlan,
          activeStageId: nextActiveStageId,
          stageAttempts: nextStageAttempts,
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
    macroPlan: state.macroPlan ?? null,
    activeStageId: state.activeStageId ?? '',
    stageAttempts: state.stageAttempts ?? {},
    awaitingUser: state.awaitingUser ?? null,
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
  // Model prose is never filesystem authority.  Only paths attached by the
  // host after a successful, verified file tool call can satisfy delivery.
  return artifacts
    .map((artifact) => artifact.relativePath.replaceAll('\\', '/'))
    .filter((path) => path.startsWith('outputs/'))
    .slice(0, 30);
}

type CompletionState = {
  requiresDeliverable: boolean;
  deliverablePaths: string[];
  draftPaths: string[];
  requiresHtml: boolean;
  requiresReview: boolean;
  reviewPassed: boolean;
  reviewFailed: boolean;
  reviewAttempts: number;
  missing: string[];
};

function requiresNamedCodingReview(task: string): { kimi: boolean; codebuddy: boolean } {
  const text = task.toLowerCase();
  return {
    kimi: /kimi\s*(?:code)?|kimi写代码/u.test(text),
    codebuddy: /codebuddy|code buddy|代码验收/u.test(text),
  };
}

export function collaborationReviewLimit(mode: CollaborationMode = 'expert'): number {
  if (mode === 'fast') return 0;
  if (mode === 'balanced') return 1;
  return Number.POSITIVE_INFINITY;
}

function collectReviewDraftPaths(text: string): string[] {
  const legacy = [...text.matchAll(/(?:^|[\s`'"])(\.runtime[\\/]review-drafts[\\/][^\s`'"<>|:*?]+?\.html?)(?![\p{L}\p{N}_.-])/gimu)]
    .map((match) => match[1]?.replaceAll('\\', '/'))
    .filter((path): path is string => Boolean(path));
  const temporary = [...text.matchAll(/TEMP_SAVED:\s*([^\s（(]+?\.html?)\b/giu)]
    .map((match) => `temp:${match[1]?.trim() ?? ''}`)
    .filter((path) => path !== 'temp:');
  return [...new Set([...legacy, ...temporary])].slice(0, 20);
}

function hasDraftAfterLatestFailedReview(text: string): boolean {
  const failedReview = Math.max(
    text.lastIndexOf('验收结论：不通过'),
    text.lastIndexOf('验收结论: 不通过'),
  );
  if (failedReview < 0) return false;
  const latestDraft = Math.max(
    text.lastIndexOf('TEMP_SAVED:'),
    text.lastIndexOf('.runtime/review-drafts/'),
    text.lastIndexOf('.runtime\\review-drafts\\'),
  );
  return latestDraft > failedReview;
}

function buildCompletionState(
  task: string,
  evidence: string,
  artifacts: Array<{ relativePath: string; content: string }>,
  delegations: CLIDelegation[],
  availableAgents: DelegatableAgentInfo[],
  mode: CollaborationMode = 'expert',
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
  const delegatedReviewAttempts = delegations.filter((delegation) => {
    const agent = agentById.get(delegation.agentInstanceId);
    return agent && isAcceptanceReviewerAgent(agent) && delegation.status !== 'pending' && delegation.status !== 'running';
  }).length;
  const recordedReviewAttempts = [...evidence.matchAll(/(?:^|\n)\s*验收结论\s*[:：]\s*(?:不通过|通过)\s*(?:$|\n)/gu)].length;
  const reviewAttempts = Math.max(delegatedReviewAttempts, recordedReviewAttempts, reviewDecision === 'unknown' ? 0 : 1);
  const requiresReview = collaborationReviewLimit(mode) > 0 && requiresQualityReview(task) && reviewerAvailable;
  const missing: string[] = [];
  const namedRoles = requiresNamedCodingReview(task);
  const completedAgents = new Set(delegations.filter((d) => d.status === 'completed').map((d) => agentById.get(d.agentInstanceId)));
  if (namedRoles.kimi && ![...completedAgents].some((a) => a && (/kimi(?:\s|-)?code/i.test(`${a.definitionId} ${a.name}`)))) {
    missing.push('用户指定的 Kimi Code 尚未完成代码编写');
  }
  if (namedRoles.codebuddy && ![...completedAgents].some((a) => a && (/codebuddy/i.test(`${a.definitionId} ${a.name}`)))) {
    missing.push('用户指定的 CodeBuddy 尚未完成验收');
  }
  const balancedReviewDelivered = mode === 'balanced'
    && reviewFailed
    && reviewAttempts >= collaborationReviewLimit(mode)
    && deliverablePaths.length > 0;
  if (balancedReviewDelivered) {
    // A balanced run records the single review's findings as delivery risk,
    // but does not enter a writer/reviewer loop after the file is published.
  } else if (requiresReview && reviewFailed) {
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
    reviewAttempts,
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
  mode: CollaborationMode = 'expert',
): AdaptivePlannerDecision {
  if (completion.missing.length === 0) return decision;
  const reason = `当前结果仍缺少：${completion.missing.join('；')}。不能提前结束。`;
  const latestDraft = completion.draftPaths.at(-1);
  const latestDraftFileName = latestDraft?.startsWith('temp:') ? latestDraft.slice('temp:'.length) : latestDraft;
  const repairedSinceReview = hasDraftAfterLatestFailedReview(evidence);
  const promoteInstruction = latestDraftFileName
    ? `请调用 temp:promote，填写 fileName=${latestDraftFileName}，将真实临时文件复制为正式成果 outputs/task-delivery-${safeRunSegment(runId)}.html；只有工具返回 TEMP_PROMOTED 才能声称交付。`
    : '';
  if (mode === 'fast' && latestDraft && completion.deliverablePaths.length === 0) {
    return {
      ...decision,
      status: 'self_execute',
      stageSatisfied: false,
      reason,
      assignments: [],
      selfInstruction: `快速协同不安排独立验收。${promoteInstruction}`,
    };
  }
  if (mode === 'balanced' && completion.reviewFailed && completion.reviewAttempts >= collaborationReviewLimit(mode) && latestDraft) {
    return {
      ...decision,
      status: 'self_execute',
      stageSatisfied: false,
      reason: `${reason} 均衡协同的一次验收额度已经使用，不再进入返修和复验循环；交付时必须保留验收风险说明。`,
      assignments: [],
      selfInstruction: `均衡协同已完成一次验收，不再返修或复验。${promoteInstruction}`,
    };
  }
  if (mode === 'balanced' && !completion.requiresReview && latestDraft && completion.deliverablePaths.length === 0) {
    return {
      ...decision,
      status: 'self_execute',
      stageSatisfied: false,
      reason,
      assignments: [],
      selfInstruction: `当前任务无需独立验收。${promoteInstruction}`,
    };
  }
  if (mode === 'balanced' && completion.reviewPassed && latestDraft && completion.deliverablePaths.length === 0) {
    return {
      ...decision,
      status: 'self_execute',
      stageSatisfied: false,
      reason,
      assignments: [],
      selfInstruction: `验收已经通过。${promoteInstruction}`,
    };
  }
  if (decision.status !== 'complete') return decision;
  const reviewer = completion.requiresReview
    && (completion.draftPaths.length > 0 || completion.deliverablePaths.length > 0)
    && !completion.reviewPassed
    && (!completion.reviewFailed || repairedSinceReview)
    && completion.reviewAttempts < collaborationReviewLimit(mode)
    ? chooseReviewerAgent(agents)
    : undefined;
  const writer = chooseArtifactAgent(task, agents);
  const writerAlreadyProducedCurrentDraft = completion.draftPaths.length > 0 && !completion.reviewFailed;
  if (completion.reviewFailed && writer && !repairedSinceReview) {
    return {
      ...decision,
      status: 'delegate',
      stageSatisfied: false,
      reason,
      assignments: [{
        stepId: 'repair-deliverable',
        agentInstanceId: writer.id,
        objective: `最近一次验收没有通过。请逐项落实返修意见，覆盖同名临时候选稿，不要发布正式附件；修改完成后通过 temp:save 覆盖文件名 ${latestDraftFileName ?? 'draft.html'}，只返回实际结果。\n完整任务：${task}\n候选稿文件名：${latestDraftFileName ?? 'draft.html'}\n验收意见和已有结果：\n${evidence.slice(-20_000)}`,
        expectedDeliverable: '完成返修的待审稿路径和逐项修改说明',
        visibleMessage: '验收发现了需要修正的内容，请按具体意见完成返修，完成后再复核。',
      }],
    };
  }
  if (reviewer) {
    return {
      ...decision,
      status: 'delegate',
      stageSatisfied: false,
      reason,
      assignments: [{
        stepId: `review-deliverable-${completion.reviewAttempts + 1}`,
        agentInstanceId: reviewer.id,
        objective: `当前核验批次的最近结果：${conciseTaskBrief(evidence.slice(-800))}\n先用 temp:list/temp:read 读取真实候选稿，再用 template:list/template:read 读取实际模板和 knowledge:search/knowledge:readDocument 获取证据。逐项核对用户要求、模板和证据；通过时明确回复“验收结论：通过”，不通过时给出可执行返修清单。\n完整任务：${task}\n候选稿文件名：${latestDraftFileName ?? '先用 temp:list 确认'}\n已有成员结果：\n${evidence.slice(-20_000)}`,
        expectedDeliverable: '明确的验收结论和必要的返修意见',
        visibleMessage: '成果已经生成，我请验收智能体独立核对关键内容；通过后再正式交付。',
      }],
    };
  }
  if (completion.reviewPassed && completion.draftPaths.length > 0 && completion.deliverablePaths.length === 0) {
    return {
      ...decision,
      status: 'self_execute',
      stageSatisfied: false,
      reason,
      assignments: [],
      selfInstruction: `验收已经通过。${promoteInstruction}`,
    };
  }
  if (writer && !writerAlreadyProducedCurrentDraft) {
    if (isLocalExecutorAgent(writer)) {
      return {
        ...decision,
        status: 'delegate',
        stageSatisfied: false,
        reason,
        assignments: [{
          stepId: 'complete-deliverable',
          agentInstanceId: writer.id,
          objective: `${buildLocalExecutorTask(task)}\n\n已有可用结果：\n${evidence.slice(-24_000) || '暂无'}\n\n本轮必须补齐以下缺口：${completion.missing.join('；')}。在你内部完成必要核验和返修，真实生成并提升 outputs 成果后再返回。`,
          expectedDeliverable: completion.requiresHtml ? '已真实生成并发布的 HTML 成果文件' : '满足完成标准的真实成果和综合结论',
          visibleMessage: '请围绕完整业务目标补齐当前交付缺口，并在内部完成必要核验后返回最终成果。',
        }],
      };
    }
    const writerObjective = mode === 'fast'
          ? `请自行检索授权知识、完整读取明确文件，并用 template:list/template:read 获取实际模板；一次性完成整篇候选成果，不要逐章多步生成或自行验收。使用 temp:save 将完整稿保存为文件名 draft.html，只填写文件名不要填写路径；不要发布正式附件。\n完整任务：${task}\n已有成员结果：\n${evidence.slice(-24_000) || '暂无，请依据任务完成必要内容并标注不确定项'}`
      : mode === 'balanced'
        ? `请自行检索授权知识、完整读取明确文件，并用 template:list/template:read 获取实际模板；在当前环节内完成结构和证据自检，然后一次性生成整篇候选成果，不要逐章多步生成或重复改稿。使用 temp:save 将完整稿保存为文件名 draft.html，只填写文件名不要填写路径；不要发布正式附件。\n完整任务：${task}\n已有成员结果：\n${evidence.slice(-24_000) || '暂无，请依据任务完成必要内容并标注不确定项'}`
        : `当前补齐依据的最近结果：${conciseTaskBrief(evidence.slice(-800))}\n根据完整任务，自行检索授权知识、完整读取明确文件并读取实际模板，完成用户要求的候选成果。若当前任务需要独立验收，请使用 temp:save 将候选稿保存为文件名 draft.html，不要发布正式附件；无需验收时也必须通过系统文件工具真实保存后再交付。不要只返回源码。\n完整任务：${task}\n已有成员结果：\n${evidence.slice(-24_000) || '暂无，请依据任务自行补齐必要内容并标注不确定项'}`;
    return {
      ...decision,
      status: 'delegate',
      stageSatisfied: false,
      reason,
      assignments: [{
        stepId: 'produce-deliverable',
        agentInstanceId: writer.id,
        objective: writerObjective,
        expectedDeliverable: mode === 'expert'
          ? completion.requiresReview ? '已保存的 HTML 待审稿路径' : completion.requiresHtml ? '已发布且可直接打开的 HTML 文件' : '已发布的正式成果文件'
          : '一次性生成并保存的完整 HTML 候选稿路径',
        visibleMessage: '资料已经返回，接下来请把它整理成完整的候选成果。',
      }],
    };
  }
  return {
    ...decision,
    status: 'self_execute',
    stageSatisfied: false,
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
  sendTrace(
    ctx,
    'reasoning',
    '汇总真实结果并生成用户答复',
    'running',
  );
  if (requiresCoordinationView(state)) {
    sendOrchestratorChecklist(ctx, 'validating', {
      understand: conciseTaskBrief(task),
      validate: '正在核对成员结论、交付物完整性与剩余风险。',
    });
  }

  const verifiedDelegations = state.cliDelegations.filter((delegation) => Boolean(delegation.subRunId));
  const verifiedAgentNames = [...new Set(verifiedDelegations.map((delegation) => delegation.agentName).filter(Boolean))];
  const verifiedRoster = verifiedDelegations.length > 0
    ? verifiedDelegations.map((delegation) => `- ${delegation.agentName}：${delegation.status === 'completed' ? '已完成' : '执行失败'}`).join('\n')
    : '- 无主任务子智能体委派记录';
  const memberResults = verifiedDelegations
    .filter((delegation) => delegation.result.trim())
    .map((delegation) => delegation.result);
  const singleDelegation = verifiedDelegations.length === 1
    && state.cliDelegations.length === 1
    && !state.parallelDelegationApproved;
  const synthesisModeDirective = ctx.collaborationMode === 'fast'
    ? '\n\n当前为快速协同：一次性形成简洁最终交付，不再发起验收、返修或重复归纳。'
    : ctx.collaborationMode === 'balanced'
      ? '\n\n当前为均衡协同：形成适度完整的最终交付；只保留一次必要核验的结论，不进入反复返修或重复归纳。'
      : '';
  const singleDelegationDirective = singleDelegation
    ? '\n\n当前只有一个成员独立完成了任务。不要复述其过程或逐字改写其回复，只用自己的话给出一段简洁结论和必要的成果/风险说明。'
    : '';
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: `${ORCHESTRATOR_SYNTHESIS_SYSTEM_PROMPT}\n\n本次真实委派成员仅限：${verifiedAgentNames.join('、') || '无'}。${synthesisModeDirective}${singleDelegationDirective}`,
    },
    {
      role: 'user',
      content: `用户本次完整需求：\n${task}\n\n系统核验的本次子任务记录：\n${verifiedRoster}\n\n实际返回结果：\n${state.subAgentResult || '(无有效结果)'}\n\n请直接给出最终交付，不评价未被委派的成员。`,
    },
  ];

  const synthesisSlot = singleDelegation ? 'fast' : 'reasoning';
  const synthesisOptions = conciseGenerationOptions(singleDelegation ? 900 : 1_400);
  let finalResult = await ctx.services.generateText(synthesisSlot, messages, synthesisOptions);
  let cleanedFinalText = sanitizeUserFacingResponse(removeHtmlSourceFromFormalMessage(finalResult.text));
  const needsRegeneration = containsInternalOrchestrationProtocol(cleanedFinalText)
    || (ctx.collaborationMode !== 'fast' && (
      isNearDuplicateMemberSummary(cleanedFinalText, memberResults)
      || cleanedFinalText !== finalResult.text.trim()
    ));
  if (needsRegeneration) {
    ctx.services.getLogger().warn(`Orchestrator.synthesize: 最终交付包含内部协议、HTML 源码或近似复制，正在重新归纳 (runId=${ctx.runId})`);
    sendTrace(ctx, 'warning', '最终交付需要重新归纳，正在去除重复内容与源码', 'running');
    finalResult = await ctx.services.generateText(synthesisSlot, [
      { role: 'system', content: `${ORCHESTRATOR_SYNTHESIS_SYSTEM_PROMPT}${singleDelegationDirective}` },
      {
        role: 'user',
        content: `用户本次完整需求：\n${task}\n\n成员执行结果：\n${state.subAgentResult || '(无有效结果)'}\n\n上一版交付因为近似复制成员原文、包含 HTML 源码或内部协议而被拒绝。请重新形成你自己的归纳：只保留最终判断、3-5 条高价值结论、真实成果附件说明和必要风险；不要逐段复述成员结果。`,
      },
    ], conciseGenerationOptions(singleDelegation ? 800 : 1_200));
    cleanedFinalText = sanitizeUserFacingResponse(removeHtmlSourceFromFormalMessage(finalResult.text));
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
  const verifiedText = sanitizeUserFacingResponse(
    removeUnverifiedAgentFailureClaims(finalResult.text, verifiedAgentNames, knownAgentNames),
  );
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
  const text = sanitizeUserFacingResponse(removeHtmlSourceFromFormalMessage(rawText))
    || buildSafeSynthesisFallback(state.subAgentResult, task);
  if (!text) return {};

  const artifactLines = (state.artifacts ?? []).map(
    (a) => `成果文件：**${a.relativePath}**（已发送到群聊）`,
  );
  const combinedText = artifactLines.length > 0 ? text + '\n\n---\n\n' + artifactLines.join('\n\n') : text;

  // 子智能体完成时 @回父智能体
  const mentions: Array<{ target: { scope: string; id: string }; label: string; start: number; end: number }> = [];
  const parentRunId = ctx.services.getParentRunId(ctx.runId);
  let parentAgentId: string | null = null;
  if (parentRunId) {
    parentAgentId = ctx.services.getRunAgentInstanceId(parentRunId);
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

  const isWaitingForUser = Boolean(state.awaitingUser);
  const audience = parentAgentId
    ? { scope: 'parent' as const, id: parentAgentId, ...(isWaitingForUser ? { includeUser: true } : {}) }
    : { scope: 'user' as const };
  const deliveryText = state.awaitingUser
    ? `${parentAgentId && mentions[0] ? `@${mentions[0].label}\n\n` : ''}@用户 ${combinedText}`
    : mentions[0] ? `@${mentions[0].label}\n\n${combinedText}` : combinedText;
  const contentJson = JSON.stringify({
    schemaVersion: 1,
    text: deliveryText,
    mentions,
    stagedUploadIds: [],
    requiresUserResponse: isWaitingForUser,
    audience,
  });
  const isLightweightResponse = isWaitingForUser || isConversationStatusQuestion(ctx.instruction) || isSimpleDirectTask(task);

  if (!isLightweightResponse && requiresCoordinationView(state)) {
    sendOrchestratorChecklist(ctx, 'delivering', {
      understand: conciseTaskBrief(task),
      deliver: '正在发送结论与成果文件。',
    });
  }
  const agentMsgId = await ctx.services.insertMessage(ctx.projectId, ctx.agentInstanceId, 'text', contentJson);
  if (!isLightweightResponse && requiresCoordinationView(state)) {
    sendTrace(ctx, 'execution', '向用户提交最终结果', 'completed');
    sendOrchestratorChecklist(ctx, 'completed', {
      understand: conciseTaskBrief(task),
      deliver: '最终结果已经交付。',
    });
  }
  ctx.services.setResultMessage(ctx.runId, agentMsgId);

  if (isWaitingForUser) {
    ctx.services.addRunEvent(ctx.runId, 'run.awaiting-user', {
      messageId: agentMsgId,
      question: state.awaitingUser?.question ?? combinedText,
      missingFields: state.awaitingUser?.missingFields ?? [],
    });
    ctx.services.setRunStatus(ctx.runId, 'awaiting_user');
    ctx.services.setTaskPlanStatus?.(ctx.runId, 'waiting-user');
    sendTrace(ctx, 'handoff', '等待用户补充关键信息', 'running', state.awaitingUser?.question ?? combinedText);
    sendOrchestratorChecklist(ctx, 'waiting', {
      understand: conciseTaskBrief(task),
      wait: '等待用户回复后继续当前任务。',
    });
    ctx.services.emitEvent({
      type: 'run.status',
      projectId: ctx.projectId,
      run: { id: ctx.runId, agentId: ctx.agentInstanceId, status: 'awaiting_user', stage: '等待用户回复' },
    });
    return {};
  }

  ctx.services.emitEvent({
    type: 'run.status',
    projectId: ctx.projectId,
    run: { id: ctx.runId, agentId: ctx.agentInstanceId, status: 'completed' },
  });
  ctx.services.setTaskPlanStatus?.(ctx.runId, 'completed');
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

function routeAfterDelegateCLI(state: GraphState): string {
  // 简单单委派（analyzeIntent 判定成员可独立闭环交付）：统筹转入
  // 静默守望——成功时成员自己回复用户、统筹零输出结束；成员失败
  // 才交回收集纠偏流程。其余场景仍进入等待收集与总结环节。
  if (state.fireAndForgetDelegation
    && state.cliDelegations.length === 1
    && Boolean(state.cliDelegations[0]?.subRunId)
    && canFireAndForget(state.macroPlan, state.activeStageId ? { stageId: state.activeStageId } : {}, state)) {
    return 'watchDelegationOutcome';
  }
  return 'collectCLIResults';
}

// 独立闭环交付的静默守望：统筹已把最终交付权交给成员，成功时不做
// 任何归纳总结（成员的回复就是给用户的最终输出），仅在成员失败或
// 超时的情况下把控制权交回正常的收集纠偏流程，保证简单任务失败
// 依然有人兜底（缩小范围重委派或向用户说明原因）。
async function watchDelegationOutcome(state: GraphState, config: { configurable: { ctx: IGraphContext } }): Promise<Partial<GraphState>> {
  const ctx = config.configurable.ctx;
  ctx.signal.throwIfAborted();
  const delegation = state.cliDelegations[0];
  if (!delegation?.subRunId) return {};
  ctx.services.getLogger().info(`watchDelegationOutcome: 静默等待 ${delegation.agentName || delegation.agentInstanceId} 独立交付`);
  const deadline = Date.now() + MAX_COLLECT_WAIT_MS;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (Date.now() < deadline) {
    ctx.signal.throwIfAborted();
    try {
      const runStatus = ctx.services.getRunStatus(delegation.subRunId);
      const descendants = ['completed', 'failed', 'cancelled', 'interrupted'].includes(runStatus.status)
        ? (ctx.services.getRunDescendants?.(delegation.subRunId) ?? [])
        : [];
      const activeDescendants = descendants.filter((child) => (
        ['queued', 'starting', 'running', 'cancelling'].includes(child.status)
      ));
      if (activeDescendants.length > 0) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (runStatus.status === 'completed') {
        // 独立成员完成后只有在宏观计划和交付边界都已满足时才可结束。
        // 多阶段任务继续回到收集/规划 loop，避免“查到资料就结束”。
        const completedPlan = updateMacroPlan(state.macroPlan, {
          status: 'complete',
          reason: '独立成员已完成当前阶段',
          assignments: [],
          ...(state.activeStageId ? { activeStageId: state.activeStageId } : {}),
          stageSatisfied: true,
        });
        if (hasUnmetMacroStages(completedPlan)) {
          return {
            cliDelegations: [{ ...delegation, status: 'completed' as const, result: '当前阶段已完成，仍有后续宏观阶段待统筹推进' }],
            macroPlan: completedPlan,
            activeStageId: completedPlan?.stages.find((stage) => stage.status === 'active')?.id ?? '',
          };
        }
        // 成员已经独立向用户交付，统筹不再归纳总结，本轮零输出结束。
        // 零输出路径不经过 respond 节点，必须在这里补发完成事件，
        // 否则群聊界面的「执行中」状态永远等不到终态广播。
        ctx.services.emitEvent({
          type: 'run.status',
          projectId: ctx.projectId,
          run: { id: ctx.runId, agentId: ctx.agentInstanceId, status: 'completed' },
        });
        ctx.services.setTaskPlanStatus?.(ctx.runId, 'completed');
        activeTraceIdsByRun.delete(ctx.runId);
        return {
          cliDelegations: [{ ...delegation, status: 'completed' as const, result: '成员已独立交付最终结果' }],
          macroPlan: completedPlan,
          activeStageId: '',
        };
      }
      if (runStatus.status === 'awaiting_user') {
        // 成员已直接向用户提出补充问题：统筹静默结束，等用户回复后再
        // 自然触发后续处理，不做超时纠偏。
        ctx.services.setRunStatus(ctx.runId, 'awaiting_user');
        ctx.services.setTaskPlanStatus?.(ctx.runId, 'waiting-user');
        ctx.services.emitEvent({
          type: 'run.status',
          projectId: ctx.projectId,
          run: { id: ctx.runId, agentId: ctx.agentInstanceId, status: 'awaiting_user', stage: '等待用户回复' },
        });
        activeTraceIdsByRun.delete(ctx.runId);
        return { cliDelegations: [{ ...delegation, status: 'completed' as const, result: '成员已向用户提问，等待用户补充' }] };
      }
      if (['failed', 'cancelled', 'interrupted'].includes(runStatus.status)) {
        // 成员失败：交回收集纠偏流程，由统筹决定缩小范围重委派或告知用户。
        return {
          cliDelegations: [{
            ...delegation,
            status: 'failed' as const,
            result: runStatus.errorMessage ?? `子任务 ${delegation.subRunId} 状态: ${runStatus.status}`,
          }],
        };
      }
    } catch {
      // 状态暂不可得时继续等待，直到终态或超时。
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { cliDelegations: [{ ...delegation, status: 'failed' as const, result: '独立交付等待超时未完成' }] };
}

function routeAfterWatchDelegation(state: GraphState): string {
  const outcome = state.cliDelegations[0];
  if (outcome?.status === 'completed' && !hasUnmetMacroStages(state.macroPlan)) return END;
  return 'collectCLIResults';
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
    .addNode('watchDelegationOutcome', watchDelegationOutcome as any)
    .addNode('synthesize', synthesize as any)
    .addNode('respond', respond as any)
    .addEdge('__start__', 'analyzeIntent')
    .addConditionalEdges('analyzeIntent', routeAfterAnalyze, ['delegateToKM', 'delegateCLI', 'executeOrchestratorStep', 'synthesize', 'respond'])
    .addConditionalEdges('delegateToKM', routeAfterDelegate, ['collectCLIResults', 'synthesize', 'respond'])
    .addConditionalEdges('delegateCLI', routeAfterDelegateCLI, ['collectCLIResults', 'watchDelegationOutcome'])
    .addConditionalEdges('watchDelegationOutcome', routeAfterWatchDelegation, ['collectCLIResults', END])
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
      macroPlan: null,
      activeStageId: '',
      stageAttempts: {},
      awaitingUser: null,
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
      ctx.services.setTaskPlanStatus?.(ctx.runId, 'cancelled');
      return;
    }
    throw err;
  }
}
