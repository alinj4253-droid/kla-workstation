/**
 * 内置 ACP CLI 注册表
 *
 * 每个条目描述一种支持 ACP 的 CLI：启动命令、ACP 端点参数、版本探测参数
 * 与 banner 抑制环境变量。启动参数来自逐个 CLI 实测（MVP 规格 L876：
 * 禁止猜测命令行参数），未实测的 CLI 不得加入。
 */

import type { SpawnSpec } from '../../external-agent-adapter';

export type AcpCliRegistryEntry = {
  /** 适配器 type（connection.adapterType 使用） */
  type: string;
  /** 可执行文件名或绝对路径（detect 阶段在 PATH 中查找） */
  command: string;
  /** 启动 ACP 端点的参数（实测获得） */
  args: string[];
  /** 版本探测参数 */
  versionArgs: string[];
  /** 注入的 banner 抑制/非交互环境变量 */
  env: Record<string, string>;
  /** 默认信任级别 */
  trustTier: 'trusted' | 'sandboxed' | 'restricted';
  /** 能力上报 */
  capabilities: string[];
  /** 是否已通过 ACP 端点实测（L876） */
  verified: boolean;
};

export const ACP_CLI_REGISTRY: AcpCliRegistryEntry[] = [
  {
    type: 'hermes',
    command: 'hermes',
    // 官方文档：hermes acp 启动 stdio ACP server（JSON-RPC over stdio）。
    // 日志走 stderr（configure stderr logging），stdout 保持纯协议流，无需 banner 抑制。
    args: ['acp'],
    // 顶层 --version（官方 CLI reference：hermes --version/-V 显示版本并退出）
    versionArgs: ['--version'],
    env: {},
    trustTier: 'sandboxed',
    capabilities: ['code-generation', 'file-read', 'file-write', 'terminal', 'search', 'network-access'],
    verified: false,
  },
  {
    type: 'opencode',
    command: 'opencode',
    // 官方文档：opencode acp 启动 ACP server，stdin/stdout 走 nd-JSON（JSON-RPC over stdio）。
    // 日志走 stderr，stdout 保持纯协议流，无需 banner 抑制。
    args: ['acp'],
    // 官方 CLI reference：opencode --version 显示版本并退出
    versionArgs: ['--version'],
    env: {},
    trustTier: 'sandboxed',
    capabilities: ['code-generation', 'file-read', 'file-write', 'terminal', 'search', 'network-access'],
    // 已实测：v1.18.13 握手 + 完整 prompt 生命周期（initialize/session-new/prompt/事件流/close）
    verified: true,
  },
  {
    type: 'gemini',
    command: 'gemini',
    // 官方文档：gemini --acp 启动 ACP 模式（JSON-RPC over stdio；--experimental-acp 已弃用）。
    // 日志走 stderr，stdout 保持纯协议流，无需 banner 抑制。
    args: ['--acp'],
    // 官方文档：gemini --version 显示版本并退出
    versionArgs: ['--version'],
    env: {},
    trustTier: 'sandboxed',
    capabilities: ['code-generation', 'file-read', 'file-write', 'search', 'reasoning', 'network-access'],
    // 未实测：ACP 端点与启动参数来自官方文档，待真实 CLI 实测后启用
    verified: false,
  },
  {
    type: 'qwen-code',
    command: 'qwen',
    // 官方文档：qwen --acp 启动 ACP 模式（PR #1355 已由 --experimental-acp 转正为稳定 --acp）。
    // 日志走 stderr（acpAgent.ts 将 console.* 重定向到 stderr），stdout 保持纯协议流。
    args: ['--acp'],
    // 官方 CLI reference：qwen --version 显示版本并退出
    versionArgs: ['--version'],
    env: {},
    trustTier: 'sandboxed',
    capabilities: ['code-generation', 'file-read', 'file-write', 'search', 'network-access'],
    // 未实测：ACP 端点与启动参数来自官方文档，待真实 CLI 实测后启用
    verified: false,
  },
  {
    type: 'kimi',
    command: 'kimi',
    // 官方文档：kimi acp 启动 ACP 模式（JSON-RPC over stdio；无 banner，日志走 stderr）。
    args: ['acp'],
    // 官方 CLI reference：kimi --version 显示版本并退出
    versionArgs: ['--version'],
    env: {},
    trustTier: 'sandboxed',
    capabilities: ['code-generation', 'file-read', 'file-write', 'search', 'network-access'],
    // 未实测：ACP 端点与启动参数来自官方文档，待真实 CLI 实测后启用
    verified: false,
  },
  {
    type: 'codebuddy',
    command: 'codebuddy',
    // 官方文档：codebuddy --acp 启动 ACP 模式（JSON-RPC over stdio；标准 ACP surface 零 meta 可运行）。
    args: ['--acp'],
    // 官方 CLI reference：codebuddy --version 显示版本并退出
    versionArgs: ['--version'],
    env: {},
    trustTier: 'sandboxed',
    capabilities: ['code-generation', 'file-read', 'file-write', 'search', 'network-access'],
    // 已实测：v2.132.0 握手 + 完整 prompt 生命周期（initialize/session-new/prompt/事件流/close）
    verified: true,
  },
  {
    type: 'qoder',
    command: 'qodercli',
    // 官方文档（docs.qoder.com/cli/acp）：qodercli --acp 启动 ACP server，stdio JSON-RPC 通信。
    // 认证复用 CLI 登录态，可配 QODER_PERSONAL_ACCESS_TOKEN 自动登录。Windows 下需 .cmd shim。
    args: ['--acp'],
    // 官方 CLI reference：qodercli --version 显示版本并退出
    versionArgs: ['--version'],
    env: {},
    trustTier: 'sandboxed',
    capabilities: ['code-generation', 'file-read', 'file-write', 'search', 'reasoning', 'network-access'],
    // 未实测：启动参数来自官方文档，待真实 CLI 实测后启用
    verified: false,
  },
  {
    type: 'qoder-cn',
    command: 'qoderclicn',
    // 官方文档（docs.qoder.cn/cli/acp）：qoderclicn --acp 启动 ACP server，stdio JSON-RPC 通信。
    // 独立产品线（账号/模型池与 qoder 不互通），认证可配 QODERCN_PERSONAL_ACCESS_TOKEN。
    args: ['--acp'],
    // 官方 CLI reference：qoderclicn --version 显示版本并退出
    versionArgs: ['--version'],
    env: {},
    trustTier: 'sandboxed',
    capabilities: ['code-generation', 'file-read', 'file-write', 'search', 'reasoning', 'network-access'],
    // 未实测：启动参数来自官方文档，待真实 CLI 实测后启用
    verified: false,
  },
];

export function getAcpRegistryEntry(type: string): AcpCliRegistryEntry | undefined {
  return ACP_CLI_REGISTRY.find((entry) => entry.type === type);
}

/** 由注册表条目构建 ACP run 的 SpawnSpec（cwd 由调用方指定） */
export function buildAcpSpawnSpec(
  entry: AcpCliRegistryEntry,
  executablePath: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): SpawnSpec {
  return {
    executable: executablePath,
    args: entry.args,
    cwd,
    env: { ...entry.env, ...extraEnv },
    shell: process.platform === 'win32',
  };
}
