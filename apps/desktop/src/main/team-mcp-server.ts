import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { ToolRegistry, type AgentRole } from './tool-registry';
import { getLogger } from './logger';

// ─── MCP Protocol Types ──────────────────────────────────────────────────────

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type McpListToolsResult = {
  tools: McpToolDefinition[];
};

export type McpCallToolParams = {
  name: string;
  arguments: Record<string, unknown>;
};

export type McpCallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type McpRequest = {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

export type McpResponse = {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// ─── Team MCP Server ─────────────────────────────────────────────────────────

export class TeamMcpServer {
  private server: http.Server | null = null;
  private token: string = '';
  private port = 0;
  private running = false;

  constructor(
    private toolRegistry: ToolRegistry,
    private options: {
      role: AgentRole;
      projectId: string;
      runId?: string;
    },
  ) {}

  /** 启动 MCP Server，绑定 127.0.0.1 随机端口 */
  async start(): Promise<{ port: number; token: string }> {
    if (this.running) return { port: this.port, token: this.token };

    this.token = randomUUID().replace(/-/g, '');
    const logger = getLogger();

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          logger?.warn({ err }, 'TeamMCP: 请求处理出错');
          this.sendError(res, null, -32603, 'Internal error');
        });
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          this.running = true;
          logger?.info({ port: this.port }, 'TeamMCP: 服务已启动');
          resolve({ port: this.port, token: this.token });
        } else {
          reject(new Error('TeamMCP: 无法获取端口'));
        }
      });

      this.server.on('error', (err) => {
        logger?.warn({ err }, 'TeamMCP: 服务启动失败');
        reject(err);
      });
    });
  }

  /** 停止 MCP Server */
  async stop(): Promise<void> {
    if (!this.server || !this.running) return;
    this.running = false;
    return new Promise((resolve) => {
      this.server!.close(() => {
        getLogger()?.info('TeamMCP: 服务已停止');
        resolve();
      });
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get portNumber(): number {
    return this.port;
  }

  get bearerToken(): string {
    return this.token;
  }

  // ── 私有方法 ─────────────────────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 认证检查
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== this.token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '未授权' } }));
      return;
    }

    // 只接受 POST
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    // 读取 body
    const body = await this.readBody(req);
    let request: McpRequest;
    try {
      request = JSON.parse(body) as McpRequest;
    } catch {
      this.sendError(res, null, -32700, 'Parse error');
      return;
    }

    if (request.jsonrpc !== '2.0') {
      this.sendError(res, request, -32600, 'Invalid Request: 需要 jsonrpc 2.0');
      return;
    }

    switch (request.method) {
      case 'tools/list':
        await this.handleListTools(res, request);
        break;
      case 'tools/call':
        await this.handleCallTool(res, request);
        break;
      default:
        this.sendError(res, request, -32601, `Method not found: ${request.method}`);
    }
  }

  private async handleListTools(res: http.ServerResponse, request: McpRequest): Promise<void> {
    const definitions = this.toolRegistry.getDefinitionsForRole(this.options.role);

    const tools: McpToolDefinition[] = definitions.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: {
        type: 'object',
        properties: d.parameters as Record<string, unknown>,
        required: ((d.parameters as any)?.required as string[]) ?? [],
      },
    }));

    this.sendResult(res, request, { tools } satisfies McpListToolsResult);
  }

  private async handleCallTool(res: http.ServerResponse, request: McpRequest): Promise<void> {
    const params = request.params as McpCallToolParams | undefined;
    if (!params?.name) {
      this.sendError(res, request, -32602, 'Invalid params: 缺少工具名称');
      return;
    }

    const result = await this.toolRegistry.execute(params.name, params.arguments ?? {}, {
      role: this.options.role,
      ...(this.options.runId ? { runId: this.options.runId } : {}),
      ...(this.options.projectId ? { projectId: this.options.projectId } : {}),
    });

    this.sendResult(res, request, {
      content: [{ type: 'text', text: result }],
      isError: result.startsWith('未知工具') || result.startsWith('权限不足') || result.startsWith('工具执行失败'),
    } satisfies McpCallToolResult);
  }

  private sendResult(res: http.ServerResponse, request: McpRequest, result: unknown): void {
    const response: McpResponse = { jsonrpc: '2.0', id: request.id, result };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private sendError(res: http.ServerResponse, request: McpRequest | null, code: number, message: string): void {
    const response: McpResponse = { jsonrpc: '2.0', id: request?.id ?? (null as unknown as string | number), error: { code, message } };
    res.writeHead(code === -32700 ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }
}
