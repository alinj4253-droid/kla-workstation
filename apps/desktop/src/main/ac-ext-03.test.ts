// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync, rmSync, readlinkSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import type { ManagedCopyService } from './managed-copy';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test', getVersion: () => '0.1.0-test' },
}));

// ---------------------------------------------------------------------------
// AC-EXT-03: managed-copy Run 只能看到 manifest 中声明的输入；
//            输出越界、绝对路径、`..` 和符号链接被拒绝。
// ---------------------------------------------------------------------------

describe('AC-EXT-03', () => {
  let workspaceRoot: string;
  let runId: string;
  let managedCopy: ManagedCopyService;

  // 延迟导入，先创建临时目录
  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'ac-ext-03-'));
    runId = 'test-run-001';
    const { ManagedCopyService } = await import('./managed-copy');
    managedCopy = new ManagedCopyService(workspaceRoot);
    // 创建输入目录
    mkdirSync(join(workspaceRoot, '.runtime', 'managed-copy', runId, 'input'), { recursive: true });
    mkdirSync(join(workspaceRoot, '.runtime', 'managed-copy', runId, 'output'), { recursive: true });
  });

  afterEach(() => {
    if (workspaceRoot && existsSync(workspaceRoot)) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  // ── 输入侧：源路径校验 ──────────────────────────────────────────────────

  describe('输入侧 - copyFile 源路径安全', () => {
    it('拒绝包含 `..` 路径穿越的源路径', async () => {
      // 使用 literal `..` 构造路径（不用 join 以避免提前解析）
      const traversalPath = workspaceRoot + '\\..\\secret.txt';
      await expect(managedCopy.copyFile(traversalPath, runId)).rejects.toThrow('路径穿越');
    });

    it('拒绝相对路径作为源路径', async () => {
      await expect(managedCopy.copyFile('relative/path.txt', runId)).rejects.toThrow('绝对路径');
    });

    it('拒绝深层嵌套的 `..` 路径穿越', async () => {
      const deepTraversal = workspaceRoot + '\\subdir\\..\\..\\..\\etc\\passwd';
      await expect(managedCopy.copyFile(deepTraversal, runId)).rejects.toThrow('路径穿越');
    });

    it('拒绝解析后超出工作区范围的路径', async () => {
      // join 会解析 `..`，所以最终路径不包含 `..` 但超出工作区
      const traversalPath = join(workspaceRoot, '..', 'secret.txt');
      await expect(managedCopy.copyFile(traversalPath, runId)).rejects.toThrow('超出工作区范围');
    });

    it('接受合法的绝对路径', async () => {
      const validFile = join(workspaceRoot, 'legitimate.txt');
      writeFileSync(validFile, 'hello');
      const result = await managedCopy.copyFile(validFile, runId);
      expect(result).toContain(managedCopy.getManagedDir(runId));
      expect(result).not.toBe(validFile);
    });

    it('合法文件拷贝后能追踪到', async () => {
      const validFile = join(workspaceRoot, 'tracked.txt');
      writeFileSync(validFile, 'data');
      await managedCopy.copyFile(validFile, runId);
      const copies = managedCopy.getCopies(runId);
      expect(copies.length).toBe(1);
    });

    it('validateSourcePath 对路径穿越返回非空字符串', () => {
      const result = managedCopy.validateSourcePath('/some/../path');
      expect(result).not.toBe('');
    });

    it('validateSourcePath 对合法路径返回空字符串', () => {
      const result = managedCopy.validateSourcePath(join(workspaceRoot, 'file.txt'));
      expect(result).toBe('');
    });
  });

  // ── 输出侧：输出路径校验 ──────────────────────────────────────────────────

  describe('输出侧 - validateOutputPath 安全', () => {
    it('拒绝绝对路径', async () => {
      const result = await managedCopy.validateOutputPath('/etc/passwd', runId);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('绝对路径');
    });

    it('拒绝 `..` 路径穿越', async () => {
      const result = await managedCopy.validateOutputPath('../../secret.txt', runId);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('路径穿越');
    });

    it('拒绝深层嵌套的 `..` 路径穿越', async () => {
      const result = await managedCopy.validateOutputPath('output/../../../etc/passwd', runId);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('路径穿越');
    });

    it('拒绝符号链接', async () => {
      const outputDir = managedCopy.getOutputDir(runId);
      const symlinkPath = join(outputDir, 'evil-link.txt');
      const targetPath = join(workspaceRoot, 'secret.txt');
      writeFileSync(targetPath, 'secret data');
      // 尝试创建符号链接；如果失败则跳过
      try {
        symlinkSync(targetPath, symlinkPath);
      } catch {
        // 跳过（Windows 可能需要管理员权限）
        return;
      }
      // 验证符号链接确实创建成功
      if (!existsSync(symlinkPath)) return;

      const result = await managedCopy.validateOutputPath('evil-link.txt', runId);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('符号链接');
    });

    it('拒绝超出 managed-copy 范围的路径', async () => {
      const result = await managedCopy.validateOutputPath('../../../../outside.txt', runId);
      expect(result.valid).toBe(false);
    });

    it('接受合法的相对路径', async () => {
      const result = await managedCopy.validateOutputPath('result.md', runId);
      expect(result.valid).toBe(true);
    });

    it('接受合法的子目录路径', async () => {
      const result = await managedCopy.validateOutputPath('subdir/result.txt', runId);
      expect(result.valid).toBe(true);
    });
  });

  // ── Manifest 校验 ──────────────────────────────────────────────────────

  describe('manifest 校验', () => {
    it('没有拷贝时 validateManifest 返回 true', () => {
      expect(managedCopy.validateManifest(runId, [])).toBe(true);
    });

    it('所有拷贝文件都在 manifest 中时返回 true', async () => {
      const file1 = join(workspaceRoot, 'doc1.txt');
      const file2 = join(workspaceRoot, 'doc2.txt');
      writeFileSync(file1, 'content1');
      writeFileSync(file2, 'content2');
      await managedCopy.copyFile(file1, runId);
      await managedCopy.copyFile(file2, runId);
      expect(managedCopy.validateManifest(runId, ['doc1.txt', 'doc2.txt'])).toBe(true);
    });

    it('存在未在 manifest 中声明的文件时返回 false', async () => {
      const file1 = join(workspaceRoot, 'legit.txt');
      writeFileSync(file1, 'content');
      await managedCopy.copyFile(file1, runId);
      expect(managedCopy.validateManifest(runId, ['other.txt'])).toBe(false);
    });
  });

  // ── isSymlink 检查 ────────────────────────────────────────────────────

  describe('isSymlink 检查', () => {
    it('对普通文件返回 false', async () => {
      const filePath = join(workspaceRoot, 'normal.txt');
      writeFileSync(filePath, 'normal');
      const result = await managedCopy.isSymlink(filePath);
      expect(result).toBe(false);
    });

    it('对不存在的路径返回 false', async () => {
      const result = await managedCopy.isSymlink(join(workspaceRoot, 'nonexistent'));
      expect(result).toBe(false);
    });

    it('对符号链接返回 true', async () => {
      const linkPath = join(workspaceRoot, 'mylink');
      const targetPath = join(workspaceRoot, 'target');
      writeFileSync(targetPath, 'target');
      try {
        symlinkSync(targetPath, linkPath);
      } catch {
        return; // 跳过（Windows 可能需要管理员权限）
      }
      if (!existsSync(linkPath)) return;
      const result = await managedCopy.isSymlink(linkPath);
      expect(result).toBe(true);
    });
  });

  // ── ArtifactImporter 输出导入校验 ──────────────────────────────────────

  describe('ArtifactImporter 输出导入校验', () => {
    let importer: any;
    let sandboxOutputDir: string;
    let projectOutputDir: string;

    beforeEach(async () => {
      sandboxOutputDir = managedCopy.getOutputDir(runId);
      projectOutputDir = join(workspaceRoot, 'outputs');
      mkdirSync(projectOutputDir, { recursive: true });
      const { ArtifactImporter } = await import('./artifact-importer');
      importer = new ArtifactImporter(sandboxOutputDir, projectOutputDir);
    });

    it('拒绝绝对路径', async () => {
      const result = await importer.validateAndImport('/etc/passwd');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('绝对路径');
    });

    it('拒绝 `..` 路径穿越', async () => {
      const result = await importer.validateAndImport('../../secret.txt');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('路径穿越');
    });

    it('拒绝符号链接', async () => {
      const symlinkPath = join(sandboxOutputDir, 'evil-link.txt');
      const targetPath = join(workspaceRoot, 'secret.txt');
      writeFileSync(targetPath, 'secret data');
      try {
        symlinkSync(targetPath, symlinkPath);
      } catch {
        return; // 跳过（Windows 可能需要管理员权限）
      }
      if (!existsSync(symlinkPath)) return;

      const result = await importer.validateAndImport('evil-link.txt');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('符号链接');
    });

    it('成功导入合法文件', async () => {
      const validContent = 'valid output content';
      writeFileSync(join(sandboxOutputDir, 'result.txt'), validContent);
      const result = await importer.validateAndImport('result.txt');
      expect(result.ok).toBe(true);
      expect(result.destPath).toContain(projectOutputDir);
    });

    it('拒绝超出 sandbox 范围的路径', async () => {
      const result = await importer.validateAndImport('../../outside.txt');
      expect(result.ok).toBe(false);
    });

    it('拒绝不存在的文件', async () => {
      const result = await importer.validateAndImport('nonexistent.txt');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('不存在');
    });
  });

  // ── 集成测试 ──────────────────────────────────────────────────────────

  describe('集成测试', () => {
    it('完整流程：输入拷贝 → 输出写回 → 校验', async () => {
      // 1. 拷贝输入文件
      const inputFile = join(workspaceRoot, 'input.txt');
      writeFileSync(inputFile, 'input data');
      await managedCopy.copyFile(inputFile, runId);

      // 2. 验证输入已在 manifest 中
      expect(managedCopy.validateManifest(runId, ['input.txt'])).toBe(true);

      // 3. 写输出文件
      const outputDir = managedCopy.getOutputDir(runId);
      writeFileSync(join(outputDir, 'output.txt'), 'output data');

      // 4. 验证输出路径安全
      const outputCheck = await managedCopy.validateOutputPath('output.txt', runId);
      expect(outputCheck.valid).toBe(true);

      // 5. 导入输出
      const { ArtifactImporter } = await import('./artifact-importer');
      const importer = new ArtifactImporter(outputDir, join(workspaceRoot, 'outputs'));
      const importResult = await importer.validateAndImport('output.txt');
      expect(importResult.ok).toBe(true);
    });

    it('攻击尝试：路径穿越绕过应该被拒绝', async () => {
      // 使用 literal `..` 构造路径
      const badPaths = [
        workspaceRoot + '\\..\\secret.txt',
        workspaceRoot + '\\ok\\..\\..\\secret.txt',
        'C:\\Windows\\system32\\config\\SAM',
        '/etc/shadow',
      ];
      for (const badPath of badPaths) {
        await expect(managedCopy.copyFile(badPath, runId)).rejects.toThrow();
      }
    });

    it('攻击尝试：输出路径穿越绕过应该被拒绝', async () => {
      const badOutputs = [
        '/etc/passwd',
        '..\\..\\secret.txt',
        'output/../../../etc/passwd',
        '..\\secret.txt',
      ];
      for (const badOutput of badOutputs) {
        const result = await managedCopy.validateOutputPath(badOutput, runId);
        expect(result.valid).toBe(false);
      }
    });
  });
});