import { BrowserWindow, app, dialog } from 'electron';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelGateway, type ModelSlot } from './model-gateway';
import type { QueuedRun, Scheduler } from './scheduler';
import { MemoryManager } from './memory-manager';
import { ContextBuilder } from './context-builder';
import { createProjectTools, registerProjectTools } from './agent-tools';
import { ToolRegistry, type AgentRole as LocalAgentRole } from './tool-registry';
import { runOrchestrator } from './langgraph-orchestrator';
import { runKnowledgeManager, type KMExecContext } from './langgraph-knowledge-manager';
import { cliExecutor } from './cli-executor';
import { cliAgentRegistry } from './cli-agent-registry';
import { AgentRunRepository, MessageRepository } from '@kunqing/database';
import { getLogger } from './logger';
import { getProjectRoot } from './paths';
import { processMessageMentions } from './message-router';
import { buildAgentCollaborationInstructions, normalizeAgentMessageContent, resolveAgentMentions, sanitizeAgentDisplayText, type AgentMention } from './agent-collaboration';
import { AgentArtifactPublisher } from './agent-artifact-publisher';
import { isStructuredEvent, normalizeChunk } from './event-normalizer';
import { listAgentPrivateOutputFiles, prepareAgentPrivateWorkspace, syncAgentPrivateOutputs } from './agent-private-workspace';
import { getSkillDisplayName } from './skill-display';
import { AGENT_TASK_TIMEOUT_MS } from './agent-runtime-limits';
import {
  parsePostTaskKnowledgeInstruction,
  runPostTaskKnowledgeCapture,
} from './business-process';
import type { BusinessProcess } from '@kunqing/native-agent-core';

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

function lookupRunChainMetadata(runRepo: AgentRunRepository, runId: string): {
  triggerMessageId?: string; parentRunId?: string; requestedByType?: string; requestedById?: string; createdAt?: string;
} {
  try {
    const persisted = runRepo.getById(runId);
    return {
      ...(persisted.triggerMessageId ? { triggerMessageId: persisted.triggerMessageId } : {}),
      ...(persisted.parentRunId ? { parentRunId: persisted.parentRunId } : {}),
      requestedByType: persisted.requestedByType,
      requestedById: persisted.requestedById,
      createdAt: persisted.createdAt,
    };
  } catch {
    return {};
  }
}

function plainRunInstruction(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    if (typeof parsed.text === 'string') return parsed.text.trim();
  } catch { /* use raw instruction */ }
  return raw.trim();
}

function containsInternalAgentProtocol(text: string): boolean {
  return /(?:^|\n)\s*(?:NEED_AGENTS|NEED_CLI|NEED_KM)\b/i.test(text);
}

/**
 * 查询触发者（用户或智能体）的显示名称
 */
function lookupTriggeredByName(db: Database.Database, runRepo: AgentRunRepository, runId: string): { triggeredBy: string; triggeredByName: string | null } | null {
  try {
    const run = runRepo.getById(runId);
    if (run.requestedByType === 'user') {
      return { triggeredBy: 'user', triggeredByName: '用户' };
    }
    if (run.requestedByType === 'agent' && run.requestedById) {
      const name = lookupAgentName(db, run.requestedById);
      return { triggeredBy: run.requestedById, triggeredByName: name };
    }
    return null;
  } catch {
    return null;
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
  if (window.isDestroyed()) return;
  const agentName = lookupAgentName(db, run.agentInstanceId);
  const triggered = lookupTriggeredByName(db, runRepo, run.runId);
  const safeExtra = extra ? Object.fromEntries(Object.entries(extra).map(([key, value]) => [
    key,
    typeof value === 'string' ? sanitizeAgentDisplayText(db, run.projectId, value) : value,
  ])) : undefined;
  window.webContents.send('event:dispatch', {
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
      ...lookupRunChainMetadata(runRepo, run.runId),
      ...safeExtra,
    },
  });
}

type RunTraceKind = 'plan' | 'reasoning' | 'handoff' | 'tool' | 'execution' | 'file' | 'warning';
type RunTraceStatus = 'running' | 'completed' | 'failed';
type ChecklistStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
type RunChecklistItem = { id: string; title: string; status: ChecklistStatus; detail?: string };

function dispatchRunTrace(
  db: Database.Database,
  runRepo: AgentRunRepository,
  window: BrowserWindow,
  run: QueuedRun,
  kind: RunTraceKind,
  title: string,
  status: RunTraceStatus,
  detail?: string,
): void {
  const trace = {
    id: randomUUID().toLowerCase().replace(/-/g, '').slice(0, 16),
    kind,
    title: sanitizeAgentDisplayText(db, run.projectId, title),
    status,
    ...(detail ? { detail: sanitizeAgentDisplayText(db, run.projectId, detail).slice(0, 500) } : {}),
    at: new Date().toISOString(),
  };
  runRepo.addEvent(run.runId, 'run.trace', trace);
  if (!window.isDestroyed()) {
    window.webContents.send('event:dispatch', {
      type: 'run.trace',
      projectId: run.projectId,
      runId: run.runId,
      agentId: run.agentInstanceId,
      anchorMessageId: lookupRunAnchorMessageId(runRepo, run.runId),
      ...lookupRunChainMetadata(runRepo, run.runId),
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
    window.webContents.send('event:dispatch', {
      type: 'run.checklist', projectId: run.projectId, runId: run.runId, agentId: run.agentInstanceId,
      ...lookupRunChainMetadata(runRepo, run.runId),
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
  runId: string,
): AgentMention[] {
  try {
    const currentRun = runRepo.getById(runId);
    if (!currentRun.parentRunId) return [];

    const parentRun = runRepo.getById(currentRun.parentRunId);
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
  runId: string,
  text: string,
): { text: string; mentions: ReturnType<typeof buildParentMention> } {
  const mentions = buildParentMention(db, runRepo, runId);
  const parent = mentions[0];
  if (!parent || text.includes(`@${parent.label}`)) return { text, mentions };
  return { text: `@${parent.label}\n\n${text}`, mentions };
}

export type AgentExecutor = {
  (run: QueuedRun, signal: AbortSignal): Promise<void>;
  setScheduler(s: Scheduler): void;
  onRunCompleted(cb: (runId: string, projectId: string, resultMessageId: string) => void): void;
};

export function createAgentExecutor(db: Database.Database, window: BrowserWindow, gateway: ModelGateway, scheduler?: Scheduler, toolRegistry?: ToolRegistry): AgentExecutor {
  const runRepo = new AgentRunRepository(db);
  const msgRepo = new MessageRepository(db);
  const memory = new MemoryManager(db);
  const artifactPublisher = new AgentArtifactPublisher(db, (event) => {
    if (!window.isDestroyed()) window.webContents.send('event:dispatch', event);
  });
  let _scheduler = scheduler;
  let tools = createProjectTools(db, _scheduler);
  const registry = toolRegistry ?? new ToolRegistry(db);
  if (!toolRegistry) {
    registerProjectTools(registry, db, _scheduler);
  }
  let _runCompletedCallback: ((runId: string, projectId: string, resultMessageId: string) => void) | null = null;

  const captureRunMemory = async (run: QueuedRun, resultMessageId: string | null, resultText?: string, artifacts: string[] = []): Promise<void> => {
    try {
      let text = resultText ?? '';
      if (!text && resultMessageId) {
        const row = db.prepare('SELECT content_json as contentJson FROM messages WHERE id = ?').get(resultMessageId) as { contentJson: string } | undefined;
        if (row) {
          try { text = (JSON.parse(row.contentJson) as { text?: string }).text ?? row.contentJson; } catch { text = row.contentJson; }
        }
      }
      let selfSummary = '';
      if (text.trim()) {
        const agentName = lookupAgentName(db, run.agentInstanceId) ?? '当前智能体';
        try {
          const summarized = await gateway.generateText('fast', [{
            role: 'user',
            content: `任务：${run.instruction.slice(0, 1_000)}\n\n我的执行结果：${text.slice(0, 3_000)}\n\n成果：${artifacts.join('、') || '无文件'}`,
          }], {
            system: `你是“${agentName}”自己的私有记忆压缩模块。只总结本智能体刚完成的工作，不读取、推断或记录其他智能体的私有身份和记忆。输出 150-400 字的结构化摘要，包含：已完成、关键决策、可复用经验、未完成事项。不要输出思维过程。`,
          });
          selfSummary = summarized.text.trim();
        } catch { /* 模型不可用时由本地任务闭环摘要兜底 */ }
      }
      await memory.captureTurn({
        projectId: run.projectId,
        agentInstanceId: run.agentInstanceId,
        triggerMessageId: run.triggerMessageId,
        runId: run.runId,
        request: run.instruction,
        result: text,
        artifacts,
        ...(selfSummary ? { selfSummary } : {}),
      });
    } catch (err) {
      getLogger()?.warn({ err, runId: run.runId }, 'AgentExecutor: 记录任务记忆失败');
    }
  };

  const commitAgentText = (
    run: QueuedRun,
    senderId: string,
    text: string,
    messageType: 'progress' | 'final' = 'progress',
  ): { messageId: string; contentJson: string; childRunIds: string[] } => {
    const messageId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const contentJson = normalizeAgentMessageContent(
      db,
      run.projectId,
      JSON.stringify({ schemaVersion: 1, text, mentions: [], stagedUploadIds: [], messageType }),
      [],
      senderId,
    );
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(messageId, run.projectId, 'agent', senderId, 'text', contentJson, 'sent', now, now);
    runRepo.addEvent(run.runId, 'run.anchor', { messageId });
    const childRunIds = _scheduler
      ? processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, senderId, run.runId, 'agent', messageId)
      : [];
    if (!window.isDestroyed()) {
      window.webContents.send('event:dispatch', {
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
  }): Promise<void> => {
    const { run, senderId, responseText, reportLength, businessProcess } = input;
    const delivery = prepareParentDelivery(db, runRepo, run.runId, responseText);
    const agentMsgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const contentJson = normalizeAgentMessageContent(
      db,
      run.projectId,
      JSON.stringify({ schemaVersion: 1, text: delivery.text, mentions: delivery.mentions, stagedUploadIds: [] }),
      delivery.mentions,
      senderId,
    );
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(agentMsgId, run.projectId, 'agent', senderId, 'text', contentJson, 'sent', now, now);
    runRepo.addEvent(run.runId, 'run.anchor', { messageId: agentMsgId });
    if (businessProcess) runRepo.addEvent(run.runId, 'run.business-process', businessProcess);
    runRepo.setResultMessage(run.runId, agentMsgId);
    _runCompletedCallback?.(run.runId, run.projectId, agentMsgId);
    await captureRunMemory(run, agentMsgId, responseText);
    runRepo.addEvent(run.runId, 'agent.completed', {
      definitionId: 'builtin.knowledge-manager',
      reportLength,
      resultLength: responseText.length,
      ...(businessProcess ? { businessProcessApplicable: businessProcess.applicable } : {}),
    });

    if (!window.isDestroyed()) {
      window.webContents.send('event:dispatch', {
        type: 'message.committed', projectId: run.projectId, messageId: agentMsgId, senderId, content: contentJson,
      });
      if (businessProcess) {
        window.webContents.send('event:dispatch', {
          type: 'run.business-process',
          projectId: run.projectId,
          runId: run.runId,
          agentId: senderId,
          ...lookupRunChainMetadata(runRepo, run.runId),
          businessProcess,
        });
      }
    }

    if (_scheduler) {
      processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, senderId, run.runId, 'agent', agentMsgId);
    }
    dispatchRunStatus(db, runRepo, window, run, 'completed');
  };

  const executor = async (run: QueuedRun, signal: AbortSignal): Promise<void> => {
    const logger = getLogger();

    const agentInstance = db.prepare(
      `SELECT pai.id, pai.role, pai.runtime_mode as runtimeMode, pai.cli_connection_id as cliConnectionId,
              ap.name as agentName, ap.definition_id as definitionId
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = ?`,
    ).get(run.agentInstanceId) as { id: string; role: string; runtimeMode: string; cliConnectionId: string | null; agentName: string; definitionId: string } | undefined;

    runRepo.addEvent(run.runId, 'agent.started', {
      definitionId: agentInstance?.definitionId ?? 'unknown',
      agentName: agentInstance?.agentName,
      instruction: run.instruction.slice(0, 200),
    });
    dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '读取角色卡与记忆', progress: 5 });
    dispatchRunTrace(db, runRepo, window, run, 'plan', '读取群聊角色卡、记忆和任务上下文', 'completed');

    if (agentInstance?.definitionId === 'builtin.orchestrator') {
      dispatchRunTrace(db, runRepo, window, run, 'plan', '拆解任务并选择执行成员', 'running');
      const contextBuilder = new ContextBuilder(db);
      return runOrchestrator(
        db, gateway, window,
        run.runId, run.projectId, run.agentInstanceId,
        run.instruction, run.triggerMessageId, signal,
        memory, registry, contextBuilder, _scheduler,
      ).then(async () => {
        const completed = runRepo.getById(run.runId);
        await captureRunMemory(run, completed.resultMessageId ?? null);
        runRepo.addEvent(run.runId, 'agent.completed', { definitionId: 'builtin.orchestrator' });
      }).catch((err) => {
        runRepo.addEvent(run.runId, 'agent.error', { definitionId: 'builtin.orchestrator', error: err instanceof Error ? err.message : String(err) });
        dispatchRunStatus(db, runRepo, window, run, 'failed', { error: err instanceof Error ? err.message : String(err) });
        throw err;
      });
    }

    if (agentInstance?.definitionId === 'builtin.knowledge-manager') {
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
        });
        return;
      }

      dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '执行知识处理', progress: 25 });
      dispatchRunTrace(db, runRepo, window, run, 'execution', '处理文档、知识图谱或 Wiki 任务', 'running');
      const workspaceRoot = app?.getPath?.('userData') ?? join(process.cwd(), '.runtime');
      const kmCtx: KMExecContext = {
        db,
        gateway,
        runId: run.runId,
        projectId: run.projectId,
        agentInstanceId: run.agentInstanceId,
        instruction: run.instruction,
        triggerMessageId: run.triggerMessageId,
        signal,
        workspaceRoot,
      };
      const report = await runKnowledgeManager(kmCtx);
      dispatchRunTrace(db, runRepo, window, run, 'execution', '知识处理完成，生成验收摘要', 'completed');

      const taskText = plainRunInstruction(run.instruction);
      const collaborationInstructions = buildAgentCollaborationInstructions(db, run.projectId, run.agentInstanceId);
      const researchAgent = db.prepare(
        `SELECT pai.id, ap.name
         FROM project_agent_instances pai
         JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
         WHERE pai.project_id = ? AND ap.definition_id = 'builtin.researcher' AND ap.enabled = 1
         LIMIT 1`,
      ).get(run.projectId) as { id: string; name: string } | undefined;
      const needsResearch = !report.startsWith('## 知识入库完成')
        && /(调研|研究|检索|查找|核实|资料|竞品|市场|行业|最新|外部|research)/i.test(taskText);

      let responseText = report;
      try {
        dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '判断是否需要补充资料调研', progress: 72 });
        dispatchRunTrace(db, runRepo, window, run, 'reasoning', '根据知识处理结果判断后续协作', 'running');
        const naturalResponse = await gateway.generateText('fast', [{
          role: 'user',
          content: `群聊交给你的任务：\n${taskText}\n\n知识处理流程返回：\n${report}\n\n请给出下一条正式群聊消息。如果现有资料不足且任务需要外部资料、事实核查或补充调研，就自然地 @资料调研智能体 并说明需要对方查什么、交回什么；否则直接给出简洁的处理结果。`,
        }], {
          system: `你是当前群聊的知识管理智能体。你负责把资料整理成可复用知识，也可以在确有必要时请资料调研智能体补充来源。\n\n${collaborationInstructions}\n\n正式消息像同事沟通，不要输出 NEED_AGENTS、NEED_CLI、NEED_KM，不要写“目标、输入、输出、验收条件”等底层提示词字段，不要机械汇报“已分配、正在等待”。`,
        });
        if (naturalResponse.text.trim() && !containsInternalAgentProtocol(naturalResponse.text)) {
          responseText = naturalResponse.text.trim();
        }
        dispatchRunTrace(db, runRepo, window, run, 'reasoning', '已确定知识处理的后续动作', 'completed');
      } catch (error) {
        logger?.warn({ error, runId: run.runId }, 'AgentExecutor: 知识管理协作判断失败，使用流程报告');
        dispatchRunTrace(db, runRepo, window, run, 'warning', '协作判断未完成，保留知识处理结果', 'failed');
      }

      let resolvedCollaborators = resolveAgentMentions(db, run.projectId, responseText)
        .filter((mention) => mention.target.scope === 'instance' && mention.target.id !== run.agentInstanceId);
      if (resolvedCollaborators.length === 0 && needsResearch && researchAgent) {
        const conciseTask = taskText.replace(/\s+/g, ' ').slice(0, 180);
        responseText = `@${researchAgent.name} 麻烦围绕“${conciseTask}”补充可核验的资料和关键结论，标明主要来源与仍不确定的部分；整理好后发回来，我继续归档。`;
        resolvedCollaborators = resolveAgentMentions(db, run.projectId, responseText)
          .filter((mention) => mention.target.scope === 'instance' && mention.target.id !== run.agentInstanceId);
      }

      if (resolvedCollaborators.length > 0) {
        const delegated = commitAgentText(run, run.agentInstanceId, responseText, 'progress');
        if (delegated.childRunIds.length > 0) {
          dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '等待资料调研结果', progress: 78 });
          dispatchRunTrace(db, runRepo, window, run, 'handoff', `等待 ${resolvedCollaborators.map((item) => item.label).join('、')} 返回资料`, 'running');
          const collaborationResult = await waitForChildRuns(run, delegated.childRunIds, signal);
          dispatchRunTrace(db, runRepo, window, run, 'handoff', '资料调研结果已返回，继续整理知识', 'completed', collaborationResult);
          try {
            const continuation = await gateway.generateText('fast', [{
              role: 'user',
              content: `原任务：\n${taskText}\n\n知识处理结果：\n${report}\n\n资料调研反馈：\n${collaborationResult}\n\n请把两部分整理成一条给负责人看的自然交付，只保留关键结论、来源情况、知识库处理状态和必要风险。`,
            }], {
              system: '你是知识管理智能体，正在完成收到调研反馈后的最终归档说明。这次不要再委派任何人，不要输出内部协议、系统字段或机械进度话术。',
            });
            if (continuation.text.trim() && !containsInternalAgentProtocol(continuation.text)) {
              responseText = continuation.text.trim();
            } else {
              responseText = `${report}\n\n${collaborationResult}`;
            }
          } catch {
            responseText = `${report}\n\n${collaborationResult}`;
          }
        } else {
          responseText = report;
        }
      }

      await completeKnowledgeManagerRun({
        run,
        senderId: agentInstance?.id ?? run.agentInstanceId,
        responseText,
        reportLength: report.length,
      });
      return;
    }

    // ── 外部 CLI 智能体执行 ──
    if (agentInstance?.runtimeMode === 'external-cli' && agentInstance.cliConnectionId) {
      const cliRow = db.prepare(`
        SELECT cc.id, cc.name, cc.adapter_type as adapterType, cc.executable_path as executablePath,
               cc.args_json as argsJson, cc.strategy_id as strategyId, cc.detected_version as detectedVersion,
               cc.status, cc.trust_tier as trustTier
        FROM cli_connections cc
        WHERE cc.id = ?
      `).get(agentInstance.cliConnectionId) as {
        id: string; name: string; adapterType: string; executablePath: string;
        argsJson: string | null; strategyId: string | null; detectedVersion: string | null;
        status: string; trustTier: 'trusted' | 'sandboxed' | 'restricted';
      } | undefined;

      if (cliRow) {
        const connection: import('@kunqing/agent-core').CliConnectionConfig = {
          id: cliRow.id, name: cliRow.name, adapterType: cliRow.adapterType,
          executablePath: cliRow.executablePath,
          args: cliRow.argsJson ? JSON.parse(cliRow.argsJson) : [],
          strategyId: cliRow.strategyId ?? 'auto',
          detectedVersion: cliRow.detectedVersion, status: cliRow.status,
          trustTier: cliRow.trustTier, capabilities: [], secretRefs: [],
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
        try {
          const ctxBuilder = new ContextBuilder(db);
          const snapshot = ctxBuilder.build(run.projectId, agentInstance.id, run.triggerMessageId);
          externalContext = ctxBuilder.renderToText(snapshot);
          await ctxBuilder.writeContextManifest(snapshot, privateWorkspaceRoot);
        } catch { /* 非致命 */ }

        dispatchRunStatus(db, runRepo, window, run, 'running', { message: `${agentInstance.agentName}正在执行`, stage: `正在执行：${plainRunInstruction(run.instruction).slice(0, 80)}`, progress: 20 });
        dispatchRunTrace(db, runRepo, window, run, 'reasoning', `${agentInstance.agentName}正在拆解自己的执行任务`, 'running');

        // 使用适配器的 run 方法（含策略构建 args），兜底用 cliExecutor
        let result: import('./cli-executor').CliRunResult;
        if (adapter && 'run' in adapter) {
          try {
            const isCodeBuddy = connection.adapterType === 'codebuddy';
            const compactCodeBuddyInstruction = `请直接处理这条群聊消息，并完整理解其中的所有内容（包括位于开头、中间或结尾的 @提及）：\n\n${plainRunInstruction(run.instruction)}\n\n你在群聊中显示为“${agentInstance.agentName}”。可以读取当前隔离目录中只属于你的 identity/ 和 memory/，成果文件写入 outputs/。回复要像同事之间自然沟通，只说实际进展和结果；不要复述提示词、身份文件、记忆、成员名单，也不要使用“目标”“当前输入”“技术框架”“执行约束”等系统化字段。`;
            const fullExternalInstruction = isCodeBuddy
              ? compactCodeBuddyInstruction
              : `${plainRunInstruction(run.instruction)}

请直接、自然地在最终输出中回复上面的群聊消息，这就是用户真正想问的，直接给出答案；除非任务确实需要生成文件成果，否则不要写任何文件，也不要调用工具。你在群聊中显示为“${agentInstance.agentName}”。`;
            let externalChecklist: RunChecklistItem[] = [];
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
            if (externalChecklist.length > 1) {
              externalChecklist = externalChecklist.map((item, index) => index === 0 ? { ...item, status: 'in_progress' } : item);
              dispatchRunChecklist(db, runRepo, window, run, externalChecklist);
            }
            dispatchRunTrace(db, runRepo, window, run, 'execution', `${agentInstance.agentName}开始执行自己的任务`, 'running');
            const externalResult = await adapter.run(
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
        dispatchRunTrace(db, runRepo, window, run, 'execution', `${agentInstance.agentName}执行完成`, result.exitCode === 0 ? 'completed' : 'failed');
        for (const path of preparedOutput.publishedPaths) {
          dispatchRunTrace(db, runRepo, window, run, 'file', '发布成果文件', 'completed', path);
        }

        let resultMessageId: string | null = null;
        if (output) {
          const agentMsgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
          resultMessageId = agentMsgId;

          for (let i = 0, seq = 0; i < output.length; i += 3, seq++) {
            if (signal?.aborted) break;
            if (!window.isDestroyed()) {
              window.webContents.send('event:dispatch', {
                type: 'message.delta', projectId: run.projectId, messageId: agentMsgId, seq, delta: output.slice(i, i + 3),
              });
            }
          }

          const delivery = prepareParentDelivery(db, runRepo, run.runId, output);
          const contentJson = normalizeAgentMessageContent(
            db,
            run.projectId,
            JSON.stringify({ schemaVersion: 1, text: delivery.text, mentions: delivery.mentions, stagedUploadIds: [] }),
            delivery.mentions,
            agentInstance.id,
          );
          const now = new Date().toISOString();
          db.prepare(
            'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(agentMsgId, run.projectId, 'agent', agentInstance.id, 'text', contentJson, 'sent', now, now);
          runRepo.addEvent(run.runId, 'run.anchor', { messageId: agentMsgId });

          runRepo.setResultMessage(run.runId, agentMsgId);
          _runCompletedCallback?.(run.runId, run.projectId, agentMsgId);

          // 处理消息中的 @mention，触发目标智能体调度
          if (_scheduler) {
            processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, run.agentInstanceId, run.runId, 'agent', agentMsgId);
          }

          dispatchRunStatus(db, runRepo, window, run, 'completed');
          if (!window.isDestroyed()) {
            window.webContents.send('event:dispatch', {
              type: 'message.committed', projectId: run.projectId, messageId: agentMsgId, senderId: agentInstance.id, content: contentJson,
            });
          }
        } else {
          dispatchRunStatus(db, runRepo, window, run, 'completed', { message: `${agentInstance.agentName}执行完毕（无文本输出）` });
        }

        await captureRunMemory(run, resultMessageId, output, preparedOutput.publishedPaths);
        runRepo.addEvent(run.runId, 'agent.completed', { definitionId: agentInstance.definitionId, cli: true, charCount: output.length });
        return;
      }
    }

    logger?.info({ runId: run.runId, agentInstanceId: run.agentInstanceId }, 'AgentExecutor: 直接模式');

    try {
      dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '分析任务并准备执行', progress: 20 });
      dispatchRunTrace(db, runRepo, window, run, 'reasoning', '分析任务并确定执行步骤', 'running');
      const projectInfo = db.prepare('SELECT name FROM projects WHERE id = ?').get(run.projectId) as { name: string } | undefined;
      const recentMessages = db.prepare(
        `SELECT sender_type as senderType, content_json as contentJson, created_at as createdAt
         FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`,
      ).all(run.projectId) as Array<{ senderType: string; contentJson: string; createdAt: string }>;

      const agentName = agentInstance?.agentName ?? '智能体';
      const snapshot = new ContextBuilder(db).build(run.projectId, run.agentInstanceId, run.triggerMessageId);
      const memoryContext = [
        snapshot.memory.longTerm.length ? `群聊长期记忆：\n${snapshot.memory.longTerm.map((item) => `- ${item}`).join('\n')}` : '',
        snapshot.memory.shortTerm.length ? `相关任务记忆：\n${snapshot.memory.shortTerm.map((item) => `- ${item}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n');

      const collaborationInstructions = buildAgentCollaborationInstructions(db, run.projectId, run.agentInstanceId);
      const systemMsg = `你是 ${agentName}，一个多智能体协作系统中的 AI 智能体。
当前项目：${projectInfo?.name ?? run.projectId}

## 本群聊角色卡与身份
${snapshot.agent.identity || '请按照当前智能体名称和群聊分工执行任务。'}

执行任务前必须遵守以上角色卡，并使用本群聊中召回的记忆；不得沿用其他群聊的身份或记忆。

你的回复应该专业、准确。使用 Markdown 格式输出。
${memoryContext ? `\n${memoryContext}` : ''}

${collaborationInstructions}`;

      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = recentMessages.reverse().slice(-15).map((m) => ({
        role: m.senderType === 'user' ? 'user' as const : 'assistant' as const,
        content: (() => { try { return JSON.parse(m.contentJson).text ?? m.contentJson; } catch { return m.contentJson; } })(),
      }));

      const slot: ModelSlot = agentInstance?.definitionId === 'builtin.knowledge-manager' ? 'fast' : 'reasoning';
      const planResult = await gateway.generateText(slot, [
        ...messages,
        { role: 'user', content: `当前负责人任务：${run.instruction}\n\n请判断这是单一任务还是复合任务，并返回 JSON：{"summary":"执行目标","items":["可验收步骤"]}。单一任务只能有 1 项；复合任务拆成 2-8 项。只输出 JSON，不输出思维过程。` },
      ], { system: systemMsg });
      const plan = parseTaskPlan(planResult.text, run.instruction.slice(0, 300));
      const compound = plan.items.length > 1;
      let checklist: RunChecklistItem[] = plan.items.map((title, index) => ({ id: `step-${index + 1}`, title, status: 'pending' }));
      if (compound) dispatchRunChecklist(db, runRepo, window, run, checklist);
      dispatchRunTrace(db, runRepo, window, run, 'reasoning', compound ? `已形成 ${plan.items.length} 项执行清单` : '已确认单一执行项', 'completed', plan.summary);

      const toolRole: LocalAgentRole = agentInstance?.definitionId === 'builtin.knowledge-manager'
        ? 'knowledge-manager'
        : agentInstance?.runtimeMode === 'external-cli'
          ? 'external-cli'
          : agentInstance?.role === 'leader'
            ? 'orchestrator'
            : 'researcher';
      const toolDefinitions = Object.fromEntries(registry.getDefinitionsForRole(toolRole).map((tool) => [tool.name, { description: tool.description, parameters: tool.parameters }]));
      const completedSteps: string[] = [];
      const allPublishedPaths = new Set<string>();

      for (let stepIndex = 0; stepIndex < plan.items.length; stepIndex++) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const step = plan.items[stepIndex]!;
        if (compound) {
          checklist = checklist.map((item, index) => index === stepIndex ? { ...item, status: 'in_progress' } : item);
          dispatchRunChecklist(db, runRepo, window, run, checklist);
        }
        const progress = 20 + Math.round((stepIndex / Math.max(plan.items.length, 1)) * 60);
        dispatchRunStatus(db, runRepo, window, run, 'running', { stage: `正在处理：${step}`, progress });
        dispatchRunTrace(db, runRepo, window, run, 'execution', `执行：${step}`, 'running');

        const stepConversation: Array<{ role: 'user' | 'assistant'; content: string }> = [
          ...messages,
          { role: 'user', content: `负责人总任务：${run.instruction}\n\n我的执行清单：${plan.items.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n\n已完成：${completedSteps.join('\n') || '暂无'}\n\n现在只执行第 ${stepIndex + 1} 项：${step}\n如果需要另一个智能体完成下一环节，请在本步骤汇报中使用准确中文名 @对方，并写清目标、输入、输出和验收条件；如果需要人工决定，使用 @用户。` },
        ];
        let stepText = '';
        for (let round = 0; round < 4; round++) {
          const generated = await gateway.generateText(slot, stepConversation, { system: `${systemMsg}\n\n你正在执行清单中的单个步骤。先完成可用工具调用，再给出本步骤可验收结果。不要输出隐藏思维过程。`, tools: toolDefinitions });
          if (!generated.toolCalls?.length) {
            stepText = generated.text.trim();
            break;
          }
          const toolResults: string[] = [];
          for (const call of generated.toolCalls) {
            const skillName = getSkillDisplayName(call.name);
            const targetPath = call.name === 'publish_artifact' && typeof call.args.relativePath === 'string' ? call.args.relativePath : null;
            const skillStage = targetPath ? `正在生成 ${targetPath} 文件` : `正在调用${skillName}技能`;
            dispatchRunStatus(db, runRepo, window, run, 'running', { stage: skillStage, progress: Math.min(progress + 8, 88) });
            dispatchRunTrace(db, runRepo, window, run, 'tool', targetPath ? `正在生成 ${targetPath} 文件` : `正在调用${skillName}技能完成“${step}”`, 'running');
            const result = await registry.execute(call.name, call.args, { role: toolRole, runId: run.runId, projectId: run.projectId });
            dispatchRunTrace(db, runRepo, window, run, 'tool', `${skillName}技能调用完成`, result.startsWith('工具执行失败') ? 'failed' : 'completed', result);
            toolResults.push(`${call.name}: ${result}`);
            if (call.name === 'publish_artifact' && typeof call.args.relativePath === 'string') {
              toolResults.push(`ARTIFACT: ${call.args.relativePath}`);
            }
          }
          if (generated.text.trim()) stepConversation.push({ role: 'assistant', content: generated.text.trim() });
          stepConversation.push({ role: 'user', content: `工具执行结果：\n${toolResults.join('\n\n')}\n\n请继续完成当前步骤。` });
        }
        if (!stepText) stepText = `已处理执行项：${step}`;

        const preparedStep = await artifactPublisher.publishFromOutput({
          projectId: run.projectId,
          agentInstanceId: run.agentInstanceId,
          runId: run.runId,
          triggerMessageId: run.triggerMessageId,
          text: stepText,
        });
        stepText = preparedStep.text;
        for (const path of preparedStep.publishedPaths) {
          allPublishedPaths.add(path);
          dispatchRunTrace(db, runRepo, window, run, 'file', '发布成果文件', 'completed', path);
        }

        const senderId = agentInstance?.id ?? run.agentInstanceId;
        const shouldReportProgress = resolveAgentMentions(db, run.projectId, stepText)
          .some((mention) => mention.target.scope === 'user' || mention.target.id !== senderId);
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

        completedSteps.push(`${stepIndex + 1}. ${step}\n${stepText}${collaborationResult ? `\n协作反馈：${collaborationResult}` : ''}`);
        if (compound) {
          checklist = checklist.map((item, index) => index === stepIndex ? { ...item, status: 'completed', detail: stepText.slice(0, 240) } : item);
          dispatchRunChecklist(db, runRepo, window, run, checklist);
        }
        dispatchRunTrace(db, runRepo, window, run, 'execution', `完成：${step}`, 'completed', stepText);
      }

      dispatchRunStatus(db, runRepo, window, run, 'running', { stage: '正在生成任务交付说明与成果汇报', progress: 92 });
      dispatchRunTrace(db, runRepo, window, run, 'reasoning', '汇总全部执行项并准备交付', 'running');
      const finalResult = await gateway.generateText(slot, [{
        role: 'user',
        content: `负责人任务：${run.instruction}\n\n我的全部执行结果：\n${completedSteps.join('\n\n')}\n\n成果文件：${[...allPublishedPaths].join('、') || '无'}\n\n请向任务负责人交付，说明完成项、结果、成果路径和剩余风险。不要重复输出完整 HTML，不要输出运行状态或隐藏思维。`,
      }], { system: systemMsg });
      let fullText = finalResult.text.trim() || completedSteps[completedSteps.length - 1] || '任务已完成。';
      dispatchRunTrace(db, runRepo, window, run, 'reasoning', '负责人交付内容已生成', 'completed');
      const agentMsgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);

      const preparedOutput = await artifactPublisher.publishFromOutput({
        projectId: run.projectId,
        agentInstanceId: run.agentInstanceId,
        runId: run.runId,
        triggerMessageId: run.triggerMessageId,
        text: fullText,
      });
      fullText = preparedOutput.text;
      for (const path of preparedOutput.publishedPaths) allPublishedPaths.add(path);
      for (const path of preparedOutput.publishedPaths) {
        dispatchRunTrace(db, runRepo, window, run, 'file', '发布成果文件', 'completed', path);
      }
      const delivery = prepareParentDelivery(db, runRepo, run.runId, fullText);
      const contentJson = normalizeAgentMessageContent(
        db,
        run.projectId,
        JSON.stringify({ schemaVersion: 1, text: delivery.text, mentions: delivery.mentions, stagedUploadIds: [] }),
        delivery.mentions,
        agentInstance?.id ?? run.agentInstanceId,
      );
      const now = new Date().toISOString();

      db.prepare(
        'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(agentMsgId, run.projectId, 'agent', agentInstance?.id ?? run.agentInstanceId, 'text', contentJson, 'sent', now, now);
      runRepo.addEvent(run.runId, 'run.anchor', { messageId: agentMsgId });

      runRepo.setResultMessage(run.runId, agentMsgId);
      _runCompletedCallback?.(run.runId, run.projectId, agentMsgId);
      await captureRunMemory(run, agentMsgId, fullText, [...allPublishedPaths]);

      // 处理消息中的 @mention，触发目标智能体调度
      if (_scheduler) {
        processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, run.agentInstanceId, run.runId, 'agent', agentMsgId);
      }

      dispatchRunStatus(db, runRepo, window, run, 'completed');
      if (!window.isDestroyed()) {
        window.webContents.send('event:dispatch', {
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
      if (err instanceof DOMException && err.name === 'AbortError') {
        runRepo.setStatus(run.runId, 'cancelled');
        runRepo.addEvent(run.runId, 'agent.error', { definitionId: 'direct', error: '用户取消' });
        dispatchRunStatus(db, runRepo, window, run, 'cancelled');
        return;
      }
      throw err;
    }
  };

  executor.setScheduler = (s: Scheduler) => {
    _scheduler = s;
    tools = createProjectTools(db, s);
  };

  executor.onRunCompleted = (cb: (runId: string, projectId: string, resultMessageId: string) => void) => {
    _runCompletedCallback = cb;
  };

  return executor;
}
