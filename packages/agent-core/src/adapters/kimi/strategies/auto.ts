import type { VersionStrategy, ExecutableRef, CliConnectionSnapshot, SpawnSpec, PreparedExternalRun, ParserState, ParsedAgentEvent, ProcessExit, NormalizedExit, VersionCapabilities } from '../../../external-agent-adapter';

export class KimiAutoStrategy implements VersionStrategy {
  readonly id = 'auto';
  readonly versionRange = '>=0.1.0 <=9.99.99';
  readonly capabilities: VersionCapabilities = {
    nonInteractive: true, structuredOutput: false, resumableSession: false, processScopedMcp: false, reliableCancellation: true,
  };

  buildVersionProbe(executable: ExecutableRef): SpawnSpec {
    return { executable: executable.executablePath, args: ['--version'], cwd: process.cwd(), env: {}, shell: process.platform === 'win32' };
  }

  buildAuthProbe(_connection: CliConnectionSnapshot): SpawnSpec | null { return null; }

  buildRun(input: PreparedExternalRun): SpawnSpec {
    return { executable: input.executablePath, args: ['run', input.instruction, ...input.args], cwd: input.workspaceRoot, env: input.env, shell: process.platform === 'win32' };
  }

  parseStdout(chunk: Uint8Array, state: ParserState): ParsedAgentEvent[] {
    state.buffer += new TextDecoder().decode(chunk);
    if (state.lineMode && state.buffer.includes('\n')) {
      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() ?? '';
      return lines.filter(Boolean).map((text) => ({ type: 'text', data: text, ts: new Date().toISOString() }));
    }
    return [];
  }

  classifyExit(result: ProcessExit): NormalizedExit {
    if (result.code === 0) return { code: 0, reason: 'success', message: '正常退出' };
    if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') return { code: -1, reason: 'cancelled', message: `被信号终止: ${result.signal}` };
    return { code: result.code ?? -1, reason: 'error', message: `异常退出 (code=${result.code})` };
  }
}
