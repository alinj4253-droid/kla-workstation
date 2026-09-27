export type McpTransport = 'stdio' | 'streamableHttp' | 'sse';

export type McpConnectionConfig = {
  transport: McpTransport;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  toolName?: string;
  /** A reference to an encrypted local secret. The client never persists the secret itself. */
  secretRef?: string;
};

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
};

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType?: string }
  | { type: 'audio'; data: string; mimeType?: string }
  | { type: 'resource'; resource: unknown };

export type McpToolResult = {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

export type McpServerInfo = {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  tools: McpTool[];
};
