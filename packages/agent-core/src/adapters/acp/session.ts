import { execSync } from 'node:child_process';
import { client, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  ClientContext,
  ActiveSession,
  ClientRequestContext,
  McpServer,
  ClientCapabilities,
  PromptResponse,
  SessionUpdate,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { AgentEventSink, ExternalRunResult } from '../../external-agent-adapter.js';
import type { AcpTransport } from './transport.js';

export type AcpSessionRunOptions = {
  transport: AcpTransport;
  instruction: string;
  workspaceRoot: string;
  sink: AgentEventSink;
  signal: AbortSignal;
  /** session/new 注入的 MCP server 列表（进程级，Run 结束即释放） */
  mcpServers?: McpServer[];
  /** initialize 时上报的 client capabilities */
  clientCapabilities?: ClientCapabilities;
  /** 默认按 trustTier 决定，未提供时拒绝权限请求 */
  onPermissionRequest?: (context: ClientRequestContext<RequestPermissionRequest>) => Promise<RequestPermissionResponse>;
  /** stdout 单事件上限（字节），超限则降级为受限文本 */
  maxEventBytes?: number;
};

export type AcpSessionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  stopReason?: string;
};

const MAX_EVENT_BYTES = 256 * 1024; // MVP 规格 L1411：单事件 256 KB
const PROCESS_TREE_KILL_GRACE_MS = 2_000; // MVP 规格 L1419：session/cancel 后 2 秒兜底终止进程树

/** 跨平台终止进程树（Windows 经 taskkill /T /F；POSIX 向进程组发信号） */
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

function toEventAt(): string {
  return new Date().toISOString();
}

/** 序列化 agentEventSchema 兼容的 JSON 行（desktop 端 normalizeChunk 解析） */
function jsonLine(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

/** L1411：单事件超限时截断为受限文本（protocol_degraded 由呈现层标记） */
function truncateText(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  const truncated = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  return truncated.replace(/\uFFFD+$/, '');
}

/** 将 ACP session/update 通知映射为 AgentEventSink 可消费的事件行 */
function mapSessionUpdate(
  update: SessionUpdate,
  emit: (line: string) => void,
  collectText: (text: string) => void,
  maxBytes: number,
): void {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content.type === 'text') {
        const text = truncateText(update.content.text, maxBytes);
        if (text) {
          emit(jsonLine({ type: 'message.delta', text, at: toEventAt() }));
          collectText(text);
        }
      }
      break;
    case 'agent_thought_chunk':
      // MVP 规格 L1412：隐藏推理不落聊天，仅内部 trace（骨架阶段忽略）
      break;
    case 'tool_call':
      emit(jsonLine({
        type: 'tool.requested',
        callId: update.toolCallId,
        tool: update.title,
        safeSummary: truncateText(update.title, maxBytes),
        at: toEventAt(),
      }));
      break;
    case 'tool_call_update':
      emit(jsonLine({
        type: 'tool.completed',
        callId: update.toolCallId,
        ok: update.status === 'completed',
        at: toEventAt(),
      }));
      break;
    case 'plan':
    case 'plan_update':
    case 'plan_removed':
      // 规划事件仅作内部 trace（骨架阶段忽略，不落聊天）
      break;
    case 'usage_update':
      break;
    default:
      break;
  }
}

/** 取消当前 prompt turn：先发 session/cancel 优雅取消，2 秒后终止进程树 */
async function cancelTurn(
  ctx: ClientContext,
  session: ActiveSession,
  transport: AcpTransport,
): Promise<void> {
  try {
    await ctx.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
  } catch {
    // 通知失败不阻塞兜底终止
  }
  const killTimer = setTimeout(() => {
    const pid = transport.child.pid;
    if (pid && !transport.child.killed) {
      killProcessTree(pid);
    }
  }, PROCESS_TREE_KILL_GRACE_MS);
  transport.child.once('exit', () => clearTimeout(killTimer));
}

/**
 * 执行一次完整的 ACP run() 生命周期（自包含，可独立调用）：
 *
 *   connectWith → initialize → session/new → prompt → 读 session/update 流
 *   → stopReason 到达 → session/close → 进程退出
 *
 * 任何异常路径都会终止子进程树并等待退出，不泄漏进程。
 */
export async function runAcpSession(options: AcpSessionRunOptions): Promise<AcpSessionResult> {
  const {
    transport, instruction, workspaceRoot, sink, signal,
    mcpServers, clientCapabilities, onPermissionRequest, maxEventBytes,
  } = options;
  const start = Date.now();
  const eventLimit = maxEventBytes ?? MAX_EVENT_BYTES;

  const emit = (line: string): void => {
    sink.onStdout?.(line + '\n');
  };

  const app = client({ name: 'kun-ai-chat-acp-client' })
    .onRequest(methods.client.session.requestPermission, (ctx) =>
      onPermissionRequest
        ? onPermissionRequest(ctx)
        : Promise.resolve({ outcome: { outcome: 'cancelled' } as const }),
    );

  let stdout = '';
  let stderr = '';
  let stopReason: string | undefined;

  const collectText = (text: string): void => {
    stdout += text;
  };

  transport.child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    sink.onStderr?.(text);
  });

  try {
    await app.connectWith(transport.stream, async (ctx) => {
      await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: clientCapabilities ?? {
          fs: { readTextFile: true, writeTextFile: true },
        },
        clientInfo: { name: 'kun-ai-chat', version: '0.1.0' },
      });

      const builder = ctx.buildSession(workspaceRoot);
      for (const server of mcpServers ?? []) {
        builder.withMcpServer(server);
      }

      const session = await builder.start({ cancellationSignal: signal });

      const onAbort = (): void => {
        void cancelTurn(ctx, session, transport);
      };
      if (!signal.aborted) signal.addEventListener('abort', onAbort);

      try {
        const promptPromise = session.prompt(instruction, { cancellationSignal: signal });
        for (;;) {
          const message = await session.nextUpdate();
          if (message.kind === 'stop') {
            stopReason = message.stopReason;
            await promptPromise;
            return message.response;
          }
          mapSessionUpdate(message.notification.update, emit, collectText, eventLimit);
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        session.dispose();
        await ctx.request(methods.agent.session.close, { sessionId: session.sessionId }).catch(() => undefined);
      }
    });

    if (stdout) {
      emit(jsonLine({ type: 'run.completed', at: toEventAt() }));
    }
  } finally {
    // 结束连接后终止子进程树并等待退出
    const pid = transport.child.pid;
    if (pid && !transport.child.killed) {
      killProcessTree(pid);
    }
    await new Promise<void>((resolve) => {
      if (transport.child.exitCode !== null || transport.child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => resolve(), PROCESS_TREE_KILL_GRACE_MS);
      transport.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    exitCode: transport.child.exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - start,
    ...(stopReason ? { stopReason } : {}),
  };
}

/**
 * smoke 测试握手：仅 initialize + session/new + session/close，不发起真实 prompt，
 * 不触发计费/依赖账号额度。用于验证 ACP 协议端点可用（agent-connection-service 调用）。
 */
export async function acpSmokeHandshake(
  transport: AcpTransport,
  signal: AbortSignal,
  workspaceRoot = process.cwd(),
): Promise<{ ok: boolean; error?: string }> {
  try {
    await transport.app.connectWith(transport.stream, async (ctx) => {
      await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: 'kun-ai-chat', version: '0.1.0' },
      });
      const session = await ctx.buildSession(workspaceRoot).start({ cancellationSignal: signal });
      session.dispose();
      await ctx.request(methods.agent.session.close, { sessionId: session.sessionId }).catch(() => undefined);
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
