import * as path from 'node:path';
import * as os from 'node:os';

import type { DetectInput, DetectedExecutable } from '../../external-agent-adapter';
import { detectExecutables } from '../detect-shared.js';

const home = os.homedir();

export class CodexDetector {
  async detect(input: DetectInput, signal: AbortSignal): Promise<DetectedExecutable[]> {
    return detectExecutables(input, signal, ['codex'], [
      path.join(home, '.codex', 'bin'),
    ], ['--version']);
  }
}
