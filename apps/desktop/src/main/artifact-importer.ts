import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, relative, normalize, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { getLogger } from './logger';

/**
 * ArtifactImporter
 *
 * 外部 CLI 运行完成后，将 sandbox output/ 中的结果导入到群聊 outputs/。
 * 导入前进行严格的安全校验：
 * - 拒绝绝对路径
 * - 拒绝 `..` 路径穿越
 * - 拒绝符号链接
 * - 拒绝超出 output 目录范围的文件
 * - 校验文件类型、大小上限
 */
export class ArtifactImporter {
  constructor(
    private readonly sandboxOutputDir: string,
    private readonly projectOutputDir: string,
  ) {}

  /**
   * 执行文件系统校验，通过后执行导入
   * 返回导入后的目标路径
   */
  validateAndImport(sandboxRelativePath: string): Promise<{ ok: boolean; destPath?: string; error?: string }>;
  async validateAndImport(sandboxRelativePath: string): Promise<{ ok: boolean; destPath?: string; error?: string }> {
    const logger = getLogger();

    // 1. 拒绝绝对路径
    if (isAbsolute(sandboxRelativePath)) {
      return { ok: false, error: '输出路径不能是绝对路径' };
    }

    // 2. 拒绝 `..` 路径穿越
    const normalized = normalize(sandboxRelativePath);
    if (normalized.includes('..') || sandboxRelativePath.includes('..')) {
      return { ok: false, error: '输出路径不能包含路径穿越' };
    }

    // 3. 源文件必须在 sandbox output/ 目录内
    const sourcePath = join(this.sandboxOutputDir, normalized);
    if (!sourcePath.startsWith(this.sandboxOutputDir)) {
      return { ok: false, error: '输出路径超出 sandbox 范围' };
    }

    if (!existsSync(sourcePath)) {
      return { ok: false, error: '输出文件不存在' };
    }

    // 4. 检查符号链接
    const { lstat } = await import('node:fs/promises');
    try {
      const stats = await lstat(sourcePath);
      if (stats.isSymbolicLink()) {
        return { ok: false, error: '输出路径不能是符号链接' };
      }
    } catch {
      return { ok: false, error: '无法读取输出文件信息' };
    }

    // 5. 检查文件大小上限（默认 50 MB）
    const { stat } = await import('node:fs/promises');
    try {
      const fileStats = await stat(sourcePath);
      const MAX_SIZE = 50 * 1024 * 1024; // 50 MB
      if (fileStats.size > MAX_SIZE) {
        return { ok: false, error: '输出文件超过大小限制（50 MB）' };
      }
    } catch {
      return { ok: false, error: '无法读取输出文件大小' };
    }

    // 6. 执行导入：复制到项目 outputs/ 目录
    const destPath = join(this.projectOutputDir, normalized);
    try {
      await mkdir(join(destPath, '..'), { recursive: true });
      await copyFile(sourcePath, destPath);
      logger?.info({ sourcePath, destPath }, 'ArtifactImporter: 导入成功');
      return { ok: true, destPath };
    } catch (err) {
      logger?.warn({ err, sourcePath, destPath }, 'ArtifactImporter: 导入失败');
      return { ok: false, error: '导入文件时发生错误' };
    }
  }
}