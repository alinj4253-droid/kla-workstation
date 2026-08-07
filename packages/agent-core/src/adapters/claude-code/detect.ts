import * as path from 'node:path';
import * as os from 'node:os';

import type { DetectInput, DetectedExecutable } from '../../external-agent-adapter';
import { detectExecutables } from '../detect-shared.js';

const home = os.homedir();

export class ClaudeCodeDetector {
  async detect(input: DetectInput, signal: AbortSignal): Promise<DetectedExecutable[]> {
    return detectExecutables(input, signal, ['claude'], [
      path.join(home, '.local', 'bin'),
    ], ['--version']);
  }
}
