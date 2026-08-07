// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalOcrService } from './local-ocr';

const temporaryRoots: string[] = [];

async function createPack(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kunqing-ocr-'));
  temporaryRoots.push(root);
  const paths = {
    executable: 'runtime/win32-x64/python/python.exe',
    entry: 'runner/run_ocr.py',
    detection: 'models/det',
    recognition: 'models/rec',
    classification: 'models/cls',
  };
  await Promise.all([
    mkdir(join(root, 'runtime', 'win32-x64', 'python'), { recursive: true }),
    mkdir(join(root, 'runner'), { recursive: true }),
    mkdir(join(root, 'models', 'det'), { recursive: true }),
    mkdir(join(root, 'models', 'rec'), { recursive: true }),
    mkdir(join(root, 'models', 'cls'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, paths.executable), ''),
    writeFile(join(root, paths.entry), ''),
    writeFile(join(root, paths.detection, 'model.bin'), ''),
    writeFile(join(root, paths.recognition, 'model.bin'), ''),
    writeFile(join(root, paths.classification, 'model.bin'), ''),
    writeFile(join(root, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      offline: true,
      runtime: { executable: paths.executable },
      entry: paths.entry,
      models: {
        detection: paths.detection,
        recognition: paths.recognition,
        classification: paths.classification,
      },
    })),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalOcrService', () => {
  it('uses only the bundled runtime and forces an offline environment', async () => {
    const root = await createPack();
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const service = new LocalOcrService([root], async (command, args, _timeout, options) => {
      calls.push({ command, args, env: options.env });
      return args.includes('--self-check')
        ? { code: 0, stdout: '{"ok":true}', stderr: '' }
        : { code: 0, stdout: '{"lines":["first","second"],"text":"first\\nsecond"}', stderr: '' };
    });

    const status = await service.status();
    expect(status).toMatchObject({ available: true, runtime: 'paddleocr', packRoot: root });
    expect(calls[0]?.command).toBe(join(root, 'runtime', 'win32-x64', 'python', 'python.exe'));
    expect(calls[0]?.args).toEqual([join(root, 'runner', 'run_ocr.py'), '--self-check']);
    expect(calls[0]?.env.HF_HUB_OFFLINE).toBe('1');
    expect(calls[0]?.env.TRANSFORMERS_OFFLINE).toBe('1');
    expect(calls[0]?.env.PYTHONNOUSERSITE).toBe('1');

    await expect(service.extract(join(root, 'scan.png'))).resolves.toBe('first\nsecond');
    expect(calls[1]?.args).toContain('--det-model-dir');
    expect(calls[1]?.args).toContain(join(root, 'models', 'det'));
    expect(calls[1]?.args).toContain(join(root, 'models', 'rec'));
    expect(calls[1]?.args).toContain(join(root, 'models', 'cls'));
  });

  it('does not fall back to a system OCR installation when the pack is incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kunqing-ocr-empty-'));
    temporaryRoots.push(root);
    const service = new LocalOcrService([root]);
    await expect(service.status()).resolves.toMatchObject({ available: false, runtime: 'paddleocr' });
    await expect(service.extract('scan.png')).rejects.toThrow('PaddleOCR');
  });

  it.runIf(process.platform === 'win32')('maps a non-ASCII pack path before invoking the bundled runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kunqing-离线识别-'));
    temporaryRoots.push(root);
    const source = await createPack();
    await rm(root, { recursive: true, force: true });
    await cp(source, root, { recursive: true });
    const commands: string[] = [];
    const service = new LocalOcrService([root], async (command) => {
      commands.push(command);
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    });

    try {
      await expect(service.status()).resolves.toMatchObject({ available: true, packRoot: root });
      expect(commands[0]).toMatch(/^[R-Z]:\\runtime\\win32-x64\\python\\python\.exe$/i);
    } finally {
      const drive = commands[0]?.slice(0, 2);
      if (drive) spawnSync('subst', [drive, '/D'], { windowsHide: true, shell: false });
    }
  });
});
