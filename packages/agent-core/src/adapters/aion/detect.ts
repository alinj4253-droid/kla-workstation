import type { DetectInput, DetectedExecutable } from '../../external-agent-adapter';
import { detectExecutables } from '../detect-shared.js';

export class AionDetector {
  async detect(input: DetectInput, signal: AbortSignal): Promise<DetectedExecutable[]> {
    return detectExecutables(input, signal, ['aion'], [], ['--version']);
  }
}
