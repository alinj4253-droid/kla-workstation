import { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { runOrchestrator as coreRunOrchestrator } from '@kunqing/native-agent-core';
import type { IGraphContext, ExecContextSnapshot, SubRunParams, CreateSubRunInput, AgentRole, CollaborationMode } from '@kunqing/native-agent-core';
import type { ModelSlot, ModelMessage, GenerateOptions, GenerateResult } from '@kunqing/model-core';
import { ModelGateway } from './model-gateway';
import { MemoryManager } from './memory-manager';
import { ContextBuilder, type ContextSnapshot } from './context-builder';
import { ToolRegistry } from './tool-registry';
import type { AgentRole as LocalAgentRole } from './tool-registry';
import { AgentRunRepository } from '@kunqing/database';
import { getLogger } from './logger';
import { getProjectRoot } from './paths';
import { Scheduler } from './scheduler';
import { broadcastEvent } from './event-broadcast';
import { getAcceptanceReviewBudget, normalizeRoutedInstruction, processMessageMentions } from './message-router';
import { createHash, randomUUID } from 'node:crypto';
import {
  findEquivalentAgentTaskMessage,
  findDuplicateAwaitingUserMessage,
  messageRequestsUserResponse,
  normalizeAgentMessageContent,
} from './agent-collaboration';
import { AgentArtifactPublisher } from './agent-artifact-publisher';
import { getSkillDisplayName } from './skill-display';
import { streamAgentMessage } from './message-stream';
import { buildModelProfileSnapshot } from './project-creator';
import { reserveRetrievalBudget } from './retrieval-budget';
import { listProjectCoordinationRegistry } from './coordination-registry';
import { TaskPlanStore } from './task-plan-store';

export type ExecContext = IGraphContext;

export async function runOrchestrator(
  db: Database.Database,
  gateway: ModelGateway,
  window: BrowserWindow,
  runId: string,
  projectId: string,
  agentInstanceId: string,
  instruction: string,
  triggerMessageId: string,
  signal: AbortSignal,
  memory: MemoryManager,
  toolRegistry: ToolRegistry,
  contextBuilder: ContextBuilder,
  scheduler: Scheduler | undefined,
  collaborationMode: CollaborationMode = 'expert',
): Promise<void> {
  const runRepo = new AgentRunRepository(db);
  const logger = getLogger();
  const artifactPublisher = new AgentArtifactPublisher(db, (event) => {
    broadcastEvent(window, event);
  });
  const taskPlanStore = new TaskPlanStore(db);
  // 子任务 Run 通过 parent_run_id 注入父任务结果，避免委派后丢失上游产出。
  let parentRunId: string | undefined;
  try {
    parentRunId = (runRepo.getById(runId) as { parentRunId: string | null }).parentRunId ?? undefined;
  } catch {
    parentRunId = undefined;
  }
  const fullSnapshot = collaborationMode === 'fast'
    ? new ContextBuilder(db, { recentMessageLimit: 4, knowledgeChunkLimit: 2, sharedKnowledgeChunkLimit: 1 })
      .build(projectId, agentInstanceId, triggerMessageId, parentRunId)
    : collaborationMode === 'balanced'
      ? new ContextBuilder(db, { recentMessageLimit: 6, knowledgeChunkLimit: 4, sharedKnowledgeChunkLimit: 2 })
        .build(projectId, agentInstanceId, triggerMessageId, parentRunId)
      : contextBuilder.build(projectId, agentInstanceId, triggerMessageId, parentRunId);

  const ctx: IGraphContext = {
    projectId,
    agentInstanceId,
    runId,
    instruction,
    triggerMessageId,
    signal,
    workspaceRoot: getProjectRoot(projectId),
    collaborationMode,

    services: {
      generateText(slot: ModelSlot, messages: ModelMessage[], options?: GenerateOptions): Promise<GenerateResult> {
        const systemMsg = messages.find((m) => m.role === 'system')?.content;
        const chatMessages = messages.filter((m) => m.role !== 'system') as Array<{ role: 'user' | 'assistant'; content: string }>;
        const genOptions: GenerateOptions & { system?: string } = { ...(options ?? {}) };
        if (systemMsg) genOptions.system = systemMsg;
        const effectiveSlot: ModelSlot = collaborationMode === 'fast' && slot === 'reasoning' ? 'fast' : slot;
        return gateway.generateText(effectiveSlot, chatMessages, genOptions);
      },

      getToolDefinitions(role: AgentRole) {
        return toolRegistry.getDefinitionsForRole(role as LocalAgentRole);
      },

      async executeTool(name: string, args: Record<string, unknown>, role: AgentRole, context: { runId?: string; projectId?: string }) {
        const traceId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 16);
        const skillName = getSkillDisplayName(name);
        const started = { id: traceId, kind: name === 'delegate_tasks' ? 'handoff' : 'tool', title: name === 'delegate_tasks' ? '正在调用智能体任务委派技能创建子任务' : `正在调用${skillName}技能`, status: 'running', detail: `技能标识：${name}\n${JSON.stringify(args).slice(0, 420)}`, at: new Date().toISOString() };
        runRepo.addEvent(runId, 'run.trace', started);
        if (!window.isDestroyed()) broadcastEvent(window, { type: 'run.trace', projectId, runId, agentId: agentInstanceId, trace: started });
        try {
          let result: string;
          if ((name === 'web:search' || name === 'knowledge:search') && (context.runId || runId)) {
            const kind = name === 'web:search' ? 'web' : 'knowledge';
            const query = typeof args.query === 'string' ? args.query.trim() : '';
            const reservation = reserveRetrievalBudget(
              db,
              runRepo,
              context.runId ?? runId,
              collaborationMode,
              kind,
              query,
            );
            if (reservation.status === 'duplicate') {
              result = `已跳过当前任务节点中重复或高度相似的${kind === 'web' ? '网页搜索' : '知识检索'}，请使用已经取得的证据。`;
            } else if (reservation.status === 'exhausted') {
              result = `当前任务节点已达到 ${reservation.budget} 次检索预算，请基于已经取得的内部和外部证据继续处理。`;
            } else {
              result = await toolRegistry.execute(name, args, { role: role as LocalAgentRole, ...context });
            }
          } else {
            result = await toolRegistry.execute(name, args, { role: role as LocalAgentRole, ...context });
          }
          const completed = { ...started, status: 'completed', detail: result.slice(0, 500), at: new Date().toISOString() };
          runRepo.addEvent(runId, 'run.trace', completed);
          if (!window.isDestroyed()) broadcastEvent(window, { type: 'run.trace', projectId, runId, agentId: agentInstanceId, trace: completed });
          return result;
        } catch (error) {
          const failed = { ...started, status: 'failed', detail: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
          runRepo.addEvent(runId, 'run.trace', failed);
          if (!window.isDestroyed()) broadcastEvent(window, { type: 'run.trace', projectId, runId, agentId: agentInstanceId, trace: failed });
          throw error;
        }
      },

      async createFileRecord(projectId: string, relativePath: string, content: string, agentInstanceId: string, runId: string, note?: string) {
        await artifactPublisher.publishExisting({
          projectId,
          agentInstanceId,
          runId,
          triggerMessageId,
          relativePath,
          ...(note ? { note } : {}),
        });
      },

      async insertMessage(projectId: string, senderId: string, kind: string, contentJson: string): Promise<string> {
        const existingResult = runRepo.getById(runId).resultMessageId;
        if (existingResult) return existingResult;
        const id = createHash('sha256').update(`agent-message:${runId}:final`).digest('hex').slice(0, 24);
        const now = new Date().toISOString();
        const normalizedContent = kind === 'text'
          ? normalizeAgentMessageContent(db, projectId, contentJson, [], senderId)
          : contentJson;
        const equivalentMessageId = findEquivalentAgentTaskMessage(db, {
          projectId,
          triggerMessageId,
          senderId,
          kind,
          contentJson: normalizedContent,
          excludeRunId: runId,
        });
        if (equivalentMessageId) {
          runRepo.setResultMessage(runId, equivalentMessageId);
          runRepo.addEvent(runId, 'run.final-message-reused', {
            messageId: equivalentMessageId,
            reason: 'equivalent-root-task-message',
          });
          return equivalentMessageId;
        }
        if (kind === 'text' && messageRequestsUserResponse(normalizedContent)) {
          const duplicateMessageId = findDuplicateAwaitingUserMessage(db, projectId, triggerMessageId, normalizedContent, runId);
          if (duplicateMessageId) {
            runRepo.setResultMessage(runId, duplicateMessageId);
            runRepo.setStatus(runId, 'awaiting_user');
            runRepo.addEvent(runId, 'run.user-question-deduplicated', { duplicateMessageId });
            return duplicateMessageId;
          }
        }
        const inserted = db.prepare(
          'INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, projectId, 'agent', senderId, kind, normalizedContent, 'sent', now, now);
        if (inserted.changes === 0) return id;
        runRepo.addEvent(runId, 'run.anchor', { messageId: id });

        if (kind === 'text' && !window.isDestroyed()) {
          let streamText = normalizedContent;
          try { streamText = (JSON.parse(normalizedContent) as { text?: string }).text ?? normalizedContent; } catch { /* use raw */ }
          await streamAgentMessage(window, { projectId, messageId: id, senderId, text: streamText }, signal);
        }

        // 整条智能体协作链沿用最初的 triggerMessageId。
        // 这样每条用户消息最多 20 个 Run 的限制不会因智能体回复产生新消息而被重置。
        if (scheduler) {
          processMessageMentions(
            db, runRepo, scheduler, projectId, normalizedContent, triggerMessageId, senderId, runId, 'agent', id,
            (notice) => {
              broadcastEvent(window, {
                type: 'message.committed', projectId, messageId: notice.messageId, senderId: 'system', content: notice.contentJson,
              });
            },
          );
        }
        broadcastEvent(window, {
          type: 'message.committed', projectId, messageId: id, senderId, content: normalizedContent,
        });

        return id;
      },

      async sendDelegationMessage(input) {
        const target = db.prepare(
          `SELECT ap.definition_id as definitionId
           FROM project_agent_instances pai
           JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
           WHERE pai.id = ? AND pai.project_id = ?`,
        ).get(input.targetAgentInstanceId, input.projectId) as { definitionId: string } | undefined;
        if (target?.definitionId === 'builtin.acceptance-reviewer'
          && !getAcceptanceReviewBudget(db, input.rootTriggerMessageId).allowed) {
          return { messageId: '', childRunIds: [] };
        }
        const text = `@${input.targetAgentName} ${input.visibleInstruction?.trim() || input.instruction}`;
        const requestedMention = {
          target: { scope: 'instance' as const, id: input.targetAgentInstanceId },
          label: input.targetAgentName,
          start: 0,
          end: input.targetAgentName.length + 1,
        };
        const contentJson = normalizeAgentMessageContent(db, input.projectId, JSON.stringify({
          schemaVersion: 1,
          text,
          mentions: [requestedMention],
          stagedUploadIds: [],
          messageType: 'delegation',
          audience: { scope: 'instance', id: input.targetAgentInstanceId },
        }), [requestedMention], input.senderId);
        const dispatchKey = [
          input.rootTriggerMessageId,
          input.parentRunId,
          input.targetAgentInstanceId,
          normalizeRoutedInstruction(input.instruction),
        ].join(':');
        const messageId = createHash('sha256').update(`agent-delegation:${dispatchKey}`).digest('hex').slice(0, 24);
        const now = new Date().toISOString();
        const inserted = db.prepare(
          'INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(messageId, input.projectId, 'agent', input.senderId, 'text', contentJson, 'sent', now, now);
        const routingText = `@${input.targetAgentName} ${input.instruction}`;
        const routingContentJson = normalizeAgentMessageContent(db, input.projectId, JSON.stringify({
          schemaVersion: 1,
          text: routingText,
          mentions: [requestedMention],
          stagedUploadIds: [],
          messageType: 'delegation',
          audience: { scope: 'instance', id: input.targetAgentInstanceId },
        }), [requestedMention], input.senderId);
        const childRunIds = scheduler
          ? processMessageMentions(
            db, runRepo, scheduler, input.projectId, routingContentJson, input.rootTriggerMessageId,
            input.senderId, input.parentRunId, 'agent', messageId,
            (notice) => {
              broadcastEvent(window, {
                type: 'message.committed', projectId: input.projectId, messageId: notice.messageId, senderId: 'system', content: notice.contentJson,
              });
            },
          )
          : [];
        if (inserted.changes > 0) {
          broadcastEvent(window, {
            type: 'message.committed', projectId: input.projectId, messageId, senderId: input.senderId, content: contentJson,
          });
        }
        return { messageId, childRunIds };
      },

      async sendOrchestratorNote(input) {
        // 协调说明（例如子需求清单）只做群聊展示，不触发成员 Run。
        const messageId = createHash('sha256')
          .update(`orchestrator-note:${input.runId}:${input.text}`)
          .digest('hex')
          .slice(0, 24);
        const contentJson = normalizeAgentMessageContent(db, input.projectId, JSON.stringify({
          schemaVersion: 1,
          text: input.text,
          mentions: [],
          stagedUploadIds: [],
        }), [], input.senderId);
        const now = new Date().toISOString();
        const inserted = db.prepare(
          'INSERT OR IGNORE INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(messageId, input.projectId, 'agent', input.senderId, 'text', contentJson, 'sent', now, now);
        if (inserted.changes > 0 && !window.isDestroyed()) {
          broadcastEvent(window, {
            type: 'message.committed', projectId: input.projectId, messageId, senderId: input.senderId, content: contentJson,
          });
        }
        return messageId;
      },

      setRunStatus(runId: string, status: string, error?: { errorCode?: string; errorMessage?: string }) {
        const opts: Record<string, string> = {};
        if (error?.errorCode) opts.errorCode = error.errorCode;
        if (error?.errorMessage) opts.errorMessage = error.errorMessage;
        runRepo.setStatus(runId, status as any, opts);
      },

      setResultMessage(runId: string, messageId: string) {
        runRepo.setResultMessage(runId, messageId);
      },

      addRunEvent(runId: string, type: string, payload: Record<string, unknown>) {
        runRepo.addEvent(runId, type, payload);
      },

      getRunEvents(runId: string) {
        return runRepo.listEvents(runId).flatMap((event) => {
          if (!event.payloadJson) return [{ type: event.type }];
          try {
            const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
            return [{ type: event.type, payload }];
          } catch {
            return [{ type: event.type }];
          }
        });
      },

      getRunStatus(runId: string) {
        const run = runRepo.getById(runId);
        return {
          status: run.status as string,
          resultMessageId: run.resultMessageId ?? undefined,
          errorMessage: run.errorMessage ?? undefined,
        } as { status: string; resultMessageId?: string; errorMessage?: string };
      },

      getRunDescendants(rootRunId: string) {
        return db.prepare(
          `WITH RECURSIVE descendants AS (
             SELECT id, parent_run_id, agent_instance_id, status, result_message_id, error_message, created_at
             FROM agent_runs WHERE parent_run_id = ?
             UNION ALL
             SELECT child.id, child.parent_run_id, child.agent_instance_id, child.status,
                    child.result_message_id, child.error_message, child.created_at
             FROM agent_runs child
             JOIN descendants parent ON child.parent_run_id = parent.id
           )
           SELECT id as runId, agent_instance_id as agentInstanceId, status,
                  result_message_id as resultMessageId, error_message as errorMessage
           FROM descendants ORDER BY created_at`,
        ).all(rootRunId) as Array<{
          runId: string;
          agentInstanceId: string;
          status: string;
          resultMessageId?: string;
          errorMessage?: string;
        }>;
      },

      getRunArtifacts(rootRunId: string, recursive = false) {
        const runIds = [
          rootRunId,
          ...(recursive ? (this.getRunDescendants?.(rootRunId) ?? []).map((run) => run.runId) : []),
        ];
        const artifacts: Array<{
          relativePath: string; fileId?: string; versionId?: string; messageId?: string; sha256?: string;
        }> = [];
        for (const artifactRunId of runIds) {
          for (const event of runRepo.listEvents(artifactRunId)) {
            if (event.type !== 'run.artifact-published' || !event.payloadJson) continue;
            try {
              const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
              if (typeof payload.relativePath !== 'string' || !payload.relativePath) continue;
              artifacts.push({
                relativePath: payload.relativePath,
                ...(typeof payload.fileId === 'string' ? { fileId: payload.fileId } : {}),
                ...(typeof payload.versionId === 'string' ? { versionId: payload.versionId } : {}),
                ...(typeof payload.messageId === 'string' ? { messageId: payload.messageId } : {}),
                ...(typeof payload.sha256 === 'string' ? { sha256: payload.sha256 } : {}),
              });
            } catch { /* ignore malformed legacy event */ }
          }
        }
        return [...new Map(artifacts.map((artifact) => [artifact.sha256 || artifact.relativePath, artifact])).values()];
      },

      getParentRunId(runId: string): string | null {
        try {
          const run = runRepo.getById(runId);
          return run.parentRunId ?? null;
        } catch {
          return null;
        }
      },

      getRunAgentInstanceId(runId: string): string | null {
        try {
          const run = runRepo.getById(runId);
          return run.agentInstanceId;
        } catch {
          return null;
        }
      },

      getAgentDisplayName(targetAgentInstanceId: string): string | null {
        const row = db.prepare(
          `SELECT ap.name FROM project_agent_instances pai
           JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
           WHERE pai.id = ?`,
        ).get(targetAgentInstanceId) as { name: string } | undefined;
        return row?.name ?? null;
      },

      createSubRun(input: CreateSubRunInput): string {
        const opts: Record<string, unknown> = {
          projectId: input.projectId,
          agentInstanceId: input.agentInstanceId,
          requestedByType: input.requestedByType,
          requestedById: input.requestedById,
        };
        if (input.instruction) opts.instruction = input.instruction;
        if (input.parentRunId) opts.parentRunId = input.parentRunId;
        const modelSnapshot = input.modelProfileSnapshotJson ?? buildModelProfileSnapshot(db, input.agentInstanceId);
        if (modelSnapshot !== null) opts.modelProfileSnapshotJson = modelSnapshot;
        const run = runRepo.create(opts as any);
        return run.id;
      },

      enqueueRun(params: SubRunParams) {
        if (scheduler) {
          scheduler.enqueue({
            runId: params.runId,
            projectId: params.projectId,
            agentInstanceId: params.agentInstanceId,
            instruction: params.instruction,
            triggerMessageId: params.triggerMessageId,
          });
        }
      },

      emitEvent(event: Record<string, unknown>) {
        if (!window.isDestroyed()) {
          const eventRun = event.run && typeof event.run === 'object' ? event.run as Record<string, unknown> : null;
          const eventRunId = typeof event.runId === 'string' ? event.runId : typeof eventRun?.id === 'string' ? eventRun.id : runId;
          let chainMetadata: Record<string, unknown> = {};
          try {
            const persisted = runRepo.getById(eventRunId);
            chainMetadata = {
              ...(persisted.triggerMessageId ? { triggerMessageId: persisted.triggerMessageId } : {}),
              ...(persisted.parentRunId ? { parentRunId: persisted.parentRunId } : {}),
              requestedByType: persisted.requestedByType,
              requestedById: persisted.requestedById,
              createdAt: persisted.createdAt,
            };
          } catch { /* omit metadata for an event without a persisted Run */ }
          const anchorEvent = [...runRepo.listEvents(eventRunId)].reverse().find((item) => item.type === 'run.anchor' && item.payloadJson);
          let anchorMessageId: string | null = null;
          if (anchorEvent?.payloadJson) {
            try {
              const parsed = JSON.parse(anchorEvent.payloadJson) as { messageId?: unknown };
              if (typeof parsed.messageId === 'string') anchorMessageId = parsed.messageId;
            } catch { /* omit invalid anchor */ }
          }
          broadcastEvent(window, eventRun
            ? { ...event, ...chainMetadata, run: { ...eventRun, ...chainMetadata, ...(anchorMessageId ? { anchorMessageId } : {}) } }
            : { ...event, ...chainMetadata, ...(anchorMessageId ? { anchorMessageId } : {}) });
        }
      },

      storeMemory(projectId: string, agentInstanceId: string, type: string, content: string, confidence?: number) {
        memory.storeShortTerm(projectId, agentInstanceId, type, content, confidence);
      },

      consolidateMemory(projectId: string, agentInstanceId: string): number {
        return memory.consolidateShortTerm(projectId, agentInstanceId);
      },

      extractLongTermMemory(projectId: string, agentInstanceId: string): number {
        return memory.extractLongTerm(projectId, agentInstanceId);
      },

      buildMemoryContext(projectId: string, agentInstanceId: string, query = ''): string {
        if (query.trim()) {
          const recalled = memory.recallRelevant(
            query,
            projectId,
            agentInstanceId,
            collaborationMode === 'fast' ? 2 : collaborationMode === 'balanced' ? 3 : 4,
          ).join('\n');
          return recalled.slice(0, collaborationMode === 'fast' ? 800 : collaborationMode === 'balanced' ? 1_200 : 1_800);
        }
        return memory.buildMemoryContext(projectId, agentInstanceId).slice(
          0,
          collaborationMode === 'fast' ? 1_000 : collaborationMode === 'balanced' ? 1_500 : 2_000,
        );
      },

      async buildContextSnapshot(projectId: string, agentInstanceId: string, triggerMessageId: string): Promise<ExecContextSnapshot> {
        const memberNames = new Map(fullSnapshot.members.map((member) => [member.instanceId, member.name]));
        const messages = fullSnapshot.messages.map((row) => ({
          id: row.id,
          role: (row.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: row.content.slice(0, collaborationMode === 'fast' ? 700 : collaborationMode === 'balanced' ? 900 : 1_200),
          ...(row.taskRelation ? { taskRelation: row.taskRelation } : {}),
          ...(row.senderType === 'agent' ? { senderName: memberNames.get(row.senderId) ?? '群聊成员' } : {}),
        }));
        return {
          snapshotChecksum: fullSnapshot.snapshotChecksum,
          messages,
        };
      },

      async writeContextManifest(_snapshot: ExecContextSnapshot, projectRoot: string): Promise<void> {
        await contextBuilder.writeContextManifest(fullSnapshot, projectRoot);
      },

      getProjectRoot(projectId: string): string {
        return getProjectRoot(projectId);
      },

      renderSnapshotToText(snapshot: ExecContextSnapshot): string {
        const parts = [
          `## 当前群聊\n- 名称: ${fullSnapshot.project.name}\n- 摘要: ${fullSnapshot.project.summary || '(无)'}`,
        ];
        const taskMessages = snapshot.messages.filter((message) => message.taskRelation !== 'history');
        if (taskMessages.length > 0) {
          parts.push(`## 当前任务消息\n${taskMessages.map((message) => (
            `${message.role === 'user' ? '用户' : message.senderName ?? '群聊成员'}：${message.content}`
          )).join('\n')}`);
        }
        if (fullSnapshot.rollingSummary) {
          parts.push(`## 历史摘要\n${fullSnapshot.rollingSummary.slice(0, collaborationMode === 'expert' ? 1_200 : 800)}`);
        }
        if (fullSnapshot.referencedFiles.length > 0) {
          parts.push(`## 本轮引用文件\n${fullSnapshot.referencedFiles.map((file) => `- ${file.name}`).join('\n')}`);
        }
        if (fullSnapshot.parentRunResult) {
          parts.push(`## 已有上游结果\n${fullSnapshot.parentRunResult.slice(0, 1_000)}`);
        }
        return parts.join('\n\n');
      },

      getKmInstance(projectId: string) {
        const row = db.prepare(
          `SELECT pai.id, pai.identity_rel_path as identityRelPath, ap.enabled as profileEnabled
           FROM project_agent_instances pai
           JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
           WHERE pai.project_id = ? AND ap.definition_id = 'builtin.knowledge-manager' LIMIT 1`,
        ).get(projectId) as { id: string; identityRelPath: string | null; profileEnabled: number } | undefined;
        return row;
      },

      getProjectDelegatableAgents(projectId: string) {
        return listProjectCoordinationRegistry(db, projectId);
      },

      saveTaskPlan(input) {
        return taskPlanStore.save(input);
      },

      updateTaskNode(rootRunId, nodeId, patch) {
        taskPlanStore.updateNode(rootRunId, nodeId, patch);
      },

      setTaskPlanStatus(rootRunId, status) {
        taskPlanStore.setStatus(rootRunId, status);
      },

      getMessageContent(messageId: string): string | null {
        const row = db.prepare(
          'SELECT content_json as contentJson FROM messages WHERE id = ?',
        ).get(messageId) as { contentJson: string } | undefined;
        if (!row) return null;
        try {
          const parsed = JSON.parse(row.contentJson);
          return parsed.text ?? row.contentJson;
        } catch {
          return row.contentJson;
        }
      },

      getLogger() {
        return logger ?? { info: () => {}, warn: () => {}, error: () => {} };
      },
    },
  };

  await coreRunOrchestrator(ctx);
}
