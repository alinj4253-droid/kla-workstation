import { CodexCliAdapter, ClaudeCodeCliAdapter } from '@kunqing/agent-core';
import type { ExternalAgentAdapter, DetectedExecutable, DetectInput } from '@kunqing/agent-core';

export class CliAgentRegistry {
  private adapters = new Map<string, ExternalAgentAdapter>();

  constructor() {
    this.register(new CodexCliAdapter());
    this.register(new ClaudeCodeCliAdapter());
  }

  register(adapter: ExternalAgentAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  getAdapter(type: string): ExternalAgentAdapter | undefined {
    return this.adapters.get(type);
  }

  async detectAll(input?: DetectInput): Promise<Array<{ type: string; executables: DetectedExecutable[] }>> {
    const results: Array<{ type: string; executables: DetectedExecutable[] }> = [];
    const controller = new AbortController();
    for (const [type, adapter] of this.adapters) {
      try {
        const executables = await adapter.detect(input ?? {}, controller.signal);
        results.push({ type, executables });
      } catch {
        results.push({ type, executables: [] });
      }
    }
    return results;
  }
}

export const cliAgentRegistry = new CliAgentRegistry();
