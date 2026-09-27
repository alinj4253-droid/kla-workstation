import type { McpConnectionConfig, McpServerInfo, McpTool, McpToolResult } from './types.js';

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** Minimal MCP client for WorkBuddy's streamable HTTP/SSE connector format. */
export class StreamableHttpMcpClient {
  private sessionId: string | null = null;
  private requestId = 0;
  private initialized = false;
  private ssePostUrl: string | null = null;

  constructor(private readonly config: McpConnectionConfig) {}

  async initialize(signal?: AbortSignal): Promise<McpServerInfo> {
    if (this.config.transport === 'sse') await this.openSseEndpoint(signal);
    const response = await this.request('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'KLA Workstation', version: '0.1.0' },
    }, signal);
    this.initialized = true;
    // MCP notifications do not require a response. Some servers accept a
    // normal request only, so ignore a failed notification after initialize.
    try { await this.notify('notifications/initialized', {}); } catch { /* optional */ }
    const result = response.result ?? {};
    const tools = await this.listTools(signal);
    return {
      protocolVersion: result.protocolVersion,
      serverInfo: result.serverInfo,
      capabilities: result.capabilities,
      tools,
    };
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    if (!this.initialized) {
      throw new Error('MCP session has not been initialized');
    }
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const response = await this.request('tools/list', cursor ? { cursor } : {}, signal);
      if (Array.isArray(response.result?.tools)) tools.push(...response.result.tools as McpTool[]);
      const next = response.result?.nextCursor;
      if (typeof next !== 'string' || !next) break;
      cursor = next;
    }
    return tools;
  }

  async callTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    if (!this.initialized) throw new Error('MCP session has not been initialized');
    const response = await this.request('tools/call', { name, arguments: arguments_ }, signal);
    return (response.result ?? {}) as McpToolResult;
  }

  async close(): Promise<void> {
    if (this.sessionId) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(this.ssePostUrl ?? this.config.url, { method: 'DELETE', headers: this.headers(), signal: controller.signal });
      } catch { /* servers may not implement session DELETE */ }
      clearTimeout(timeout);
    }
    this.sessionId = null;
    this.initialized = false;
    this.ssePostUrl = null;
  }

  getSessionId(): string | null { return this.sessionId; }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.config.timeoutMs ?? 15000, 5000));
    try {
      await fetch(this.ssePostUrl ?? this.config.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const id = ++this.requestId;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 60000);
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(this.ssePostUrl ?? this.config.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      const body = await response.text();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`WorkBuddy MCP 需要认证（HTTP ${response.status}），请检查 MCP Token 或重新授权 WorkBuddy`);
        }
        if (response.status === 404) {
          throw new Error('WorkBuddy MCP 地址不存在（HTTP 404），请确认使用的是 MCP endpoint，而不是普通网页地址');
        }
        throw new Error(`WorkBuddy MCP 返回 ${response.status}: ${body.slice(0, 500)}`);
      }
      const message = parseRpcBody(body, id);
      if (message?.error) {
        throw new Error(`MCP ${method} 失败: ${message.error.message ?? '未知错误'}`);
      }
      return message ?? { jsonrpc: '2.0', id, result: {} };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': DEFAULT_PROTOCOL_VERSION,
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      ...(this.config.headers ?? {}),
    };
  }

  /** The legacy SSE MCP transport announces a POST endpoint over an initial GET. */
  private async openSseEndpoint(signal?: AbortSignal): Promise<void> {
    if (this.ssePostUrl) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.config.timeoutMs ?? 60000, 10000));
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(this.config.url, { method: 'GET', headers: { ...this.headers(), Accept: 'text/event-stream' }, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`WorkBuddy SSE endpoint 返回 ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (buffer.length < 32_000) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const event = parseSseEndpoint(buffer);
        if (event) {
          this.ssePostUrl = new URL(event, this.config.url).toString();
          return;
        }
      }
      throw new Error('WorkBuddy SSE 响应未提供 MCP POST endpoint');
    } finally {
      clearTimeout(timeout);
      controller.abort();
      signal?.removeEventListener('abort', abort);
    }
  }
}

function parseSseEndpoint(body: string): string | null {
  const blocks = body.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const event = block.match(/(?:^|\n)event:\s*endpoint\s*(?:\n|$)/i);
    if (!event) continue;
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
    if (data) return data;
  }
  return null;
}

function parseRpcBody(body: string, expectedId?: string | number): JsonRpcResponse | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed) as JsonRpcResponse; } catch { /* SSE below */ }
  const dataLines = trimmed.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const messages: JsonRpcResponse[] = [];
  for (const line of dataLines) {
    try {
      const parsed = JSON.parse(line) as JsonRpcResponse;
      messages.push(parsed);
    } catch { /* continue */ }
  }
  if (messages.length > 0) {
    const matched = expectedId === undefined ? undefined : messages.find((item) => item.id === expectedId);
    return matched ?? messages[messages.length - 1]!;
  }
  throw new Error(`无法解析 WorkBuddy MCP 响应: ${trimmed.slice(0, 300)}`);
}

export type { McpConnectionConfig, McpServerInfo, McpTool, McpToolResult } from './types.js';
