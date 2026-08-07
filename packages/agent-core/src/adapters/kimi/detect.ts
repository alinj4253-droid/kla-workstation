import * as path from 'node:path';
import * as os from 'node:os';

import type { DetectInput, DetectedExecutable } from '../../external-agent-adapter';
import { detectExecutables } from '../detect-shared.js';

const home = os.homedir();

export class KimiDetector {
  async detect(input: DetectInput, signal: AbortSignal): Promise<DetectedExecutable[]> {
    return detectExecutables(input, signal, ['kimi'], [
      path.join(home, '.kimi-code', 'bin'),
      path.join(home, '.kimi', 'bin'),
    ], ['--version']);
  }
}
