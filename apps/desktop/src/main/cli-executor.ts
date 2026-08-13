import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { ProcessSupervisor, type SpawnSpec } from './process-supervisor';
import { cliAgentRegistry } from './cli-agent-registry';
import { getProjectRoot } from './paths';
import { sanitizeEnv } from './env-sanitizer';
import { normalizeChunk, isStructuredEvent } from './event-normalizer';
import { getLogger } from './logger';
import type { CliConnectionConfig, ExternalAgentAdapter, ExternalRunResult } from '@kunqing/agent-core';

export type CliRunOptions = {
  connection: CliConnectionConfig;
  instruction: string;
  projectId: string;
  window: BrowserWindow;
  signal: AbortSignal | undefined;
  /** 适配器策略生成的参数，用于替代默认的 [instruction] */
  args?: string[];
  /** 映射到群聊中的真实 Agent Run，供 UI 展示执行轨迹 */
  activityRunId?: string;
  /** 外部智能体按 Run 隔离的私有执行目录；未提供时仅用于设置页的独立测试。 */
  workspaceRoot?: string;
};

export type CliRunResult = {
  exitCode: number | null;
  output: string;
  durationMs: number;
  cancelled: boolean;
};

export class CliExecutor {
  private supervisor = new ProcessSupervisor();
  private runMap = new Map<string, { connectionId: string; runId: string }>();
  private acpRuns = new Map<string, { abort: () => void }>();

  /**
   * 判断该连接是否应走 ACP 长连接路径。
   * 只有适配器显式声明 acp 支持时才启用；其余连接保持原有 spawn 模型。
   */
  private isAcpConnection(adapterType: string): boolean {
    const adapter = cliAgentRegistry.getAdapter(adapterType);
    return !!adapter && 'acp' in adapter && (adapter as any).acp === true;
  }

  private async executeAcp(
    options: CliRunOptions,
    adapter: ExternalAgentAdapter,
  ): Promise<CliRunResult> {
    const logger = getLogger();
    const { connection, instruction, projectId, window } = options;
    const runId = `acp-${randomUUID().slice(0, 8)}`;
    const start = Date.now();
    const abortController = new AbortController();
    let stdout = '';
    let stderr = '';

    logger?.info({ runId, adapterType: connection.adapterType, adapter: adapter.type }, 'CliExecutor: 走 ACP 长连接路径（executeAcp）');

    const dispatch = (event: Record<string, unknown>): void => {
      if (!window.isDestroyed()) window.webContents.send('event:dispatch', event);
    };
    const onStdout = (data: string): void => {
      stdout += data;
      for (const event of normalizeChunk(data, runId)) {
        dispatch({ type: 'cli.event', runId: options.activityRunId ?? runId, projectId, event });
        if (isStructuredEvent(event)) {
          dispatch({ type: `cli.event.${event.type.replace('.', '_')}`, runId: options.activityRunId ?? runId, projectId, event });
        }
      }
    };
    const onStderr = (data: string): void => {
      stderr += data;
      for (const event of normalizeChunk(data, runId)) {
        dispatch({
          type: 'cli.event',
          runId: options.activityRunId ?? runId,
          projectId,
          event: { ...event, protocol_degraded: true, _source: 'stderr' },
        });
      }
    };

    const connSnapshot: import('@kunqing/agent-core').CliConnectionSnapshot = {
      id: connection.id,
      name: connection.name,
      adapterType: connection.adapterType,
      executablePath: connection.executablePath,
      strategyId: connection.strategyId,
      trustTier: connection.trustTier,
      capabilities: connection.capabilities ?? [],
      secretRefs: connection.secretRefs ?? [],
      detectedVersion: connection.detectedVersion,
    };

    const abortRun = (): void => {
      abortController.abort();
      this.acpRuns.delete(runId);
    };
    const onAbort = (): void => abortRun();
    this.acpRuns.set(runId, { abort: abortRun });
    if (options.signal) options.signal.addEventListener('abort', onAbort);

    let result: ExternalRunResult;
    try {
      result = await adapter.run(
        {
          connection: connSnapshot,
          instruction,
          workspaceRoot: options.workspaceRoot ?? getProjectRoot(projectId),
        },
        { onStdout, onStderr },
        abortController.signal,
      );
    } finally {
      this.acpRuns.delete(runId);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }

    return {
      exitCode: result.exitCode,
      output: stdout + (stderr ? `\n${stderr}` : ''),
      durationMs: result.durationMs,
      cancelled: result.exitCode === null,
    };
  }

  async execute(options: CliRunOptions): Promise<CliRunResult> {
    const { connection, instruction, projectId, window, signal } = options;
    if (this.isAcpConnection(connection.adapterType)) {
      const adapter = cliAgentRegistry.getAdapter(connection.adapterType)!;
      return this.executeAcp({ ...options, connection }, adapter);
    }
    getLogger()?.info({ runId: `cli-${randomUUID().slice(0, 8)}`, adapterType: connection.adapterType }, 'CliExecutor: 走手写 spawn 路径（非 ACP）');

    const runId = `cli-${randomUUID().slice(0, 8)}`;
    const start = Date.now();

    const projectRoot = options.workspaceRoot ?? getProjectRoot(projectId);
    const spec: SpawnSpec = {
      executable: connection.executablePath,
      args: options.args ?? [instruction],
      cwd: projectRoot,
      env: sanitizeEnv(process.env as Record<string, string>),
      stdin: instruction,
      shell: process.platform === 'win32',
    };

    let output = '';

    const dispatch = (event: Record<string, unknown>): void => {
      if (!window.isDestroyed()) window.webContents.send('event:dispatch', event);
    };

    return new Promise((resolve) => {
      this.runMap.set(runId, { connectionId: connection.id, runId });

      const unsubStdout = this.supervisor.on(runId, 'stdout', (evt) => {
        output += evt.data;
        // 将 CLI 输出块经过归一化后分发为结构化事件
        const normalized = normalizeChunk(evt.data, runId);
        for (const event of normalized) {
          dispatch({
            type: 'cli.event',
            runId: options.activityRunId ?? runId,
            projectId,
            event,
          });
          // 结构化事件（非降级文本）也单独按类型分发
          if (isStructuredEvent(event)) {
            dispatch({ type: `cli.event.${event.type.replace('.', '_')}`, runId: options.activityRunId ?? runId, projectId, event });
          }
        }
      });

      const unsubStderr = this.supervisor.on(runId, 'stderr', (evt) => {
        // stderr 也经归一化，但始终标记为降级事件
        const normalized = normalizeChunk(evt.data, runId);
        for (const event of normalized) {
          dispatch({
            type: 'cli.event',
            runId: options.activityRunId ?? runId,
            projectId,
            event: { ...event, protocol_degraded: true, _source: 'stderr' },
          });
        }
      });

      const unsubExit = this.supervisor.on(runId, 'exit', (evt) => {
        unsubStdout();
        unsubStderr();
        unsubExit();
        unsubError();
        this.runMap.delete(runId);
        resolve({ exitCode: evt.code, output, durationMs: Date.now() - start, cancelled: evt.code === null });
      });

      const unsubError = this.supervisor.on(runId, 'error', (evt) => {
        unsubStdout();
        unsubStderr();
        unsubExit();
        unsubError();
        this.runMap.delete(runId);
        resolve({ exitCode: -1, output, durationMs: Date.now() - start, cancelled: false });
      });

      if (signal) {
        const onAbort = (): void => {
          this.supervisor.cancel(runId);
          signal.removeEventListener('abort', onAbort);
        };
        signal.addEventListener('abort', onAbort);
      }

      this.supervisor.spawn(runId, spec);
    });
  }

  cancelRun(runId: string): void {
    const acpRun = this.acpRuns.get(runId);
    if (acpRun) {
      acpRun.abort();
      this.acpRuns.delete(runId);
      return;
    }
    this.supervisor.cancel(runId);
  }

  cancelAll(): void {
    for (const [runId, run] of this.acpRuns) {
      run.abort();
      this.acpRuns.delete(runId);
    }
    this.supervisor.cancelAll();
  }

  isRunning(runId: string): boolean {
    if (this.acpRuns.has(runId)) return true;
    return this.supervisor.isRunning(runId);
  }

  getSupervisor(): ProcessSupervisor {
    return this.supervisor;
  }
}

export const cliExecutor = new CliExecutor();
