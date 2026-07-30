import { BrowserWindow, app, dialog } from 'electron';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ModelGateway, type ModelSlot } from './model-gateway';
import type { QueuedRun, Scheduler } from './scheduler';
import { MemoryManager } from './memory-manager';
import { ContextBuilder } from './context-builder';
import { createProjectTools, registerProjectTools } from './agent-tools';
import { ToolRegistry } from './tool-registry';
import { runOrchestrator } from './langgraph-orchestrator';
import { runKnowledgeManager, type KMExecContext } from './langgraph-knowledge-manager';
import { cliExecutor } from './cli-executor';
import { cliAgentRegistry } from './cli-agent-registry';
import { AgentRunRepository, MessageRepository } from '@kunqing/database';
import { getLogger } from './logger';
import { getProjectRoot } from './paths';
import { processMessageMentions } from './message-router';

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
  extra?: { error?: string; message?: string },
): void {
  if (window.isDestroyed()) return;
  const agentName = lookupAgentName(db, run.agentInstanceId);
  const triggered = lookupTriggeredByName(db, runRepo, run.runId);
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
      ...extra,
    },
  });
}

/**
 * 查询当前 Run 的父 Run，如果存在则返回父智能体的 @mention 条目。
 * 用于子智能体执行完成后自动 @回父智能体，形成链式协作。
 */
function buildParentMention(
  db: Database.Database,
  runRepo: AgentRunRepository,
  runId: string,
): Array<{ target: { scope: string; id: string }; label: string; start: number; end: number }> {
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
      end: 0,
    }];
  } catch {
    return [];
  }
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
      `SELECT pai.id, pai.runtime_mode as runtimeMode, pai.cli_connection_id as cliConnectionId,
              ap.name as agentName, ap.definition_id as definitionId
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.id = ?`,
    ).get(run.agentInstanceId) as { id: string; runtimeMode: string; cliConnectionId: string | null; agentName: string; definitionId: string } | undefined;

    runRepo.addEvent(run.runId, 'agent.started', {
      definitionId: agentInstance?.definitionId ?? 'unknown',
      agentName: agentInstance?.agentName,
      instruction: run.instruction.slice(0, 200),
    });

    if (agentInstance?.definitionId === 'builtin.orchestrator') {
      const contextBuilder = new ContextBuilder(db);
      return runOrchestrator(
        db, gateway, window,
        run.runId, run.projectId, run.agentInstanceId,
        run.instruction, run.triggerMessageId, signal,
        memory, registry, contextBuilder, _scheduler,
      ).then(() => {
        runRepo.addEvent(run.runId, 'agent.completed', { definitionId: 'builtin.orchestrator' });
      }).catch((err) => {
        runRepo.addEvent(run.runId, 'agent.error', { definitionId: 'builtin.orchestrator', error: err instanceof Error ? err.message : String(err) });
        dispatchRunStatus(db, runRepo, window, run, 'failed', { error: err instanceof Error ? err.message : String(err) });
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

      // 知识入库失败时不 @mention 编排器，避免死循环
      const isErrorReport = report.startsWith('## 知识入库失败');
      const mentions = isErrorReport ? [] : buildParentMention(db, runRepo, run.runId);

      // 保存知识管理报告消息
      const agentMsgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
      const contentJson = JSON.stringify({ schemaVersion: 1, text: report, mentions, stagedUploadIds: [] });
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

      // 处理消息中的 @mention，触发目标智能体调度
      if (_scheduler && mentions.length > 0) {
        const currentRun = runRepo.getById(run.runId);
        processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, run.agentInstanceId, currentRun.parentRunId ?? undefined);
      }

      dispatchRunStatus(db, runRepo, window, run, 'completed');
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

        // 构建上下文快照
        try {
          const ctxBuilder = new ContextBuilder(db);
          const snapshot = ctxBuilder.build(run.projectId, agentInstance.id);
          const projectRoot = getProjectRoot(run.projectId);
          await ctxBuilder.writeContextManifest(snapshot, projectRoot);
        } catch { /* 非致命 */ }

        dispatchRunStatus(db, runRepo, window, run, 'running', { message: `${cliRow.name} (CLI) 正在执行...` });

        // 使用适配器的 run 方法（含策略构建 args），兜底用 cliExecutor
        let result: import('./cli-executor').CliRunResult;
        if (adapter && 'run' in adapter) {
          const projectRoot = getProjectRoot(run.projectId);
          try {
            const externalResult = await adapter.run(
              { connection: { ...connection, capabilities: [], secretRefs: [] }, instruction: run.instruction, workspaceRoot: projectRoot },
              {},
              signal ?? new AbortController().signal,
            );
            result = {
              exitCode: externalResult.exitCode,
              output: externalResult.stdout + (externalResult.stderr ? '\n' + externalResult.stderr : ''),
              durationMs: externalResult.durationMs,
              cancelled: externalResult.exitCode === null,
            };
          } catch (err) {
            runRepo.setStatus(run.runId, 'failed');
            dispatchRunStatus(db, runRepo, window, run, 'failed', { error: err instanceof Error ? err.message : String(err) });
            runRepo.addEvent(run.runId, 'agent.error', { definitionId: agentInstance.definitionId, error: err instanceof Error ? err.message : String(err) });
            return;
          }
        } else {
          result = await cliExecutor.execute({
            connection, instruction: run.instruction, projectId: run.projectId, window, signal,
          });
        }

        const output = result.output.trim();

        if (result.cancelled) {
          runRepo.setStatus(run.runId, 'cancelled');
          dispatchRunStatus(db, runRepo, window, run, 'cancelled');
          return;
        }

        if (output) {
          const agentMsgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);

          for (let i = 0, seq = 0; i < output.length; i += 3, seq++) {
            if (signal?.aborted) break;
            if (!window.isDestroyed()) {
              window.webContents.send('event:dispatch', {
                type: 'message.delta', projectId: run.projectId, messageId: agentMsgId, seq, delta: output.slice(i, i + 3),
              });
            }
          }

          const agentContent = { schemaVersion: 1 as const, text: output, mentions: buildParentMention(db, runRepo, run.runId), stagedUploadIds: [] };
          const contentJson = JSON.stringify(agentContent);
          const now = new Date().toISOString();
          db.prepare(
            'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(agentMsgId, run.projectId, 'agent', agentInstance.id, 'text', contentJson, 'sent', now, now);

          runRepo.setResultMessage(run.runId, agentMsgId);
          _runCompletedCallback?.(run.runId, run.projectId, agentMsgId);

          // 处理消息中的 @mention，触发目标智能体调度
          if (_scheduler) {
            const currentRun = runRepo.getById(run.runId);
            processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, run.agentInstanceId, currentRun.parentRunId ?? undefined);
          }

          dispatchRunStatus(db, runRepo, window, run, 'completed');
          if (!window.isDestroyed()) {
            window.webContents.send('event:dispatch', {
              type: 'message.committed', projectId: run.projectId, messageId: agentMsgId, senderId: agentInstance.id, content: contentJson,
            });
          }
        } else {
          dispatchRunStatus(db, runRepo, window, run, 'completed', { message: `${cliRow.name} (CLI) 执行完毕（无文本输出）` });
        }

        runRepo.addEvent(run.runId, 'agent.completed', { definitionId: agentInstance.definitionId, cli: true, charCount: output.length });
        return;
      }
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

      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = recentMessages.reverse().slice(-15).map((m) => ({
        role: m.senderType === 'user' ? 'user' as const : 'assistant' as const,
        content: (() => { try { return JSON.parse(m.contentJson).text ?? m.contentJson; } catch { return m.contentJson; } })(),
      }));

      const slot: ModelSlot = agentInstance?.definitionId === 'builtin.knowledge-manager' ? 'fast' : 'reasoning';
      const stream = await gateway.streamText(slot, messages, systemMsg);
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

      const contentJson = JSON.stringify({ schemaVersion: 1, text: fullText, mentions: buildParentMention(db, runRepo, run.runId), stagedUploadIds: [] });
      const now = new Date().toISOString();

      db.prepare(
        'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(agentMsgId, run.projectId, 'agent', agentInstance?.id ?? run.agentInstanceId, 'text', contentJson, 'sent', now, now);

      runRepo.setResultMessage(run.runId, agentMsgId);
      _runCompletedCallback?.(run.runId, run.projectId, agentMsgId);

      // 处理消息中的 @mention，触发目标智能体调度
      if (_scheduler) {
        const currentRun = runRepo.getById(run.runId);
        processMessageMentions(db, runRepo, _scheduler, run.projectId, contentJson, run.triggerMessageId, run.agentInstanceId, currentRun.parentRunId ?? undefined);
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

      memory.storeShortTerm(run.projectId, run.agentInstanceId, 'interaction', run.instruction.slice(0, 300), 0.5);

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
