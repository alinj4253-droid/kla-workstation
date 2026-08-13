import { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { runOrchestrator as coreRunOrchestrator } from '@kunqing/native-agent-core';
import type { IGraphContext, ExecContextSnapshot, SubRunParams, CreateSubRunInput, AgentRole } from '@kunqing/native-agent-core';
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
import { processMessageMentions } from './message-router';
import { randomUUID } from 'node:crypto';
import { normalizeAgentMessageContent } from './agent-collaboration';
import { AgentArtifactPublisher } from './agent-artifact-publisher';
import { getSkillDisplayName } from './skill-display';
import { loadAgentCoordinationSummary } from './agent-identity';

export type ExecContext = IGraphContext;

function agentCapabilities(definitionId: string, runtimeMode: string, name: string): string {
  if (definitionId === 'builtin.knowledge-manager' || /知识|文档/i.test(name)) {
    return '本地制度和群聊知识检索；读取原始文件；切片、摘要、标签、向量、图谱、Wiki；归集可复用知识';
  }
  if (definitionId === 'builtin.researcher' || /调研|研究/i.test(name)) {
    return '公开网络资料、行业/市场/竞品调研、来源核验和外部事实补充';
  }
  if (definitionId === 'builtin.material-writer' || /材料编写|写作/i.test(name)) {
    return '依据证据和模板先列框架、逐章编写、统一校对并生成 HTML 待审稿';
  }
  if (definitionId === 'builtin.acceptance-reviewer' || /验收|审核/i.test(name)) {
    return '读取材料待审稿，检索本地知识证据，核验事实与来源并给出通过或返修结论';
  }
  if (runtimeMode === 'external-cli' || /code|代码|编程/i.test(`${definitionId} ${name}`)) {
    return '代码、脚本、HTML 和文件成果生成；可在本地工作区执行外部 CLI';
  }
  return '根据自身角色卡和可用技能完成专属工作，并返回可验收结果';
}

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
): Promise<void> {
  const runRepo = new AgentRunRepository(db);
  const logger = getLogger();
  const artifactPublisher = new AgentArtifactPublisher(db, (event) => {
    if (!window.isDestroyed()) window.webContents.send('event:dispatch', event);
  });
  const fullSnapshot = contextBuilder.build(projectId, agentInstanceId, triggerMessageId);

  const ctx: IGraphContext = {
    projectId,
    agentInstanceId,
    runId,
    instruction,
    triggerMessageId,
    signal,
    workspaceRoot: getProjectRoot(projectId),

    services: {
      generateText(slot: ModelSlot, messages: ModelMessage[], options?: GenerateOptions): Promise<GenerateResult> {
        const systemMsg = messages.find((m) => m.role === 'system')?.content;
        const chatMessages = messages.filter((m) => m.role !== 'system') as Array<{ role: 'user' | 'assistant'; content: string }>;
        const genOptions: { system?: string; tools?: Record<string, { description: string; parameters: Record<string, unknown> }> } = options ?? {};
        if (systemMsg) genOptions.system = systemMsg;
        return gateway.generateText(slot, chatMessages, genOptions);
      },

      getToolDefinitions(role: AgentRole) {
        return toolRegistry.getDefinitionsForRole(role as LocalAgentRole);
      },

      async executeTool(name: string, args: Record<string, unknown>, role: AgentRole, context: { runId?: string; projectId?: string }) {
        const traceId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 16);
        const skillName = getSkillDisplayName(name);
        const started = { id: traceId, kind: name === 'delegate_tasks' ? 'handoff' : 'tool', title: name === 'delegate_tasks' ? '正在调用智能体任务委派技能创建子任务' : `正在调用${skillName}技能`, status: 'running', detail: `技能标识：${name}\n${JSON.stringify(args).slice(0, 420)}`, at: new Date().toISOString() };
        runRepo.addEvent(runId, 'run.trace', started);
        if (!window.isDestroyed()) window.webContents.send('event:dispatch', { type: 'run.trace', projectId, runId, agentId: agentInstanceId, trace: started });
        try {
          const result = await toolRegistry.execute(name, args, { role: role as LocalAgentRole, ...context });
          const completed = { ...started, status: 'completed', detail: result.slice(0, 500), at: new Date().toISOString() };
          runRepo.addEvent(runId, 'run.trace', completed);
          if (!window.isDestroyed()) window.webContents.send('event:dispatch', { type: 'run.trace', projectId, runId, agentId: agentInstanceId, trace: completed });
          return result;
        } catch (error) {
          const failed = { ...started, status: 'failed', detail: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
          runRepo.addEvent(runId, 'run.trace', failed);
          if (!window.isDestroyed()) window.webContents.send('event:dispatch', { type: 'run.trace', projectId, runId, agentId: agentInstanceId, trace: failed });
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
        const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
        const now = new Date().toISOString();
        const normalizedContent = kind === 'text'
          ? normalizeAgentMessageContent(db, projectId, contentJson, [], senderId)
          : contentJson;
        db.prepare(
          'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, projectId, 'agent', senderId, kind, normalizedContent, 'sent', now, now);
        runRepo.addEvent(runId, 'run.anchor', { messageId: id });

        // 整条智能体协作链沿用最初的 triggerMessageId。
        // 这样每条用户消息最多 20 个 Run 的限制不会因智能体回复产生新消息而被重置。
        if (scheduler) {
          processMessageMentions(db, runRepo, scheduler, projectId, normalizedContent, triggerMessageId, senderId, runId, 'agent', id);
        }
        if (!window.isDestroyed()) {
          window.webContents.send('event:dispatch', {
            type: 'message.committed', projectId, messageId: id, senderId, content: normalizedContent,
          });
        }

        return id;
      },

      async sendDelegationMessage(input) {
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
        }), [requestedMention], input.senderId);
        const messageId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
        const now = new Date().toISOString();
        db.prepare(
          'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(messageId, input.projectId, 'agent', input.senderId, 'text', contentJson, 'sent', now, now);
        const routingText = `@${input.targetAgentName} ${input.instruction}`;
        const routingContentJson = normalizeAgentMessageContent(db, input.projectId, JSON.stringify({
          schemaVersion: 1,
          text: routingText,
          mentions: [requestedMention],
          stagedUploadIds: [],
          messageType: 'delegation',
        }), [requestedMention], input.senderId);
        const childRunIds = scheduler
          ? processMessageMentions(
            db, runRepo, scheduler, input.projectId, routingContentJson, input.rootTriggerMessageId,
            input.senderId, input.parentRunId, 'agent', messageId,
          )
          : [];
        if (!window.isDestroyed()) {
          window.webContents.send('event:dispatch', {
            type: 'message.committed', projectId: input.projectId, messageId, senderId: input.senderId, content: contentJson,
          });
        }
        return { messageId, childRunIds };
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
        if (input.modelProfileSnapshotJson !== null) opts.modelProfileSnapshotJson = input.modelProfileSnapshotJson;
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
          window.webContents.send('event:dispatch', eventRun
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
          return memory.recallRelevant(query, projectId, agentInstanceId, 6).join('\n');
        }
        return memory.buildMemoryContext(projectId, agentInstanceId).slice(0, 2_000);
      },

      async buildContextSnapshot(projectId: string, agentInstanceId: string, triggerMessageId: string): Promise<ExecContextSnapshot> {
        const rows = db.prepare(
          `SELECT id, sender_type as senderType, sender_id as senderId, content_json as contentJson, created_at as createdAt
           FROM messages
           WHERE project_id = ? AND kind IN ('text', 'artifact')
           ORDER BY created_at DESC
           LIMIT 80`,
        ).all(projectId) as Array<{ id: string; senderType: string; senderId: string; contentJson: string; createdAt: string }>;
        const memberNames = new Map(fullSnapshot.members.map((member) => [member.instanceId, member.name]));
        const chronological = rows.reverse();
        const selectedIndexes = new Set<number>();
        const takeLatest = (senderType: string, limit: number): void => {
          let remaining = limit;
          for (let index = chronological.length - 1; index >= 0 && remaining > 0; index -= 1) {
            if (chronological[index]?.senderType !== senderType) continue;
            selectedIndexes.add(index);
            remaining -= 1;
          }
        };
        // 用户多轮需求优先；只保留少量智能体正式结果作为“已有成果”上下文。
        takeLatest('user', 12);
        takeLatest('agent', 6);
        const messages = chronological
          .filter((row, index) => selectedIndexes.has(index) || row.id === triggerMessageId)
          .map((row) => {
            let content = row.contentJson;
            try { content = (JSON.parse(content) as { text?: string }).text ?? content; } catch { /* use raw */ }
            return {
              role: (row.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
              content: content.slice(0, 1_200),
              ...(row.senderType === 'agent' ? { senderName: memberNames.get(row.senderId) ?? '群聊成员' } : {}),
            };
          });
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

      renderSnapshotToText(_snapshot: ExecContextSnapshot): string {
        return contextBuilder.renderToText(fullSnapshot, { includeMemory: false });
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
        const rows = db.prepare(
          `SELECT pai.id, ap.name, pai.role, ap.definition_id as definitionId, pai.runtime_mode as runtimeMode,
                  pai.identity_rel_path as identityRelPath
           FROM project_agent_instances pai
           JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
           WHERE pai.project_id = ? AND ap.enabled = 1
           ORDER BY pai.ordinal`,
        ).all(projectId) as Array<{ id: string; name: string; role: string; definitionId: string; runtimeMode: string; identityRelPath: string | null }>;
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          role: r.role,
          definitionId: r.definitionId,
          runtimeMode: r.runtimeMode,
          capabilities: agentCapabilities(r.definitionId, r.runtimeMode, r.name),
          coordinationProfile: loadAgentCoordinationSummary(projectId, r.identityRelPath, {
            name: r.name,
            runtimeMode: r.runtimeMode,
            definitionId: r.definitionId,
          }),
        }));
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
