import { CodexCliAdapter, ClaudeCodeCliAdapter, AionCliAdapter, GeminiCliAdapter, QwenCodeCliAdapter, OpencodeCliAdapter, KimiCliAdapter, CodeBuddyCliAdapter } from '@kunqing/agent-core';
import type { ExternalAgentAdapter, DetectedExecutable, DetectInput } from '@kunqing/agent-core';

export class CliAgentRegistry {
  private adapters = new Map<string, ExternalAgentAdapter>();

  constructor() {
    this.register(new CodexCliAdapter());
    this.register(new ClaudeCodeCliAdapter());
    this.register(new AionCliAdapter());
    this.register(new GeminiCliAdapter());
    this.register(new QwenCodeCliAdapter());
    this.register(new OpencodeCliAdapter());
    this.register(new KimiCliAdapter());
    this.register(new CodeBuddyCliAdapter());
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
