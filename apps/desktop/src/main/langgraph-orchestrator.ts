import { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ModelGateway } from './model-gateway';
import { MemoryManager } from './memory-manager';
import { createProjectTools } from './agent-tools';
import { AgentRunRepository } from '@kunqing/database';
import { getLogger } from './logger';

const SYSTEM_PROMPT = `你是统筹智能体 (Orchestrator)，一个多智能体系统的协调者。

## 职责
- 分析用户指令，判断是否需要动用子智能体（如知识管理员）
- 如果用户询问项目知识、文档内容、搜索信息，调用 knowledge-manager 子智能体
- 如果用户询问日常对话、代码编写、一般问题，直接回复
- 收集子智能体的结果并进行汇总

## 回复格式
使用 Markdown 格式输出。需要调用子智能体时，请在回复末尾注明需要调用的智能体。`;

const KM_PROMPT = `你是知识管理员 (Knowledge Manager)。你负责管理项目知识库。

## 可用工具
你可以使用以下工具来获取信息：
- knowledge:search - 搜索知识库文档
- workspace:readFile - 读取工作区文件
- project:search - 跨项目搜索
- knowledge:listGraph - 列出知识图谱

## 输出
基于获取的信息，给出准确的回答。如果信息不足，明确告知用户。`;

const SUB_AGENT_HEADER = '## 需要知识管理员协助';
const MAX_TOOL_RETRIES = 3;

export type ExecContext = {
  db: Database.Database;
  gateway: ModelGateway;
  window: BrowserWindow;
  runId: string;
  projectId: string;
  agentInstanceId: string;
  instruction: string;
  triggerMessageId: string;
  signal: AbortSignal;
  memory: MemoryManager;
  tools: ReturnType<typeof createProjectTools>;
};

export async function runOrchestrator(ctx: ExecContext): Promise<void> {
  const logger = getLogger();
  const runRepo = new AgentRunRepository(ctx.db);

  try {
    const messages = buildMessages(ctx, SYSTEM_PROMPT);
    const result = await ctx.gateway.generateText('reasoning', messages);

    if (result.includes(SUB_AGENT_HEADER)) {
      const kmResult = await delegateToKnowledgeManager(ctx);
      const finalMessages = buildMessages(ctx, SYSTEM_PROMPT);
      finalMessages.push({ role: 'assistant', content: result });
      finalMessages.push({ role: 'user', content: `知识管理员返回了以下结果：\n\n${kmResult}\n\n请根据这些信息给出最终回复。` });
      const finalResult = await ctx.gateway.generateText('reasoning', finalMessages);
      await emitResult(ctx, finalResult);
    } else {
      await emitResult(ctx, result);
    }

    ctx.memory.storeShortTerm(ctx.projectId, ctx.agentInstanceId, 'interaction', ctx.instruction.slice(0, 500), 0.6);
    ctx.memory.consolidateShortTerm(ctx.projectId, ctx.agentInstanceId);
    ctx.memory.extractLongTerm(ctx.projectId, ctx.agentInstanceId);

    logger?.info({ runId: ctx.runId }, 'Orchestrator: 完成');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      runRepo.setStatus(ctx.runId, 'cancelled');
      return;
    }
    throw err;
  }
}

async function delegateToKnowledgeManager(ctx: ExecContext): Promise<string> {
  const kmInstanceId = ctx.db.prepare(
    `SELECT pai.id FROM project_agent_instances pai
     JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
     WHERE pai.project_id = ? AND ap.definition_id = 'builtin.knowledge-manager' LIMIT 1`,
  ).get(ctx.projectId) as { id: string } | undefined;

  if (!kmInstanceId) return '未找到知识管理员智能体实例';

  const toolResults: string[] = [];
  const kmRun = new AgentRunRepository(ctx.db).create({
    projectId: ctx.projectId,
    agentInstanceId: kmInstanceId.id,
    requestedByType: 'agent',
    requestedById: ctx.agentInstanceId,
    instruction: ctx.instruction,
    parentRunId: ctx.runId,
  });

  const kmMessages = buildMessages(ctx, KM_PROMPT);

  try {
    const kmResult = await ctx.gateway.generateText('fast', kmMessages);
    const toolCalls = extractToolCalls(kmResult);

    for (const call of toolCalls.slice(0, MAX_TOOL_RETRIES)) {
      const tool = ctx.tools.find((t) => call.name === t.name);
      if (!tool) continue;
      try {
        const result = await tool.execute(call.args);
        toolResults.push(`${call.name} 返回：\n${result}`);
      } catch (err) {
        toolResults.push(`${call.name} 执行失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    new AgentRunRepository(ctx.db).setStatus(kmRun.id, 'completed');

    if (toolResults.length > 0) {
      return toolResults.join('\n\n');
    }
    return kmResult;
  } catch (err) {
    return `知识管理员执行出错: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function buildMessages(ctx: ExecContext, systemPrompt: string): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const recentMessages = ctx.db.prepare(
    `SELECT sender_type as senderType, content_json as contentJson
     FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT 15`,
  ).all(ctx.projectId) as Array<{ senderType: string; contentJson: string }>;

  const memoryContext = ctx.memory.buildMemoryContext(ctx.projectId, ctx.agentInstanceId);
  const systemContent = systemPrompt + (memoryContext ? `\n\n## 上下文记忆\n${memoryContext}` : '');

  return [
    { role: 'system', content: systemContent },
    ...recentMessages.reverse().map((m) => ({
      role: (m.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: (() => { try { return JSON.parse(m.contentJson).text ?? m.contentJson; } catch { return m.contentJson; } })(),
    })),
    { role: 'user', content: ctx.instruction },
  ];
}

function extractToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const regex = /(\w+(?::\w+)?)\s*\(\s*({[^}]*})\s*\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const [, name, argsJson] = match;
      if (name && argsJson) {
        calls.push({ name, args: JSON.parse(argsJson) });
      }
    } catch { /* skip invalid JSON args */ }
  }
  return calls;
}

async function emitResult(ctx: ExecContext, text: string): Promise<void> {
  const agentMsgId = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
  const contentJson = JSON.stringify({ schemaVersion: 1, text, mentions: [], stagedUploadIds: [] });
  const now = new Date().toISOString();

  ctx.db.prepare(
    'INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(agentMsgId, ctx.projectId, 'agent', ctx.agentInstanceId, 'text', contentJson, 'sent', now, now);

  new AgentRunRepository(ctx.db).setResultMessage(ctx.runId, agentMsgId);

  if (!ctx.window.isDestroyed()) {
    ctx.window.webContents.send('event:dispatch', {
      type: 'run.status',
      projectId: ctx.projectId,
      run: { id: ctx.runId, agentId: ctx.agentInstanceId, status: 'completed' },
    });
    ctx.window.webContents.send('event:dispatch', {
      type: 'message.committed',
      projectId: ctx.projectId,
      messageId: agentMsgId,
      senderId: ctx.agentInstanceId,
      content: contentJson,
    });
  }
}
