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
import { AgentRunRepository, FileRepository } from '@kunqing/database';
import { getLogger } from './logger';
import { getProjectRoot } from './paths';
import { Scheduler } from './scheduler';
import { processMessageMentions } from './message-router';
import { randomUUID } from 'node:crypto';

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
): Promise<void> {
  const runRepo = new AgentRunRepository(db);
  const fileRepo = new FileRepository(db);
  const logger = getLogger();
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
        return toolRegistry.execute(name, args, { role: role as LocalAgentRole, ...context });
      },

      async createFileRecord(projectId: string, relativePath: string, content: string, agentInstanceId: string, runId: string, note?: string) {
        const { join } = await import('node:path');
        const { readFile } = await import('node:fs/promises');
        const { hashContent } = await import('@kunqing/knowledge-core');

        const filePath = join(getProjectRoot(projectId), relativePath);
        const fileBuffer = await readFile(filePath);
        const sha256 = hashContent(fileBuffer.toString('utf8'));
        const size = fileBuffer.length;

        let file = fileRepo.getByPath('project', projectId, relativePath);
        if (!file) {
          file = fileRepo.create({
            scopeType: 'project',
            scopeId: projectId,
            type: 'file',
            name: relativePath.split('/').pop() ?? relativePath,
            normalizedPath: relativePath,
            origin: 'artifact',
          });
        }

        fileRepo.createVersion({
          fileId: file.id,
          storageRelPath: relativePath,
          size,
          sha256,
          createdByType: 'agent',
          createdById: agentInstanceId,
          runId,
          changeNote: note ?? 'agent 发布成果',
        });
      },

      async insertMessage(projectId: string, senderId: string, kind: string, contentJson: string): Promise<string> {
        const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
        const now = new Date().toISOString();
        db.prepare(
          'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, projectId, 'agent', senderId, kind, contentJson, 'sent', now, now);

        // 以本条消息的 ID 作为 triggerMessageId 传递给 processMessageMentions，
        // 这样被 @mention 触发的子智能体 Run 的 triggerMessageId 会指向本条消息
        if (scheduler) {
          processMessageMentions(db, runRepo, scheduler, projectId, contentJson, id, senderId, runId, 'agent');
        }

        return id;
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
          window.webContents.send('event:dispatch', event);
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

      buildMemoryContext(projectId: string, agentInstanceId: string): string {
        return memory.buildMemoryContext(projectId, agentInstanceId);
      },

      async buildContextSnapshot(projectId: string, agentInstanceId: string, triggerMessageId: string): Promise<ExecContextSnapshot> {
        return {
          snapshotChecksum: fullSnapshot.snapshotChecksum,
          messages: fullSnapshot.messages.map((m) => ({
            role: (m.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
            content: m.content,
          })),
        };
      },

      async writeContextManifest(_snapshot: ExecContextSnapshot, projectRoot: string): Promise<void> {
        await contextBuilder.writeContextManifest(fullSnapshot, projectRoot);
      },

      getProjectRoot(projectId: string): string {
        return getProjectRoot(projectId);
      },

      renderSnapshotToText(_snapshot: ExecContextSnapshot): string {
        return contextBuilder.renderToText(fullSnapshot);
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
          `SELECT pai.id, ap.name, pai.role, ap.definition_id as definitionId, pai.runtime_mode as runtimeMode
           FROM project_agent_instances pai
           JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
           WHERE pai.project_id = ? AND ap.enabled = 1
           ORDER BY pai.ordinal`,
        ).all(projectId) as Array<{ id: string; name: string; role: string; definitionId: string; runtimeMode: string }>;
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          role: r.role,
          definitionId: r.definitionId,
          runtimeMode: r.runtimeMode,
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
