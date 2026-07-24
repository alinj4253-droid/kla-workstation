import { BrowserWindow, app } from 'electron';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ModelGateway, type ModelSlot } from './model-gateway';
import type { QueuedRun, Scheduler } from './scheduler';
import { MemoryManager } from './memory-manager';
import { ContextBuilder } from './context-builder';
import { createProjectTools, registerProjectTools } from './agent-tools';
import { ToolRegistry } from './tool-registry';
import { runOrchestrator, type ExecContext } from './langgraph-orchestrator';
import { runKnowledgeManager, type KMExecContext } from './langgraph-knowledge-manager';
import { AgentRunRepository, MessageRepository } from '@kunqing/database';
import { getLogger } from './logger';

export type AgentExecutor = {
  (run: QueuedRun, signal: AbortSignal): Promise<void>;
  setScheduler(s: Scheduler): void;
  onRunCompleted(cb: (runId: string, projectId: string, resultMessageId: string) => void): void;
};

export function createAgentExecutor(db: Database.Database, window: BrowserWindow, gateway: ModelGateway, scheduler?: Scheduler, toolRegistry?: ToolRegistry): AgentExecutor {
  const runRepo = new AgentRunRepository(db);
  const msgRepo = new MessageRepository(db);
  const memory = new MemoryManager(db);
  let _scheduler = scheduler;
  let tools = createProjectTools(db, _scheduler);
  const registry = toolRegistry ?? new ToolRegistry(db);
  if (!toolRegistry) {
    registerProjectTools(registry, db, _scheduler);
  }
  let _runCompletedCallback: ((runId: string, projectId: string, resultMessageId: string) => void) | null = null;

  const executor = async (run: QueuedRun, signal: AbortSignal): Promise<void> => {
    const logger = getLogger();

    const agentInstance = db.prepare(
      `SELECT pai.id, ap.name as agentName, ap.definition_id as definitionId
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = ?`,
    ).get(run.agentInstanceId) as { id: string; agentName: string; definitionId: string } | undefined;

    runRepo.addEvent(run.runId, 'agent.started', {
      definitionId: agentInstance?.definitionId ?? 'unknown',
      agentName: agentInstance?.agentName,
      instruction: run.instruction.slice(0, 200),
    });

    if (agentInstance?.definitionId === 'builtin.orchestrator') {
      const ctx: ExecContext = {
        db,
        gateway,
        window,
        runId: run.runId,
        projectId: run.projectId,
        agentInstanceId: run.agentInstanceId,
        instruction: run.instruction,
        triggerMessageId: run.triggerMessageId,
        signal,
        memory,
        tools,
        toolRegistry: registry,
        scheduler: _scheduler,
        contextSnapshot: null as any,
        contextBuilder: new ContextBuilder(db),
      };
      return runOrchestrator(ctx).then(() => {
        runRepo.addEvent(run.runId, 'agent.completed', { definitionId: 'builtin.orchestrator' });
      }).catch((err) => {
        runRepo.addEvent(run.runId, 'agent.error', { definitionId: 'builtin.orchestrator', error: err instanceof Error ? err.message : String(err) });
        throw err;
      });
    }

    if (agentInstance?.definitionId === 'builtin.knowledge-manager') {
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

      runRepo.addEvent(run.runId, 'agent.completed', { definitionId: 'builtin.knowledge-manager', reportLength: report.length });

      // 保存知识管理报告消息
      const agentMsgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
      const contentJson = JSON.stringify({ schemaVersion: 1, text: report, mentions: [], stagedUploadIds: [] });
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(agentMsgId, run.projectId, 'agent', agentInstance?.id ?? run.agentInstanceId, 'text', contentJson, 'sent', now, now);
      runRepo.setResultMessage(run.runId, agentMsgId);
      _runCompletedCallback?.(run.runId, run.projectId, agentMsgId);

      if (!window.isDestroyed()) {
        window.webContents.send('event:dispatch', {
          type: 'message.committed',
          projectId: run.projectId,
          messageId: agentMsgId,
          senderId: agentInstance?.id ?? run.agentInstanceId,
          content: contentJson,
        });
      }

      return;
    }

    logger?.info({ runId: run.runId, agentInstanceId: run.agentInstanceId }, 'AgentExecutor: 直接模式');

    try {
      const projectInfo = db.prepare('SELECT name FROM projects WHERE id = ?').get(run.projectId) as { name: string } | undefined;
      const recentMessages = db.prepare(
        `SELECT sender_type as senderType, content_json as contentJson, created_at as createdAt
         FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`,
      ).all(run.projectId) as Array<{ senderType: string; contentJson: string; createdAt: string }>;

      const agentName = agentInstance?.agentName ?? '智能体';
      const memoryContext = memory.buildMemoryContext(run.projectId, run.agentInstanceId);

      const systemMsg = `你是 ${agentName}，一个多智能体协作系统中的 AI 智能体。
当前项目：${projectInfo?.name ?? run.projectId}

你的回复应该专业、准确。使用 Markdown 格式输出。
${memoryContext ? `\n${memoryContext}` : ''}`;

      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemMsg },
        ...recentMessages.reverse().slice(-15).map((m) => ({
          role: m.senderType === 'user' ? 'user' as const : 'assistant' as const,
          content: (() => { try { return JSON.parse(m.contentJson).text ?? m.contentJson; } catch { return m.contentJson; } })(),
        })),
      ];

      const slot: ModelSlot = agentInstance?.definitionId === 'builtin.knowledge-manager' ? 'fast' : 'reasoning';
      const stream = await gateway.streamText(slot, messages);
      const reader = stream.getReader();
      const agentMsgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);

      let fullText = '';
      let seq = 0;

      while (true) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;

        fullText += value;
        if (!window.isDestroyed()) {
          window.webContents.send('event:dispatch', {
            type: 'message.delta',
            projectId: run.projectId,
            messageId: agentMsgId,
            seq: seq++,
            delta: value,
          });
        }
      }

      if (!fullText.trim()) {
        fullText = run.instruction
          ? `收到请求：${run.instruction}\n\n我已经分析了相关信息，请等待统筹智能体汇总结果。`
          : '已收到消息，正在处理中。';
      }

      const contentJson = JSON.stringify({ schemaVersion: 1, text: fullText, mentions: [], stagedUploadIds: [] });
      const now = new Date().toISOString();

      db.prepare(
        'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(agentMsgId, run.projectId, 'agent', agentInstance?.id ?? run.agentInstanceId, 'text', contentJson, 'sent', now, now);

      runRepo.setResultMessage(run.runId, agentMsgId);
      _runCompletedCallback?.(run.runId, run.projectId, agentMsgId);

      if (!window.isDestroyed()) {
        window.webContents.send('event:dispatch', {
          type: 'run.status',
          projectId: run.projectId,
          run: { id: run.runId, agentId: agentInstance?.id ?? run.agentInstanceId, status: 'completed' },
        });
        window.webContents.send('event:dispatch', {
          type: 'message.committed',
          projectId: run.projectId,
          messageId: agentMsgId,
          senderId: agentInstance?.id ?? run.agentInstanceId,
          content: contentJson,
        });
      }

      memory.storeShortTerm(run.projectId, run.agentInstanceId, 'interaction', run.instruction.slice(0, 300), 0.5);

      runRepo.addEvent(run.runId, 'agent.completed', { definitionId: 'direct', charCount: fullText.length });
      logger?.info({ runId: run.runId, agentMsgId, charCount: fullText.length }, 'AgentExecutor: 完成');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        runRepo.setStatus(run.runId, 'cancelled');
        runRepo.addEvent(run.runId, 'agent.error', { definitionId: 'direct', error: '用户取消' });
        if (!window.isDestroyed()) {
          window.webContents.send('event:dispatch', {
            type: 'run.status',
            projectId: run.projectId,
            run: { id: run.runId, agentId: run.agentInstanceId, status: 'cancelled' },
          });
        }
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
