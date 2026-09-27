import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { getLogger } from './logger';

type RelayTaskStatus = 'pending' | 'claimed' | 'running' | 'completed' | 'failed';

export type NeutralRelayTask = {
  id: string;
  instruction: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
  status: RelayTaskStatus;
  worker?: string;
  result?: string;
  error?: string;
  createdAt: string;
  claimedAt?: string;
  updatedAt: string;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

const TOOL_DEFINITIONS = [
  {
    name: 'relay_get_pending_tasks',
    description: '读取等待外部智能体处理的任务。中立中继只负责传递任务，不执行任务。',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } } },
  },
  {
    name: 'relay_claim_task',
    description: '领取一项待处理任务，领取后其他工作进程不会再次领取。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, worker: { type: 'string' } }, required: ['taskId'] },
  },
  {
    name: 'relay_report_progress',
    description: '报告已领取任务的进度或当前阶段。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, message: { type: 'string' }, status: { type: 'string', enum: ['claimed', 'running'] } }, required: ['taskId', 'message'] },
  },
  {
    name: 'relay_complete_task',
    description: '提交任务的最终结果。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, result: { type: 'string' } }, required: ['taskId', 'result'] },
  },
  {
    name: 'relay_fail_task',
    description: '报告任务无法完成以及失败原因。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, error: { type: 'string' } }, required: ['taskId', 'error'] },
  },
  {
    name: 'relay_get_task',
    description: '按任务编号读取任务详情和当前状态。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
  },
] as const;

export type NeutralRelayStatus = {
  running: boolean;
  port: number;
  url: string;
  token: string;
  taskCount: number;
  pendingCount: number;
};

let activeNeutralRelay: NeutralMcpRelay | null = null;

export function getActiveNeutralMcpRelay(): NeutralMcpRelay | null {
  return activeNeutralRelay;
}

export function isLoopbackMcpEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.pathname.replace(/\/$/, '') === '/mcp';
  } catch { return false; }
}

/**
 * A neutral, loopback-only MCP task relay. It deliberately has no KLA or
 * WorkBuddy-specific tool names: either side can be replaced independently.
 */
export class NeutralMcpRelay {
  private server: http.Server | null = null;
  private token = '';
  private port = 0;
  private sessionId = '';
  private readonly tasks = new Map<string, NeutralRelayTask>();

  constructor() {
    activeNeutralRelay = this;
  }

  async start(): Promise<NeutralRelayStatus> {
    if (this.server && this.port) return this.status();
    this.token = randomUUID().replaceAll('-', '');
    const logger = getLogger();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res).catch((error) => {
          logger?.warn({ err: error }, 'Neutral MCP relay request failed');
          this.sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }, 500);
        });
      });
      this.server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('无法获取中立 MCP 服务端口'));
          return;
        }
        this.port = address.port;
        logger?.info({ port: this.port }, 'Neutral MCP relay started');
        resolve(this.status());
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = 0;
    this.token = '';
    this.sessionId = '';
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  status(): NeutralRelayStatus {
    const tasks = [...this.tasks.values()];
    return {
      running: Boolean(this.server && this.port),
      port: this.port,
      url: this.port ? `http://127.0.0.1:${this.port}/mcp` : '',
      token: this.token,
      taskCount: tasks.length,
      pendingCount: tasks.filter((task) => task.status === 'pending').length,
    };
  }

  enqueue(input: { instruction: string; projectId?: string; metadata?: Record<string, unknown> }): NeutralRelayTask {
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error('中立 MCP 任务内容不能为空');
    const now = new Date().toISOString();
    const task: NeutralRelayTask = {
      id: `relay-${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      instruction,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  getTask(taskId: string): NeutralRelayTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  listTasks(): NeutralRelayTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url?.split('?')[0] === '/health' && req.method === 'GET') {
      this.sendJson(res, { ok: true, service: 'neutral-task-relay', ...this.status() });
      return;
    }
    if (req.url?.split('?')[0] !== '/mcp') { this.sendJson(res, { error: 'Not found' }, 404); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST, OPTIONS' }); res.end(); return; }
    const authorization = String(req.headers.authorization ?? '');
    if (!this.token || authorization !== `Bearer ${this.token}`) {
      this.sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32001, message: '未授权：请使用当前中立服务 Token' } }, 401);
      return;
    }
    const request = JSON.parse(await this.readBody(req)) as JsonRpcRequest;
    const id = request.id ?? null;
    if (request.jsonrpc !== '2.0' || !request.method) { this.sendRpcError(res, id, -32600, 'Invalid Request'); return; }
    if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') {
      res.writeHead(202); res.end(); return;
    }
    if (request.method === 'initialize') {
      this.sessionId = `relay-session-${randomUUID().replaceAll('-', '')}`;
      res.setHeader('Mcp-Session-Id', this.sessionId);
      const requestedVersion = typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2025-06-18';
      this.sendJson(res, { jsonrpc: '2.0', id, result: { protocolVersion: requestedVersion, capabilities: { tools: {} }, serverInfo: { name: 'neutral-task-relay', version: '1.0.0' } } });
      return;
    }
    if (request.method === 'ping') { this.sendJson(res, { jsonrpc: '2.0', id, result: {} }); return; }
    if (request.method === 'tools/list') { this.sendJson(res, { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } }); return; }
    if (request.method === 'tools/call') {
      const params = request.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
      try {
        const result = this.callTool(name, args);
        this.sendJson(res, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      } catch (error) {
        this.sendRpcError(res, id, -32602, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    this.sendRpcError(res, id, -32601, `Method not found: ${request.method}`);
  }

  private callTool(name: string, args: Record<string, unknown>): unknown {
    const now = new Date().toISOString();
    if (name === 'relay_get_pending_tasks') {
      const limit = Math.max(1, Math.min(20, Number(args.limit ?? 10)));
      return this.listTasks().filter((task) => task.status === 'pending').slice(0, limit);
    }
    const taskId = typeof args.taskId === 'string' ? args.taskId : '';
    if (!taskId) throw new Error('缺少 taskId');
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (name === 'relay_get_task') return task;
    if (name === 'relay_claim_task') {
      if (task.status !== 'pending') throw new Error(`任务当前不可领取：${task.status}`);
      task.status = 'claimed'; task.worker = typeof args.worker === 'string' ? args.worker : 'external-worker'; task.claimedAt = now; task.updatedAt = now;
      return task;
    }
    if (name === 'relay_report_progress') {
      if (!['claimed', 'running'].includes(task.status)) throw new Error(`任务当前不可更新：${task.status}`);
      task.status = args.status === 'claimed' ? 'claimed' : 'running'; task.updatedAt = now;
      return { taskId, status: task.status, message: String(args.message ?? '') };
    }
    if (name === 'relay_complete_task') {
      if (!['claimed', 'running'].includes(task.status)) throw new Error(`任务当前不可完成：${task.status}`);
      task.status = 'completed'; task.result = String(args.result ?? ''); task.updatedAt = now;
      return task;
    }
    if (name === 'relay_fail_task') {
      if (!['claimed', 'running'].includes(task.status)) throw new Error(`任务当前不可失败：${task.status}`);
      task.status = 'failed'; task.error = String(args.error ?? ''); task.updatedAt = now;
      return task;
    }
    throw new Error(`未知工具：${name}`);
  }

  private sendRpcError(res: http.ServerResponse, id: string | number | null, code: number, message: string): void {
    this.sendJson(res, { jsonrpc: '2.0', id, error: { code, message } }, 200);
  }

  private sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
}
