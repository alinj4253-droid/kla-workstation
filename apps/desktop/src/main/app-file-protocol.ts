/**
 * app-file:// 只读协议
 *
 * URL format:
 *   app-file://file/<fileId>       — 按 file ID 获取当前版本
 *   app-file://version/<versionId> — 按 version ID 获取特定版本
 *
 * 安全约束：
 *   1. 只读；只允许 GET
 *   2. 路径隔离（resolveInside），禁止目录穿越
 *   3. 禁止符号链接
 *   4. 仅通过数据库记录定位文件，不暴露文件系统路径
 *   5. 配合 Chromium 内置 PDF 查看器
 */

import { protocol } from 'electron';
import { lstat, readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { FileRepository } from '@kunqing/database';
import { getStudioRoot, getProjectRoot } from './paths';
import { getLogger } from './logger';
import type Database from 'better-sqlite3';

// ─── MIME 类型映射 ───────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.jsx': 'text/jsx',
  '.tsx': 'text/tsx',
  '.css': 'text/css',
  '.scss': 'text/scss',
  '.less': 'text/less',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.bat': 'text/x-bat',
  '.ps1': 'text/x-powershell',
};

function getMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
}

// ─── 安全路径解析 ─────────────────────────────────────────────────────────────

const normalizeRelativePath = (input = ''): string => {
  if (!input) return '';
  if (input.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(input)) {
    throw new Error('VALIDATION_FAILED: 不允许使用绝对路径');
  }
  // Remove any leading "../" traversal
  const cleaned = input.replace(/\\/g, '/').replace(/^\.\.(?:\/|$)/, '');
  if (cleaned.includes('..')) throw new Error('VALIDATION_FAILED: 路径超出工作区');
  return cleaned || '';
};

const resolveInside = (root: string, relativePath = ''): string => {
  const target = resolve(root, normalizeRelativePath(relativePath));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error('VALIDATION_FAILED: 路径超出当前工作区');
  }
  return target;
};

const assertNoSymlink = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error('VALIDATION_FAILED: 不允许通过符号链接访问工作区外部');
  }
};

// ─── 文件路径解析 ─────────────────────────────────────────────────────────────

function resolveFileScopeRoot(scopeType: 'project' | 'shared', scopeId: string): string {
  if (scopeType === 'shared') {
    return join(getStudioRoot(), 'shared-knowledge', 'original-files');
  }
  return join(getProjectRoot(scopeId), 'original-files');
}

// ─── 协议注册 ─────────────────────────────────────────────────────────────────

/**
 * 注册 app-file:// 协议处理函数。
 * 必须在 `app.whenReady()` 中调用。
 */
export function registerAppFileProtocol(getDb: () => Database.Database | null): void {
  protocol.handle('app-file', async (request) => {
    const logger = getLogger();

    try {
      // 只允许 GET 方法
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 });
      }

      const url = new URL(request.url);
      const pathParts = url.pathname.replace(/^\/+/, '').split('/');

      // URL 格式： file/<fileId> 或 version/<versionId>
      if (pathParts.length < 2 || !pathParts[0] || !pathParts[1]) {
        return new Response('Invalid URL: 格式应为 app-file://file/<id> 或 app-file://version/<id>', { status: 400 });
      }

      const resourceType = pathParts[0];
      const resourceId = pathParts[1];

      // ID 格式校验：24 位十六进制
      if (!/^[a-f0-9]{24}$/i.test(resourceId)) {
        return new Response('Invalid resource ID', { status: 400 });
      }

      const db = getDb();
      if (!db) {
        logger?.warn({ url: request.url }, 'app-file: 数据库未初始化');
        return new Response('数据库未初始化，请先打开工作区', { status: 503 });
      }

      const fileRepo = new FileRepository(db);

      // ── 根据资源类型查询 ──
      let filePath = '';
      let fileName = '';

      if (resourceType === 'file') {
        // 按 file ID 获取当前版本
        const file = fileRepo.getById(resourceId);
        if (!file || file.status === 'deleted') {
          logger?.warn({ resourceId }, 'app-file: 文件不存在或已删除');
          return new Response('File not found', { status: 404 });
        }
        if (file.type !== 'file') {
          return new Response('Not a file', { status: 400 });
        }

        const version = file.currentVersionId ? fileRepo.getVersion(file.currentVersionId) : null;
        if (!version) {
          logger?.warn({ fileId: resourceId }, 'app-file: 文件版本不存在');
          return new Response('File version not found', { status: 404 });
        }

        fileName = file.name;
        const scopeRoot = resolveFileScopeRoot(file.scopeType, file.scopeId);
        filePath = resolveInside(scopeRoot, file.normalizedPath);
      } else if (resourceType === 'version') {
        // 按 version ID 获取特定版本
        const version = fileRepo.getVersion(resourceId);
        if (!version) {
          return new Response('Version not found', { status: 404 });
        }

        const file = fileRepo.getById(version.fileId);
        if (!file || file.status === 'deleted') {
          return new Response('File not found', { status: 404 });
        }

        fileName = file.name;
        const scopeRoot = resolveFileScopeRoot(file.scopeType, file.scopeId);
        filePath = resolveInside(scopeRoot, file.normalizedPath);
      } else {
        return new Response('Unknown resource type: 仅支持 file 和 version', { status: 400 });
      }

      // ── 安全校验 ──
      await assertNoSymlink(filePath);

      // ── 读取文件 ──
      const data = await readFile(filePath);
      const mimeType = getMimeType(filePath);

      // ── 返回响应 ──
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      const logger = getLogger();
      logger?.error({ err: error, url: request.url }, 'app-file 协议处理错误');

      if (error instanceof Error) {
        const msg = error.message;
        if (msg.startsWith('VALIDATION_FAILED:')) {
          return new Response(msg, { status: 403 });
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return new Response('文件在磁盘上不存在', { status: 404 });
        }
      }

      return new Response('Internal server error', { status: 500 });
    }
  });
}