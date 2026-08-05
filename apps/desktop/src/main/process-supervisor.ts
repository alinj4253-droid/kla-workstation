import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { getLogger } from './logger';
import { AGENT_TASK_TIMEOUT_MS } from './agent-runtime-limits';

export type SpawnSpec = {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  shell: boolean;
};

export type SpawnOptions = {
  /** 进程超时（毫秒），默认 4 小时 */
  timeoutMs?: number;
  /** 进程退出后等待文件稳定窗口（毫秒），默认 500ms */
  stabilityWindowMs?: number;
  /** stdout 最大字节数，默认 10MB，超限则终止进程 */
  maxStdoutBytes?: number;
  /** stderr 最大字节数，默认 1MB，超限则终止进程 */
  maxStderrBytes?: number;
};

export type SpawnInvocation = {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

/**
 * 判断该调用是否需要在 Windows 上经 cmd.exe 解析。
 * 裸命令名（如 `opencode`，可能解析为 PATH 上的 .cmd shim）与
 * .cmd/.bat 脚本都必须交给 cmd；.exe/.com 可由 CreateProcess 直接启动。
 */
export function shouldUseCmdShim(executable: string, shell: boolean, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && shell && !/\.(?:exe|com)$/i.test(executable);
}

/**
 * 将 SpawnSpec 转换为安全的 spawn 调用。永不启用 shell: true；
 * Windows 上需要 cmd 解析的命令改用 cmd.exe /d /s /c，并对每个参数
 * 做双引号包裹 + 引号翻倍，使 & | < > ^ 等元字符仅作为文本，避免命令注入。
 */
export function buildSpawnInvocation(spec: Pick<SpawnSpec, 'executable' | 'args' | 'shell'>): SpawnInvocation {
  if (shouldUseCmdShim(spec.executable, spec.shell)) {
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    const quoted = [spec.executable, ...spec.args].map((p) => `"${p.replace(/"/g, '""')}"`).join(' ');
    return { executable: comspec, args: ['/d', '/s', '/c', `"${quoted}"`], windowsVerbatimArguments: true };
  }
  return { executable: spec.executable, args: spec.args };
}

export type ProcessEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'error'; message: string }
  | { type: 'size_limit_exceeded'; stream: 'stdout' | 'stderr'; limitBytes: number; actualBytes: number };

/** 跨平台终止进程树 */
function killProcessTree(pid: number, signal?: string): void {
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'pipe', timeout: 3000 });
    } catch {
      // 进程可能已结束或无权限
    }
  } else {
    try {
      process.kill(-pid, signal ?? 'SIGTERM');
    } catch {
      try {
        process.kill(pid, signal ?? 'SIGTERM');
      } catch {
        // 进程已结束
      }
    }
  }
}

export class ProcessSupervisor {
  private processes = new Map<string, ChildProcess>();
  private timeoutTimers = new Map<string, NodeJS.Timeout>();
  private emitter = new EventEmitter();

  spawn(runId: string, spec: SpawnSpec, options?: SpawnOptions): void {
    const logger = getLogger();
    const timeoutMs = options?.timeoutMs ?? AGENT_TASK_TIMEOUT_MS;
    const stabilityWindowMs = options?.stabilityWindowMs ?? 500;
    const maxStdoutBytes = options?.maxStdoutBytes ?? 10 * 1024 * 1024;
    const maxStderrBytes = options?.maxStderrBytes ?? 1 * 1024 * 1024;

    const invocation = buildSpawnInvocation(spec);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    this.processes.set(runId, child);
    logger?.info({ runId, executable: spec.executable, timeoutMs, maxStdoutBytes, maxStderrBytes }, 'ProcessSupervisor: 子进程已启动');

    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        logger?.warn({ runId, timeoutMs }, 'ProcessSupervisor: 进程超时，正在终止');
        const proc = this.processes.get(runId);
        if (proc && !proc.killed && proc.pid) {
          try { proc.kill(); } catch { /* 可能已结束 */ }
          killProcessTree(proc.pid);
        }
      }, timeoutMs);
      this.timeoutTimers.set(runId, timer);
    }

    if (spec.stdin && child.stdin) {
      child.stdin.write(spec.stdin);
      child.stdin.end();
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedByLimit = false;

    const killByLimit = (stream: 'stdout' | 'stderr', limitBytes: number, actualBytes: number): void => {
      if (killedByLimit) return;
      killedByLimit = true;
      const proc = this.processes.get(runId);
      if (proc && !proc.killed && proc.pid) {
        try { proc.kill(); } catch { /* 可能已结束 */ }
        killProcessTree(proc.pid);
      }
      this.emitter.emit(`size_limit_exceeded:${runId}`, { type: 'size_limit_exceeded', stream, limitBytes, actualBytes } as ProcessEvent);
      logger?.warn({ runId, stream, limitBytes, actualBytes }, 'ProcessSupervisor: 输出超限，已终止进程');
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        killByLimit('stdout', maxStdoutBytes, stdoutBytes);
        return;
      }
      this.emitter.emit(`stdout:${runId}`, { type: 'stdout', data: chunk.toString() } as ProcessEvent);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        killByLimit('stderr', maxStderrBytes, stderrBytes);
        return;
      }
      this.emitter.emit(`stderr:${runId}`, { type: 'stderr', data: chunk.toString() } as ProcessEvent);
    });

    child.on('exit', (code, signal) => {
      const timer = this.timeoutTimers.get(runId);
      if (timer) {
        clearTimeout(timer);
        this.timeoutTimers.delete(runId);
      }

      this.processes.delete(runId);
      logger?.info({ runId, code, signal, stdoutBytes, stderrBytes }, 'ProcessSupervisor: 子进程已退出，等待文件稳定窗口');

      setTimeout(() => {
        this.emitter.emit(`exit:${runId}`, { type: 'exit', code, signal } as ProcessEvent);
        logger?.info({ runId, code, signal }, 'ProcessSupervisor: 文件稳定窗口结束，发出退出事件');
      }, stabilityWindowMs);
    });

    child.on('error', (err) => {
      const timer = this.timeoutTimers.get(runId);
      if (timer) {
        clearTimeout(timer);
        this.timeoutTimers.delete(runId);
      }

      this.processes.delete(runId);
      this.emitter.emit(`error:${runId}`, { type: 'error', message: err.message } as ProcessEvent);
      logger?.warn({ runId, error: err.message }, 'ProcessSupervisor: 子进程错误');
    });
  }

  on<E extends ProcessEvent['type']>(runId: string, event: E, handler: (event: Extract<ProcessEvent, { type: E }>) => void): () => void {
    const channel = `${event}:${runId}`;
    this.emitter.on(channel, handler);
    return () => { this.emitter.off(channel, handler); };
  }

  cancel(runId: string, graceMs = 2000): void {
    const proc = this.processes.get(runId);
    if (!proc) return;
    const logger = getLogger();
    logger?.info({ runId, graceMs }, 'ProcessSupervisor: 正在取消子进程');

    const timer = this.timeoutTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(runId);
    }

    try {
      try { proc.kill(); } catch { /* 进程可能已结束 */ }
      if (proc.pid) {
        killProcessTree(proc.pid);
      }

      const killTimer = setTimeout(() => {
        try {
          if (!proc.killed && proc.pid) {
            killProcessTree(proc.pid, process.platform === 'win32' ? undefined : 'SIGKILL');
            try { proc.kill('SIGKILL'); } catch { /* already dead */ }
            logger?.warn({ runId }, 'ProcessSupervisor: 优雅关闭超时，已强制终止进程树');
          }
        } catch { /* already dead */ }
      }, graceMs);

      proc.on('exit', () => clearTimeout(killTimer));
    } catch (err) {
      logger?.warn({ err, runId }, 'ProcessSupervisor: 取消子进程失败');
    }
  }

  cancelAll(graceMs = 2000): void {
    const runIds = Array.from(this.processes.keys());
    for (const runId of runIds) {
      this.cancel(runId, graceMs);
    }
  }

  isRunning(runId: string): boolean {
    return this.processes.has(runId);
  }

  private unsubscribeAll(runId: string): void {
    for (const event of ['stdout', 'stderr', 'exit', 'error', 'size_limit_exceeded'] as const) {
      this.emitter.removeAllListeners(`${event}:${runId}`);
    }
  }
}
