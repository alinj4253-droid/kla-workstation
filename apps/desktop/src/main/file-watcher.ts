import chokidar from 'chokidar';
import { basename, dirname, join } from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FileRepository, KnowledgeRepository, MessageRepository } from '@kunqing/database';
import type Database from 'better-sqlite3';
import { getLogger } from './logger';

export class FileWatcher {
  private watcher: ReturnType<typeof chokidar.watch> | null = null;
  private fileRepo: FileRepository;
  private knowledgeRepo: KnowledgeRepository;
  private messageRepo: MessageRepository;
  private watchedDirs: Map<string, { scopeType: 'project' | 'shared'; scopeId: string }> = new Map();
  /** Callback invoked when a new file or version is detected, receives the file ID */
  onIngest: ((fileId: string) => void) | null = null;

  constructor(db: Database.Database) {
    this.fileRepo = new FileRepository(db);
    this.knowledgeRepo = new KnowledgeRepository(db);
    this.messageRepo = new MessageRepository(db);
  }

  addWatch(rootPath: string, scopeType: 'project' | 'shared', scopeId: string): void {
    const originalFilesDir = join(rootPath, 'original-files');
    this.watchedDirs.set(originalFilesDir, { scopeType, scopeId });
    if (this.watcher) {
      this.watcher.add(originalFilesDir);
    }
  }

  start(studioRoot: string, projectRoots: Array<{ projectId: string; rootPath: string }>): void {
    this.stop();
    this.watchedDirs.clear();

    const watchRoots: string[] = [];
    const sharedOriginal = join(studioRoot, 'shared-knowledge', 'original-files');
    watchRoots.push(sharedOriginal);
    this.watchedDirs.set(sharedOriginal, { scopeType: 'shared', scopeId: 'shared-knowledge' });

    for (const p of projectRoots) {
      const dir = join(p.rootPath, 'original-files');
      watchRoots.push(dir);
      this.watchedDirs.set(dir, { scopeType: 'project', scopeId: p.projectId });
    }

    this.watcher = chokidar.watch(watchRoots, {
      ignored: [/(^|[/\\])\./, /[/\\]\.runtime[/\\]/, /~$/, /\.swp$/, /\.swx$/, /\.tmp$/],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    this.watcher.on('add', (filePath) => { void this.handleChange(filePath); });
    this.watcher.on('change', (filePath) => { void this.handleChange(filePath); });
    this.watcher.on('unlink', (filePath) => { void this.handleDelete(filePath); });

    getLogger().info({ watchRoots }, 'FileWatcher: 已启动');
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.watchedDirs.clear();
  }

  private getScopeInfo(filePath: string): { scopeType: 'project' | 'shared'; scopeId: string; relativePath: string } | null {
    for (const [root, info] of this.watchedDirs) {
      const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
      const normalizedPath = filePath.replace(/\\/g, '/');
      if (normalizedPath.startsWith(normalizedRoot + '/')) {
        const relative = normalizedPath.slice(normalizedRoot.length + 1);
        return { ...info, relativePath: relative };
      }
    }
    return null;
  }

  private async handleChange(filePath: string): Promise<void> {
    const scope = this.getScopeInfo(filePath);
    if (!scope) return;

    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) return;

      const buf = await readFile(filePath);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const size = buf.length;

      const existing = this.fileRepo.getByPath(scope.scopeType, scope.scopeId, scope.relativePath);
      if (existing) {
        const currentVersion = this.fileRepo.getCurrentVersion(existing.id);
        if (currentVersion && currentVersion.sha256 === sha256) return;
      }

      const name = basename(scope.relativePath);
      const parentPath = dirname(scope.relativePath);
      const normalizedParent = parentPath === '.' ? '' : parentPath;
      const storageRelPath = join('.runtime', 'versions', `${sha256.slice(0, 16)}`);

      if (!existing) {
        const file = this.fileRepo.create({
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          parentId: normalizedParent || null,
          type: 'file',
          name,
          normalizedPath: scope.relativePath,
          mimeType: '',
          origin: 'artifact',
        });
        const version = this.fileRepo.createVersion({
          fileId: file.id,
          storageRelPath,
          size,
          sha256,
          createdByType: 'agent',
          createdById: 'file-watcher',
          changeNote: 'watcher-detected',
        });
        if (scope.scopeType === 'project') {
          try {
            this.messageRepo.createArtifactMessage(scope.scopeId, scope.relativePath, file.id, version.id);
          } catch { /* ignore */ }
        }
        getLogger().info({ relativePath: scope.relativePath, scopeType: scope.scopeType, scopeId: scope.scopeId }, 'FileWatcher: 新文件已注册');
        // Trigger knowledge ingestion for new files
        if (this.onIngest) {
          setImmediate(() => this.onIngest!(file.id));
        }
      } else {
        this.fileRepo.createVersion({
          fileId: existing.id,
          storageRelPath,
          size,
          sha256,
          createdByType: 'agent',
          createdById: 'file-watcher',
          changeNote: 'watcher-detected',
        });
        getLogger().info({ relativePath: scope.relativePath, fileId: existing.id }, 'FileWatcher: 文件新版本已创建');
        // Trigger knowledge ingestion for updated files
        if (this.onIngest) {
          setImmediate(() => this.onIngest!(existing.id));
        }
      }
    } catch (err) {
      getLogger().error({ err, filePath }, 'FileWatcher: 处理文件变更失败');
    }
  }

  private async handleDelete(filePath: string): Promise<void> {
    const scope = this.getScopeInfo(filePath);
    if (!scope) return;

    try {
      const existing = this.fileRepo.getByPath(scope.scopeType, scope.scopeId, scope.relativePath);
      if (existing && existing.status !== 'deleted') {
        this.fileRepo.softDelete(existing.id);
        getLogger().info({ relativePath: scope.relativePath, fileId: existing.id }, 'FileWatcher: 文件已标记删除');
      }
    } catch (err) {
      getLogger().error({ err, filePath }, 'FileWatcher: 处理文件删除失败');
    }
  }
}
