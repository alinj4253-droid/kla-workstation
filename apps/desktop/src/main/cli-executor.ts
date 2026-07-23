import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { ProcessSupervisor, type SpawnSpec } from './process-supervisor';
import { cliAgentRegistry } from './cli-agent-registry';
import { getProjectRoot } from './paths';
import { sanitizeEnv } from './env-sanitizer';
import { normalizeChunk, isStructuredEvent } from './event-normalizer';
import type { CliConnectionConfig } from '@kunqing/agent-core';

export type CliRunOptions = {
  connection: CliConnectionConfig;
  instruction: string;
  projectId: string;
  window: BrowserWindow;
  signal: AbortSignal | undefined;
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

  async execute(options: CliRunOptions): Promise<CliRunResult> {
    const { connection, instruction, projectId, window, signal } = options;
    const runId = `cli-${randomUUID().slice(0, 8)}`;
    const start = Date.now();

    const projectRoot = getProjectRoot(projectId);
    const spec: SpawnSpec = {
      executable: connection.executablePath,
      args: [instruction],
      cwd: projectRoot,
      env: sanitizeEnv(process.env as Record<string, string>),
      stdin: instruction,
      shell: false,
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
            runId,
            projectId,
            event,
          });
          // 结构化事件（非降级文本）也单独按类型分发
          if (isStructuredEvent(event)) {
            dispatch({ type: `cli.event.${event.type.replace('.', '_')}`, runId, projectId, event });
          }
        }
      });

      const unsubStderr = this.supervisor.on(runId, 'stderr', (evt) => {
        // stderr 也经归一化，但始终标记为降级事件
        const normalized = normalizeChunk(evt.data, runId);
        for (const event of normalized) {
          dispatch({
            type: 'cli.event',
            runId,
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
    this.supervisor.cancel(runId);
  }

  cancelAll(): void {
    this.supervisor.cancelAll();
  }

  isRunning(runId: string): boolean {
    return this.supervisor.isRunning(runId);
  }

  getSupervisor(): ProcessSupervisor {
    return this.supervisor;
  }
}

export const cliExecutor = new CliExecutor();
