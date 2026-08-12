import { CodexCliAdapter, ClaudeCodeCliAdapter, AionCliAdapter, AcpCliAdapter } from '@kunqing/agent-core';
import type { ExternalAgentAdapter, DetectedExecutable, DetectInput } from '@kunqing/agent-core';

export class CliAgentRegistry {
  private adapters = new Map<string, ExternalAgentAdapter>();

  constructor() {
    this.register(new CodexCliAdapter());
    this.register(new ClaudeCodeCliAdapter());
    this.register(new AionCliAdapter());
    // gemini 已迁移到 ACP 路径（gemini --acp 原生支持）；旧手写适配器保留为 fallback
    this.register(new AcpCliAdapter('gemini'));
    // qwen-code 已迁移到 ACP 路径（qwen --acp 原生支持）；旧手写适配器保留为 fallback
    this.register(new AcpCliAdapter('qwen-code'));
    // opencode 已迁移到 ACP 路径（opencode acp 原生支持）；旧手写适配器保留为 fallback
    this.register(new AcpCliAdapter('opencode'));
    // kimi 已迁移到 ACP 路径（kimi acp 原生支持）；旧手写适配器保留为 fallback
    this.register(new AcpCliAdapter('kimi'));
    // codebuddy 已迁移到 ACP 路径（codebuddy --acp 原生支持）；旧手写适配器保留为 fallback
    this.register(new AcpCliAdapter('codebuddy'));
    this.register(new AcpCliAdapter('hermes'));
    // qoder 走 ACP 路径（qodercli --acp 原生支持，官方 docs.qoder.com/cli/acp）
    this.register(new AcpCliAdapter('qoder'));
    // qoder-cn 走 ACP 路径（qoderclicn --acp 原生支持，独立产品线，官方 docs.qoder.cn/cli/acp）
    this.register(new AcpCliAdapter('qoder-cn'));
  }

  register(adapter: ExternalAgentAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  getAdapter(type: string): ExternalAgentAdapter | undefined {
    return this.adapters.get(type);
  }

  async detectAll(input?: DetectInput): Promise<Array<{ type: string; executables: DetectedExecutable[] }>> {
    const controller = new AbortController();
    const entries = [...this.adapters.entries()];
    const settled = await Promise.allSettled(
      entries.map(async ([type, adapter]) => {
        const executables = await adapter.detect(input ?? {}, controller.signal);
        return { type, executables };
      }),
    );
    return settled.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { type: entries[i]![0], executables: [] },
    );
  }
}

export const cliAgentRegistry = new CliAgentRegistry();
