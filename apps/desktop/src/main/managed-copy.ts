import { mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { join, dirname, basename, resolve, normalize, isAbsolute, relative } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getLogger } from './logger';

/**
 * Managed Copy Service
 *
 * 为 `external-cli` 角色提供受控的文件/数据拷贝沙箱。
 * 每次工具调用读取文件/消息时，不是直接暴露原始路径，而是：
 * 1. 将数据复制到 `{workspaceRoot}/.runtime/managed-copy/{runId}/` 目录
 * 2. 返回临时路径给外部 CLI
 * 3. Run 结束后清理整个目录
 *
 * managed-copy 不提供安全隔离（spec 明确声明），
 * 但确保应用知道哪些数据被暴露给了外部 CLI。
 */
export class ManagedCopyService {
  private copies = new Map<string, Set<string>>();

  constructor(private workspaceRoot: string) {}

  getManagedDir(runId: string): string {
    return join(this.workspaceRoot, '.runtime', 'managed-copy', runId);
  }

  /**
   * 拷贝工作区文件到受控目录，返回临时路径
   *
   * 安全校验：
   * - 源路径不能包含 `..` 路径穿越
   * - 源路径必须是绝对路径
   * - 拷贝完成后记录到 managed-copy 追踪列表
   */
  async copyFile(sourcePath: string, runId: string): Promise<string> {
    const logger = getLogger();

    // 安全校验：拒绝路径穿越和越界
    const validationError = this.validateSourcePath(sourcePath);
    if (validationError) {
      const msg = `${validationError}: ${sourcePath}`;
      logger?.warn({ sourcePath, runId }, `ManagedCopy: ${msg}`);
      throw new Error(msg);
    }

    const managedDir = this.getManagedDir(runId);
    mkdirSync(managedDir, { recursive: true });

    const destName = `${randomUUID().slice(0, 12)}_${basename(sourcePath)}`;
    const destPath = join(managedDir, destName);

    try {
      const content = await readFile(sourcePath);
      await writeFile(destPath, content);
      this.track(runId, destPath);
      logger?.info({ sourcePath, destPath, runId }, 'ManagedCopy: 文件已拷贝');
      return destPath;
    } catch (err) {
      logger?.warn({ err, sourcePath, runId }, 'ManagedCopy: 文件拷贝失败');
      throw new Error(`文件拷贝失败: ${sourcePath}`, { cause: err });
    }
  }

  /**
   * 将文本内容写入受控目录的临时文件，返回临时路径
   */
  async writeContent(content: string, fileName: string, runId: string): Promise<string> {
    const managedDir = this.getManagedDir(runId);
    mkdirSync(managedDir, { recursive: true });

    const destPath = join(managedDir, fileName);
    await writeFile(destPath, content, 'utf-8');
    this.track(runId, destPath);
    return destPath;
  }

  /**
   * 清理指定 Run 的所有受控拷贝
   */
  async cleanup(runId: string): Promise<void> {
    const logger = getLogger();
    const managedDir = this.getManagedDir(runId);

    if (existsSync(managedDir)) {
      try {
        await rm(managedDir, { recursive: true, force: true });
        logger?.info({ runId, managedDir }, 'ManagedCopy: 清理完成');
      } catch (err) {
        logger?.warn({ err, runId, managedDir }, 'ManagedCopy: 清理失败');
      }
    }

    this.copies.delete(runId);
  }

  /**
   * 检查路径是否受 managed-copy 管理
   */
  isManagedPath(filePath: string, runId: string): boolean {
    return filePath.startsWith(this.getManagedDir(runId));
  }

  /**
   * 获取指定 Run 的所有受控拷贝路径
   */
  getCopies(runId: string): string[] {
    return Array.from(this.copies.get(runId) ?? []);
  }

  private track(runId: string, path: string): void {
    if (!this.copies.has(runId)) {
      this.copies.set(runId, new Set());
    }
    this.copies.get(runId)!.add(path);
  }

  // ── 安全校验方法 ──────────────────────────────────────────────────────────

  /**
   * 校验源路径是否安全（用于 copyFile 输入侧）
   *
   * 规则：
   * - 必须是绝对路径
   * - 原始路径字符串中不能包含 `..` 路径穿越（normalize 会提前解析掉 `..`）
   * - 归一化后路径必须位于工作区根目录内
   *
   * @returns 空字符串表示安全，非空字符串为拒绝原因
   */
  validateSourcePath(sourcePath: string): string {
    if (!isAbsolute(sourcePath)) return '源路径必须是绝对路径';
    // 在 normalize 之前检查原始路径中是否包含 `..` 分隔符
    const sep = sourcePath.includes('/') ? '/' : '\\';
    const parts = sourcePath.split(sep);
    if (parts.some((p) => p === '..')) return '源路径包含路径穿越';
    // 归一化后路径必须在工作区根目录内
    const normalized = normalize(sourcePath);
    if (!normalized.startsWith(normalize(this.workspaceRoot))) return '源路径超出工作区范围';
    return '';
  }

  /**
   * 校验输出路径是否安全（用于 ArtifactImporter 输出侧）
   *
   * 规则：
   * - 必须是相对路径（不允许绝对路径）
   * - 不能包含 `..` 路径穿越
   * - 不能是符号链接
   * - 必须位于 managed-copy 目录范围内
   */
  async validateOutputPath(outputPath: string, runId: string): Promise<{ valid: boolean; reason?: string }> {
    // 拒绝绝对路径
    if (isAbsolute(outputPath)) {
      return { valid: false, reason: '输出路径不能是绝对路径' };
    }

    // 拒绝 `..` 路径穿越
    const normalized = normalize(outputPath);
    if (normalized.includes('..') || outputPath.includes('..')) {
      return { valid: false, reason: '输出路径不能包含路径穿越' };
    }

    // 必须位于 managed-copy 目录内
    const fullPath = join(this.getManagedDir(runId), 'output', outputPath);
    if (!fullPath.startsWith(this.getManagedDir(runId))) {
      return { valid: false, reason: '输出路径超出 managed-copy 范围' };
    }

    // 检查符号链接
    if (existsSync(fullPath)) {
      try {
        const stats = await lstat(fullPath);
        if (stats.isSymbolicLink()) {
          return { valid: false, reason: '输出路径不能是符号链接' };
        }
      } catch {
        // 路径不存在则忽略
      }
    }

    return { valid: true };
  }

  /**
   * 检查路径是否为符号链接
   */
  async isSymlink(filePath: string): Promise<boolean> {
    try {
      if (!existsSync(filePath)) return false;
      const stats = await lstat(filePath);
      return stats.isSymbolicLink();
    } catch {
      return false;
    }
  }

  /**
   * 校验 manifest 完整性：所有已拷贝文件都应在 manifest 中声明
   */
  validateManifest(runId: string, manifest: string[]): boolean {
    const copies = this.getCopies(runId);
    if (copies.length === 0) return true;
    const manifestSet = new Set(manifest);
    for (const copyPath of copies) {
      const fileName = basename(copyPath);
      const found = manifest.some((m) => m.includes(fileName) || copyPath.includes(m));
      if (!found) return false;
    }
    return true;
  }

  /**
   * 获取 managed-copy 输入目录
   */
  getInputDir(runId: string): string {
    return join(this.getManagedDir(runId), 'input');
  }

  /**
   * 获取 managed-copy 输出目录
   */
  getOutputDir(runId: string): string {
    return join(this.getManagedDir(runId), 'output');
  }
}
