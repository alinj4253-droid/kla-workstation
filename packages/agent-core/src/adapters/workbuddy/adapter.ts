import type {
  AgentEventSink, AuthProbeResult, DetectInput, DetectedExecutable, ExecutableRef,
  ExternalAgentAdapter, ExternalRunRequest, ExternalRunResult, VersionEvidence, VersionStrategy,
} from '../../external-agent-adapter.js';
import { StreamableHttpMcpClient } from '../../mcp/client.js';
import type { McpConnectionConfig, McpTool } from '../../mcp/types.js';

type WorkBuddyConfig = McpConnectionConfig;

export class WorkBuddyMcpAdapter implements ExternalAgentAdapter {
  readonly type = 'workbuddy';
  // Keep the existing storage/runtime slot for backwards-compatible SQLite
  // schemas; execution itself is MCP, never a spawned CLI process.
  readonly runtimeMode = 'external-cli' as const;

  async detect(_input: DetectInput, _signal: AbortSignal): Promise<DetectedExecutable[]> {
    return [];
  }

  async readVersion(executable: ExecutableRef, signal: AbortSignal): Promise<VersionEvidence> {
    const client = new StreamableHttpMcpClient({ transport: 'streamableHttp', url: executable.executablePath });
    const info = await client.initialize(signal);
    await client.close();
    return {
      rawVersion: info.serverInfo?.version ?? info.serverInfo?.name ?? 'MCP server',
      semver: null,
      source: 'stdout',
    };
  }

  selectStrategy(_version: VersionEvidence): VersionStrategy | null { return null; }

  async probeAuth(_connection: any, _signal: AbortSignal): Promise<AuthProbeResult> {
    return { source: 'none', hints: ['认证信息由 WorkBuddy MCP 连接配置提供'], error: null };
  }

  async run(input: ExternalRunRequest, sink: AgentEventSink, signal: AbortSignal): Promise<ExternalRunResult> {
    const started = Date.now();
    const config = this.readConfig(input.connection);
    const client = new StreamableHttpMcpClient(config);
    try {
      const info = await client.initialize(signal);
      const tool = pickTaskTool(info.tools, config.toolName);
      if (!tool) {
        throw new Error('WorkBuddy MCP 未提供可执行任务的工具，请在连接配置中填写任务工具名称');
      }
      sink.onEvent?.({ type: 'tool.requested', data: { tool: tool.name, summary: '调用 WorkBuddy 任务能力' }, ts: new Date().toISOString() });
      const args = buildToolArguments(tool, input.instruction, input.workspaceRoot);
      const result = await client.callTool(tool.name, args, signal);
      sink.onEvent?.({ type: 'tool.completed', data: { tool: tool.name, ok: !result.isError }, ts: new Date().toISOString() });
      const output = extractText(result);
      return { exitCode: result.isError ? 1 : 0, stdout: output, stderr: '', durationMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sink.onStderr?.(message);
      return { exitCode: 1, stdout: '', stderr: message, durationMs: Date.now() - started };
    } finally {
      await client.close();
    }
  }

  getCapabilities(): string[] {
    return ['reasoning', 'file-read', 'file-write', 'search', 'network-access'];
  }

  private readConfig(connection: ExternalRunRequest['connection']): WorkBuddyConfig {
    const raw = connection.mcpConfig;
    if (raw && typeof raw === 'object') {
      const value = raw as Partial<WorkBuddyConfig>;
      return {
        transport: value.transport === 'sse' ? 'sse' : 'streamableHttp',
        url: String(value.url ?? connection.executablePath),
        ...(value.headers ? { headers: value.headers } : {}),
        ...(value.timeoutMs ? { timeoutMs: value.timeoutMs } : {}),
        ...(value.toolName ? { toolName: value.toolName } : {}),
      };
    }
    return { transport: 'streamableHttp', url: connection.executablePath };
  }
}

function pickTaskTool(tools: McpTool[], configured?: string): McpTool | undefined {
  if (configured) return tools.find((tool) => tool.name === configured);
  const ranked = tools
    .map((tool) => ({ tool, score: toolScore(tool) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  if (ranked[0]) return ranked[0].tool;
  // A dedicated WorkBuddy connector commonly exposes one task tool with a
  // product-specific name. In that case there is no ambiguity, so use it.
  return tools.length === 1 ? tools[0] : undefined;
}

function toolScore(tool: McpTool): number {
  const name = tool.name.toLocaleLowerCase();
  const description = tool.description ?? '';
  let score = 0;
  if (/(^|[._-])(task|execute|run|chat|ask|agent|workbuddy)([._-]|$)/i.test(name)) score += 10;
  if (/任务|执行|对话|智能体|助手|工作台|workbuddy|agent/i.test(description)) score += 8;
  if (/^(chat|ask|run|execute|invoke|call)$/i.test(name)) score += 4;
  return score;
}

function buildToolArguments(tool: McpTool, instruction: string, workspaceRoot: string): Record<string, unknown> {
  const schema = tool.inputSchema?.properties ?? {};
  const properties = Object.keys(schema);
  const result: Record<string, unknown> = {};
  const candidates = ['instruction', 'prompt', 'message', 'query', 'task', 'input', 'content', 'text'];
  const key = candidates.find((candidate) => properties.includes(candidate)) ?? properties[0] ?? 'instruction';
  if (key === 'messages') {
    result[key] = [{ role: 'user', content: instruction }];
  } else if (schema[key]?.type === 'object' && key === 'input') {
    result[key] = { instruction, prompt: instruction, message: instruction };
  } else {
    result[key] = instruction;
  }
  if (properties.includes('workspaceRoot')) result.workspaceRoot = workspaceRoot;
  if (properties.includes('workspace_root')) result.workspace_root = workspaceRoot;
  if (properties.includes('cwd')) result.cwd = workspaceRoot;
  return result;
}

function extractText(result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }): string {
  const text = (result.content ?? []).filter((item) => item.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n');
  if (text.trim()) return text.trim();
  if (result.structuredContent !== undefined) {
    const value = result.structuredContent as any;
    if (typeof value === 'string') return value;
    for (const key of ['output', 'text', 'message', 'content', 'result']) {
      if (typeof value?.[key] === 'string') return value[key];
    }
    return JSON.stringify(value, null, 2);
  }
  return '';
}
