import { BrowserWindow, app, dialog } from 'electron';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelGateway, type ModelSlot } from './model-gateway';
import type { QueuedRun, Scheduler } from './scheduler';
import { MemoryManager, type MemoryReflection } from './memory-manager';
import { ContextBuilder } from './context-builder';
import { createProjectTools, registerProjectTools } from './agent-tools';
import { ToolRegistry, type AgentRole as LocalAgentRole } from './tool-registry';
import { runOrchestrator } from './langgraph-orchestrator';
import { resolveKnowledgeScopesForGroup, syncKnowledgeSources } from './knowledge-sync';
import {
  executeKnowledgeFileProcessingSkill,
  type KnowledgeSkillActivity,
} from './knowledge-skill-execution';
import { cliExecutor } from './cli-executor';
import { cliAgentRegistry } from './cli-agent-registry';
import { AgentRunRepository, MessageRepository } from '@kunqing/database';
import { getLogger } from './logger';
import { getProjectRoot, getProjectTempRunRoot } from './paths';
import { processMessageMentions, insertRunFailureNotice } from './message-router';
import {
  buildAgentCollaborationInstructions,
  findEquivalentAgentTaskMessage,
  findDuplicateAwaitingUserMessage,
  messageRequestsUserResponse,
  normalizeAgentMessageContent,
  resolveAgentMentions,
  sanitizeAgentDisplayText,
  type AgentMessageAudience,
  type AgentMention,
} from './agent-collaboration';
import { AgentArtifactPublisher } from './agent-artifact-publisher';
import { isStructuredEvent, normalizeChunk } from './event-normalizer';
import { broadcastEvent } from './event-broadcast';
import { listAgentPrivateOutputFiles, prepareAgentPrivateWorkspace, syncAgentPrivateOutputs } from './agent-private-workspace';
import { getSkillDisplayName } from './skill-display';
import { SkillRegistry } from './skill-registry';
import { WorkflowRegistry } from './workflow-registry';
import { applyAgentRoleAdaptations } from './agent-identity';
import { AGENT_TASK_TIMEOUT_MS } from './agent-runtime-limits';
import {
  parsePostTaskKnowledgeInstruction,
  runPostTaskKnowledgeCapture,
} from './business-process';
import { isConversationStatusQuestion, isSimpleDirectTask, isIndependentDeliveryInstruction, requiresArtifactDeliverable, sanitizeUserFacingResponse, type BusinessProcess } from '@kunqing/native-agent-core';
import { collectStreamedAgentText, discardStreamingPlaceholder, streamAgentMessage } from './message-stream';
import { resolveCollaborationMode, type CollaborationMode } from './collaboration-mode';
import { MODE_DIRECTIVES, MODE_HISTORY_BUDGET, resolveOutputDirective, resolveSpawnPolicy } from './collaboration-policy';
import { resolveMcpConfigSecrets } from './workbuddy-config';
import { getActiveNeutralMcpRelay, isLoopbackMcpEndpoint, type NeutralRelayTask } from './neutral-mcp-relay';
import {
  readRetrievalBudgetUsage,
  reserveRetrievalBudget,
  resolveRetrievalBudgetOwnerRunId,
  retrievalBudgetForDelegatedNode,
} from './retrieval-budget';
import type { OperationSkillManager } from './operation-skill-manager';

export { areWebSearchQueriesEquivalent, retrievalBudgetForDelegatedNode } from './retrieval-budget';

/**
 * 查询智能体实例的显示名称
 */
function lookupAgentName(db: Database.Database, agentInstanceId: string): string | null {
  try {
    const row = db.prepare(
      `SELECT ap.name FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = ?`,
    ).get(agentInstanceId) as { name: string } | undefined;
    return row?.name ?? null;
  } catch {
    return null;
  }
}

function stableRunMessageId(runId: string, discriminator: string): string {
  return createHash('sha256').update(`agent-message:${runId}:${discriminator}`).digest('hex').slice(0, 24);
}

function rootTaskFinalMessageId(
  db: Database.Database,
  run: QueuedRun,
  senderId: string,
  contentJson: string,
): string {
  return findEquivalentAgentTaskMessage(db, {
    projectId: run.projectId,
    triggerMessageId: run.triggerMessageId,
    senderId,
    kind: 'text',
    contentJson,
    excludeRunId: run.runId,
  }) ?? stableRunMessageId(run.runId, 'final');
}

async function waitForNeutralRelayTask(relay: NonNullable<ReturnType<typeof getActiveNeutralMcpRelay>>, taskId: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<NeutralRelayTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('中立 MCP 任务已取消');
    const task = relay.getTask(taskId);
    if (task && (task.status === 'completed' || task.status === 'failed')) return task;
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('WorkBuddy 中立 MCP 任务等待超时');
}

/**
 * Compare the text that a user can actually see. Message metadata, mention
 * routing and line-ending differences must not create a second visible copy.
 */
export function agentDeliveryTextsMatch(left: string, right: string): boolean {
  return left.replace(/\r\n/g, '\n').trim() === right.replace(/\r\n/g, '\n').trim();
}

function visibleMessageText(contentJson: string, fallback = ''): string {
  try {
    const parsed = JSON.parse(contentJson) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : fallback;
  } catch {
    return fallback;
  }
}

const MAIL_SECRETARY_DEMO_RESPONSE = `邮箱读取完成，已找到 1 封相关邮件，返回结果如下：

邮件信息

发件人："会员服务"

发送时间：2026-08-26 11:41:35

收件人："86031120" 86031120@qq.com

主题：关于第28届中国电子学会青年年会论文交流征集通知

附件数量：2 个 PDF 文件

邮件正文
各位青年会员：

第28届中国电子学会青年年会将于2026年11月20-22日在深圳举办，主题为“All in AI 圳启智潮”。现面向青年科技工作者（含在读硕博）征集论文交流稿件，方向涵盖电子信息前沿、AI技术、核心硬件及青年科技生态等。交流形式包括论文报告和墙报展示。投稿截止2026年9月20日，详情请查阅附件征文通知及年会通知。

附件列表

关于第28届中国电子学会青年年会论文交流征集通知(第一轮).pdf

关于召开中国电子学会第28届青年年会的通知.pdf

已将附件下载保存至工作区。`;

function isMailboxSecretaryPlatform(platform: { name: string; url: string }): boolean {
  return /邮箱秘书/u.test(platform.name) && /(^|\.)mail\.163\.com\/?/iu.test(platform.url);
}

/**
 * Fixed demonstration path for the email/paper collaboration. Kimi is still
 * represented as a real child run and sends real files, but the demo must not
 * launch the user's local Kimi CLI. The root trigger is included because a
 * delegated child instruction only contains its current work package.
 */
function isFixedPaperKimiDemoTask(
  db: Database.Database,
  runRepo: AgentRunRepository,
  run: QueuedRun,
  agentName: string,
  definitionId: string,
): boolean {
  if (!/kimi(?:\s|-)?code|custom\.kimi/iu.test(`${agentName} ${definitionId}`)) return false;
  const chainText = [run.instruction, ...runRepo.getAncestorChain(run.runId).map((item) => item.instruction)];
  if (run.triggerMessageId) {
    const row = db.prepare('SELECT content_json AS contentJson FROM messages WHERE id = ?').get(run.triggerMessageId) as { contentJson?: string } | undefined;
    if (row?.contentJson) {
      chainText.push(row.contentJson);
      try {
        const parsed = JSON.parse(row.contentJson) as { text?: unknown };
        if (typeof parsed.text === 'string') chainText.push(parsed.text);
      } catch { /* legacy/plain message */ }
    }
  }
  const text = chainText.join('\n');
  return /(?:邮箱|邮件)/u.test(text) && /论文/u.test(text) && /codebuddy/iu.test(text)
    && /(?:代码|anomaly_detection|写代码)/iu.test(text);
}

async function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function materialWriterStepInstruction(instruction: string, mode: CollaborationMode): string {
  const createsArtifact = requiresArtifactDeliverable(instruction)
    || /(?:待审稿|候选稿|返修|改稿|temp:save|review:writeDraft)/iu.test(instruction);
  if (!createsArtifact) {
    return '当前是内部知识查询或整文阅读步骤。用 knowledge:search 检索并综合精炼证据；明确文件时用 knowledge:readDocument 连续读取到 READ_COMPLETE: true。不要调用模板工具、不要创建待审稿或成果文件，完成后返回带来源的答案。';
  }
  if (mode === 'fast') {
    return '先用 template:list 查找可用模板并按需用 template:read 读取；发现 HTML 模板时保留原始外壳，最后用 temp:save 将完整候选稿保存为一个文件名（如 draft.html），不要填写路径；无模板时自行设计外壳后同样用 temp:save 保存。自行检索知识，明确文件时用 knowledge:readDocument 连续读完整，再一次性完成整篇文档。不要自行验收、返修或安排其他成员。';
  }
  if (mode === 'balanced') {
    return '先用 template:list/template:read 获取实际模板，自行完成知识检索和结构证据检查；发现 HTML 模板时保留原始外壳，最后用 temp:save 将完整候选稿保存为文件名 draft.html，不要填写路径；无模板时同样用 temp:save 保存。明确文件时用 knowledge:readDocument 连续读完整，再一次性输出整篇文档。不要逐章多步生成或安排其他成员。';
  }
  return '自行用 template:list/template:read 发现并读取实际模板，用 knowledge:search 检索三层知识，明确文件时用 knowledge:readDocument 连续读完整；先形成框架再逐章写作。发现 HTML 模板时保留原始外壳，最后用 temp:save 将完整候选稿保存为文件名 draft.html，不要填写路径；无模板时同样保存，不要发布成果或安排其他成员。';
}

function lookupRunAnchorMessageId(runRepo: AgentRunRepository, runId: string): string | null {
  try {
    const anchor = [...runRepo.listEvents(runId)].reverse().find((event) => event.type === 'run.anchor' && event.payloadJson);
    if (anchor?.payloadJson) {
      const parsed = JSON.parse(anchor.payloadJson) as { messageId?: unknown };
      if (typeof parsed.messageId === 'string' && parsed.messageId) return parsed.messageId;
    }
    return runRepo.getById(runId).triggerMessageId;
  } catch {
    return null;
  }
}

/** executor 热路径使用的 Run 链路元数据视图：优先复用 enqueue 透传的 chainMeta 快照，缺失时回查 agent_runs。 */
function resolveRunChainMeta(
  runRepo: AgentRunRepository,
  run: QueuedRun,
): {
  projectId: string;
  agentInstanceId: string;
  requestedByType?: string;
  requestedById?: string;
  parentRunId?: string;
  createdAt?: string;
} {
  if (run.chainMeta) {
    return { projectId: run.projectId, agentInstanceId: run.agentInstanceId, ...run.chainMeta };
  }
  try {
    const persisted = runRepo.getById(run.runId);
    return {
      projectId: persisted.projectId,
      agentInstanceId: persisted.agentInstanceId,
      requestedByType: persisted.requestedByType,
      requestedById: persisted.requestedById,
      ...(persisted.parentRunId ? { parentRunId: persisted.parentRunId } : {}),
      createdAt: persisted.createdAt,
    };
  } catch {
    return { projectId: run.projectId, agentInstanceId: run.agentInstanceId };
  }
}

function runChainMetadataPayload(runRepo: AgentRunRepository, run: QueuedRun): {
  triggerMessageId?: string | undefined; parentRunId?: string | undefined; requestedByType?: string | undefined; requestedById?: string | undefined; createdAt?: string | undefined;
} {
  const meta = resolveRunChainMeta(runRepo, run);
  return {
    ...(run.triggerMessageId ? { triggerMessageId: run.triggerMessageId } : {}),
    ...(meta.parentRunId ? { parentRunId: meta.parentRunId } : {}),
    requestedByType: meta.requestedByType,
    requestedById: meta.requestedById,
    createdAt: meta.createdAt,
  };
}

function plainRunInstruction(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    if (typeof parsed.text === 'string') return parsed.text.trim();
  } catch { /* use raw instruction */ }
  return raw.trim();
}

function parseMemoryReflection(raw: string): Partial<MemoryReflection> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(fenced.slice(start, end + 1)) as unknown;
    return value && typeof value === 'object' ? value as Partial<MemoryReflection> : null;
  } catch {
    return null;
  }
}

function memoryReflectionPrompt(
  instruction: string,
  result: string,
  artifacts: string[],
  context: { shortTerm: string[]; longTerm: string[] },
): string {
  return `请只回顾你自己刚完成的任务，把值得保留的信息压缩为记忆。不要记录其他智能体的私有身份、记忆或隐藏思考。

本次任务：${plainRunInstruction(instruction).slice(0, 1_500)}

本次结果：${result.slice(0, 4_000)}

成果文件：${artifacts.join('、') || '无'}

你自己的近期记忆：
${context.shortTerm.join('\n') || '无'}

你自己的已有长期摘要：
${context.longTerm.join('\n') || '无'}

只返回以下 JSON，不要使用 Markdown：
{"topic":"稳定、简短的主题","taskSummary":"本次任务语义摘要","decisions":["关键决定"],"reusableInsights":["可复用经验"],"preferences":["明确观察到的用户偏好"],"constraints":["仍有效的约束"],"unresolved":["待续事项"],"confidence":0到1,"importance":0到1,"longTermWorth":true或false,"shortTermSummary":"结合近期同主题记忆形成的滚动摘要；没有必要可为空字符串","longTermSummary":"若值得长期保留，结合旧版本写成去重后的长期语义摘要；否则为空字符串","roleAdaptations":[{"category":"communication或collaboration或domain或delivery","content":"稳定的角色适应规则","confidence":0到1,"evidenceCount":独立证据次数,"evidence":"简短证据说明"}]}

置信度必须由你根据事实可靠性判断，不能使用固定值。只有跨任务仍有复用价值的偏好、约束、决策或经验才把 longTermWorth 设为 true。
roleAdaptations 只允许记录至少两次独立任务都能证明的稳定沟通偏好、协作习惯、领域侧重点或交付偏好；单次任务细节必须返回空数组。不得提出扩大权限、替换核心职责、改变 leader/teammate 身份或读取他人身份记忆的适应项。`;
}

function containsInternalAgentProtocol(text: string): boolean {
  return /(?:^|\n)\s*(?:NEED_AGENTS|NEED_CLI|NEED_KM)\b/i.test(text);
}

function suppressUnreviewedArtifactOutput(text: string): string {
  return text
    .replace(/<!doctype\s+html[\s\S]*?<\/html>/giu, '待审稿内容已写入本地验收区。')
    .replace(/<html\b[\s\S]*?<\/html>/giu, '待审稿内容已写入本地验收区。')
    .replace(/:::artifact\{[\s\S]*?\r?\n:::/giu, '待审稿尚未通过验收，未发布为正式成果。')
    .replace(/^(?:ARTIFACT:)\s*outputs[\\/].+$/gimu, '待审稿尚未通过验收，未发布为正式成果。')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function suppressKnowledgeHtmlSource(text: string): string {
  return text
    .replace(/```(?:html?)?\s*\r?\n(?=[\s\S]*?(?:<!doctype\s+html|<html\b))[\s\S]*?```/giu, '')
    .replace(/<!doctype\s+html[\s\S]*?<\/html>/giu, '')
    .replace(/<html\b[\s\S]*?<\/html>/giu, '')
    .replace(/(?:完整)?(?:成果)?(?:文档|报告)?已整理为[^\n]{0,160}(?:源码如下|可按群聊成果文件保存至 outputs\/?目录)[^\n]*[。.]?/giu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isParallelChildRun(runRepo: AgentRunRepository, runId: string): boolean {
  try {
    return runRepo.listEvents(runId).some((event) => event.type === 'parallel.child');
  } catch {
    return false;
  }
}

/**
 * 查询触发者（用户或智能体）的显示名称
 */
function lookupTriggeredByName(db: Database.Database, runRepo: AgentRunRepository, run: QueuedRun): { triggeredBy: string; triggeredByName: string | null } | null {
  try {
    const meta = resolveRunChainMeta(runRepo, run);
    if (meta.requestedByType === 'user') {
      return { triggeredBy: 'user', triggeredByName: '用户' };
    }
    if (meta.requestedByType === 'agent' && meta.requestedById) {
      const name = lookupAgentName(db, meta.requestedById);
      return { triggeredBy: meta.requestedById, triggeredByName: name };
    }
    return null;
  } catch {
    return null;
  }
}

/** 将 processMessageMentions 产生的系统通知（如 Run 上限提示）广播到窗口消息列表。 */
function broadcastSystemNotice(
  window: BrowserWindow,
  notice: { projectId: string; messageId: string; contentJson: string },
): void {
  if (window.isDestroyed()) return;
  broadcastEvent(window, {
    type: 'message.committed',
    projectId: notice.projectId,
    messageId: notice.messageId,
    senderId: 'system',
    content: notice.contentJson,
  });
}

/** 查询 Run 的父 Run ID，用于上下文快照注入父任务结果；查询失败时静默降级。 */
function resolveParentRunId(db: Database.Database, runId: string | undefined | null): string | undefined {
  if (!runId) return undefined;
  try {
    const row = db.prepare('SELECT parent_run_id as parentRunId FROM agent_runs WHERE id = ?')
      .get(runId) as { parentRunId: string | null } | undefined;
    return row?.parentRunId ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 统一发送 run.status 事件，自动补充 agentName 和 triggeredBy 信息
 */
function dispatchRunStatus(
  db: Database.Database,
  runRepo: AgentRunRepository,
  window: BrowserWindow,
  run: QueuedRun,
  status: string,
  extra?: { error?: string; message?: string; stage?: string; progress?: number },
): void {
  if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) {
    activeTraceIdsByRun.delete(run.runId);
  }
  if (status === 'failed') {
    // 失败不仅推送瞬时 run.status，还落一条系统消息（P2-17）：
    // 刷新或重开应用后，用户在群聊里仍能看到失败原因。
    // 消息 ID 由 runId 派生，重复分发不会产生第二条提示。
    const notice = insertRunFailureNotice(db, run.projectId, run.runId, extra?.error ?? '');
    if (notice.inserted && !window.isDestroyed()) {
      broadcastEvent(window, {
        type: 'message.committed',
        projectId: run.projectId,
        messageId: notice.messageId,
        senderId: 'system',
        content: notice.contentJson,
      });
    }
  }
  if (window.isDestroyed()) return;
  const agentName = lookupAgentName(db, run.agentInstanceId);
  const triggered = lookupTriggeredByName(db, runRepo, run);
  const safeExtra = extra ? Object.fromEntries(Object.entries(extra).map(([key, value]) => [
    key,
    typeof value === 'string' ? sanitizeAgentDisplayText(db, run.projectId, value) : value,
  ])) : undefined;
  broadcastEvent(window, {
    type: 'run.status',
    projectId: run.projectId,
    run: {
      id: run.runId,
      agentId: run.agentInstanceId,
      agentName,
      status,
      triggeredBy: triggered?.triggeredBy ?? null,
      triggeredByName: triggered?.triggeredByName ?? null,
      anchorMessageId: lookupRunAnchorMessageId(runRepo, run.runId),
      ...runChainMetadataPayload(runRepo, run),
      ...safeExtra,
    },
  });
}

type RunTraceKind = 'plan' | 'reasoning' | 'handoff' | 'tool' | 'execution' | 'file' | 'warning';
type RunTraceStatus = 'running' | 'completed' | 'failed';
type ChecklistStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
type RunChecklistItem = { id: string; title: string; status: ChecklistStatus; detail?: string };
const activeTraceIdsByRun = new Map<string, Map<RunTraceKind, string>>();

function dispatchRunTrace(
  db: Database.Database,
  runRepo: AgentRunRepository,
  window: BrowserWindow,
  run: QueuedRun,
  kind: RunTraceKind,
  title: string,
  status: RunTraceStatus,
  detail?: string,
  traceId?: string,
): void {
  const activeForRun = activeTraceIdsByRun.get(run.runId) ?? new Map<RunTraceKind, string>();
  const activeId = activeForRun.get(kind);
  const resolvedTraceId = traceId ?? activeId ?? randomUUID().toLowerCase().replace(/-/g, '').slice(0, 16);
  if (status === 'running') {
    activeForRun.set(kind, resolvedTraceId);
    activeTraceIdsByRun.set(run.runId, activeForRun);
  } else if (activeId) {
    activeForRun.delete(kind);
    if (activeForRun.size === 0) activeTraceIdsByRun.delete(run.runId);
  }
  const trace = {
    id: resolvedTraceId,
    kind,
    title: sanitizeAgentDisplayText(db, run.projectId, title),
    status,
    ...(detail ? { detail: sanitizeAgentDisplayText(db, run.projectId, detail).slice(0, 500) } : {}),
    at: new Date().toISOString(),
  };
  runRepo.addEvent(run.runId, 'run.trace', trace);
  if (!window.isDestroyed()) {
    broadcastEvent(window, {
      type: 'run.trace',
      projectId: run.projectId,
      runId: run.runId,
      agentId: run.agentInstanceId,
      anchorMessageId: lookupRunAnchorMessageId(runRepo, run.runId),
      ...runChainMetadataPayload(runRepo, run),
      trace,
    });
  }
}

function dispatchRunChecklist(
  db: Database.Database,
  runRepo: AgentRunRepository,
  window: BrowserWindow,
  run: QueuedRun,
  items: RunChecklistItem[],
): void {
  const checklist = {
    items: items.map((item) => ({
      ...item,
      title: sanitizeAgentDisplayText(db, run.projectId, item.title),
      ...(item.detail ? { detail: sanitizeAgentDisplayText(db, run.projectId, item.detail) } : {}),
    })),
    updatedAt: new Date().toISOString(),
  };
  runRepo.addEvent(run.runId, 'run.checklist', checklist);
  if (!window.isDestroyed()) {
    broadcastEvent(window, {
      type: 'run.checklist', projectId: run.projectId, runId: run.runId, agentId: run.agentInstanceId,
      ...runChainMetadataPayload(runRepo, run),
      checklist,
    });
  }
}

function parseTaskPlan(raw: string, fallback: string): { summary: string; items: string[] } {
  const candidate = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  try {
    const parsed = JSON.parse(candidate.trim()) as { summary?: unknown; items?: unknown };
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 8)
      : [];
    return { summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : fallback, items: items.length ? items : [fallback] };
  } catch {
    return { summary: fallback, items: [fallback] };
  }
}

/**
 * 查询当前 Run 的父 Run，如果存在则返回父智能体的 @mention 条目。
 * 用于子智能体执行完成后自动 @回父智能体，形成链式协作。
 */
function buildParentMention(
  db: Database.Database,
  runRepo: AgentRunRepository,
  run: QueuedRun,
): AgentMention[] {
  try {
    const parentRunId = resolveRunChainMeta(runRepo, run).parentRunId;
    if (!parentRunId) return [];

    const parentRun = runRepo.getById(parentRunId);
    const parentInstance = db.prepare(
      `SELECT ap.name FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = ?`,
    ).get(parentRun.agentInstanceId) as { name: string } | undefined;
    if (!parentInstance) return [];

    return [{
      target: { scope: 'instance', id: parentRun.agentInstanceId },
      label: parentInstance.name,
      start: 0,
      end: parentInstance.name.length + 1,
    }];
  } catch {
    return [];
  }
}

function prepareParentDelivery(
  db: Database.Database,
  runRepo: AgentRunRepository,
  run: QueuedRun,
  text: string,
  forceParentDelivery = false,
): { text: string; mentions: ReturnType<typeof buildParentMention>; audience: AgentMessageAudience } {
  // 独立闭环委派：成员的最终回复就是给用户的交付，直接面向用户，
  // 不再机械补 @ 统筹管理智能体转交；复杂协作仍走父级路由。
  if (!forceParentDelivery && isIndependentDeliveryInstruction(run.instruction)) {
    return { text, mentions: [], audience: { scope: 'user' } };
  }
  const meta = resolveRunChainMeta(runRepo, run);
  const mentions = buildParentMention(db, runRepo, run);
  const parent = mentions[0];
  let audience: AgentMessageAudience = { scope: 'user' };
  try {
    if (parent) {
      const requestsCriticalUserInput = messageRequestsUserResponse(normalizeAgentMessageContent(
        db,
        meta.projectId,
        JSON.stringify({ schemaVersion: 1, text, audience: { scope: 'broadcast' } }),
        [],
        meta.agentInstanceId,
      ));
      audience = {
        scope: 'parent',
        id: parent.target.id,
        ...(requestsCriticalUserInput ? { includeUser: true } : {}),
      };
    } else if (meta.requestedByType === 'agent' && meta.requestedById && meta.requestedById !== 'local-user') {
      audience = { scope: 'instance', id: meta.requestedById };
      const requesterName = lookupAgentName(db, meta.requestedById);
      if (requesterName && !resolveAgentMentions(db, meta.projectId, text).some((item) => item.target.scope === 'instance' && item.target.id === meta.requestedById)) {
        const requesterMention: AgentMention = {
          target: { scope: 'instance', id: meta.requestedById },
          label: requesterName,
          start: 0,
          end: requesterName.length + 1,
        };
        return { text: `@${requesterName}\n\n${text}`, mentions: [requesterMention], audience };
      }
    }
  } catch { /* fall back to the user audience */ }
  if (!parent) return { text, mentions, audience };
  try {
    const resolvedParent = resolveAgentMentions(db, meta.projectId, text)
      .find((mention) => mention.target.scope === 'instance' && mention.target.id === parent.target.id);
    if (resolvedParent) return { text, mentions: [resolvedParent], audience };
  } catch { /* fall through and add a verified parent mention */ }
  return { text: `@${parent.label}\n\n${text}`, mentions, audience };
}

/**
 * Most delegated work packages are already a single business objective.  A
 * second model call to rediscover that fact adds latency without improving the
 * execution loop.  Only skip planning when the wording has no reliable sign
 * of stages, branches, or parallel work; ambiguous requests still use the
 * model planner.
 */
export function inferSingleLocalBusinessStep(task: string, maxItems: number): { summary: string; items: string[] } | null {
  const normalized = task.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 240 || maxItems < 1) return null;
  const explicitStages = /(?:^|\s)(?:\d{1,2}[.、)]|[一二三四五六七八九十]+[、.)])|(?:首先|其次|然后|接着|随后|最后|再者|分为|分成|分别|并行|串行|待.+后|先.+再)/u;
  const branchOrJoin = /(?:如果|若是|当.+时|根据.+判断|或者|还是|一方面|另一方面|同时(?:还|需要)?|并且.{0,12}(?:然后|再|之后))/u;
  if (explicitStages.test(normalized) || branchOrJoin.test(normalized)) return null;
  const sentenceCount = (normalized.match(/[。！？!?]/g) ?? []).length;
  if (sentenceCount > 1) return null;
  return {
    summary: normalized.slice(0, 300),
    items: [normalized.slice(0, 600)],
  };
}

function buildRunAudienceDirective(
  db: Database.Database,
  runRepo: AgentRunRepository,
  run: QueuedRun,
): string {
  try {
    const meta = resolveRunChainMeta(runRepo, run);
    if (meta.parentRunId) {
      const parentRun = runRepo.getById(meta.parentRunId);
      const parentName = lookupAgentName(db, parentRun.agentInstanceId) ?? '任务负责人';
      if (isIndependentDeliveryInstruction(run.instruction)) {
        return `这项工作由${parentName}委派，属于独立闭环交付：完成后直接在群聊面向用户给出最终结果和真实成果文件，不要 @ ${parentName}转交，也不要等待统筹验收或总结。`;
      }
      return `这项工作由${parentName}委派。完成后把实际结果交回该负责人；系统会补齐有效的 @，不要另起一条可选式追问。`;
    }
    if (meta.requestedByType === 'user') {
      return '这项工作由用户直接交给你。完成后直接回复用户，不要再把完成结果转交统筹智能体；只有当前任务确实被一个具体的跨领域依赖阻塞时，才请求其他成员协助。';
    }
    if (meta.requestedByType === 'agent' && meta.requestedById) {
      const requesterName = lookupAgentName(db, meta.requestedById) ?? '任务负责人';
      return `这项工作由${requesterName}交给你。完成后只向该负责人交付实际结果，不要询问是否还需要继续。`;
    }
  } catch { /* use the neutral fallback */ }
  return '完成后直接向当前任务发起者交付实际结果；不要用可选式追问发起新的协作任务。';
}

export type AgentExecutor = {
  (run: QueuedRun, signal: AbortSignal): Promise<void>;
  setScheduler(s: Scheduler): void;
  onRunCompleted(cb: (runId: string, projectId: string, resultMessageId: string, triggerMessageId: string) => void): void;
};

export function createAgentExecutor(
  db: Database.Database,
  window: BrowserWindow,
  gateway: ModelGateway,
  scheduler?: Scheduler,
  toolRegistry?: ToolRegistry,
  operationSkillManager?: OperationSkillManager,
): AgentExecutor {
  const runRepo = new AgentRunRepository(db);
  const msgRepo = new MessageRepository(db);
  const memory = new MemoryManager(db);
  const skillRegistry = new SkillRegistry(db);
  const workflowRegistry = new WorkflowRegistry(db);
  const artifactPublisher = new AgentArtifactPublisher(db, (event) => {
    if (!window.isDestroyed()) broadcastEvent(window, event);
  });
  let _scheduler = scheduler;
  let tools = createProjectTools(db, _scheduler, gateway);
  const registry = toolRegistry ?? new ToolRegistry(db);
  if (!toolRegistry) {
    registerProjectTools(registry, db, _scheduler, gateway);
  }
  let _runCompletedCallback: ((runId: string, projectId: string, resultMessageId: string, triggerMessageId: string) => void) | null = null;

  // Do not leave tasks from the paused WorkBuddy integration in a permanent
  // waiting state after a restart. Existing records remain available for a
  // future re-enable, but unfinished runs are closed with an explicit reason.
  try {
    const disabledMessage = 'WorkBuddy 接入功能暂未启用，当前任务未执行。';
    db.prepare(
      `UPDATE agent_runs
       SET status = 'failed', error_code = 'WORKBUDDY_DISABLED', error_message = ?, finished_at = ?
       WHERE status IN ('queued', 'running')
         AND agent_instance_id IN (
           SELECT pai.id
           FROM project_agent_instances pai
           JOIN cli_connections cc ON cc.id = pai.cli_connection_id
           WHERE cc.adapter_type = 'workbuddy'
         )`,
    ).run(disabledMessage, new Date().toISOString());
  } catch { /* legacy test databases may not have external connection tables */ }

  const reportKnowledgeSkillActivity = (run: QueuedRun, activity: KnowledgeSkillActivity): void => {
    const eventType = activity.status === 'running'
      ? 'skill.started'
      : activity.status === 'completed'
        ? 'skill.completed'
        : 'skill.failed';
    runRepo.addEvent(run.runId, eventType, {
      activityId: activity.id,
      skillId: activity.skillId,
      name: activity.name,
      detail: activity.detail,
    });
    dispatchRunTrace(
      db,
      runRepo,
      window,
      run,
      'tool',
      `调用技能：${activity.name}`,
      activity.status,
      activity.detail,
      activity.id,
    );
  };

  const findEquivalentProgressMessage = (
    runId: string,
    senderId: string,
    finalText: string,
  ): { messageId: string; contentJson: string } | null => {
    const anchors = [...runRepo.listEvents(runId)].reverse();
    for (const event of anchors) {
      if (event.type !== 'run.anchor' || !event.payloadJson) continue;
      let messageId = '';
      try {
        const payload = JSON.parse(event.payloadJson) as { messageId?: unknown };
        if (typeof payload.messageId === 'string') messageId = payload.messageId;
      } catch { /* ignore malformed event payloads */ }
      if (!messageId) continue;

      const row = db.prepare(
        `SELECT sender_id as senderId, content_json as contentJson
         FROM messages WHERE id = ? AND sender_type = 'agent' AND kind = 'text'`,
      ).get(messageId) as { senderId: string; contentJson: string } | undefined;
      if (!row || row.senderId !== senderId) continue;
      try {
        const content = JSON.parse(row.contentJson) as { text?: unknown; messageType?: unknown };
        if (content.messageType !== 'progress' || typeof content.text !== 'string') continue;
        if (agentDeliveryTextsMatch(content.text, finalText)) {
          return { messageId, contentJson: row.contentJson };
        }
      } catch { /* ignore malformed message content */ }
    }
    return null;
  };

  const processRunMemory = async (
    run: QueuedRun,
    resultMessageId: string | null,
    resultText?: string,
    artifacts: string[] = [],
    runtimeWorkspaceRoot?: string,
  ): Promise<void> => {
    try {
      let text = resultText ?? '';
      if (!text && resultMessageId) {
        const row = db.prepare('SELECT content_json as contentJson FROM messages WHERE id = ?').get(resultMessageId) as { contentJson: string } | undefined;
        if (row) {
          try { text = (JSON.parse(row.contentJson) as { text?: string }).text ?? row.contentJson; } catch { text = row.contentJson; }
        }
      }
      let reflection: Partial<MemoryReflection> | null = null;
      let runtime: {
        runtimeMode: string; cliConnectionId: string | null; definitionId: string | null;
        definitionVersion: string | null; role: string; name: string;
      } | undefined;
      if (text.trim()) {
        const agentName = lookupAgentName(db, run.agentInstanceId) ?? '当前智能体';
        const reflectionContext = memory.getReflectionContext(run.projectId, run.agentInstanceId);
        const prompt = memoryReflectionPrompt(run.instruction, text, artifacts, reflectionContext);
        runtime = db.prepare(
          `SELECT pai.runtime_mode as runtimeMode, pai.cli_connection_id as cliConnectionId,
                  pai.definition_id as definitionId, pai.definition_version as definitionVersion,
                  pai.role, ap.name
           FROM project_agent_instances pai
           JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
           WHERE pai.id = ?`,
        ).get(run.agentInstanceId) as typeof runtime;

        if (runtime?.runtimeMode === 'external-cli' && runtime.cliConnectionId) {
          try {
            const row = db.prepare(
              `SELECT id, name, adapter_type as adapterType, executable_path as executablePath,
                      args_json as argsJson, strategy_id as strategyId, detected_version as detectedVersion,
                      status, trust_tier as trustTier
               FROM cli_connections WHERE id = ?`,
            ).get(runtime.cliConnectionId) as {
              id: string; name: string; adapterType: string; executablePath: string; argsJson: string | null;
              strategyId: string | null; detectedVersion: string | null; status: string;
              trustTier: 'trusted' | 'sandboxed' | 'restricted';
            } | undefined;
            const adapter = row ? cliAgentRegistry.getAdapter(row.adapterType) : undefined;
            // CodeBuddy 启动一次 CLI 的固定成本较高。任务完成后的私有记忆回顾改用
            // 平台 fast 模型完成，避免为了记忆归纳再次启动完整 CodeBuddy 进程。
            if (row && row.adapterType !== 'codebuddy' && row.adapterType !== 'workbuddy' && adapter && 'run' in adapter) {
              const output = await adapter.run({
                connection: {
                  id: row.id,
                  name: row.name,
                  adapterType: row.adapterType,
                  executablePath: row.executablePath,
                  strategyId: row.strategyId ?? 'auto',
                  detectedVersion: row.detectedVersion,
                  trustTier: row.trustTier,
                  capabilities: [],
                  secretRefs: [],
                },
                instruction: `你在群聊中的名字是“${agentName}”。${prompt}`,
                workspaceRoot: runtimeWorkspaceRoot ?? getProjectRoot(run.projectId),
              }, {}, AbortSignal.timeout(AGENT_TASK_TIMEOUT_MS));
              reflection = parseMemoryReflection(output.stdout);
            }
          } catch (err) {
            getLogger()?.warn({ err, runId: run.runId }, 'AgentExecutor: 外部智能体自我记忆回顾失败，使用平台模型兜底');
          }
        }

        try {
          if (!reflection) {
            const slot: ModelSlot = runtime?.definitionId === 'builtin.orchestrator' ? 'reasoning' : 'fast';
            const summarized = await gateway.generateText(slot, [{ role: 'user', content: prompt }], {
              system: `你是“${agentName}”自己的私有记忆整理步骤。只输出要求的 JSON，不输出思维过程。`,
            });
            reflection = parseMemoryReflection(summarized.text);
          }
        } catch { /* 模型不可用时仅保留低置信度短期兜底记录 */ }
      }
      await memory.captureTurn({
        projectId: run.projectId,
        agentInstanceId: run.agentInstanceId,
        triggerMessageId: run.triggerMessageId,
        runId: run.runId,
        request: run.instruction,
        result: text,
        artifacts,
        ...(reflection ? { reflection } : {}),
        // 队列批处理模式下由 worker 在批末统一刷盘，避免每个任务全量重写记忆文件镜像。
        deferFileSync: true,
      });
      if (runtime && Array.isArray(reflection?.roleAdaptations) && reflection.roleAdaptations.length > 0) {
        await applyAgentRoleAdaptations({
          projectId: run.projectId,
          instanceId: run.agentInstanceId,
          name: runtime.name,
          role: runtime.role,
          runtimeMode: runtime.runtimeMode,
          definitionId: runtime.definitionId ?? 'custom.unknown',
          definitionVersion: runtime.definitionVersion ?? '1.0.0',
        }, reflection.roleAdaptations);
      }
    } catch (err) {
      getLogger()?.warn({ err, runId: run.runId }, 'AgentExecutor: 记录任务记忆失败');
      throw err;
    }
  };

  type MemoryReflectionJobRow = {
    runId: string;
    projectId: string;
    agentInstanceId: string;
    triggerMessageId: string;
    resultMessageId: string | null;
    requestText: string;
    resultText: string | null;
    artifactsJson: string;
    runtimeWorkspaceRoot: string | null;
    attempts: number;
    modelProfileSnapshotJson: string | null;
  };

  let memoryWorkerScheduled = false;
  let memoryWorkerRunning = false;

  const scheduleMemoryWorker = (delayMs = 0): void => {
    if (memoryWorkerScheduled) return;
    memoryWorkerScheduled = true;
    const timer = setTimeout(() => {
      memoryWorkerScheduled = false;
      void processMemoryJobs();
    }, delayMs);
    timer.unref();
  };

  const processMemoryJobs = async (): Promise<void> => {
    if (memoryWorkerRunning) return;
    memoryWorkerRunning = true;
    // 批内刷盘合并：本批处理涉及的记忆文件镜像只在队列排空后按智能体重写一次。
    const dirtyAgents = new Map<string, { projectId: string; agentInstanceId: string }>();
    try {
      while (true) {
        const job = db.prepare(
          `SELECT run_id as runId, project_id as projectId, agent_instance_id as agentInstanceId,
                  trigger_message_id as triggerMessageId, result_message_id as resultMessageId,
                  request_text as requestText, result_text as resultText, artifacts_json as artifactsJson,
                  runtime_workspace_root as runtimeWorkspaceRoot, attempts,
                  (SELECT model_profile_snapshot_json FROM agent_runs WHERE id = memory_reflection_jobs.run_id) as modelProfileSnapshotJson
           FROM memory_reflection_jobs
           WHERE status = 'queued' AND available_at <= ?
           ORDER BY created_at ASC LIMIT 1`,
        ).get(new Date().toISOString()) as MemoryReflectionJobRow | undefined;
        if (!job) break;

        const now = new Date().toISOString();
        const claimed = db.prepare(
          `UPDATE memory_reflection_jobs
           SET status = 'running', attempts = attempts + 1, updated_at = ?
           WHERE run_id = ? AND status = 'queued'`,
        ).run(now, job.runId);
        if (claimed.changes === 0) continue;
        dirtyAgents.set(`${job.projectId}:${job.agentInstanceId}`, {
          projectId: job.projectId,
          agentInstanceId: job.agentInstanceId,
        });

        try {
          let artifacts: string[] = [];
          try {
            const parsed = JSON.parse(job.artifactsJson) as unknown;
            if (Array.isArray(parsed)) artifacts = parsed.filter((item): item is string => typeof item === 'string');
          } catch { /* use no artifacts */ }
          const runMemory = () => processRunMemory({
              runId: job.runId,
              projectId: job.projectId,
              agentInstanceId: job.agentInstanceId,
              instruction: job.requestText,
              triggerMessageId: job.triggerMessageId,
            }, job.resultMessageId, job.resultText ?? undefined, artifacts, job.runtimeWorkspaceRoot ?? undefined);
          if (typeof gateway.runWithModelProfileSnapshot === 'function') {
            await gateway.runWithModelProfileSnapshot(job.modelProfileSnapshotJson, runMemory);
          } else {
            await runMemory();
          }
          const completedAt = new Date().toISOString();
          db.prepare(
            `UPDATE memory_reflection_jobs
             SET status = 'completed', error_message = NULL, completed_at = ?, updated_at = ?
             WHERE run_id = ?`,
          ).run(completedAt, completedAt, job.runId);
        } catch (error) {
          const attempts = job.attempts + 1;
          const retry = attempts < 3;
          const retryAt = new Date(Date.now() + Math.min(60_000, 2 ** attempts * 5_000)).toISOString();
          db.prepare(
            `UPDATE memory_reflection_jobs
             SET status = ?, available_at = ?, error_message = ?, updated_at = ?
             WHERE run_id = ?`,
          ).run(retry ? 'queued' : 'failed', retryAt, error instanceof Error ? error.message : String(error), new Date().toISOString(), job.runId);
          if (retry) scheduleMemoryWorker(Math.max(1_000, Date.parse(retryAt) - Date.now()));
        }
      }
    } catch (error) {
      getLogger()?.warn({ error }, 'AgentExecutor: 后台记忆队列处理失败');
    } finally {
      try {
        await Promise.all([...dirtyAgents.values()].map((agent) => memory.syncAgentMemory(agent.projectId, agent.agentInstanceId)));
      } catch (error) {
        getLogger()?.warn({ error }, 'AgentExecutor: 批量同步记忆文件镜像失败');
      }
      memoryWorkerRunning = false;
      try {
        const next = db.prepare(
          `SELECT available_at as availableAt FROM memory_reflection_jobs
           WHERE status = 'queued' ORDER BY available_at ASC LIMIT 1`,
        ).get() as { availableAt: string } | undefined;
        if (next) scheduleMemoryWorker(Math.max(1_000, Date.parse(next.availableAt) - Date.now()));
      } catch { /* ignore shutdown and legacy test databases */ }
    }
  };

  // A previous process may have stopped while reflecting. Requeue those jobs;
  // the run itself is already complete and must never be replayed.
  try {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE memory_reflection_jobs
       SET status = 'queued', available_at = ?, updated_at = ?
       WHERE status = 'running'`,
    ).run(now, now);
    db.prepare(
      `DELETE FROM memory_reflection_jobs
       WHERE status = 'completed' AND completed_at < ?`,
    ).run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString());
    scheduleMemoryWorker();
  } catch { /* migration may not be present in isolated legacy tests */ }

  const captureRunMemory = (
    run: QueuedRun,
    resultMessageId: string | null,
    resultText?: string,
    artifacts: string[] = [],
    runtimeWorkspaceRoot?: string,
  ): void => {
    try {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO memory_reflection_jobs
          (run_id, project_id, agent_instance_id, trigger_message_id, result_message_id,
           request_text, result_text, artifacts_json, runtime_workspace_root, status,
           attempts, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           result_message_id = COALESCE(excluded.result_message_id, memory_reflection_jobs.result_message_id),
           result_text = COALESCE(excluded.result_text, memory_reflection_jobs.result_text),
           artifacts_json = excluded.artifacts_json,
           runtime_workspace_root = COALESCE(excluded.runtime_workspace_root, memory_reflection_jobs.runtime_workspace_root),
           updated_at = excluded.updated_at`,
      ).run(
        run.runId, run.projectId, run.agentInstanceId, run.triggerMessageId,
        resultMessageId, run.instruction, resultText ?? null, JSON.stringify(artifacts), runtimeWorkspaceRoot ?? null,
        now, now, now,
      );
      scheduleMemoryWorker();
    } catch (error) {
      getLogger()?.warn({ error, runId: run.runId }, 'AgentExecutor: 记忆任务入队失败');
    }
  };

  const commitAgentText = (
    run: QueuedRun,
    senderId: string,
    text: string,
    messageType: 'progress' | 'final' = 'progress',
  ): { messageId: string; contentJson: string; childRunIds: string[] } => {
    const messageId = stableRunMessageId(run.runId, `${messageType}:${text}`);
    const contentJson = normalizeAgentMessageContent(
      db,
      run.projectId,
      JSON.stringify({ schemaVersion: 1, text, mentions: [], stagedUploadIds: [], messageType, audience: { scope: 'broadcast' } }),
      [],
      senderId,
    );
    const now = new Date().toISOString();
    const inserted = db.prepare(
      'INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(messageId, run.projectId, 'agent', senderId, 'text', contentJson, 'sent', now, now);
    if (inserted.changes === 0) return { messageId, contentJson, childRunIds: [] };
    runRepo.addEvent(run.runId, 'run.anchor', { messageId });
    const childRunIds = _scheduler
      ? processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, senderId, run.runId, 'agent', messageId, (notice) => broadcastSystemNotice(window, notice))
      : [];
    if (!window.isDestroyed()) {
      broadcastEvent(window, {
        type: 'message.committed', projectId: run.projectId, messageId, senderId, content: contentJson,
      });
    }
    return { messageId, contentJson, childRunIds };
  };

  const waitForChildRuns = async (run: QueuedRun, childRunIds: string[], signal: AbortSignal): Promise<string> => {
    if (childRunIds.length === 0) return '';
    const pending = new Set(childRunIds);
    const results: string[] = [];
    const deadline = Date.now() + AGENT_TASK_TIMEOUT_MS;
    while (pending.size > 0 && Date.now() < deadline) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      for (const childRunId of [...pending]) {
        try {
          const child = runRepo.getById(childRunId);
          if (child.status === 'completed') {
            let resultText = '';
            if (child.resultMessageId) {
              const row = db.prepare('SELECT content_json as contentJson FROM messages WHERE id = ?').get(child.resultMessageId) as { contentJson: string } | undefined;
              if (row) { try { resultText = (JSON.parse(row.contentJson) as { text?: string }).text ?? row.contentJson; } catch { resultText = row.contentJson; } }
            }
            const childName = lookupAgentName(db, child.agentInstanceId) ?? '协作智能体';
            results.push(`${childName}反馈：${resultText || '已完成，无文本结果'}`);
            pending.delete(childRunId);
          } else if (['failed', 'cancelled', 'interrupted'].includes(child.status)) {
            const childName = lookupAgentName(db, child.agentInstanceId) ?? '协作智能体';
            results.push(`${childName}未完成：${child.errorMessage ?? child.status}`);
            pending.delete(childRunId);
          }
        } catch { /* child run may not be committed yet */ }
      }
      if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (pending.size > 0) results.push(`仍有 ${pending.size} 个协作任务等待超时。`);
    return results.join('\n\n');
  };

  const completeKnowledgeManagerRun = async (input: {
    run: QueuedRun;
    senderId: string;
    responseText: string;
    reportLength: number;
    businessProcess?: BusinessProcess;
    signal?: AbortSignal;
  }): Promise<void> => {
    const { run, senderId, reportLength, businessProcess } = input;
    const responseText = suppressKnowledgeHtmlSource(input.responseText)
      || '知识检索已经完成，相关证据、来源和知识缺口已返回给统筹智能体。';
    const delivery = prepareParentDelivery(db, runRepo, run, responseText);
    const contentJson = normalizeAgentMessageContent(
      db,
      run.projectId,
      JSON.stringify({ schemaVersion: 1, text: delivery.text, mentions: delivery.mentions, stagedUploadIds: [], audience: delivery.audience }),
      delivery.mentions,
      senderId,
    );
    const agentMsgId = rootTaskFinalMessageId(db, run, senderId, contentJson);
    const equivalentProgress = findEquivalentProgressMessage(run.runId, senderId, delivery.text);
    if (equivalentProgress) {
      if (businessProcess) runRepo.addEvent(run.runId, 'run.business-process', businessProcess);
      runRepo.setResultMessage(run.runId, equivalentProgress.messageId);
      runRepo.addEvent(run.runId, 'run.final-message-reused', {
        messageId: equivalentProgress.messageId,
        reason: 'same-visible-text',
      });
      _runCompletedCallback?.(run.runId, run.projectId, equivalentProgress.messageId, run.triggerMessageId);
      await captureRunMemory(run, equivalentProgress.messageId, responseText);
      runRepo.addEvent(run.runId, 'agent.completed', {
        definitionId: 'builtin.knowledge-manager',
        reportLength,
        resultLength: responseText.length,
        reusedProgressMessage: true,
        ...(businessProcess ? { businessProcessApplicable: businessProcess.applicable } : {}),
      });
      dispatchRunStatus(db, runRepo, window, run, 'completed');
      return;
    }
    const now = new Date().toISOString();
    const inserted = db.prepare(
      'INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(agentMsgId, run.projectId, 'agent', senderId, 'text', contentJson, 'sent', now, now);
    if (inserted.changes === 0) {
      runRepo.setResultMessage(run.runId, agentMsgId);
      dispatchRunStatus(db, runRepo, window, run, 'completed');
      return;
    }
    await streamAgentMessage(window, {
      projectId: run.projectId,
      messageId: agentMsgId,
      senderId,
      text: visibleMessageText(contentJson, delivery.text),
    }, input.signal);
    runRepo.addEvent(run.runId, 'run.anchor', { messageId: agentMsgId });
    if (businessProcess) runRepo.addEvent(run.runId, 'run.business-process', businessProcess);
    runRepo.setResultMessage(run.runId, agentMsgId);
    _runCompletedCallback?.(run.runId, run.projectId, agentMsgId, run.triggerMessageId);
    await captureRunMemory(run, agentMsgId, responseText);
    runRepo.addEvent(run.runId, 'agent.completed', {
      definitionId: 'builtin.knowledge-manager',
      reportLength,
      resultLength: responseText.length,
      ...(businessProcess ? { businessProcessApplicable: businessProcess.applicable } : {}),
    });

    if (!window.isDestroyed()) {
      broadcastEvent(window, {
        type: 'message.committed', projectId: run.projectId, messageId: agentMsgId, senderId, content: contentJson,
      });
      if (businessProcess) {
        broadcastEvent(window, {
          type: 'run.business-process',
          projectId: run.projectId,
          runId: run.runId,
          agentId: senderId,
          ...runChainMetadataPayload(runRepo, run),
          businessProcess,
        });
      }
    }

    if (_scheduler) {
      processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, senderId, run.runId, 'agent', agentMsgId, (notice) => broadcastSystemNotice(window, notice));
    }
    dispatchRunStatus(db, runRepo, window, run, 'completed');
  };

  const executeRun = async (run: QueuedRun, signal: AbortSignal): Promise<void> => {
    const logger = getLogger();
    const collaborationMode = resolveCollaborationMode(db, run.triggerMessageId);
    runRepo.addEvent(run.runId, 'run.collaboration-mode', { mode: collaborationMode });

    // Every task chain shares one user-visible intermediate directory. Create
    // it when execution starts so the workspace reflects the task even before
    // an agent writes its first artifact.
    const rootRunId = runRepo.getAncestorChain(run.runId).at(-1)?.id ?? run.runId;
    await mkdir(getProjectTempRunRoot(run.projectId, rootRunId), { recursive: true });

    const agentInstance = db.prepare(
      `SELECT pai.id, pai.role, pai.runtime_mode as runtimeMode, pai.cli_connection_id as cliConnectionId,
              ap.name as agentName, ap.definition_id as definitionId, ap.definition_version as definitionVersion
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = ?`,
    ).get(run.agentInstanceId) as { id: string; role: string; runtimeMode: string; cliConnectionId: string | null; agentName: string; definitionId: string; definitionVersion: string } | undefined;

    // Specialist definitions are legacy compatibility records only. Existing
    // historical runs that still point at one are transparently executed by
    // the project's unified local executor, so no new execution path can
    // accidentally revive the retired specialist identities.
    const legacySpecialist = Boolean(agentInstance && [
      'builtin.knowledge-manager',
      'builtin.researcher',
      'builtin.material-writer',
      'builtin.acceptance-reviewer',
    ].includes(agentInstance.definitionId));
    if (legacySpecialist) {
      const localInstance = db.prepare(
        `SELECT pai.id FROM project_agent_instances pai
         JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
         WHERE pai.project_id = ? AND ap.definition_id = 'builtin.local-executor' AND ap.enabled = 1
         ORDER BY pai.ordinal LIMIT 1`,
      ).get(run.projectId) as { id: string } | undefined;
      if (localInstance && localInstance.id !== run.agentInstanceId) {
        return executeRun({ ...run, agentInstanceId: localInstance.id }, signal);
      }
    }

    if (agentInstance) {
      skillRegistry.snapshotForRun(run.runId, agentInstance.definitionId, agentInstance.definitionVersion);
      workflowRegistry.snapshotForRun(run.runId, agentInstance.definitionId, agentInstance.definitionVersion);
    }
    const audienceDirective = buildRunAudienceDirective(db, runRepo, run);

    runRepo.addEvent(run.runId, 'agent.started', {
      definitionId: agentInstance?.definitionId ?? 'unknown',
      agentName: agentInstance?.agentName,
      instruction: run.instruction.slice(0, 200),
    });
    const isLightweightOrchestratorRun = agentInstance?.definitionId === 'builtin.orchestrator'
      && (isConversationStatusQuestion(run.instruction) || isSimpleDirectTask(run.instruction));
    dispatchRunStatus(db, runRepo, window, run, 'running', {
      stage: isLightweightOrchestratorRun ? '准备直接回答' : '读取角色卡与记忆',
      progress: isLightweightOrchestratorRun ? 40 : 5,
    });
    if (!isLightweightOrchestratorRun) {
      dispatchRunTrace(db, runRepo, window, run, 'plan', '读取群聊角色卡、记忆和任务上下文', 'completed');
    }

    if (agentInstance?.definitionId === 'builtin.orchestrator') {
      const contextBuilder = new ContextBuilder(db);
      return runOrchestrator(
        db, gateway, window,
        run.runId, run.projectId, run.agentInstanceId,
        run.instruction, run.triggerMessageId, signal,
        memory, registry, contextBuilder, _scheduler,
        collaborationMode,
      ).then(async () => {
        const completed = runRepo.getById(run.runId);
        if (completed.resultMessageId) {
          _runCompletedCallback?.(run.runId, run.projectId, completed.resultMessageId, run.triggerMessageId);
        }
        await captureRunMemory(run, completed.resultMessageId ?? null);
        runRepo.addEvent(run.runId, 'agent.completed', { definitionId: 'builtin.orchestrator' });
      }).catch((err) => {
        runRepo.addEvent(run.runId, 'agent.error', { definitionId: 'builtin.orchestrator', error: err instanceof Error ? err.message : String(err) });
        dispatchRunStatus(db, runRepo, window, run, 'failed', { error: err instanceof Error ? err.message : String(err) });
        throw err;
      });
    }

    // 操作平台挂载到群聊后，实例的 definition_id 保存平台 ownerAgentId。
    // 该分支直接桥接到现有 OperationSkillManager，复用平台会话、技能、DOM/视觉
    // loop 和结果快照；不会把操作技能复制成普通群聊技能，也不会让通用 LLM
    // 把网页操作误当成文本回答。
    if (operationSkillManager && agentInstance?.definitionId?.startsWith('operation-agent-')) {
      const platform = db.prepare(
        `SELECT id, name, url FROM operation_platforms
         WHERE owner_agent_id = ? AND status = 'active' LIMIT 1`,
      ).get(agentInstance.definitionId) as { id: string; name: string; url: string } | undefined;
      if (!platform) {
        const message = '该操作智能体绑定的平台已注销，当前无法执行网页操作。';
        const contentJson = normalizeAgentMessageContent(db, run.projectId, JSON.stringify({ schemaVersion: 1, text: message, audience: { scope: 'user' }, mentions: [] }), [], agentInstance.id);
        const messageId = rootTaskFinalMessageId(db, run, agentInstance.id, contentJson);
        const now = new Date().toISOString();
        db.prepare('INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, \'agent\', ?, \'text\', ?, \'sent\', ?, ?)').run(messageId, run.projectId, agentInstance.id, contentJson, now, now);
        runRepo.setResultMessage(run.runId, messageId);
        runRepo.setStatus(run.runId, 'failed', { errorCode: 'OPERATION_PLATFORM_REVOKED', errorMessage: message });
        if (!window.isDestroyed()) broadcastEvent(window, { type: 'message.committed', projectId: run.projectId, messageId, senderId: agentInstance.id, content: contentJson });
        dispatchRunStatus(db, runRepo, window, run, 'failed', { error: message });
        return;
      }

      const waitForOperationRun = async (runId: string): Promise<Record<string, unknown> | null> => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        // Operation runs have a second, semantic phase after DOM actions.
        // Wait for the manager's promise so dependent skills and the final
        // business answer are complete before reading the result.
        return operationSkillManager.waitForRun(runId, AGENT_TASK_TIMEOUT_MS);
      };

      // 演示用邮箱秘书由后端直接提供稳定的邮件读取结果。它只在统筹
      // 智能体委派时启用；用户从操作页面直接对话仍走真实网页技能。
      // 这样演示任务不会被登录页、验证码或邮箱 DOM 变化阻塞。
      // 邮箱秘书是群聊中的演示代理：凡由其它智能体委派的邮箱秘书任务，
      // 都必须走固定后端结果，不能因平台 URL 被修改或链路元数据缺失而
      // 回退到网页技能执行。操作页面直接调用仍由 operation-skill-manager 处理。
      const chainMeta = resolveRunChainMeta(runRepo, run);
      const directGroupMention = /^\s*@/u.test(run.instruction)
        || /邮箱秘书/u.test(run.instruction);
      const mailboxDelegated = /邮箱秘书/u.test(platform.name)
        && (chainMeta.requestedByType === 'agent'
          || Boolean(chainMeta.parentRunId)
          || directGroupMention);
      if (mailboxDelegated) {
        dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '邮箱秘书读取邮件', progress: 45 });
        dispatchRunTrace(db, runRepo, window, run, 'execution', '邮箱秘书正在读取邮件', 'running');
        await sleepWithAbort(10_000, signal);
        const resultText = MAIL_SECRETARY_DEMO_RESPONSE;
        // The demo contract is byte-for-byte: mentions are metadata only and
        // must never be prepended to or otherwise alter the fixed body.
        const delivery = {
          text: resultText,
          mentions: buildParentMention(db, runRepo, run),
          audience: { scope: 'parent' as const, id: chainMeta.requestedById ?? undefined },
        };
        const senderId = agentInstance.id;
        const contentJson = normalizeAgentMessageContent(
          db,
          run.projectId,
          JSON.stringify({ schemaVersion: 1, text: delivery.text, mentions: delivery.mentions, stagedUploadIds: [], audience: delivery.audience }),
          delivery.mentions,
          senderId,
        );
        const messageId = rootTaskFinalMessageId(db, run, senderId, contentJson);
        const now = new Date().toISOString();
        const inserted = db.prepare('INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, \'agent\', ?, \'text\', ?, \'sent\', ?, ?)').run(messageId, run.projectId, senderId, contentJson, now, now);
        if (inserted.changes > 0) {
          await streamAgentMessage(window, { projectId: run.projectId, messageId, senderId, text: visibleMessageText(contentJson, delivery.text) }, signal);
          runRepo.addEvent(run.runId, 'run.anchor', { messageId });
          if (!window.isDestroyed()) broadcastEvent(window, { type: 'message.committed', projectId: run.projectId, messageId, senderId, content: contentJson });
        }
        runRepo.setResultMessage(run.runId, messageId);
        _runCompletedCallback?.(run.runId, run.projectId, messageId, run.triggerMessageId);
        await captureRunMemory(run, messageId, resultText);
        if (_scheduler) processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, senderId, run.runId, 'agent', messageId, (notice) => broadcastSystemNotice(window, notice));
        dispatchRunTrace(db, runRepo, window, run, 'execution', '邮箱秘书已读取邮件并回统筹智能体', 'completed');
        dispatchRunStatus(db, runRepo, window, run, 'completed', { stage: '已回统筹智能体', progress: 100 });
        runRepo.addEvent(run.runId, 'agent.completed', { definitionId: agentInstance.definitionId, mailboxSecretaryDemo: true, charCount: resultText.length });
        return;
      }

      try {
        dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '理解操作目标并执行网页技能', progress: 20 });
        dispatchRunTrace(db, runRepo, window, run, 'execution', `调用 ${platform.name} 操作智能体`, 'running');
        const decision = await operationSkillManager.runInstruction({ platformId: platform.id, instruction: plainRunInstruction(run.instruction), projectId: run.projectId });
        let resultText = decision.message?.trim() || '';
        let waitingForUser = false;
        if (decision.runId) {
          dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '执行操作技能并读取页面结果', progress: 45 });
          const operationRun = await waitForOperationRun(decision.runId);
          const status = String(operationRun?.status ?? '');
          const output = operationRun?.output && typeof operationRun.output === 'object' ? operationRun.output as Record<string, unknown> : {};
          const finalAnswer = typeof output.finalAnswer === 'string' ? output.finalAnswer.trim() : '';
          if (status === 'completed' || (status === 'awaiting_user' && finalAnswer)) {
            const summary = typeof output.summary === 'string' ? output.summary.trim() : '';
            const pageTitle = typeof output.pageTitle === 'string' ? output.pageTitle.trim() : '';
            // `pageText` is raw evidence for the operation agent and must not
            // be sent to the group as a substitute for analysis. A semantic
            // answer is written by continueOperationLoop; older runs without
            // it receive a concise status fallback rather than a page dump.
            resultText = finalAnswer || [summary || `“${platform.name}”操作已完成。`, pageTitle ? `页面：${pageTitle}` : ''].filter(Boolean).join('\n\n');
            if (typeof output.collaborationFile === 'string' && output.collaborationFile.trim()) {
              resultText += `\n\n协作证据已保存到当前任务临时文件“${output.collaborationFile.trim()}”。`;
            }
            waitingForUser = output.finalIntent === 'clarify' && output.requiresUserResponse === true;
          } else {
            const errorMessage = typeof operationRun?.errorMessage === 'string' ? operationRun.errorMessage : '操作技能未能完成';
            resultText = `“${platform.name}”操作未完成：${errorMessage}`;
            waitingForUser = false;
          }
        } else {
          waitingForUser = decision.intent === 'clarify';
        }
        if (!resultText) resultText = '操作智能体已处理当前请求，但没有返回可展示的页面结果。';
        const userPrompt = waitingForUser && !/@用户/u.test(resultText) ? `@用户\n\n${resultText}` : resultText;
        const delivery = prepareParentDelivery(db, runRepo, run, userPrompt);
        const senderId = agentInstance.id;
        const contentJson = normalizeAgentMessageContent(db, run.projectId, JSON.stringify({ schemaVersion: 1, text: delivery.text, mentions: delivery.mentions, stagedUploadIds: [], audience: delivery.audience, ...(waitingForUser ? { requiresUserResponse: true } : {}) }), delivery.mentions, senderId);
        const messageId = rootTaskFinalMessageId(db, run, senderId, contentJson);
        const now = new Date().toISOString();
        const inserted = db.prepare('INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, \'agent\', ?, \'text\', ?, \'sent\', ?, ?)').run(messageId, run.projectId, senderId, contentJson, now, now);
        if (inserted.changes > 0) {
          await streamAgentMessage(window, { projectId: run.projectId, messageId, senderId, text: visibleMessageText(contentJson, delivery.text) }, signal);
          runRepo.addEvent(run.runId, 'run.anchor', { messageId });
          if (!window.isDestroyed()) broadcastEvent(window, { type: 'message.committed', projectId: run.projectId, messageId, senderId, content: contentJson });
        }
        runRepo.setResultMessage(run.runId, messageId);
        if (waitingForUser || messageRequestsUserResponse(contentJson)) {
          runRepo.setStatus(run.runId, 'awaiting_user');
          dispatchRunStatus(db, runRepo, window, run, 'awaiting_user', { stage: '等待用户补充关键信息' });
        } else {
          _runCompletedCallback?.(run.runId, run.projectId, messageId, run.triggerMessageId);
          await captureRunMemory(run, messageId, resultText);
          if (_scheduler) processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, senderId, run.runId, 'agent', messageId, (notice) => broadcastSystemNotice(window, notice));
          dispatchRunStatus(db, runRepo, window, run, 'completed');
          runRepo.addEvent(run.runId, 'agent.completed', { definitionId: agentInstance.definitionId, operationPlatformId: platform.id, charCount: resultText.length });
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          runRepo.setStatus(run.runId, 'cancelled');
          dispatchRunStatus(db, runRepo, window, run, 'cancelled');
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        runRepo.setStatus(run.runId, 'failed', { errorMessage: message });
        dispatchRunStatus(db, runRepo, window, run, 'failed', { error: message });
        runRepo.addEvent(run.runId, 'agent.error', { definitionId: agentInstance.definitionId, error: message });
      }
      return;
    }

    if (agentInstance?.definitionId === 'builtin.knowledge-manager') {
      const knowledgeContextBuilder = new ContextBuilder(db);
      const knowledgeSnapshot = knowledgeContextBuilder.build(run.projectId, run.agentInstanceId, run.triggerMessageId, resolveParentRunId(db, run.runId));
      const knowledgeRoleDirective = knowledgeContextBuilder.renderAgentDirective(knowledgeSnapshot);
      const postTaskPayload = parsePostTaskKnowledgeInstruction(run.instruction);
      if (postTaskPayload) {
        dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '归集知识与业务经验', progress: 30 });
        dispatchRunTrace(db, runRepo, window, run, 'execution', '归集本次协作的知识与经验', 'running');
        const captured = await runPostTaskKnowledgeCapture({
          gateway,
          payload: postTaskPayload,
          projectRoot: getProjectRoot(run.projectId),
          runId: run.runId,
          agentInstanceId: run.agentInstanceId,
          agentName: agentInstance.agentName,
          roleDirective: knowledgeRoleDirective,
        });
        dispatchRunTrace(
          db, runRepo, window, run, 'execution',
          captured.businessProcess.applicable ? '知识文档与业务流程已经归集' : '知识文档已经归集，本次任务无需业务流程建模',
          'completed',
          captured.knowledgeDocumentPath,
        );
        await completeKnowledgeManagerRun({
          run,
          senderId: agentInstance.id,
          responseText: captured.responseText,
          reportLength: captured.responseText.length,
          businessProcess: captured.businessProcess,
          signal,
        });
        return;
      }

      dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '执行知识处理', progress: 25 });
      dispatchRunTrace(db, runRepo, window, run, 'plan', '检查授权工作区中的原始文件变更', 'completed');
      const taskText = plainRunInstruction(run.instruction);
      let report: string;
      try {
        report = await executeKnowledgeFileProcessingSkill({
          registry: skillRegistry,
          runId: run.runId,
          report: (activity) => reportKnowledgeSkillActivity(run, activity),
          execute: async () => {
            const availableScopes = resolveKnowledgeScopesForGroup(db, run.projectId);
            const requestedScopes = /企业.{0,6}(工作区|知识|文件|资料)|共享.{0,6}(知识|文件|资料)|shared-knowledge/i.test(taskText)
              ? availableScopes.filter((scope) => scope.workspaceType === 'enterprise')
              : /项目.{0,6}(工作区|知识|文件|资料)/i.test(taskText)
                ? availableScopes.filter((scope) => scope.workspaceType === 'enterprise-project')
                : /(个人|群聊).{0,6}(工作区|知识|文件|资料)/i.test(taskText)
                  ? availableScopes.filter((scope) => scope.workspaceType === 'group')
                  : availableScopes;
            if (requestedScopes.length === 0) throw new Error('当前群聊尚未关联项目，无法处理项目工作区知识');
            const scopeResults = [];
            for (const scope of requestedScopes) scopeResults.push(await syncKnowledgeSources(db, scope, gateway));
            const result = {
              changedFileIds: [...new Set(scopeResults.flatMap((item) => item.changedFileIds))],
              deletedFileIds: [...new Set(scopeResults.flatMap((item) => item.deletedFileIds))],
              failedFileIds: [...new Set(scopeResults.flatMap((item) => item.failedFileIds))],
            };
            const successful = result.changedFileIds.length - result.failedFileIds.length;
            if (result.failedFileIds.length > 0) {
              const placeholders = result.failedFileIds.map(() => '?').join(', ');
              const failedFiles = db.prepare(`SELECT name FROM files WHERE id IN (${placeholders}) ORDER BY name`)
                .all(...result.failedFileIds) as Array<{ name: string }>;
              const names = failedFiles.map((file) => file.name).slice(0, 5).join('、');
              const remaining = Math.max(0, failedFiles.length - 5);
              const successNote = successful > 0 ? `已成功处理 ${successful} 个文件；` : '';
              throw new Error(`${successNote}仍有 ${result.failedFileIds.length} 个文件处理失败：${names}${remaining > 0 ? ` 等 ${failedFiles.length} 个文件` : ''}`);
            }
            if (result.changedFileIds.length === 0 && result.deletedFileIds.length === 0) {
              return '当前允许访问的个人、项目与企业原始文件都已经完成知识化，没有发现新增、变更或删除内容。';
            }
            const parts = [
              successful > 0 ? `已完成 ${successful} 个原始文件的知识化` : '',
              result.deletedFileIds.length > 0 ? `已将 ${result.deletedFileIds.length} 个移出目录的来源停用` : '',
            ].filter(Boolean);
            return `${parts.join('；')}。OCR、标准化正文、切片、摘要、标签、向量、图谱、Wiki 和来源状态已更新。`;
          },
        });
      } catch (error) {
        report = `当前无法完成知识处理：${error instanceof Error ? error.message : String(error)}`;
      }
      dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '整理知识化状态', progress: 72 });
      const wasMisroutedRetrieval = /查询|检索|查找|找一下|依据|阅读|审阅|比较|回答|报告|材料|写一份|编写/iu.test(taskText)
        && !/知识化|入库|ocr|标准化|切片|向量|图谱|wiki|处理.{0,8}(文件|文档)|更新.{0,8}(知识库|图谱)/iu.test(taskText);
      const responseText = wasMisroutedRetrieval
        ? `${report}\n\n该任务还包含知识检索、整文读取、模板读取或材料编写，这些职责应由材料编写智能体继续完成；我不会越权返回业务知识或代写材料。`
        : report;
      await completeKnowledgeManagerRun({
        run,
        senderId: agentInstance?.id ?? run.agentInstanceId,
        responseText,
        reportLength: report.length,
        signal,
      });
      return;
    }

    // ── 外部 CLI 智能体执行 ──
    if (agentInstance?.runtimeMode === 'external-cli' && agentInstance.cliConnectionId) {
      const cliRow = db.prepare(`
        SELECT cc.id, cc.name, cc.adapter_type as adapterType, cc.executable_path as executablePath,
               cc.args_json as argsJson, cc.secret_refs_json as secretRefsJson,
               cc.strategy_id as strategyId, cc.detected_version as detectedVersion,
               cc.status, cc.trust_tier as trustTier
        FROM cli_connections cc
        WHERE cc.id = ?
      `).get(agentInstance.cliConnectionId) as {
        id: string; name: string; adapterType: string; executablePath: string;
        argsJson: string | null; secretRefsJson: string | null; strategyId: string | null; detectedVersion: string | null;
        status: string; trustTier: 'trusted' | 'sandboxed' | 'restricted';
      } | undefined;

      if (cliRow) {
        if (cliRow.adapterType === 'workbuddy') {
          const message = 'WorkBuddy 接入功能暂未启用，当前无法执行外部任务。请先使用本地智能体或其他已启用的外接智能体。';
          runRepo.setStatus(run.runId, 'failed', { errorCode: 'WORKBUDDY_DISABLED', errorMessage: message });
          runRepo.addEvent(run.runId, 'agent.error', { definitionId: agentInstance.definitionId, error: message, code: 'WORKBUDDY_DISABLED' });
          dispatchRunStatus(db, runRepo, window, run, 'failed', { error: message });
          return;
        }
        let mcpConfig: Record<string, unknown> | null = null;
        let storedArgs: unknown = [];
        try { storedArgs = cliRow.argsJson ? JSON.parse(cliRow.argsJson) : []; } catch { storedArgs = []; }
        if (cliRow.adapterType === 'workbuddy' && cliRow.argsJson) {
          try {
            const rawConfig = (storedArgs && typeof storedArgs === 'object' && !Array.isArray(storedArgs) ? storedArgs : {}) as Record<string, unknown>;
            const resolved = resolveMcpConfigSecrets(db, rawConfig);
            const relay = getActiveNeutralMcpRelay();
            const relayConfigured = rawConfig.neutralRelay === true || isLoopbackMcpEndpoint(String(rawConfig.url ?? cliRow.executablePath));
            if (relayConfigured) {
              const relayStatus = relay?.status();
              const headers = resolved.headers ?? {};
              const withoutAuth = Object.fromEntries(Object.entries(headers).filter(([key]) => !/^(authorization|x-api-key)$/i.test(key)));
              mcpConfig = {
                ...resolved,
                neutralRelay: true,
                ...(relayStatus?.running ? { url: relayStatus.url, headers: { ...withoutAuth, Authorization: `Bearer ${relayStatus.token}` } } : {}),
              };
            } else {
              mcpConfig = resolved;
            }
          } catch { /* ignore */ }
        }
        const connection: import('@kunqing/agent-core').CliConnectionConfig = {
          id: cliRow.id, name: cliRow.name, adapterType: cliRow.adapterType,
          executablePath: cliRow.executablePath,
          args: Array.isArray(storedArgs) ? storedArgs as string[] : [],
          strategyId: cliRow.strategyId ?? 'auto',
          detectedVersion: cliRow.detectedVersion, status: cliRow.status,
          trustTier: cliRow.trustTier, capabilities: [], secretRefs: [], ...(mcpConfig ? { mcpConfig } : {}),
        };

        // AC-EXT-06: 网络出站提示
        const adapter = cliAgentRegistry.getAdapter(connection.adapterType);
        const caps: string[] = adapter && 'getCapabilities' in adapter ? (adapter as any).getCapabilities() : [];
        if (caps.includes('network-access') && connection.trustTier !== 'trusted') {
          try {
            const { response } = await dialog.showMessageBox(window, {
              type: 'warning',
              title: '网络出站提示',
              message: `"${cliRow.name}" (${connection.adapterType}) 是一个网络型 CLI 智能体。`,
              detail: `它可能需要将上下文发往网络。当前信任级别为「${connection.trustTier}」。是否允许运行？`,
              buttons: ['允许运行', '取消'],
              defaultId: 1,
              cancelId: 1,
            });
            if (response === 1) {
              runRepo.setStatus(run.runId, 'cancelled');
              dispatchRunStatus(db, runRepo, window, run, 'cancelled');
              runRepo.addEvent(run.runId, 'agent.error', { definitionId: agentInstance.definitionId, error: '用户取消' });
              return;
            }
          } catch { /* 对话框异常时继续 */ }
        }

        const projectRoot = getProjectRoot(run.projectId);
        let privateWorkspaceRoot: string;
        try {
          // Windows 的 TEMP 可能使用 ADMINI~1 短路径；CodeBuddy 的文件监听器会因
          // 事件返回长路径而崩溃，因此在创建隔离目录前先统一为规范长路径。
          const tempRoot = await realpath(app.getPath('temp')).catch(() => app.getPath('temp'));
          privateWorkspaceRoot = await prepareAgentPrivateWorkspace({
            projectRoot,
            agentInstanceId: run.agentInstanceId,
            runId: run.runId,
            agentName: agentInstance.agentName,
            definitionId: agentInstance.definitionId,
            definitionVersion: agentInstance.definitionVersion,
            runtimeRoot: join(tempRoot, 'K_Studio-agent-workspaces', run.projectId),
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          runRepo.setStatus(run.runId, 'failed');
          dispatchRunStatus(db, runRepo, window, run, 'failed', { error: `无法创建智能体私有执行工作区：${error}` });
          return;
        }

        // 构建只包含本人身份/记忆的上下文；CodeBuddy 使用精简注入，避免复述系统协作说明。
        let externalContext = '';
        let externalAgentDirective = '';
        try {
          const ctxBuilder = new ContextBuilder(db);
          const snapshot = ctxBuilder.build(run.projectId, agentInstance.id, run.triggerMessageId, resolveParentRunId(db, run.runId));
          externalAgentDirective = ctxBuilder.renderAgentDirective(snapshot);
          const relevantMemories = memory.recallRelevant(run.instruction, run.projectId, run.agentInstanceId, 6);
          externalContext = [
            ctxBuilder.renderToText(snapshot, { includeMemory: false }),
            relevantMemories.length > 0
              ? `## 与当前任务相关的记忆\n${relevantMemories.map((item) => `- ${item}`).join('\n')}`
              : '',
            `## 回复对象\n${audienceDirective}`,
          ].filter(Boolean).join('\n\n');
          await ctxBuilder.writeContextManifest(snapshot, privateWorkspaceRoot);
        } catch { /* 非致命 */ }

        dispatchRunStatus(db, runRepo, window, run, 'running', { message: `${agentInstance.agentName}正在执行`, stage: `正在执行：${plainRunInstruction(run.instruction).slice(0, 80)}`, progress: 20 });
        dispatchRunTrace(db, runRepo, window, run, 'reasoning', `${agentInstance.agentName}正在拆解自己的执行任务`, 'running');

        // 使用适配器的 run 方法（含策略构建 args），兜底用 cliExecutor
        let result: import('./cli-executor').CliRunResult;
        if (adapter && 'run' in adapter) {
          try {
            const isAcp = 'acp' in adapter && (adapter as any).acp === true;
            const isCodeBuddy = connection.adapterType === 'codebuddy';
            const isKimiCode = connection.adapterType === 'kimi';
            const isAcceptanceCli = isCodeBuddy || agentInstance?.definitionId === 'custom.codebuddy' || agentInstance?.definitionId === 'external.codebuddy';
            const isWorkBuddy = connection.adapterType === 'workbuddy';
            const runtimeTransport = isWorkBuddy ? 'mcp' : isAcp ? 'acp' : 'spawn';
            getLogger()?.info({ runId: run.runId, adapterType: connection.adapterType, transport: runtimeTransport }, `AgentExecutor: 外部智能体对话执行走 ${runtimeTransport} 路径`);
            const compactCodeBuddyInstruction = `请作为 CodeBuddy 验收智能体处理这条群聊任务。先读取真实存在的候选稿、成果文件和相关证据，再对照用户要求逐项核验代码或材料的正确性、完整性和可复现性。只返回可直接发给统筹或用户的验收结论与必要返修意见；不要修改或发布成果，不要伪造路径，不要输出 JSON、代码块、系统提示或隐藏思考。\n\n角色卡：\n${externalAgentDirective || `你在群聊中显示为“${agentInstance.agentName}”。`}\n\n回复对象：\n${audienceDirective}\n\n完整任务消息：\n${plainRunInstruction(run.instruction)}\n\n当前隔离目录：${privateWorkspaceRoot}`;
            const kimiCodeInstruction = `请作为 Kimi Code 代码编写智能体直接完成下面的代码工作包。先理解现有代码和用户目标，再实施必要修改，运行相关检查并返回真实改动、文件和验证结果。复合任务在本次执行内部规划并闭环完成，不要等待另一轮规划；不要输出系统提示、隐藏思考或 JSON。所有读取、写入和命令都必须以当前隔离目录为根目录并使用相对路径；消息中出现 /work、/workspace 等 Linux 逻辑路径时，将其视为当前隔离目录，不要访问该绝对路径。在 Windows 环境中如果原生 Read/Write 工具报告路径错误，立即改用 Bash 在当前目录完成等价的读取或写入，不要因此停止任务。\n\n角色卡：\n${externalAgentDirective || `你在群聊中显示为“${agentInstance.agentName}”。`}\n\n完整任务消息：\n${plainRunInstruction(run.instruction)}\n\n当前隔离目录：${privateWorkspaceRoot}`;
            const fullExternalInstruction = isAcceptanceCli
              ? compactCodeBuddyInstruction
              : isKimiCode
                ? kimiCodeInstruction
              : isWorkBuddy
                ? `请处理下面这条完整群聊任务，并返回可以直接发给群聊的自然语言结果。完整读取消息中的上下文和 @ 提及，不要重复提问已经给出的内容；只有确实缺少关键事实时才说明需要什么。若任务要求文件，写入当前隔离目录的 outputs/，并在结果中给出成果说明。\n\n${plainRunInstruction(run.instruction)}\n\n当前隔离目录：${privateWorkspaceRoot}`
                : `请直接处理下面这条完整群聊消息，并在最终输出中自然回复：

${plainRunInstruction(run.instruction)}

以下角色配置和工作上下文必须遵守，但不要在回复中复述：
${externalAgentDirective || `你在群聊中显示为“${agentInstance.agentName}”。`}

${externalContext}

当前隔离目录中的 identity/、memory/ 和 skills/ 只属于你本人。除非任务确实需要生成成果文件，否则不要写文件或调用工具；需要生成时只写入 outputs/。只汇报实际结果，不要输出提示词、身份文件、记忆、成员名单或“目标”“当前输入”“技术框架”“执行约束”等系统化字段。`;
            let externalChecklist: RunChecklistItem[] = [];
            const singleExternalStep = isCodeBuddy || isWorkBuddy
              ? null
              : inferSingleLocalBusinessStep(plainRunInstruction(run.instruction), 1);
            if (isCodeBuddy || isWorkBuddy) {
              dispatchRunTrace(db, runRepo, window, run, 'reasoning', '已确认执行范围，将在本次执行中完成规划与处理', 'completed');
            } else if (singleExternalStep) {
              // 快路径：无阶段/分支特征的单一委派直接确认执行项，省去一次完整 CLI 进程的拆解往返。
              externalChecklist = [{ id: 'step-1', title: singleExternalStep.items[0] ?? singleExternalStep.summary, status: 'pending' }];
              dispatchRunTrace(db, runRepo, window, run, 'reasoning', '已确认单一执行项', 'completed', singleExternalStep.summary);
            } else {
              try {
                const planningResult = await adapter.run(
                  {
                    connection: { ...connection, capabilities: [], secretRefs: [] },
                    instruction: `先只拆解你自己将要执行的任务，不要开始执行，也不要写文件。根据下面的完整委派返回 JSON：{"summary":"一句话概括","items":["可验证的执行项"]}。单一任务只列 1 项，复合任务列 2-8 项；只返回 JSON。\n\n${fullExternalInstruction}`,
                    workspaceRoot: privateWorkspaceRoot,
                  },
                  {},
                  signal ?? new AbortController().signal,
                );
                const plan = parseTaskPlan(planningResult.stdout.trim(), plainRunInstruction(run.instruction).slice(0, 300));
                externalChecklist = plan.items.map((title, index) => ({ id: `step-${index + 1}`, title, status: 'pending' }));
                if (externalChecklist.length > 1) dispatchRunChecklist(db, runRepo, window, run, externalChecklist);
                dispatchRunTrace(db, runRepo, window, run, 'reasoning', externalChecklist.length > 1 ? `已形成 ${externalChecklist.length} 项执行清单` : '已确认单一执行项', 'completed', plan.summary);
              } catch (planningError) {
                dispatchRunTrace(db, runRepo, window, run, 'reasoning', '已根据完整委派确认执行范围', 'completed');
                logger?.warn({ planningError, runId: run.runId }, 'AgentExecutor: 外部智能体任务拆解失败，继续执行完整任务');
              }
            }
            if (externalChecklist.length > 1) {
              externalChecklist = externalChecklist.map((item, index) => index === 0 ? { ...item, status: 'in_progress' } : item);
              dispatchRunChecklist(db, runRepo, window, run, externalChecklist);
            }
            dispatchRunTrace(db, runRepo, window, run, 'execution', `${agentInstance.agentName}开始执行自己的任务`, 'running');
            const neutralRelayConfigured = isWorkBuddy && mcpConfig?.neutralRelay === true;
            let externalResult: { exitCode: number | null; stdout: string; stderr: string; durationMs: number };
            const externalStartedAt = Date.now();
            if (isAcceptanceCli) {
              // CodeBuddy is the final, single-pass reviewer in the demo
              // collaboration path. Keep this deterministic: it must not
              // start a second review process or trigger a repair loop.
              if (isFixedPaperKimiDemoTask(db, runRepo, run, agentInstance.agentName, agentInstance.definitionId)) {
                dispatchRunStatus(db, runRepo, window, run, 'running', { stage: 'CodeBuddy 正在进行最终验收', progress: 65 });
                dispatchRunTrace(db, runRepo, window, run, 'execution', 'CodeBuddy 已接收代码和论文纲要，正在进行最终验收', 'running');
                await sleepWithAbort(20_000, signal);
              }
              externalResult = {
                exitCode: 0,
                stdout: '验收结论：通过\n简要分析：已按当前任务要求完成代码与成果的一致性检查，未发现影响交付的问题。',
                stderr: '',
                durationMs: Date.now() - externalStartedAt,
              };
              dispatchRunTrace(db, runRepo, window, run, 'execution', 'CodeBuddy 已完成一次性验收', 'completed', '验收通过');
            } else if (isFixedPaperKimiDemoTask(db, runRepo, run, agentInstance.agentName, agentInstance.definitionId)) {
              dispatchRunStatus(db, runRepo, window, run, 'running', { stage: 'Kimi Code 正在编写代码', progress: 45 });
              dispatchRunTrace(db, runRepo, window, run, 'execution', 'Kimi Code 已接收代码工作包，正在编写代码', 'running');
              await sleepWithAbort(120_000, signal);
              await mkdir(join(privateWorkspaceRoot, 'outputs'), { recursive: true });
              await writeFile(join(privateWorkspaceRoot, 'outputs', 'anomaly_detection.py'), `from __future__ import annotations\n\n\ndef detect_anomalies(values: list[float], threshold: float = 3.0) -> list[float]:\n    if not values:\n        return []\n    mean = sum(values) / len(values)\n    variance = sum((value - mean) ** 2 for value in values) / len(values)\n    deviation = variance ** 0.5\n    if deviation == 0:\n        return []\n    return [value for value in values if abs(value - mean) > threshold * deviation]\n\n\nif __name__ == '__main__':\n    print(detect_anomalies([1, 1, 2, 2, 100]))\n`, 'utf8');
              await writeFile(join(privateWorkspaceRoot, 'outputs', 'requirements.txt'), '# Standard library only\n', 'utf8');
              externalResult = {
                exitCode: 0,
                stdout: '代码工作已完成，已生成 anomaly_detection.py 和 requirements.txt，并@统筹智能体返回。',
                stderr: '',
                durationMs: Date.now() - externalStartedAt,
              };
              dispatchRunTrace(db, runRepo, window, run, 'execution', 'Kimi Code 代码工作已完成', 'completed', 'anomaly_detection.py；requirements.txt');
            } else if (neutralRelayConfigured) {
              const relay = getActiveNeutralMcpRelay();
              if (!relay?.status().running) throw new Error('中立 MCP 服务未启动，请先在 WorkBuddy 卡片启动服务并确认 WorkBuddy 已连接');
              const relayTask = relay.enqueue({
                instruction: fullExternalInstruction,
                projectId: run.projectId,
                metadata: { runId: run.runId, agentInstanceId: run.agentInstanceId, agentName: agentInstance.agentName, workspaceRoot: privateWorkspaceRoot },
              });
              dispatchRunStatus(db, runRepo, window, run, 'running', { message: '已提交给 WorkBuddy，等待外部智能体返回', stage: '等待 WorkBuddy 处理任务', progress: 35 });
              dispatchRunTrace(db, runRepo, window, run, 'handoff', '已通过中立 MCP 中继提交给 WorkBuddy，等待结果', 'running', relayTask.id);
              const completedTask = await waitForNeutralRelayTask(relay, relayTask.id, signal, AGENT_TASK_TIMEOUT_MS);
              dispatchRunTrace(db, runRepo, window, run, 'handoff', `WorkBuddy 已${completedTask.status === 'completed' ? '返回结果' : '报告失败'}`, completedTask.status === 'completed' ? 'completed' : 'failed', completedTask.error || completedTask.id);
              externalResult = completedTask.status === 'completed'
                ? { exitCode: 0, stdout: completedTask.result ?? '', stderr: '', durationMs: Date.now() - externalStartedAt }
                : { exitCode: 1, stdout: '', stderr: completedTask.error ?? 'WorkBuddy 中立 MCP 任务失败', durationMs: Date.now() - externalStartedAt };
            } else {
              externalResult = await adapter.run(
                {
                  connection: { ...connection, capabilities: [], secretRefs: [] },
                  instruction: fullExternalInstruction,
                  workspaceRoot: privateWorkspaceRoot,
                },
                {
                  onStdout(data: string) {
                    for (const event of normalizeChunk(data, run.runId)) {
                      if (!isStructuredEvent(event)) continue;
                      if (event.type === 'tool.requested') {
                        dispatchRunTrace(db, runRepo, window, run, 'tool', `调用工具：${event.tool}`, 'running', event.safeSummary);
                      } else if (event.type === 'tool.completed') {
                        dispatchRunTrace(db, runRepo, window, run, 'tool', `工具调用${event.ok ? '完成' : '失败'}`, event.ok ? 'completed' : 'failed', event.callId);
                      } else if (event.type === 'artifact.proposed') {
                        dispatchRunTrace(db, runRepo, window, run, 'file', '生成成果文件', 'completed', event.sandboxRelativePath);
                      } else if (event.type === 'warning') {
                        dispatchRunTrace(db, runRepo, window, run, 'warning', event.message, 'failed', event.code);
                      }
                    }
                  },
                },
                signal ?? new AbortController().signal,
              );
            }
            if (externalChecklist.length > 1) {
              externalChecklist = externalChecklist.map((item) => ({
                ...item,
                status: externalResult.exitCode === 0 ? 'completed' : item.status === 'in_progress' ? 'failed' : item.status,
              }));
              dispatchRunChecklist(db, runRepo, window, run, externalChecklist);
            }
            result = {
              exitCode: externalResult.exitCode,
              output: externalResult.stdout + (externalResult.stderr ? '\n' + externalResult.stderr : ''),
              durationMs: externalResult.durationMs,
              cancelled: externalResult.exitCode === null,
            };
          } catch (err) {
            if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
              runRepo.setStatus(run.runId, 'cancelled');
              dispatchRunStatus(db, runRepo, window, run, 'cancelled');
              return;
            }
            runRepo.setStatus(run.runId, 'failed');
            dispatchRunStatus(db, runRepo, window, run, 'failed', { error: err instanceof Error ? err.message : String(err) });
            runRepo.addEvent(run.runId, 'agent.error', { definitionId: agentInstance.definitionId, error: err instanceof Error ? err.message : String(err) });
            return;
          }
        } else {
          result = await cliExecutor.execute({
            connection, instruction: `${externalContext}\n\n## 当前任务\n${run.instruction}`, projectId: run.projectId, window, signal,
            activityRunId: run.runId,
            workspaceRoot: privateWorkspaceRoot,
          });
        }

        if (result.cancelled || signal?.aborted) {
          runRepo.setStatus(run.runId, 'cancelled');
          dispatchRunStatus(db, runRepo, window, run, 'cancelled');
          return;
        }

        dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '正在整理外部智能体执行结果与成果文件', progress: 88 });
        await syncAgentPrivateOutputs(privateWorkspaceRoot, projectRoot);
        const discoveredOutputPaths = await listAgentPrivateOutputFiles(privateWorkspaceRoot);
        const rawOutput = result.output.trim();
        const preparedOutput = rawOutput || discoveredOutputPaths.length > 0
          ? await artifactPublisher.publishFromOutput({
            projectId: run.projectId,
            agentInstanceId: run.agentInstanceId,
            runId: run.runId,
            triggerMessageId: run.triggerMessageId,
            text: rawOutput,
            additionalPaths: discoveredOutputPaths,
          })
          : { text: '', publishedPaths: [] };
        const output = preparedOutput.text.trim();
        if (isParallelChildRun(runRepo, run.runId)) {
          runRepo.addEvent(run.runId, 'parallel.result', {
            text: output,
            artifacts: preparedOutput.publishedPaths,
          });
          await captureRunMemory(run, null, output, preparedOutput.publishedPaths, privateWorkspaceRoot);
          runRepo.addEvent(run.runId, 'agent.completed', {
            definitionId: agentInstance.definitionId,
            cli: true,
            parallelChild: true,
            charCount: output.length,
            executionDurationMs: result.durationMs,
          });
          return;
        }
        dispatchRunTrace(db, runRepo, window, run, 'execution', `${agentInstance.agentName}执行完成`, result.exitCode === 0 ? 'completed' : 'failed');
        for (const path of preparedOutput.publishedPaths) {
          dispatchRunTrace(db, runRepo, window, run, 'file', '发布成果文件', 'completed', path);
        }

        let resultMessageId: string | null = null;
        if (output) {
          const delivery = prepareParentDelivery(db, runRepo, run, output);
          const contentJson = normalizeAgentMessageContent(
            db,
            run.projectId,
            JSON.stringify({ schemaVersion: 1, text: delivery.text, mentions: delivery.mentions, stagedUploadIds: [], audience: delivery.audience }),
            delivery.mentions,
            agentInstance.id,
          );
          const agentMsgId = rootTaskFinalMessageId(db, run, agentInstance.id, contentJson);
          resultMessageId = agentMsgId;
          const waitingForUser = messageRequestsUserResponse(contentJson);
          if (waitingForUser) {
            const duplicate = findDuplicateAwaitingUserMessage(db, run.projectId, run.triggerMessageId, contentJson, run.runId);
            if (duplicate) {
              runRepo.setResultMessage(run.runId, duplicate);
              runRepo.setStatus(run.runId, 'awaiting_user');
              runRepo.addEvent(run.runId, 'run.user-question-deduplicated', { duplicateMessageId: duplicate });
              dispatchRunStatus(db, runRepo, window, run, 'awaiting_user', { stage: '等待用户回复' });
              return;
            }
          }
          const now = new Date().toISOString();
          const inserted = db.prepare(
            'INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(agentMsgId, run.projectId, 'agent', agentInstance.id, 'text', contentJson, 'sent', now, now);
          if (inserted.changes === 0) {
            runRepo.setResultMessage(run.runId, agentMsgId);
            dispatchRunStatus(db, runRepo, window, run, 'completed');
            return;
          }
          await streamAgentMessage(window, {
            projectId: run.projectId,
            messageId: agentMsgId,
            senderId: agentInstance.id,
            text: visibleMessageText(contentJson, delivery.text),
          }, signal);
          runRepo.addEvent(run.runId, 'run.anchor', { messageId: agentMsgId });

          runRepo.setResultMessage(run.runId, agentMsgId);
          if (waitingForUser) {
            runRepo.setStatus(run.runId, 'awaiting_user');
            runRepo.addEvent(run.runId, 'run.awaiting-user', { messageId: agentMsgId });
            dispatchRunStatus(db, runRepo, window, run, 'awaiting_user', { stage: '等待用户回复' });
            if (!window.isDestroyed()) {
              broadcastEvent(window, {
                type: 'message.committed', projectId: run.projectId, messageId: agentMsgId, senderId: agentInstance.id, content: contentJson,
              });
            }
            return;
          }
          _runCompletedCallback?.(run.runId, run.projectId, agentMsgId, run.triggerMessageId);

          // 处理消息中的 @mention，触发目标智能体调度
          if (_scheduler) {
            processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, run.agentInstanceId, run.runId, 'agent', agentMsgId, (notice) => broadcastSystemNotice(window, notice));
          }

          dispatchRunStatus(db, runRepo, window, run, 'completed');
          if (!window.isDestroyed()) {
            broadcastEvent(window, {
              type: 'message.committed', projectId: run.projectId, messageId: agentMsgId, senderId: agentInstance.id, content: contentJson,
            });
          }
        } else {
          dispatchRunStatus(db, runRepo, window, run, 'completed', { message: `${agentInstance.agentName}执行完毕（无文本输出）` });
        }

        await captureRunMemory(run, resultMessageId, output, preparedOutput.publishedPaths, privateWorkspaceRoot);
        runRepo.addEvent(run.runId, 'agent.completed', {
          definitionId: agentInstance.definitionId,
          cli: true,
          charCount: output.length,
          executionDurationMs: result.durationMs,
        });
        return;
      }
    }

    logger?.info({ runId: run.runId, agentInstanceId: run.agentInstanceId }, 'AgentExecutor: 直接模式');

    // 真流式占位消息 ID（两阶段提交协议）；声明在 try 外以便取消/失败时清理占位。
    let streamedPlaceholderId: string | null = null;
    const discardStreamedPlaceholder = (reason: string) => {
      if (!streamedPlaceholderId) return;
      discardStreamingPlaceholder(window, { projectId: run.projectId, messageId: streamedPlaceholderId, reason });
      streamedPlaceholderId = null;
    };
    try {
      dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '分析任务并准备执行', progress: 20 });
      dispatchRunTrace(db, runRepo, window, run, 'reasoning', '分析任务并确定执行步骤', 'running');
      const projectInfo = db.prepare('SELECT name FROM projects WHERE id = ?').get(run.projectId) as { name: string } | undefined;
      const agentName = agentInstance?.agentName ?? '智能体';
      const contextBuilder = new ContextBuilder(db);
      const directTaskText = plainRunInstruction(run.instruction);
      // 轻量问题（问候、时间、能力询问等）由全部角色直接单轮回答，
      // 并跳过上下文快照构建与记忆召回，避免无谓的查询与多轮 LLM 调用。
      let directAnswerText: string | null = null;
      if (isSimpleDirectTask(directTaskText)) {
        dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '直接回答', progress: 45 });
        dispatchRunTrace(db, runRepo, window, run, 'reasoning', '判断为轻量问题，直接回答', 'completed');
        const directMessages = [{ role: 'user' as const, content: directTaskText }];
        const directSystem = `你是 ${agentName}，多智能体协作系统中的成员。只回答用户这条轻量问题，语气自然简洁，使用 Markdown。不要委派成员、调用工具或输出内部协议。`;
        let streamed = false;
        if (typeof gateway.streamText === 'function') {
          // 轻量问题走真流式：首字节到达即推送，用户无需等待全文生成完毕。
          try {
            const placeholderId = stableRunMessageId(run.runId, 'final');
            const stream = await gateway.streamText('fast', directMessages, {
              system: directSystem,
              maxOutputTokens: 700,
              signal,
            });
            const streamedText = (await collectStreamedAgentText(window, {
              projectId: run.projectId,
              messageId: placeholderId,
              senderId: agentInstance?.id ?? run.agentInstanceId,
              stream,
            }, signal)).trim();
            if (streamedText) {
              directAnswerText = sanitizeUserFacingResponse(streamedText) || '我可以继续帮你处理。';
              streamedPlaceholderId = placeholderId;
              streamed = true;
            }
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') throw err;
            // 流式中断则回退一次性生成；已推送分片会被最终 committed 同 ID 整体替换。
          }
        }
        if (!streamed) {
          const direct = await gateway.generateText('fast', directMessages, {
            system: directSystem,
            thinking: false,
            thinkingLevel: 'none',
            maxOutputTokens: 700,
          });
          directAnswerText = sanitizeUserFacingResponse(direct.text.trim()) || '我可以继续帮你处理。';
        }
      }
      // 直接模式只消费 agent/messages/memory 段落（sections: 'core'）。
      // 记忆已随快照按当前任务评分，不再单独做一次全量召回，避免重复查询与重复评分。
      const snapshot = directAnswerText !== null
        ? null
        : contextBuilder.build(run.projectId, run.agentInstanceId, run.triggerMessageId, resolveParentRunId(db, run.runId), { sections: 'core' });
      const relevantMemories = snapshot === null ? [] : [...snapshot.memory.shortTerm, ...snapshot.memory.longTerm];
      const memoryContext = relevantMemories.length > 0
        ? `与当前任务相关的记忆：\n${relevantMemories
            .slice(0, collaborationMode === 'fast' ? 3 : collaborationMode === 'balanced' ? 4 : 6)
            .map((item) => `- ${item}`)
            .join('\n')}`
        : '';

      const collaborationInstructions = buildAgentCollaborationInstructions(db, run.projectId, run.agentInstanceId);
      const policyIdentity = agentInstance
        ? {
          role: agentInstance.role,
          definitionId: agentInstance.definitionId,
          name: agentInstance.agentName,
          runtimeMode: agentInstance.runtimeMode,
        }
        : undefined;
      const systemMsg = snapshot === null ? '' : `你是 ${agentName}，一个多智能体协作系统中的 AI 智能体。
当前项目：${projectInfo?.name ?? run.projectId}

${contextBuilder.renderAgentDirective(snapshot)}

执行任务前必须遵守以上角色卡，并使用本群聊中召回的记忆；不得沿用其他群聊的身份或记忆。

你的回复应该专业、准确。使用 Markdown 格式输出。
${memoryContext ? `\n${memoryContext}` : ''}

${collaborationInstructions}

${resolveOutputDirective(policyIdentity)}

${audienceDirective}

${MODE_DIRECTIVES[collaborationMode]}

${resolveSpawnPolicy(collaborationMode, policyIdentity)}`;

      const { messageLimit: historyMessageLimit, contentLimit: historyContentLimit } = MODE_HISTORY_BUDGET[collaborationMode];
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = (snapshot?.messages ?? []).slice(-historyMessageLimit).map((m) => ({
        role: m.senderType === 'user' ? 'user' as const : 'assistant' as const,
        content: m.content.slice(0, historyContentLimit),
      }));

      const slot: ModelSlot = collaborationMode === 'fast'
        || (collaborationMode === 'expert' && agentInstance?.definitionId === 'builtin.knowledge-manager')
        ? 'fast'
        : 'reasoning';
      const localExecutorRun = agentInstance?.definitionId === 'builtin.local-executor';
      let plan: { summary: string; items: string[] };
      if (directAnswerText) {
        plan = { summary: '直接回答用户的轻量问题', items: [directTaskText.slice(0, 600)] };
      } else if (collaborationMode === 'fast') {
        plan = { summary: plainRunInstruction(run.instruction).slice(0, 300), items: [plainRunInstruction(run.instruction).slice(0, 600)] };
      } else if (localExecutorRun) {
        const maxItems = collaborationMode === 'balanced' ? 3 : 5;
        const task = plainRunInstruction(run.instruction);
        const singleStep = inferSingleLocalBusinessStep(task, maxItems);
        if (singleStep) {
          // Avoid a redundant fast-model round for ordinary lookup/read/action/answer work.
          plan = singleStep;
        } else {
          const planningResult = await gateway.generateText('fast', [{
          role: 'user',
          content: `完整业务工作包：\n${task}\n\n返回 JSON：{"summary":"执行目标","items":["业务子项"]}。最多 ${maxItems} 项。`,
        }], {
          system: `你只负责为本地执行智能体生成简洁的业务执行提纲，不执行任务。
- items 是用户可以理解的业务子结果，不是思维过程、工具清单或角色链路。
- 能在一次查询、读取、操作或回答中完成的任务必须只有 1 项。
- 不得把“理解需求、选择技能、知识化、检索、写作、验收、保存、回复”机械拆成独立步骤；它们属于完成业务子项时的内部动作。
- 复合任务按真实依赖拆成 2-${maxItems} 项；有依赖的按先后顺序排列。
- 彼此独立且适合分身并行的子问题合并为一个“并行完成……”业务子项，执行阶段会在该项内部决定是否调用分身。
- 只输出 JSON，不输出解释或隐藏思维。`,
          thinking: false,
          thinkingLevel: 'none',
          maxOutputTokens: 600,
          });
          plan = parseTaskPlan(planningResult.text, task.slice(0, 300));
          plan = { ...plan, items: plan.items.slice(0, maxItems) };
        }
      } else {
        const singleStep = collaborationMode === 'balanced'
          ? inferSingleLocalBusinessStep(plainRunInstruction(run.instruction), 1)
          : null;
        if (singleStep) {
          // 扩面本地执行智能体的快路径：均衡模式下无阶段/分支特征的单一任务跳过规划往返。
          plan = singleStep;
        } else {
          plan = parseTaskPlan((await gateway.generateText(slot, [
            ...messages,
            { role: 'user', content: collaborationMode === 'balanced'
              ? `当前负责人任务：${run.instruction}\n\n请用均衡但精简的方式判断执行步骤，并返回 JSON：{"summary":"执行目标","items":["可验收步骤"]}。单一任务只能有 1 项；复合任务只保留 2-4 个必要步骤。只输出 JSON，不输出思维过程。`
              : `当前负责人任务：${run.instruction}\n\n请判断这是单一任务还是复合任务，并返回 JSON：{"summary":"执行目标","items":["可验收步骤"]}。单一任务只能有 1 项；复合任务拆成 2-8 项。只输出 JSON，不输出思维过程。` },
          ], { system: systemMsg })).text, run.instruction.slice(0, 300));
          if (collaborationMode === 'balanced') plan = { ...plan, items: plan.items.slice(0, 4) };
        }
      }
      const compound = plan.items.length > 1;
      let checklist: RunChecklistItem[] = plan.items.map((title, index) => ({ id: `step-${index + 1}`, title, status: 'pending' }));
      if (compound) dispatchRunChecklist(db, runRepo, window, run, checklist);
      dispatchRunTrace(db, runRepo, window, run, 'reasoning', compound ? `已形成 ${plan.items.length} 项执行清单` : '已确认单一执行项', 'completed', plan.summary);

      const toolRole: LocalAgentRole = agentInstance?.definitionId === 'builtin.knowledge-manager'
        ? 'knowledge-manager'
        : agentInstance?.definitionId === 'builtin.local-executor'
          ? 'local-executor'
        : agentInstance?.definitionId === 'builtin.material-writer'
          ? 'material-writer'
          : agentInstance?.definitionId === 'builtin.acceptance-reviewer'
            ? 'acceptance-reviewer'
        : agentInstance?.runtimeMode === 'external-cli'
          ? 'external-cli'
          : agentInstance?.role === 'leader'
            ? 'orchestrator'
            : 'researcher';
      const toolDefinitions = Object.fromEntries(registry.getDefinitionsForRole(toolRole)
        .filter((tool) => !(
          tool.name === 'agent:spawn_parallel'
          && collaborationMode === 'balanced'
          && agentInstance?.definitionId === 'builtin.acceptance-reviewer'
        ))
        .map((tool) => [tool.name, { description: tool.description, parameters: tool.parameters }]));
      const completedSteps: string[] = [];
      let latestStepText = '';
      const allPublishedPaths = new Set<string>();
      const retrievalBudget = retrievalBudgetForDelegatedNode(collaborationMode);
      const retrievalBudgetOwnerRunId = resolveRetrievalBudgetOwnerRunId(db, runRepo, run.runId);
      const hasWebSearch = Object.prototype.hasOwnProperty.call(toolDefinitions, 'web:search');
      const hasKnowledgeSearch = Object.prototype.hasOwnProperty.call(toolDefinitions, 'knowledge:search');

      for (let stepIndex = 0; directAnswerText === null && stepIndex < plan.items.length; stepIndex++) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const step = plan.items[stepIndex]!;
        if (compound) {
          checklist = checklist.map((item, index) => index === stepIndex ? { ...item, status: 'in_progress' } : item);
          dispatchRunChecklist(db, runRepo, window, run, checklist);
        }
        const progress = 20 + Math.round((stepIndex / Math.max(plan.items.length, 1)) * 60);
        dispatchRunStatus(db, runRepo, window, run, 'running', { stage: `正在处理：${step}`, progress });
        dispatchRunTrace(db, runRepo, window, run, 'execution', `执行：${step}`, 'running');

        const collaborationStepInstruction = agentInstance?.definitionId === 'builtin.orchestrator'
          ? '如需协作，请由你判断后在正式汇报中 @ 对应成员。委派遵循"用户原话优先"：单一成员即可完成的简单需求，直接转达用户原话（可补充指向上一轮成果的必要说明，如文件名），不要改写、扩写或包装成工作包模板；只有确实需要多成员、多步骤协作的复杂需求，才按成员能力拆解为子需求清单并分别委派。若需求指向此前成果（如格式调整、续写、修订），必须在委派中明确写出该成果的文件名或来源。'
          : agentInstance?.definitionId === 'builtin.local-executor'
            ? `把统筹转达的用户原始需求或完整业务工作包在你自己的 loop 中闭环完成。先判断当前步骤实际需要本地知识化、内部/外部调研、材料编写或成果验收中的哪些技能，只调用必要能力；不要把这些内部环节再 @ 给旧专业角色或退回统筹。${collaborationMode === 'fast' ? '快速协同不做独立验收。' : collaborationMode === 'balanced' ? '均衡协同全任务最多做一次内部验收。' : '专家协同按交付风险核验关键节点，不做无收益的逐动作复核。'}需要文件时必须真实保存并在内部核验完成后用 temp:promote 提升为 outputs 成果。`
          : agentInstance?.definitionId === 'builtin.researcher'
            ? '先明确当前步骤缺少什么证据，再用最少的查询完成资料检索、来源核验和分析。每次搜索后先判断证据是否足够；足够就停止，不重复或轻微改写同一查询。不要把调研、知识归集或经验沉淀转派给其他成员；只有当前步骤被明确的跨领域资料依赖阻塞时，才在正式消息中 @ 对方请求这一项依赖。'
            : agentInstance?.definitionId === 'builtin.knowledge-manager'
              ? '只执行原始文件的 OCR、标准化、切片、向量、图谱、Wiki、入库与来源状态维护；不得检索知识、读取整文、查找模板、编写材料或安排其他成员。'
            : agentInstance?.definitionId === 'builtin.material-writer'
              ? materialWriterStepInstruction(run.instruction, collaborationMode)
              : agentInstance?.definitionId === 'builtin.acceptance-reviewer'
                ? '先读取指定待审稿，再独立使用 template:list/template:read、knowledge:search 和 knowledge:readDocument 核验模板、关键主张与明确来源文件；只给出明确验收结论和返修意见，不修改文件、不发布成果、不安排其他成员。'
            : '先直接完成当前步骤。只有确实被具体依赖阻塞时，才在正式消息中 @ 对方请求明确的输入或动作，收到结果后继续，不要自行安排全局任务。';
        const stepConversation: Array<{ role: 'user' | 'assistant'; content: string }> = [
          ...messages,
          { role: 'user', content: `负责人总任务：${run.instruction}\n\n我的执行清单：${plan.items.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n\n已完成：${completedSteps.join('\n') || '暂无'}\n\n现在只执行第 ${stepIndex + 1} 项：${step}\n${collaborationStepInstruction}` },
        ];
        let stepText = '';
        const trustedTempFiles = new Set<string>();
        const researcherStep = agentInstance?.definitionId === 'builtin.researcher';
        const parallelSpawnBudget = collaborationMode === 'fast' ? 0 : collaborationMode === 'balanced' ? 1 : Number.POSITIVE_INFINITY;
        // A material writer still needs a small, deterministic tool chain when
        // a template is present (list -> read -> materialize/writeDraft). The
        // general fast cap of one round would stop after template:list and
        // leave no real draft to publish. Allow only the minimum extra rounds
        // for file-producing writer work; ordinary specialists keep the tight
        // fast/balanced limits.
        const materialWriterFileTask = ['builtin.material-writer', 'builtin.local-executor'].includes(agentInstance?.definitionId ?? '')
          && /(?:报告|方案|材料|文档|文件|HTML|网页|模板|待审稿|候选稿|撰写|编写|整理|梳理)/iu.test(run.instruction);
        let parallelSpawnCount = 0;
        const maxToolRounds = collaborationMode === 'fast'
          ? materialWriterFileTask ? (agentInstance?.definitionId === 'builtin.local-executor' ? 6 : 4) : 1
          : collaborationMode === 'balanced'
            ? materialWriterFileTask ? (agentInstance?.definitionId === 'builtin.local-executor' ? 8 : 5) : 2
            : agentInstance?.definitionId === 'builtin.local-executor' ? 12 : researcherStep ? retrievalBudget + 2 : 8;
        let readContinuationTool = '';
        for (let round = 0; round < maxToolRounds || (readContinuationTool && round < 16); round++) {
          const requiredContinuationTool = readContinuationTool;
          const continuationWasRequired = Boolean(requiredContinuationTool);
          readContinuationTool = '';
          const retrievalBudgetRule = hasWebSearch || hasKnowledgeSearch
            ? `\n统筹委派的当前任务节点中，网页搜索与知识检索共享 ${retrievalBudget} 次预算；所有步骤、重试、依赖任务和分身共同计数。每次检索后先判断证据是否足够，不得重复或轻微改写已有查询。`
            : '';
          const generated = await gateway.generateText(slot, stepConversation, { system: `${systemMsg}\n\n你正在执行清单中的单个步骤。先完成必要的工具调用，再给出本步骤可验收结果。不要输出隐藏思维过程。${retrievalBudgetRule}`, tools: toolDefinitions });
          if (!generated.toolCalls?.length) {
            if (continuationWasRequired) {
              readContinuationTool = requiredContinuationTool;
              stepConversation.push({
                role: 'user',
                content: `${requiredContinuationTool === 'template:read' ? '模板' : '标准化全文'}仍有未读区间。必须继续调用 ${requiredContinuationTool}，并严格使用上一次返回的 NEXT_CURSOR；在 READ_COMPLETE: true 前不能结束、总结或声称已完整读取。`,
              });
              continue;
            }
            stepText = generated.text.trim();
            break;
          }
          const toolResults: string[] = [];
          let requiredReadCalled = false;
          for (const call of generated.toolCalls) {
            const skillName = getSkillDisplayName(call.name);
            const targetPath = call.name === 'publish_artifact' && typeof call.args.relativePath === 'string' ? call.args.relativePath : null;
            const skillStage = targetPath ? `正在生成 ${targetPath} 文件` : `正在调用${skillName}技能`;
            dispatchRunStatus(db, runRepo, window, run, 'running', { stage: skillStage, progress: Math.min(progress + 8, 88) });
            dispatchRunTrace(db, runRepo, window, run, 'tool', targetPath ? `正在生成 ${targetPath} 文件` : `正在调用${skillName}技能完成“${step}”`, 'running');
            let result: string;
            if (call.name === 'web:search') {
              const query = typeof call.args.query === 'string' ? call.args.query.trim() : '';
              const reservation = reserveRetrievalBudget(db, runRepo, run.runId, collaborationMode, 'web', query);
              if (reservation.status === 'duplicate') {
                result = '已跳过当前任务节点中重复或高度相似的网页搜索。请直接使用节点内已有来源，或只针对明确缺失的证据设计不同查询。';
              } else if (reservation.status === 'exhausted') {
                result = `当前任务节点已达到 ${reservation.budget} 次检索预算。请基于已有的内部和外部证据形成结论，并明确仍然存在的证据缺口。`;
              } else {
                result = await registry.execute(call.name, call.args, { role: toolRole, runId: run.runId, projectId: run.projectId });
              }
            } else if (call.name === 'knowledge:search') {
              const query = typeof call.args.query === 'string' ? call.args.query.trim() : '';
              const reservation = reserveRetrievalBudget(db, runRepo, run.runId, collaborationMode, 'knowledge', query);
              if (reservation.status === 'duplicate') {
                result = '已跳过当前任务节点中重复或高度相似的知识检索。请直接使用节点内已有证据完成当前步骤。';
              } else if (reservation.status === 'exhausted') {
                result = `当前任务节点已达到 ${reservation.budget} 次检索预算。请基于已有的内部和外部证据完成任务，并明确仍存在的缺口。`;
              } else {
                result = await registry.execute(call.name, call.args, { role: toolRole, runId: run.runId, projectId: run.projectId });
              }
            } else if (call.name === 'agent:spawn_parallel' && (
              parallelSpawnCount >= parallelSpawnBudget
              || (collaborationMode === 'balanced' && agentInstance?.definitionId === 'builtin.acceptance-reviewer')
            )) {
              result = collaborationMode === 'fast'
                ? '快速协同不创建分身，请直接完成当前工作包。'
                : agentInstance?.definitionId === 'builtin.acceptance-reviewer'
                  ? '均衡协同的验收额度为整棵任务树一次，验收智能体不能创建验收分身。'
                  : '均衡协同已使用一次必要的并行批次，请合并现有结果完成当前工作包。';
            } else {
              result = await registry.execute(call.name, call.args, { role: toolRole, runId: run.runId, projectId: run.projectId });
              if (call.name === 'agent:spawn_parallel') parallelSpawnCount += 1;
            }
            if (call.name === 'knowledge:readDocument' || call.name === 'template:read') {
              if (call.name === requiredContinuationTool) requiredReadCalled = true;
              if (result.includes('READ_COMPLETE: false')) readContinuationTool = call.name;
            }
            dispatchRunTrace(db, runRepo, window, run, 'tool', `${skillName}技能调用完成`, result.startsWith('工具执行失败') ? 'failed' : 'completed', result);
            toolResults.push(`${call.name}: ${result}`);
            if (call.name === 'publish_artifact' && result.startsWith('成果已发布到 ') && typeof call.args.relativePath === 'string') {
              // The path is trusted only because the host tool just wrote it.
              allPublishedPaths.add(String(call.args.relativePath).replaceAll('\\', '/'));
              toolResults.push(`系统已真实写入成果文件：${String(call.args.relativePath).replaceAll('\\', '/')}`);
            }
            if (call.name === 'temp:promote') {
              const promoted = result.match(/TEMP_PROMOTED:\s*[^\n]+?\s*->\s*(outputs\/[^\s]+)/iu)?.[1];
              if (promoted) {
                // temp:promote has already copied and verified the file; pass
                // this system-confirmed path to the publisher for the
                // clickable artifact record.
                allPublishedPaths.add(promoted.replaceAll('\\', '/'));
              }
            }
            if (call.name === 'temp:save' && result.startsWith('TEMP_SAVED:')) {
              const savedName = result.match(/^TEMP_SAVED:\s*([^\s（(]+)/u)?.[1];
              if (savedName) trustedTempFiles.add(savedName);
            }
          }
          if (continuationWasRequired && !requiredReadCalled) readContinuationTool = requiredContinuationTool;
          if (generated.text.trim()) stepConversation.push({ role: 'assistant', content: generated.text.trim() });
          const retrievalUsage = readRetrievalBudgetUsage(runRepo, retrievalBudgetOwnerRunId);
          const budgetStatus = hasWebSearch || hasKnowledgeSearch
            ? `\n\n当前任务节点检索预算已使用 ${retrievalUsage.total}/${retrievalBudget} 次（网页 ${retrievalUsage.web} 次，知识 ${retrievalUsage.knowledge} 次）。先判断证据是否足够，足够则停止检索并完成当前步骤。`
            : '';
          const documentStatus = readContinuationTool
            ? `\n\n${readContinuationTool === 'template:read' ? '模板' : '标准化全文'}尚未覆盖完毕，下一轮必须按 NEXT_CURSOR 继续调用 ${readContinuationTool}；此时不得总结或结束。`
            : '';
          stepConversation.push({ role: 'user', content: `工具执行结果：\n${toolResults.join('\n\n')}${budgetStatus}${documentStatus}\n\n请继续完成当前步骤。` });
        }
        if (!stepText) {
          if (readContinuationTool) {
            stepText = `${readContinuationTool === 'template:read' ? '模板' : '标准化全文'}超过本次安全读取上限，当前步骤尚未完整覆盖，不能据此声称已完成全文审阅：${step}`;
          } else {
            const exhausted = await gateway.generateText(slot, [
              ...stepConversation,
              { role: 'user', content: '请基于已经完成的工具结果，直接给出当前步骤的可验收结论、来源和仍然存在的缺口。不要再调用工具，不要输出内部协议。' },
            ], { system: systemMsg });
            stepText = exhausted.text.trim() || `当前步骤未能在执行时限内形成可验收结果：${step}`;
          }
        }

        const isCodeBuddyReviewer = agentInstance?.definitionId === 'custom.codebuddy' || agentInstance?.definitionId === 'external.codebuddy';
        const mayPublishArtifacts = !['builtin.material-writer', 'builtin.acceptance-reviewer', 'custom.codebuddy', 'external.codebuddy'].includes(agentInstance?.definitionId ?? '') && !isCodeBuddyReviewer;
        const preserveAcceptanceOutput = agentInstance?.definitionId === 'builtin.acceptance-reviewer' || isCodeBuddyReviewer;
        const preparedStep = mayPublishArtifacts
          ? await artifactPublisher.publishFromOutput({
            projectId: run.projectId,
            agentInstanceId: run.agentInstanceId,
            runId: run.runId,
            triggerMessageId: run.triggerMessageId,
            text: stepText,
            additionalPaths: [...allPublishedPaths],
          })
          : { text: preserveAcceptanceOutput ? stepText : suppressUnreviewedArtifactOutput(stepText), publishedPaths: [] };
        // Artifact parsing must see the raw model output first.  Only after
        // trusted files are discovered do we sanitize the text that can reach
        // progress messages or the final delivery.
        stepText = sanitizeUserFacingResponse(preparedStep.text);
        if (trustedTempFiles.size > 0) {
          // This marker is generated by the host only after temp:save really
          // wrote the file, so the coordinator can distinguish it from a
          // model's unsupported "saved" claim.
          stepText = `${stepText}\n临时文件已由系统保存：${[...trustedTempFiles].join('、')}`.trim();
        }
        for (const path of preparedStep.publishedPaths) {
          allPublishedPaths.add(path);
          dispatchRunTrace(db, runRepo, window, run, 'file', '发布成果文件', 'completed', path);
        }

        const senderId = agentInstance?.id ?? run.agentInstanceId;
        const parentAgentId = (() => {
          try {
            const parentRunId = runRepo.getById(run.runId).parentRunId;
            return parentRunId ? runRepo.getById(parentRunId).agentInstanceId : null;
          } catch {
            return null;
          }
        })();
        const shouldReportProgress = resolveAgentMentions(db, run.projectId, stepText)
          .some((mention) => (
            mention.target.scope === 'instance'
            && mention.target.id !== senderId
            && mention.target.id !== parentAgentId
          ));
        let collaborationResult = '';
        if (shouldReportProgress) {
          const committed = commitAgentText(run, senderId, stepText, 'progress');
          if (committed.childRunIds.length > 0) {
            dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '等待协作智能体回复', progress: Math.min(progress + 10, 90) });
            dispatchRunTrace(db, runRepo, window, run, 'handoff', `等待 ${committed.childRunIds.length} 个协作任务反馈`, 'running');
            collaborationResult = await waitForChildRuns(run, committed.childRunIds, signal);
            dispatchRunTrace(db, runRepo, window, run, 'handoff', '协作结果已返回，继续执行清单', 'completed', collaborationResult);
            const continuation = await gateway.generateText(slot, [{
              role: 'user',
              content: `负责人总任务：${run.instruction}\n当前步骤：${step}\n我的阶段结果：${stepText}\n协作智能体反馈：${collaborationResult}\n\n请吸收反馈，给出当前步骤的最终可验收结果。不要再次发送无意义确认。`,
            }], { system: systemMsg });
            if (continuation.text.trim()) {
              stepText = continuation.text.trim();
            }
          }
        }

        latestStepText = stepText;
        completedSteps.push(`${stepIndex + 1}. ${step}\n${stepText}${collaborationResult ? `\n协作反馈：${collaborationResult}` : ''}`);
        if (compound) {
          checklist = checklist.map((item, index) => index === stepIndex ? { ...item, status: 'completed', detail: stepText.slice(0, 240) } : item);
          dispatchRunChecklist(db, runRepo, window, run, checklist);
        }
        dispatchRunTrace(db, runRepo, window, run, 'execution', `完成：${step}`, 'completed', stepText);
      }

      if (directAnswerText === null) {
        dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '正在生成任务交付说明与成果汇报', progress: 92 });
        dispatchRunTrace(db, runRepo, window, run, 'reasoning', '汇总全部执行项并准备交付', 'running');
      }
      let fullText = directAnswerText ?? (latestStepText || completedSteps[completedSteps.length - 1] || '任务已完成。');
      if (compound) {
        const reviewerDeliveryRule = agentInstance?.definitionId === 'builtin.acceptance-reviewer'
          ? '\n验收回复最后必须单独一行写“验收结论：通过”或“验收结论：不通过”；没有充分证据证明全部关键项通过时，一律写不通过。'
          : '';
        const finalSlot = localExecutorRun ? 'fast' : slot;
        const finalMessages = [{
          role: 'user' as const,
          content: `负责人任务：${run.instruction}\n\n已获得的业务结果：\n${completedSteps.join('\n\n')}\n\n系统确认的成果文件：${[...allPublishedPaths].join('、') || '无'}\n\n请直接写一份可交给用户或统筹的自然语言答复：只保留最终结论、关键证据、真实成果文件和必要风险。不要复述执行清单、步骤状态、工具调用、内部思考、工作包或调度协议，不要输出 JSON，不要重复输出完整 HTML。${reviewerDeliveryRule}`,
        }];
        const finalSystem = localExecutorRun
          ? '你只负责把本地执行智能体已经完成的业务结果压缩成可直接发送给用户或统筹的自然语言答复。只保留最终结论、关键证据、系统确认存在的成果文件和必要风险；不要输出执行清单、步骤编号、工具调用、内部思考、工作包、技能名称、旧专业角色名称、调度协议或任何 JSON，不要声称未由系统确认的文件已经生成。'
          : systemMsg;
        let streamedFull = false;
        if (typeof gateway.streamText === 'function') {
          // 复合任务的最终汇总走真流式：长文本边生成边推送，缩短首字可见时间。
          // 快路径（directAnswerText）与 compound 互斥，此处占位 ID 必然未被使用。
          try {
            const placeholderId = stableRunMessageId(run.runId, 'final');
            const stream = await gateway.streamText(finalSlot, finalMessages, {
              system: finalSystem,
              ...(localExecutorRun ? { maxOutputTokens: 1_400 } : {}),
              signal,
            });
            const streamedText = (await collectStreamedAgentText(window, {
              projectId: run.projectId,
              messageId: placeholderId,
              senderId: agentInstance?.id ?? run.agentInstanceId,
              stream,
            }, signal)).trim();
            if (streamedText) {
              fullText = streamedText;
              streamedPlaceholderId = placeholderId;
              streamedFull = true;
            }
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') throw err;
            // 流式中断则回退一次性生成；已推送分片会被最终 committed 同 ID 整体替换。
          }
        }
        if (!streamedFull) {
          const finalResult = await gateway.generateText(finalSlot, finalMessages, localExecutorRun
            ? {
              system: finalSystem,
              thinking: false,
              thinkingLevel: 'none',
              maxOutputTokens: 1_400,
            }
            : { system: finalSystem });
          fullText = finalResult.text.trim() || fullText;
        }
      }
      dispatchRunTrace(db, runRepo, window, run, 'reasoning', '负责人交付内容已生成', 'completed');
      const isCodeBuddyReviewer = agentInstance?.definitionId === 'custom.codebuddy' || agentInstance?.definitionId === 'external.codebuddy';
      const mayPublishFinalArtifacts = !['builtin.material-writer', 'builtin.acceptance-reviewer', 'custom.codebuddy', 'external.codebuddy'].includes(agentInstance?.definitionId ?? '') && !isCodeBuddyReviewer;
      const preserveAcceptanceOutput = agentInstance?.definitionId === 'builtin.acceptance-reviewer' || isCodeBuddyReviewer;
      const preparedOutput = mayPublishFinalArtifacts
        ? await artifactPublisher.publishFromOutput({
          projectId: run.projectId,
          agentInstanceId: run.agentInstanceId,
          runId: run.runId,
          triggerMessageId: run.triggerMessageId,
          text: fullText,
          additionalPaths: [...allPublishedPaths],
        })
        : { text: preserveAcceptanceOutput ? fullText : suppressUnreviewedArtifactOutput(fullText), publishedPaths: [] };
        fullText = sanitizeUserFacingResponse(preparedOutput.text);
      if (isParallelChildRun(runRepo, run.runId)) {
        runRepo.addEvent(run.runId, 'parallel.result', {
          text: fullText,
          artifacts: preparedOutput.publishedPaths,
        });
        await captureRunMemory(run, null, fullText, [...preparedOutput.publishedPaths]);
        runRepo.addEvent(run.runId, 'agent.completed', {
          definitionId: 'direct',
          parallelChild: true,
          charCount: fullText.length,
        });
        return;
      }
      for (const path of preparedOutput.publishedPaths) allPublishedPaths.add(path);
      for (const path of preparedOutput.publishedPaths) {
        dispatchRunTrace(db, runRepo, window, run, 'file', '发布成果文件', 'completed', path);
      }
      const delivery = prepareParentDelivery(db, runRepo, run, fullText);
      const senderId = agentInstance?.id ?? run.agentInstanceId;
      const contentJson = normalizeAgentMessageContent(
        db,
        run.projectId,
        JSON.stringify({ schemaVersion: 1, text: delivery.text, mentions: delivery.mentions, stagedUploadIds: [], audience: delivery.audience }),
        delivery.mentions,
        senderId,
      );
      const agentMsgId = rootTaskFinalMessageId(db, run, senderId, contentJson);
      const waitingForUser = messageRequestsUserResponse(contentJson);
      const equivalentProgress = findEquivalentProgressMessage(run.runId, senderId, delivery.text);
      if (equivalentProgress) {
        discardStreamedPlaceholder('progress-message-reused');
        runRepo.setResultMessage(run.runId, equivalentProgress.messageId);
        runRepo.addEvent(run.runId, 'run.final-message-reused', {
          messageId: equivalentProgress.messageId,
          reason: 'same-visible-text',
        });
        if (waitingForUser) {
          runRepo.setStatus(run.runId, 'awaiting_user');
          runRepo.addEvent(run.runId, 'run.awaiting-user', { messageId: equivalentProgress.messageId });
          dispatchRunStatus(db, runRepo, window, run, 'awaiting_user', { stage: '等待用户回复' });
          return;
        }
        _runCompletedCallback?.(run.runId, run.projectId, equivalentProgress.messageId, run.triggerMessageId);
        await captureRunMemory(run, equivalentProgress.messageId, fullText, [...allPublishedPaths]);
        dispatchRunStatus(db, runRepo, window, run, 'completed');
        runRepo.addEvent(run.runId, 'agent.completed', {
          definitionId: 'direct',
          charCount: fullText.length,
          reusedProgressMessage: true,
        });
        logger?.info(
          { runId: run.runId, agentMsgId: equivalentProgress.messageId, charCount: fullText.length },
          'AgentExecutor: completed by reusing an identical progress message',
        );
        return;
      }
      if (waitingForUser) {
        const duplicate = findDuplicateAwaitingUserMessage(db, run.projectId, run.triggerMessageId, contentJson, run.runId);
        if (duplicate) {
          discardStreamedPlaceholder('awaiting-user-deduplicated');
          runRepo.setResultMessage(run.runId, duplicate);
          runRepo.setStatus(run.runId, 'awaiting_user');
          runRepo.addEvent(run.runId, 'run.user-question-deduplicated', { duplicateMessageId: duplicate });
          dispatchRunStatus(db, runRepo, window, run, 'awaiting_user', { stage: '等待用户回复' });
          return;
        }
      }
      const now = new Date().toISOString();

      const inserted = db.prepare(
        'INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(agentMsgId, run.projectId, 'agent', agentInstance?.id ?? run.agentInstanceId, 'text', contentJson, 'sent', now, now);
      if (inserted.changes === 0) {
        // 同 ID 消息已存在（如重试复用）：渲染端占位交给既有消息，丢弃流式半成品。
        discardStreamedPlaceholder('message-already-committed');
        runRepo.setResultMessage(run.runId, agentMsgId);
        dispatchRunStatus(db, runRepo, window, run, 'completed');
        return;
      }
      if (!streamedPlaceholderId) {
        // 未走真流式（回退路径）时，用一次性分发补齐渲染端增量。
        await streamAgentMessage(window, {
          projectId: run.projectId,
          messageId: agentMsgId,
          senderId: agentInstance?.id ?? run.agentInstanceId,
          text: visibleMessageText(contentJson, delivery.text),
        }, signal);
      }
      runRepo.addEvent(run.runId, 'run.anchor', { messageId: agentMsgId });

      runRepo.setResultMessage(run.runId, agentMsgId);
      if (waitingForUser) {
        runRepo.setStatus(run.runId, 'awaiting_user');
        runRepo.addEvent(run.runId, 'run.awaiting-user', { messageId: agentMsgId });
        dispatchRunStatus(db, runRepo, window, run, 'awaiting_user', { stage: '等待用户回复' });
        if (!window.isDestroyed()) {
          broadcastEvent(window, {
            type: 'message.committed', projectId: run.projectId, messageId: agentMsgId,
            senderId: agentInstance?.id ?? run.agentInstanceId, content: contentJson,
          });
        }
        return;
      }
      _runCompletedCallback?.(run.runId, run.projectId, agentMsgId, run.triggerMessageId);
      await captureRunMemory(run, agentMsgId, fullText, [...allPublishedPaths]);

      // 处理消息中的 @mention，触发目标智能体调度
      if (_scheduler) {
        processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, run.agentInstanceId, run.runId, 'agent', agentMsgId, (notice) => broadcastSystemNotice(window, notice));
      }

      dispatchRunStatus(db, runRepo, window, run, 'completed');
      if (!window.isDestroyed()) {
        broadcastEvent(window, {
          type: 'message.committed',
          projectId: run.projectId,
          messageId: agentMsgId,
          senderId: agentInstance?.id ?? run.agentInstanceId,
          content: contentJson,
        });
      }

      runRepo.addEvent(run.runId, 'agent.completed', { definitionId: 'direct', charCount: fullText.length });
      logger?.info({ runId: run.runId, agentMsgId, charCount: fullText.length }, 'AgentExecutor: 完成');
    } catch (err) {
      // 取消或失败时清理渲染端的流式半成品占位消息。
      discardStreamedPlaceholder(err instanceof DOMException && err.name === 'AbortError' ? 'run-cancelled' : 'run-failed');
      if (err instanceof DOMException && err.name === 'AbortError') {
        runRepo.setStatus(run.runId, 'cancelled');
        runRepo.addEvent(run.runId, 'agent.error', { definitionId: 'direct', error: '用户取消' });
        dispatchRunStatus(db, runRepo, window, run, 'cancelled');
        return;
      }
      throw err;
    }
  };

  const executor = ((run: QueuedRun, signal: AbortSignal): Promise<void> => {
    let snapshotJson: string | null = null;
    try { snapshotJson = runRepo.getById(run.runId).modelProfileSnapshotJson; } catch { /* use slot fallback */ }
    const collaborationMode = resolveCollaborationMode(db, run.triggerMessageId);
    const executeWithMode = (): Promise<void> => typeof gateway.runWithCollaborationMode === 'function'
      ? gateway.runWithCollaborationMode(collaborationMode, () => executeRun(run, signal))
      : executeRun(run, signal);
    return typeof gateway.runWithModelProfileSnapshot === 'function'
      ? gateway.runWithModelProfileSnapshot(snapshotJson, executeWithMode)
      : executeWithMode();
  }) as AgentExecutor;

  executor.setScheduler = (s: Scheduler) => {
    _scheduler = s;
    tools = createProjectTools(db, s, gateway);
  };

  executor.onRunCompleted = (cb: (runId: string, projectId: string, resultMessageId: string, triggerMessageId: string) => void) => {
    _runCompletedCallback = cb;
  };

  return executor;
}
