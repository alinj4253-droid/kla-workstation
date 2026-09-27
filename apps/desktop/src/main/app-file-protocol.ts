/**
 * app-file:// 只读协议
 *
 * URL format:
 *   app-file://file/<fileId>                    — 按 file ID 获取当前版本
 *   app-file://version/<versionId>              — 按 version ID 获取特定版本
 *   app-file://preview/<fileId>/<relativeAsset> — 加载 HTML 及同目录资源
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
import { basename, extname, join, posix, resolve, sep } from 'node:path';
import { FileRepository } from '@kunqing/database';
import { getEnterpriseProjectRoot, getEnterpriseWorkspaceRoot, getProjectRoot } from './paths';
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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
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
    return join(getEnterpriseWorkspaceRoot(), 'original-files');
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

      const parsedRequest = parseAppFileRequest(request.url);
      if (!parsedRequest) return new Response('Invalid app-file URL', { status: 400 });
      const { resourceType, resourceId, assetPath } = parsedRequest;

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

      if (resourceType === 'file' || resourceType === 'preview') {
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

        const scopeRoot = resolveStoredFileRoot(db, file.scopeType, file.scopeId, file.normalizedPath);
        if (resourceType === 'preview' && assetPath && assetPath !== file.name && assetPath !== basename(file.normalizedPath)) {
          const normalizedAsset = normalizeRelativePath(assetPath).replaceAll('\\', '/');
          fileName = basename(normalizedAsset);
          filePath = resolveInside(scopeRoot, posix.join(posix.dirname(file.normalizedPath), normalizedAsset));
        } else {
          fileName = file.name;
          filePath = resolveInside(scopeRoot, file.normalizedPath);
        }
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
        const scopeRoot = resolveStoredFileRoot(db, file.scopeType, file.scopeId, file.normalizedPath);
        filePath = resolveInside(scopeRoot, file.normalizedPath);
      } else {
        return new Response('Unknown resource type', { status: 400 });
      }

      // ── 安全校验 ──
      await assertNoSymlink(filePath);

      // ── 读取文件 ──
      const data = await readFile(filePath);
      const mimeType = getMimeType(filePath);

      // HTML 作为完整文档加载。iframe sandbox 隔离 Electron/Node 权限；
      // HTTP(S) 静态资源按普通浏览器行为加载，保证 CDN 样式、字体和脚本的预览一致性。
      const headers: Record<string, string> = {
        'Content-Type': mimeType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
        'Cache-Control': resourceType === 'preview' ? 'no-store' : 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      };
      if (mimeType === 'text/html') {
        headers['Content-Security-Policy'] = [
          "default-src app-file: data: blob: https: http:",
          "img-src app-file: data: blob: https: http:",
          "style-src app-file: https: http: 'unsafe-inline'",
          "font-src app-file: data: https: http:",
          "script-src app-file: https: http: 'unsafe-inline' 'unsafe-eval' blob:",
          // GLTFLoader fetches bufferView textures from short-lived blob: URLs.
          // Permit those in previews while preserving the existing network policy.
          "connect-src blob: https: http: wss: ws:",
          "media-src app-file: data: blob: https: http:",
          "frame-src app-file: https: http:",
          "worker-src blob:",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; ');
      }

      return new Response(data, { status: 200, headers });
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

function resolveStoredFileRoot(db: Database.Database, scopeType: 'project' | 'shared', scopeId: string, normalizedPath: string): string {
  let enterpriseProject = false;
  if (scopeType === 'project') {
    try { enterpriseProject = !!db.prepare('SELECT 1 FROM enterprise_projects WHERE id = ?').get(scopeId); } catch { /* legacy database */ }
  }
  if (enterpriseProject) {
    const root = getEnterpriseProjectRoot(scopeId);
    return normalizedPath === 'outputs' || normalizedPath.startsWith('outputs/') ? root : join(root, 'original-files');
  }
  if (scopeType === 'project' && (normalizedPath === 'outputs' || normalizedPath.startsWith('outputs/'))) {
    return getProjectRoot(scopeId);
  }
  return resolveFileScopeRoot(scopeType, scopeId);
}

export type AppFileRequest = {
  resourceType: 'file' | 'version' | 'preview';
  resourceId: string;
  assetPath: string;
};

export function parseAppFileRequest(rawUrl: string): AppFileRequest | null {
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean).map(decodeURIComponent);

  if (hostname === 'file' || hostname === 'version') {
    const resourceId = parts[0];
    return resourceId ? { resourceType: hostname, resourceId, assetPath: '' } : null;
  }
  if (hostname === 'preview') {
    const resourceId = parts[0];
    return resourceId ? { resourceType: 'preview', resourceId, assetPath: parts.slice(1).join('/') } : null;
  }

  const resourceType = parts.shift();
  const resourceId = parts.shift();
  if ((resourceType === 'file' || resourceType === 'version' || resourceType === 'preview') && resourceId) {
    return { resourceType, resourceId, assetPath: parts.join('/') };
  }
  return null;
}
