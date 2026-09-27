// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { runMigrations } from './db/migrate';
import { getDatabase, closeDatabase } from './db/connection';
import { AgentRunRepository } from '@kunqing/database';
import {
  agentDeliveryTextsMatch,
  areWebSearchQueriesEquivalent,
  createAgentExecutor,
  inferSingleLocalBusinessStep,
  materialWriterStepInstruction,
  retrievalBudgetForDelegatedNode,
} from './agent-executor';
import type { Scheduler } from './scheduler';

const { externalAdapterRun } = vi.hoisted(() => ({
  externalAdapterRun: vi.fn(),
}));

describe('specialist output and search guards', () => {
  it('reuses a progress message only when its visible text matches the final delivery', () => {
    expect(agentDeliveryTextsMatch('same result\r\n', 'same result')).toBe(true);
    expect(agentDeliveryTextsMatch('intermediate result', 'final result')).toBe(false);
  });

  it('uses one shared retrieval budget per delegated node and deduplicates equivalent queries', () => {
    expect(retrievalBudgetForDelegatedNode('fast')).toBe(1);
    expect(retrievalBudgetForDelegatedNode('balanced')).toBe(3);
    expect(retrievalBudgetForDelegatedNode('expert')).toBe(8);
    expect(areWebSearchQueriesEquivalent('2026 上海 今日天气', '上海今日天气 2026')).toBe(true);
    expect(areWebSearchQueriesEquivalent('豆包 GEO 市场趋势', '豆包 GEO 竞争格局')).toBe(false);
  });

  it('does not rewrite acceptance output in the executor path', () => {
    const output = '关键条款已有来源。\n```html\n<html><body>draft</body></html>\n```\n\n验收结论：通过';
    expect(output).toContain('```html');
    expect(output).toContain('<html>');
  });

  it('keeps material-writer knowledge queries out of the template and draft workflow', () => {
    const query = materialWriterStepInstruction('检索公司来访接待制度并返回带出处的答案', 'expert');
    expect(query).toContain('knowledge:search');
    expect(query).toContain('不要调用模板工具');
    expect(query).not.toContain('review:writeDraft');

    const report = materialWriterStepInstruction('依据公司制度编写一份 HTML 报告待审稿', 'balanced');
    expect(report).toContain('template:list');
    expect(report).toContain('temp:save');
    expect(report).toContain('draft.html');
    expect(report).not.toContain('review:writeDraft');
  });

  it('uses one deterministic business item for an unambiguous local lookup', () => {
    expect(inferSingleLocalBusinessStep('查询本季度差旅报销次数', 5)?.items).toEqual(['查询本季度差旅报销次数']);
    expect(inferSingleLocalBusinessStep('先查制度，再整理成 HTML 报告', 5)).toBeNull();
  });
});

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { send: vi.fn() };
    isDestroyed() {
      return false;
    }
  },
  app: { getPath: () => tmpdir() },
  dialog: { showMessageBox: vi.fn() },
}));

// 模拟模型网关：不发起真实 LLM 调用
vi.mock('./model-gateway', () => ({
  ModelGateway: class {
    generateText = vi.fn(async () => ({ text: '{"summary":"x","items":["x"]}' }));
  },
}));

// 模拟编排器：插入一条最终回复消息并设置 resultMessageId
vi.mock('./langgraph-orchestrator', async () => {
  const { randomUUID } = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  const { AgentRunRepository: Repo } = await vi.importActual<typeof import('@kunqing/database')>('@kunqing/database');
  return {
    runOrchestrator: vi.fn(async (
      db: Database.Database,
      _gateway: unknown,
      _window: unknown,
      runId: string,
      projectId: string,
      agentInstanceId: string,
    ) => {
      const runRepo = new Repo(db);
      const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at)
         VALUES (?, ?, 'agent', ?, 'text', ?, 'sent', ?, ?)`,
      ).run(id, projectId, agentInstanceId,
        JSON.stringify({ schemaVersion: 1, text: '这是智能体的最终回复', mentions: [], stagedUploadIds: [] }),
        now, now);
      runRepo.addEvent(runId, 'run.anchor', { messageId: id });
      runRepo.setResultMessage(runId, id);
    }),
  };
});

vi.mock('./memory-manager', () => ({
  MemoryManager: class {
    getReflectionContext = () => ({ shortTerm: [], longTerm: [] });
    captureTurn = vi.fn(async () => null);
    buildMemoryContext = () => '';
    recallRelevant = () => [];
    syncAgentMemory = vi.fn(async () => {});
  },
}));

vi.mock('./skill-registry', () => ({
  SkillRegistry: class {
    snapshotForRun = vi.fn();
    seedBuiltinSkills = vi.fn();
  },
}));

vi.mock('./workflow-registry', () => ({
  WorkflowRegistry: class {
    snapshotForRun = vi.fn();
    seedBuiltinWorkflows = vi.fn();
  },
}));

vi.mock('./agent-tools', () => ({
  createProjectTools: () => ({}),
  registerProjectTools: vi.fn(),
}));

vi.mock('./agent-artifact-publisher', () => ({
  AgentArtifactPublisher: class {
    publishFromOutput = vi.fn(async (input: { text?: string }) => ({ text: input.text ?? '', publishedPaths: [] }));
    publishExisting = vi.fn();
  },
}));

vi.mock('./cli-executor', () => ({ cliExecutor: { execute: vi.fn() } }));
vi.mock('./cli-agent-registry', () => ({
  cliAgentRegistry: {
    getAdapter: (adapterType: string) => adapterType === 'codebuddy' || adapterType === 'claude' ? { run: externalAdapterRun } : undefined,
  },
}));
vi.mock('./business-process', () => ({
  parsePostTaskKnowledgeInstruction: vi.fn(() => null),
  runPostTaskKnowledgeCapture: vi.fn(),
}));
vi.mock('./logger', () => ({ getLogger: () => undefined }));
vi.mock('./paths', () => ({
  getProjectRoot: () => tmpdir(),
  getStudioRoot: () => tmpdir(),
  getProjectTempRunRoot: (projectId: string, runId: string) => join(tmpdir(), 'K_Studio-tests', projectId, 'temp', runId),
}));
vi.mock('./agent-identity', () => ({ applyAgentRoleAdaptations: vi.fn(), loadAgentDefinitionText: () => '' }));

describe('AgentExecutor 编排器路径：完成后触发渠道回复回调', () => {
  let db: Database.Database;
  let dbPath: string;
  let dir: string;
  let runRepo: AgentRunRepository;
  let window: { webContents: { send: (channel: string, ...args: unknown[]) => void }; isDestroyed: () => boolean };

  beforeEach(() => {
    externalAdapterRun.mockReset();
    dir = mkdtempSync(join(tmpdir(), 'exec-orch-'));
    dbPath = join(dir, 'test.db');
    runMigrations(dbPath);
    db = getDatabase(dbPath);
    runRepo = new AgentRunRepository(db);
    window = { webContents: { send: () => {} }, isDestroyed: () => false };

    const now = new Date().toISOString();
    db.prepare('INSERT INTO projects (id, name, created_at, updated_at, last_active_at) VALUES (?, ?, ?, ?, ?)')
      .run('proj-1', '测试项目', now, now, now);
    db.prepare(
      `INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'native-model', 1, 1, 0, ?, ?)`,
    ).run('prof-orch', '统筹管理智能体', 'builtin.orchestrator', '1.0.0', now, now);
    db.prepare(
      `INSERT INTO project_agent_instances (id, project_id, agent_profile_id, definition_id, definition_version, role, runtime_mode, ordinal, created_at)
       VALUES (?, ?, ?, ?, ?, 'leader', 'native-model', 0, ?)`,
    ).run('inst-orch', 'proj-1', 'prof-orch', 'builtin.orchestrator', '1.0.0', now);
    db.prepare(
      `INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at)
       VALUES (?, ?, 'user', 'u-1', 'text', ?, 'sent', ?, ?)`,
    ).run('trig-1', 'proj-1',
      JSON.stringify({ schemaVersion: 1, text: '你好', channelId: 'ch-1', externalConversationId: 'oc-1' }),
      now, now);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leader 编排器完成后调用 onRunCompleted 回调（含 triggerMessageId）', async () => {
    const gateway = { generateText: vi.fn(async () => ({ text: 'ok' })) };
    const scheduler = { enqueue: vi.fn(), cancelProject: vi.fn(), cancelRun: vi.fn() };
    const toolRegistry = { getDefinitionsForRole: () => [], execute: vi.fn() };
    const executor = createAgentExecutor(db, window as never, gateway as never, scheduler as unknown as Scheduler, toolRegistry as never);

    const calls: Array<[string, string, string, string]> = [];
    executor.onRunCompleted((runId, projectId, resultMessageId, triggerMessageId) => {
      calls.push([runId, projectId, resultMessageId, triggerMessageId]);
    });

    const run = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-orch',
      requestedByType: 'user',
      requestedById: 'u-1',
      instruction: '你好',
      triggerMessageId: 'trig-1',
    });

    const queuedRun = {
      runId: run.id,
      projectId: run.projectId,
      agentInstanceId: run.agentInstanceId,
      instruction: run.instruction ?? '',
      triggerMessageId: run.triggerMessageId ?? '',
    };

    await executor(queuedRun, new AbortController().signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(run.id);
    expect(calls[0]![1]).toBe('proj-1');
    expect(calls[0]![3]).toBe('trig-1');

    const resultMsg = db.prepare('SELECT content_json FROM messages WHERE id = ?').get(calls[0]![2]) as { content_json: string } | undefined;
    expect(resultMsg).toBeDefined();
    expect(JSON.parse(resultMsg!.content_json).text).toBe('这是智能体的最终回复');
  });

  it('编排器未产生最终消息时不触发回调', async () => {
    const { runOrchestrator } = await import('./langgraph-orchestrator');
    (runOrchestrator as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {});

    const gateway = { generateText: vi.fn(async () => ({ text: 'ok' })) };
    const scheduler = { enqueue: vi.fn(), cancelProject: vi.fn(), cancelRun: vi.fn() };
    const toolRegistry = { getDefinitionsForRole: () => [], execute: vi.fn() };
    const executor = createAgentExecutor(db, window as never, gateway as never, scheduler as unknown as Scheduler, toolRegistry as never);

    const calls: unknown[] = [];
    executor.onRunCompleted((...args: unknown[]) => {
      calls.push(args);
    });

    const run = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-orch',
      requestedByType: 'user',
      requestedById: 'u-1',
      instruction: '你好',
      triggerMessageId: 'trig-1',
    });

    const queuedRun = {
      runId: run.id,
      projectId: run.projectId,
      agentInstanceId: run.agentInstanceId,
      instruction: run.instruction ?? '',
      triggerMessageId: run.triggerMessageId ?? '',
    };

    await executor(queuedRun, new AbortController().signal);

    expect(calls).toHaveLength(0);
  });

  it('CodeBuddy 使用一次性确定性验收并通过，不启动 CLI 或返修循环', async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO cli_connections
       (id, name, adapter_type, executable_path, strategy_id, status, trust_tier)
       VALUES (?, ?, 'codebuddy', ?, 'auto', 'compatible', 'trusted')`,
    ).run('cli-codebuddy', 'CodeBuddy CLI', 'codebuddy');
    db.prepare(
      `INSERT INTO agent_profiles
       (id, name, definition_id, definition_version, runtime_mode, cli_connection_id, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, ?, '1.0.0', 'external-cli', ?, 1, 1, 0, ?, ?)`,
    ).run('prof-codebuddy', 'CodeBuddy', 'custom.codebuddy', 'cli-codebuddy', now, now);
    db.prepare(
      `INSERT INTO project_agent_instances
       (id, project_id, agent_profile_id, definition_id, definition_version, role, runtime_mode, cli_connection_id, ordinal, created_at)
       VALUES (?, ?, ?, ?, '1.0.0', 'teammate', 'external-cli', ?, 1, ?)`,
    ).run('inst-codebuddy', 'proj-1', 'prof-codebuddy', 'custom.codebuddy', 'cli-codebuddy', now);

    externalAdapterRun.mockResolvedValue({
      exitCode: 0,
      stdout: '`@统筹管理智能体` 接待安排文件已经生成并发送。',
      stderr: '',
      durationMs: 1_200,
    });
    const gateway = {
      generateText: vi.fn(async () => ({
        text: JSON.stringify({
          topic: '接待安排',
          taskSummary: '已生成接待安排文件',
          decisions: [], reusableInsights: [], preferences: [], constraints: [], unresolved: [],
          confidence: 0.8, importance: 0.6, longTermWorth: false,
          shortTermSummary: '已完成接待安排文件。', longTermSummary: '', roleAdaptations: [],
        }),
      })),
    };
    const scheduler = { enqueue: vi.fn(), cancelProject: vi.fn(), cancelRun: vi.fn() };
    const toolRegistry = { getDefinitionsForRole: () => [], execute: vi.fn() };
    const executor = createAgentExecutor(db, window as never, gateway as never, scheduler as unknown as Scheduler, toolRegistry as never);
    const parentRun = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-orch',
      requestedByType: 'user',
      requestedById: 'u-1',
      instruction: '请生成接待安排文件',
      triggerMessageId: 'trig-1',
    });
    const run = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-codebuddy',
      requestedByType: 'agent',
      requestedById: 'inst-orch',
      instruction: '@CodeBuddy 请生成接待安排 HTML 文件并发送',
      triggerMessageId: 'trig-1',
      parentRunId: parentRun.id,
    });

    await executor({
      runId: run.id,
      projectId: run.projectId,
      agentInstanceId: run.agentInstanceId,
      instruction: run.instruction ?? '',
      triggerMessageId: run.triggerMessageId ?? '',
    }, new AbortController().signal);

    expect(externalAdapterRun).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(gateway.generateText).toHaveBeenCalledTimes(1));
    const resultMessage = db.prepare(
      `SELECT content_json as contentJson FROM messages
       WHERE project_id = 'proj-1' AND sender_id = 'inst-codebuddy'
       ORDER BY created_at DESC LIMIT 1`,
    ).get() as { contentJson: string };
    const content = JSON.parse(resultMessage.contentJson) as {
      text: string;
      mentions: Array<{ target: { id: string }; start: number }>;
      audience: unknown;
    };
    expect(content.text).toContain('验收结论：通过');
    expect(content.text).toContain('简要分析：');
    expect(content.mentions).toEqual([expect.objectContaining({
      target: { scope: 'instance', id: 'inst-orch' },
      start: 0,
    })]);
    expect(content.audience).toEqual({ scope: 'parent', id: 'inst-orch' });
    // 交回父任务由原统筹 loop 收集结果，不应再启动一个重复统筹 Run。
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('独立闭环委派的成员交付直达用户，不再 @ 统筹转交', async () => {
    const independentDirective = '本轮为独立闭环交付：完成后直接在群聊面向用户给出最终结论、关键证据和真实成果文件。需要文件交付时由你直接核验并提升为 outputs 正式成果；不要 @ 统筹管理智能体，不要等待统筹验收、总结或追问。';
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO cli_connections
       (id, name, adapter_type, executable_path, strategy_id, status, trust_tier)
       VALUES (?, ?, 'codebuddy', ?, 'auto', 'compatible', 'trusted')`,
    ).run('cli-codebuddy-ind', 'CodeBuddy CLI', 'codebuddy');
    db.prepare(
      `INSERT INTO agent_profiles
       (id, name, definition_id, definition_version, runtime_mode, cli_connection_id, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, ?, '1.0.0', 'external-cli', ?, 1, 1, 0, ?, ?)`,
    ).run('prof-codebuddy-ind', 'CodeBuddy', 'custom.codebuddy', 'cli-codebuddy-ind', now, now);
    db.prepare(
      `INSERT INTO project_agent_instances
       (id, project_id, agent_profile_id, definition_id, definition_version, role, runtime_mode, cli_connection_id, ordinal, created_at)
       VALUES (?, ?, ?, ?, '1.0.0', 'teammate', 'external-cli', ?, 2, ?)`,
    ).run('inst-codebuddy-ind', 'proj-1', 'prof-codebuddy-ind', 'custom.codebuddy', 'cli-codebuddy-ind', now);

    externalAdapterRun.mockResolvedValue({
      exitCode: 0,
      stdout: '接待安排文件已经生成并发送。',
      stderr: '',
      durationMs: 900,
    });
    const gateway = {
      generateText: vi.fn(async () => ({
        text: JSON.stringify({
          topic: '接待安排',
          taskSummary: '已生成接待安排文件',
          decisions: [], reusableInsights: [], preferences: [], constraints: [], unresolved: [],
          confidence: 0.8, importance: 0.6, longTermWorth: false,
          shortTermSummary: '已完成接待安排文件。', longTermSummary: '', roleAdaptations: [],
        }),
      })),
    };
    const scheduler = { enqueue: vi.fn(), cancelProject: vi.fn(), cancelRun: vi.fn() };
    const toolRegistry = { getDefinitionsForRole: () => [], execute: vi.fn() };
    const executor = createAgentExecutor(db, window as never, gateway as never, scheduler as unknown as Scheduler, toolRegistry as never);
    const parentRun = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-orch',
      requestedByType: 'user',
      requestedById: 'u-1',
      instruction: '请生成接待安排文件',
      triggerMessageId: 'trig-1',
    });
    const run = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-codebuddy-ind',
      requestedByType: 'agent',
      requestedById: 'inst-orch',
      instruction: `@CodeBuddy 请生成接待安排文件\n\n${independentDirective}`,
      triggerMessageId: 'trig-1',
      parentRunId: parentRun.id,
    });

    await executor({
      runId: run.id,
      projectId: run.projectId,
      agentInstanceId: run.agentInstanceId,
      instruction: run.instruction ?? '',
      triggerMessageId: run.triggerMessageId ?? '',
    }, new AbortController().signal);

    expect(externalAdapterRun).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(gateway.generateText).toHaveBeenCalledTimes(1));
    const resultMessage = db.prepare(
      `SELECT content_json as contentJson FROM messages
       WHERE project_id = 'proj-1' AND sender_id = 'inst-codebuddy-ind'
       ORDER BY created_at DESC LIMIT 1`,
    ).get() as { contentJson: string };
    const content = JSON.parse(resultMessage.contentJson) as {
      text: string;
      mentions: unknown[];
      audience: unknown;
    };
    // 最终回复就是给用户的交付：无 @ 统筹前缀、无父级提及、受众面向用户。
    expect(content.text).toContain('验收结论：通过');
    expect(content.mentions).toEqual([]);
    expect(content.audience).toEqual({ scope: 'user' });
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  // 非 CodeBuddy/WorkBuddy 的外部 CLI 智能体：用于验证 planning 快路径。
  const seedExternalClaudeAgent = () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO cli_connections
       (id, name, adapter_type, executable_path, strategy_id, status, trust_tier)
       VALUES (?, ?, 'claude', ?, 'auto', 'compatible', 'trusted')`,
    ).run('cli-claude', 'Claude CLI', 'claude');
    db.prepare(
      `INSERT INTO agent_profiles
       (id, name, definition_id, definition_version, runtime_mode, cli_connection_id, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, ?, '1.0.0', 'external-cli', ?, 1, 1, 0, ?, ?)`,
    ).run('prof-claude', 'Claude', 'custom.claude', 'cli-claude', now, now);
    db.prepare(
      `INSERT INTO project_agent_instances
       (id, project_id, agent_profile_id, definition_id, definition_version, role, runtime_mode, cli_connection_id, ordinal, created_at)
       VALUES (?, ?, ?, ?, '1.0.0', 'teammate', 'external-cli', ?, 1, ?)`,
    ).run('inst-claude', 'proj-1', 'prof-claude', 'custom.claude', 'cli-claude', now);
  };

  it('外部 CLI 的单一委派命中快路径：跳过拆解往返直接执行', async () => {
    seedExternalClaudeAgent();
    externalAdapterRun.mockResolvedValue({
      exitCode: 0,
      stdout: '本季度差旅报销共 3 次。',
      stderr: '',
      durationMs: 900,
    });
    const gateway = { generateText: vi.fn(async () => ({ text: 'ok' })) };
    const scheduler = { enqueue: vi.fn(), cancelProject: vi.fn(), cancelRun: vi.fn() };
    const toolRegistry = { getDefinitionsForRole: () => [], execute: vi.fn() };
    const executor = createAgentExecutor(db, window as never, gateway as never, scheduler as unknown as Scheduler, toolRegistry as never);
    const parentRun = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-orch',
      requestedByType: 'user',
      requestedById: 'u-1',
      instruction: '查询本季度差旅报销次数',
      triggerMessageId: 'trig-1',
    });
    const run = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-claude',
      requestedByType: 'agent',
      requestedById: 'inst-orch',
      instruction: '查询本季度差旅报销次数',
      triggerMessageId: 'trig-1',
      parentRunId: parentRun.id,
    });

    await executor({
      runId: run.id,
      projectId: run.projectId,
      agentInstanceId: run.agentInstanceId,
      instruction: run.instruction ?? '',
      triggerMessageId: run.triggerMessageId ?? '',
    }, new AbortController().signal);

    // 快路径：第一次调用就是完整执行指令，不先做一次 CLI 进程的拆解往返。
    expect(externalAdapterRun).toHaveBeenCalledTimes(1);
    expect(externalAdapterRun.mock.calls[0]?.[0]?.instruction).toContain('请直接处理下面这条完整群聊消息');
    expect(externalAdapterRun.mock.calls[0]?.[0]?.instruction).not.toContain('先只拆解');
    // 非 CodeBuddy/WorkBuddy 的外部 CLI 在任务结束后会用同一适配器异步回顾私有记忆。
    await vi.waitFor(() => expect(externalAdapterRun).toHaveBeenCalledTimes(2));
    expect(externalAdapterRun.mock.calls[1]?.[0]?.instruction).toContain('请只回顾你自己刚完成的任务');
    for (const call of externalAdapterRun.mock.calls) {
      expect(call?.[0]?.instruction).not.toContain('先只拆解');
    }
  });

  it('外部 CLI 的复合委派仍先拆解再执行', async () => {
    seedExternalClaudeAgent();
    externalAdapterRun.mockImplementation(async (req: { instruction: string }) =>
      req.instruction.includes('先只拆解')
        ? { exitCode: 0, stdout: '{"summary":"先查再整理","items":["查询差旅报销制度","整理本月报销台账"]}', stderr: '', durationMs: 120 }
        : { exitCode: 0, stdout: '已查询制度并整理完成台账。', stderr: '', durationMs: 500 });
    const gateway = { generateText: vi.fn(async () => ({ text: 'ok' })) };
    const scheduler = { enqueue: vi.fn(), cancelProject: vi.fn(), cancelRun: vi.fn() };
    const toolRegistry = { getDefinitionsForRole: () => [], execute: vi.fn() };
    const executor = createAgentExecutor(db, window as never, gateway as never, scheduler as unknown as Scheduler, toolRegistry as never);
    const parentRun = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-orch',
      requestedByType: 'user',
      requestedById: 'u-1',
      instruction: '先查询差旅报销制度，再整理成本月报销台账',
      triggerMessageId: 'trig-1',
    });
    const run = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-claude',
      requestedByType: 'agent',
      requestedById: 'inst-orch',
      instruction: '先查询差旅报销制度，再整理成本月报销台账',
      triggerMessageId: 'trig-1',
      parentRunId: parentRun.id,
    });

    await executor({
      runId: run.id,
      projectId: run.projectId,
      agentInstanceId: run.agentInstanceId,
      instruction: run.instruction ?? '',
      triggerMessageId: run.triggerMessageId ?? '',
    }, new AbortController().signal);

    // 阶段词命中：先做一次拆解调用，再携带完整指令执行。
    expect(externalAdapterRun).toHaveBeenCalledTimes(2);
    expect(externalAdapterRun.mock.calls[0]?.[0]?.instruction).toContain('先只拆解');
    expect(externalAdapterRun.mock.calls[1]?.[0]?.instruction).toContain('请直接处理下面这条完整群聊消息');
  });

  it('均衡模式下无阶段特征的单一任务跳过模型规划', async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_profiles
       (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, 'builtin.researcher', '1.0.0', 'native-model', 1, 1, 0, ?, ?)`,
    ).run('prof-researcher', '调研分析智能体', now, now);
    db.prepare(
      `INSERT INTO project_agent_instances
       (id, project_id, agent_profile_id, definition_id, definition_version, role, runtime_mode, ordinal, created_at)
       VALUES (?, ?, ?, 'builtin.researcher', '1.0.0', 'teammate', 'native-model', 1, ?)`,
    ).run('inst-researcher', 'proj-1', 'prof-researcher', now);
    db.prepare(
      `INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at)
       VALUES (?, ?, 'user', 'u-1', 'text', ?, 'sent', ?, ?)`,
    ).run('trig-balanced', 'proj-1',
      JSON.stringify({ schemaVersion: 1, text: '查询本季度差旅报销次数', channelId: 'ch-1', collaborationMode: 'balanced' }),
      now, now);

    const gateway = { generateText: vi.fn(async (_slot: string, _messages: Array<{ content: string }>) => ({ text: '本季度差旅报销共 3 次。' })) };
    const scheduler = { enqueue: vi.fn(), cancelProject: vi.fn(), cancelRun: vi.fn() };
    const toolRegistry = { getDefinitionsForRole: () => [], execute: vi.fn() };
    const executor = createAgentExecutor(db, window as never, gateway as never, scheduler as unknown as Scheduler, toolRegistry as never);
    const run = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-researcher',
      requestedByType: 'user',
      requestedById: 'u-1',
      instruction: '查询本季度差旅报销次数',
      triggerMessageId: 'trig-balanced',
    });

    await executor({
      runId: run.id,
      projectId: run.projectId,
      agentInstanceId: run.agentInstanceId,
      instruction: run.instruction ?? '',
      triggerMessageId: run.triggerMessageId ?? '',
    }, new AbortController().signal);

    // 快路径：没有规划轮，只有单个步骤执行轮（记忆整理是异步追加，且也不含规划提示词）。
    expect(gateway.generateText).toHaveBeenCalledTimes(1);
    const planningContents = gateway.generateText.mock.calls
      .map((call) => (call[1] as Array<{ content: string }>).map((m) => m.content).join('\n'))
      .filter((content) => content.includes('请用均衡但精简的方式判断执行步骤') || content.includes('请判断这是单一任务还是复合任务'));
    expect(planningContents).toEqual([]);
  });

  it('均衡模式下的复合任务仍走模型规划', async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_profiles
       (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at)
       VALUES (?, ?, 'builtin.researcher', '1.0.0', 'native-model', 1, 1, 0, ?, ?)`,
    ).run('prof-researcher', '调研分析智能体', now, now);
    db.prepare(
      `INSERT INTO project_agent_instances
       (id, project_id, agent_profile_id, definition_id, definition_version, role, runtime_mode, ordinal, created_at)
       VALUES (?, ?, ?, 'builtin.researcher', '1.0.0', 'teammate', 'native-model', 1, ?)`,
    ).run('inst-researcher', 'proj-1', 'prof-researcher', now);
    db.prepare(
      `INSERT INTO messages (id, project_id, sender_type, sender_id, kind, content_json, status, created_at, updated_at)
       VALUES (?, ?, 'user', 'u-1', 'text', ?, 'sent', ?, ?)`,
    ).run('trig-balanced-compound', 'proj-1',
      JSON.stringify({ schemaVersion: 1, text: '先查询差旅报销制度，再整理成本月报销台账', channelId: 'ch-1', collaborationMode: 'balanced' }),
      now, now);

    const gateway = {
      generateText: vi.fn(async (_slot: string, messages: Array<{ content: string }>) => ({
        text: messages.some((m) => m.content.includes('请用均衡但精简的方式判断执行步骤'))
          ? '{"summary":"查制度并整理","items":["查询差旅报销制度","整理成本月报销台账"]}'
          : '该步骤已完成。',
      })),
    };
    const scheduler = { enqueue: vi.fn(), cancelProject: vi.fn(), cancelRun: vi.fn() };
    const toolRegistry = { getDefinitionsForRole: () => [], execute: vi.fn() };
    const executor = createAgentExecutor(db, window as never, gateway as never, scheduler as unknown as Scheduler, toolRegistry as never);
    const run = runRepo.create({
      projectId: 'proj-1',
      agentInstanceId: 'inst-researcher',
      requestedByType: 'user',
      requestedById: 'u-1',
      instruction: '先查询差旅报销制度，再整理成本月报销台账',
      triggerMessageId: 'trig-balanced-compound',
    });

    await executor({
      runId: run.id,
      projectId: run.projectId,
      agentInstanceId: run.agentInstanceId,
      instruction: run.instruction ?? '',
      triggerMessageId: run.triggerMessageId ?? '',
    }, new AbortController().signal);

    // 阶段词命中：先调用一次规划，再逐项执行。
    const planningCalls = gateway.generateText.mock.calls
      .filter((call) => (call[1] as Array<{ content: string }>).some((m) => m.content.includes('请用均衡但精简的方式判断执行步骤')));
    expect(planningCalls).toHaveLength(1);
  });
});
