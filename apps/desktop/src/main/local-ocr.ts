import { spawn } from 'node:child_process';

export type LocalOcrStatus = { available: boolean; runtime: 'paddleocr'; detail: string };

function run(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

export class LocalOcrService {
  async status(): Promise<LocalOcrStatus> {
    try {
      const result = await run('paddleocr', ['--help'], 5_000);
      return result.code === 0
        ? { available: true, runtime: 'paddleocr', detail: '本地 PaddleOCR 运行时已就绪' }
        : { available: false, runtime: 'paddleocr', detail: 'PaddleOCR 模型包未安装' };
    } catch {
      return { available: false, runtime: 'paddleocr', detail: 'PaddleOCR 模型包未安装' };
    }
  }

  async extract(filePath: string): Promise<string> {
    const status = await this.status();
    if (!status.available) throw new Error(status.detail);
    const result = await run('paddleocr', ['ocr', '-i', filePath], 10 * 60_000);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'PaddleOCR 识别失败');
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('{') && !line.startsWith('['))
      .join('\n');
  }
}
