// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { runMigrations } from './db/migrate';
import { getDatabase, closeDatabase } from './db/connection';
import { AgentRunRepository } from '@kunqing/database';
import { createAgentExecutor } from './agent-executor';
import type { Scheduler } from './scheduler';

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
vi.mock('./cli-agent-registry', () => ({ cliAgentRegistry: { getAdapter: () => undefined } }));
vi.mock('./business-process', () => ({
  parsePostTaskKnowledgeInstruction: vi.fn(() => null),
  runPostTaskKnowledgeCapture: vi.fn(),
}));
vi.mock('./logger', () => ({ getLogger: () => undefined }));
vi.mock('./paths', () => ({ getProjectRoot: () => tmpdir() }));
vi.mock('./agent-identity', () => ({ applyAgentRoleAdaptations: vi.fn() }));

describe('AgentExecutor 编排器路径：完成后触发渠道回复回调', () => {
  let db: Database.Database;
  let dbPath: string;
  let dir: string;
  let runRepo: AgentRunRepository;
  let window: { webContents: { send: (channel: string, ...args: unknown[]) => void }; isDestroyed: () => boolean };

  beforeEach(() => {
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
});
