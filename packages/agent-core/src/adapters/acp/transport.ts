import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, type ClientApp, type Stream } from '@agentclientprotocol/sdk';
import { buildSpawnInvocation } from '../spawn.js';
import type { SpawnSpec } from '../../external-agent-adapter.js';

export type AcpTransportOptions = {
  spec: SpawnSpec;
  /** banner/进度抑制等注册表配置的环境变量，叠加在 spec.env 之上 */
  envOverrides?: Record<string, string>;
  onProtocolStderr?: (text: string) => void;
};

export type AcpTransport = {
  child: ChildProcess;
  app: ClientApp;
  stream: Stream;
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
};

/**
 * 建立 ACP stdio 传输通道。
 *
 * spawn 复用 buildSpawnInvocation（L1357/L1358：永不 shell:true，Windows .cmd
 * shim 走固定 launcher）。stdin/stdout 经 Writable.toWeb / Readable.toWeb 转成
 * WHATWG 流后交给 SDK 的 ndJsonStream 做 JSON-RPC 帧解析。
 */
export function createAcpTransport(options: AcpTransportOptions): AcpTransport {
  const { spec, envOverrides, onProtocolStderr } = options;
  const invocation = buildSpawnInvocation(spec);

  const child = spawn(invocation.executable, invocation.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env, ...(envOverrides ?? {}) },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });

  const stdin = Writable.toWeb(child.stdin as never) as WritableStream<Uint8Array>;
  const stdout = Readable.toWeb(child.stdout as never) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(stdin, stdout);
  const app = client({ name: 'kun-ai-chat-acp-client' });

  if (onProtocolStderr) {
    child.stderr?.on('data', (chunk: Buffer) => onProtocolStderr(chunk.toString()));
  }

  return { child, app, stream, stdin, stdout };
}
