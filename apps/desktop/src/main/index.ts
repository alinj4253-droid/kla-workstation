import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { access, copyFile, lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { getDatabase, runMigrations } from './db';
import { getLogger } from './logger';
import { getProjectRoot, getStudioRoot, setStudioRoot } from './paths';
import { createProject, safeFileName, seedDefaultProfiles } from './project-creator';
import { FileWatcher } from './file-watcher';
import { startMemoryCleanup } from './memory-cleanup';
import { ModelGateway } from './model-gateway';
import { Scheduler } from './scheduler';
import { createAgentExecutor } from './agent-executor';
import { createPipelineContext } from './knowledge-pipeline-adapter';
import { runIngestionPipeline } from '@kunqing/knowledge-core';
import {
  DraftRepository,
  FileRepository,
  KnowledgeRepository,
  MemoryRepository,
  ProjectRepository,
  MessageRepository,
  WikiRepository,
  SearchRepository,
  ModelProviderRepository,
  ModelProfileRepository,
  AgentRunRepository,
  toRpcResult,
  toRpcError,
  DatabaseError,
} from '@kunqing/database';

type WorkspaceRequest = { projectId: string; relativePath?: string; scopeType?: 'project' | 'shared' };
type EnsureProjectRequest = { projectId: string; name: string };
type CreateFolderRequest = WorkspaceRequest & { name: string };

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_BATCH_BYTES = 500 * 1024 * 1024;

let _fileWatcher: FileWatcher | null = null;
let _scheduler: Scheduler | null = null;
let _gateway: ModelGateway | null = null;

const getScopeRoot = async (input: { projectId: string; scopeType?: 'project' | 'shared' }): Promise<string> => {
  if (input.scopeType === 'shared') return join(getStudioRoot(), 'shared-knowledge', 'original-files');
  return getOriginalFilesRoot(input.projectId);
};
const getGraphRoot = (input: { projectId: string; scopeType?: 'project' | 'shared' }): string => {
  if (input.scopeType === 'shared') return join(getStudioRoot(), 'shared-knowledge');
  return getProjectRoot(input.projectId);
};
const invalidFileName = /[<>:"/\\|?*\u0000-\u001f]/;
const reservedFileName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const assertProjectId = (projectId: string): string => {
  if (!/^[a-z0-9-]{1,64}$/i.test(projectId)) throw new DatabaseError('VALIDATION_FAILED', '群聊标识不合法');
  return projectId;
};

const normalizeRelativePath = (input = ''): string => {
  if (!input) return '';
  if (isAbsolute(input)) throw new DatabaseError('VALIDATION_FAILED', '不允许使用绝对路径');
  const cleaned = normalize(input.replaceAll('/', sep));
  if (cleaned === '..' || cleaned.startsWith(`..${sep}`)) throw new DatabaseError('VALIDATION_FAILED', '路径超出当前群聊工作区');
  return cleaned === '.' ? '' : cleaned;
};

const resolveInside = (root: string, relativePath = ''): string => {
  const target = resolve(root, normalizeRelativePath(relativePath));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) throw new DatabaseError('VALIDATION_FAILED', '路径超出当前群聊工作区');
  return target;
};

const validateFolderName = (input: string): string => {
  const name = input.trim();
  if (!name || name === '.' || name === '..') throw new DatabaseError('VALIDATION_FAILED', '文件夹名称不能为空');
  if (invalidFileName.test(name) || reservedFileName.test(name) || /[. ]$/.test(name)) throw new DatabaseError('VALIDATION_FAILED', '文件夹名称包含 Windows 不支持的字符或保留名称');
  return name;
};

// getStudioRoot/setStudioRoot/getProjectRoot now imported from ./paths

const wrapResult = (result: unknown, requestId: string): unknown => {
  if (typeof result === 'object' && result !== null && 'ok' in (result as Record<string, unknown>)) {
    return { ...(result as Record<string, unknown>), requestId };
  }
  return result;
};

const getRequestId = (input: unknown): string => {
  if (typeof input === 'object' && input !== null) return ((input as Record<string, unknown>).requestId as string) ?? '';
  return '';
};

function registerIpc(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    const requestId = getRequestId(args[0]);
    const logger = getLogger();
    try {
      const result = await handler(_event, ...args);
      return wrapResult(result, requestId);
    } catch (error) {
      logger?.warn({ err: error, channel, requestId }, 'IPC handler error');
      return wrapResult(toRpcError(error, requestId), requestId);
    }
  });
}

const writeIfMissing = async (path: string, content: string): Promise<void> => {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
};

const ORCHESTRATOR_DEF = `schemaVersion: 1
id: builtin.orchestrator
version: 1.0.0
displayName: 统筹管理智能体
runtime: native-model
framework: langgraph-js
entry: orchestratorGraph
defaultModelSlot: reasoning
modelRequirements:
  - streaming
  - toolCalling
  - structuredOutput
skills:
  - team-planning
  - result-synthesis
tools:
  - team.listAgents
  - team.delegateTasks
  - workspace.search
  - workspace.read
  - knowledge.search
  - artifact.publish
  - memory.writeOwn
memoryPolicy:
  shortTermTtlHours: 72
  longTermWrite: candidate-then-commit
`;

const ORCHESTRATOR_IDENTITY = `---
schemaVersion: 1
definitionId: builtin.orchestrator
definitionVersion: 1.0.0
role: leader
---

# 身份

你是当前群聊的统筹管理智能体，负责理解用户目标、制定计划、委派子任务并汇总结果。
`;

const KNOWLEDGE_DEF = `schemaVersion: 1
id: builtin.knowledge-manager
version: 1.0.0
displayName: 知识管理智能体
runtime: native-model
framework: langgraph-js
entry: knowledgeGraph
defaultModelSlot: reasoning
modelRequirements:
  - structuredOutput
skills:
  - document-ingestion
  - entity-relation-extraction
  - provenance-validation
  - wiki-materialization
  - graph-projection
tools:
  - knowledge.search
  - knowledge.ingest
  - memory.writeOwn
memoryPolicy:
  shortTermTtlHours: 72
  longTermWrite: candidate-then-commit
`;

const KNOWLEDGE_IDENTITY = `---
schemaVersion: 1
definitionId: builtin.knowledge-manager
definitionVersion: 1.0.0
role: teammate
---

# 身份

你是当前群聊的知识管理智能体，负责文档入库、实体关系提取、图谱构建和 Wiki 生成。
`;

const installAgentDefinitions = async (root: string): Promise<void> => {
  const orchestratorDir = join(root, 'agent-definitions', 'built-in', 'builtin.orchestrator', '1.0.0');
  const knowledgeDir = join(root, 'agent-definitions', 'built-in', 'builtin.knowledge-manager', '1.0.0');
  await mkdir(orchestratorDir, { recursive: true });
  await mkdir(knowledgeDir, { recursive: true });
  await writeIfMissing(join(orchestratorDir, 'agent.yaml'), ORCHESTRATOR_DEF);
  await writeIfMissing(join(orchestratorDir, 'IDENTITY.template.md'), ORCHESTRATOR_IDENTITY);
  await writeIfMissing(join(knowledgeDir, 'agent.yaml'), KNOWLEDGE_DEF);
  await writeIfMissing(join(knowledgeDir, 'IDENTITY.template.md'), KNOWLEDGE_IDENTITY);
};

const tryAcquireLock = async (root: string): Promise<boolean> => {
  const lockPath = join(root, '.kstudio', 'workspace.lock');
  try {
    await writeFile(lockPath, `${process.pid}`, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    return false;
  }
};

const releaseLock = async (root: string): Promise<void> => {
  try {
    await writeFile(join(root, '.kstudio', 'workspace.lock'), '', { encoding: 'utf8' });
  } catch { /* ignore */ }
};

const ensureStudioWorkspace = async (): Promise<{ workspaceId: string; isNew: boolean }> => {
  const root = getStudioRoot();
  const markerPath = join(root, '.kstudio', 'workspace.json');
  const isNew = !existsSync(markerPath);
  await Promise.all([
    mkdir(join(root, '.kstudio', 'logs'), { recursive: true }),
    mkdir(join(root, '.kstudio', 'cache'), { recursive: true }),
    mkdir(join(root, '.kstudio', 'temp', 'staged-uploads'), { recursive: true }),
    mkdir(join(root, 'agent-definitions', 'built-in'), { recursive: true }),
    mkdir(join(root, 'agent-definitions', 'custom'), { recursive: true }),
    mkdir(join(root, 'group-chats'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'original-files'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'knowledge', 'graph'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'knowledge', 'wiki'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'graph-visualization'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', '.runtime', 'trash'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', '.runtime', 'versions'), { recursive: true }),
  ]);
  let workspaceId: string;
  if (isNew) {
    workspaceId = randomUUID();
    await writeFile(markerPath, JSON.stringify({ schemaVersion: 1, workspaceId, product: 'K_Studio', createdAt: new Date().toISOString() }, null, 2));
    await installAgentDefinitions(root);
  } else {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { workspaceId: string };
    workspaceId = marker.workspaceId;
  }
  return { workspaceId, isNew };
};

const ensureProjectWorkspace = async ({ projectId, name }: EnsureProjectRequest): Promise<string> => {
  await ensureStudioWorkspace();
  const projectRoot = getProjectRoot(projectId);
  await Promise.all([
    mkdir(join(projectRoot, 'agent-identities'), { recursive: true }),
    mkdir(join(projectRoot, 'agent-memories'), { recursive: true }),
    mkdir(join(projectRoot, 'original-files'), { recursive: true }),
    mkdir(join(projectRoot, 'knowledge', 'graph'), { recursive: true }),
    mkdir(join(projectRoot, 'knowledge', 'wiki'), { recursive: true }),
    mkdir(join(projectRoot, 'knowledge', 'review'), { recursive: true }),
    mkdir(join(projectRoot, 'graph-visualization', 'layouts'), { recursive: true }),
    mkdir(join(projectRoot, 'graph-visualization', 'exports'), { recursive: true }),
    mkdir(join(projectRoot, 'outputs'), { recursive: true }),
    mkdir(join(projectRoot, '.runtime', 'trash'), { recursive: true }),
    mkdir(join(projectRoot, '.runtime', 'versions'), { recursive: true }),
    mkdir(join(projectRoot, '.runtime', 'run-temp'), { recursive: true }),
    mkdir(join(projectRoot, '.runtime', 'sandboxes'), { recursive: true }),
  ]);
  const publicName = name.replace(/[\r\n]/g, ' ').trim() || projectId;
  await writeIfMissing(join(projectRoot, 'group.yaml'), `schemaVersion: 1\nprojectId: ${projectId}\nname: ${JSON.stringify(publicName)}\n`);
  return join(projectRoot, 'original-files');
};

const getOriginalFilesRoot = async (projectId: string): Promise<string> => ensureProjectWorkspace({ projectId, name: projectId });

const assertNoSymlink = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new DatabaseError('VALIDATION_FAILED', '不允许通过符号链接访问群聊工作区外部');
};

const nextAvailablePath = async (directory: string, fileName: string): Promise<string> => {
  const extensionIndex = fileName.lastIndexOf('.');
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : '';
  let candidate = join(directory, fileName);
  let index = 1;
  while (true) {
    try {
      await access(candidate);
      candidate = join(directory, `${stem} (${index})${extension}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
};

const registerWorkspaceIpc = (): void => {
  registerIpc('workspace:ensureProject', async (_event, input: EnsureProjectRequest) => {
    const root = await ensureProjectWorkspace(input);
    if (_fileWatcher) _fileWatcher.addWatch(getProjectRoot(input.projectId), 'project', input.projectId);
    return { ok: true };
  });

  registerIpc('workspace:openItem', async (_event, input: WorkspaceRequest) => {
    const root = await getOriginalFilesRoot(input.projectId);
    const target = resolveInside(root, input.relativePath);
    await assertNoSymlink(target);
    const message = await shell.openPath(target);
    if (message) throw new Error(message);
    return { ok: true };
  });

  registerIpc('workspace:openInExplorer', async (_event, input: { projectId: string }) => {
    const root = await getOriginalFilesRoot(input.projectId);
    const message = await shell.openPath(root);
    if (message) throw new Error(message);
    return { ok: true };
  });

  registerIpc('workspace:openWithSystem', async (_event, input: WorkspaceRequest) => {
    const root = await getOriginalFilesRoot(input.projectId);
    const target = resolveInside(root, input.relativePath);
    await assertNoSymlink(target);
    const message = await shell.openPath(target);
    if (message) throw new Error(message);
    return { ok: true };
  });
};

const knowledgeIngestForFile = (db: ReturnType<typeof getDatabase>, fileId: string): unknown => {
  const fileRepo = new FileRepository(db);
  const file = fileRepo.getById(fileId);
  if (!file) return null;
  if (file.type !== 'file') return null;
  const repo = new KnowledgeRepository(db);
  const existing = file.currentVersionId ? repo.getSourceByFileAndVersion(fileId, file.currentVersionId) : repo.getSourceByFile(fileId);
  if (existing) {
    if (existing.status === 'ready') return existing;
    if (existing.status !== 'error') return existing;
    repo.setSourceStatus(existing.id, 'pending');
    const oldJob = repo.getJob(existing.id);
    if (oldJob) repo.setJobStatus(oldJob.id, 'queued');
    return existing;
  }
  const sourceInput: { scopeType: string; scopeId: string; fileId: string; versionId?: string } = {
    scopeType: file.scopeType,
    scopeId: file.scopeId,
    fileId: file.id,
  };
  if (file.currentVersionId) sourceInput.versionId = file.currentVersionId;
  const source = repo.createSource(sourceInput);
  const job = repo.createJob({ scopeType: file.scopeType, scopeId: file.scopeId, sourceId: source.id });
  repo.setSourceStatus(source.id, 'ingesting');
  repo.setJobStatus(job.id, 'running', { stage: 'parsing' });

  // Run the real ingestion pipeline asynchronously
  if (_gateway) {
    const root = file.scopeType === 'shared'
      ? join(getStudioRoot(), 'shared-knowledge', 'original-files')
      : getProjectRoot(file.scopeId);
    const fileNode = fileRepo.getById(fileId);
    if (fileNode) {
      const filePath = resolveInside(root, fileNode.normalizedPath);
      const ctx = createPipelineContext(db, _gateway, filePath, source.id, file.scopeType, file.scopeId);
      runIngestionPipeline(ctx).catch((err: unknown) => {
        getLogger().error({ err, fileId, sourceId: source.id }, '知识入库流水线异常');
      });
    }
  }

  return { source, job };
};

const registerFileIpc = (db: ReturnType<typeof getDatabase>): void => {
  const fileRepo = new FileRepository(db);

  registerIpc('workspace:listFiles', async (_event, input: WorkspaceRequest) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const directory = resolveInside(root, input.relativePath);
    await assertNoSymlink(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const result = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry) => {
      const entryPath = join(directory, entry.name);
      const info = await lstat(entryPath);
      const relativePath = join(normalizeRelativePath(input.relativePath), entry.name).replaceAll('\\', '/');
      const dbRow = entry.isDirectory() ? null : fileRepo.getByPath(st, sid, relativePath);
      let size = entry.isDirectory() ? 0 : info.size;
      let sha256: string | undefined;
      let knowledgeStatus: string | undefined;
      if (dbRow?.currentVersionId) {
        const ver = fileRepo.getCurrentVersion(dbRow.id);
        if (ver) { size = ver.size; sha256 = ver.sha256; }
      }
      if (dbRow) {
        const src = new KnowledgeRepository(db).getSourceByFile(dbRow.id);
        if (src) knowledgeStatus = src.status;
      }
      return {
        name: entry.name,
        relativePath,
        kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
        size,
        modifiedAt: info.mtime.toISOString(),
        fileId: dbRow?.id,
        currentVersionId: dbRow?.currentVersionId,
        mimeType: dbRow?.mimeType,
        sha256,
        knowledgeStatus,
      };
    }));
    return result.sort((left, right) => left.kind === right.kind ? right.modifiedAt.localeCompare(left.modifiedAt) : left.kind === 'directory' ? -1 : 1);
  });

  registerIpc('workspace:uploadFiles', async (event, input: WorkspaceRequest) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const targetDirectory = resolveInside(root, input.relativePath);
    await assertNoSymlink(targetDirectory);
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { title: '导入到群聊用户原始文件', properties: ['openFile', 'multiSelections'] };
    const selection = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options);
    if (selection.canceled) return { cancelled: true, importedCount: 0 };
    const sources = await Promise.all(selection.filePaths.map(async (sourcePath) => ({ sourcePath, info: await lstat(sourcePath) })));
    if (sources.some(({ info }) => !info.isFile() || info.isSymbolicLink())) throw new DatabaseError('VALIDATION_FAILED', '只能导入普通文件');
    if (sources.some(({ info }) => info.size > MAX_FILE_BYTES)) throw new DatabaseError('VALIDATION_FAILED', '单个文件不能超过 100 MB');
    if (sources.reduce((total, { info }) => total + info.size, 0) > MAX_BATCH_BYTES) throw new DatabaseError('VALIDATION_FAILED', '单次导入总量不能超过 500 MB');
    const importedFileIds: string[] = [];
    for (const { sourcePath } of sources) {
      const destName = basename(sourcePath);
      const destination = await nextAvailablePath(targetDirectory, destName);
      await copyFile(sourcePath, destination);
      const storageRelPath = join('.runtime', 'versions', basename(destination));
      const { createHash } = await import('node:crypto');
      const { readFile: rf } = await import('node:fs/promises');
      const buf = await rf(destination);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const normalizedPath = join(normalizeRelativePath(input.relativePath), destName).replaceAll('\\', '/');
      const existing = fileRepo.getByPath(st, sid, normalizedPath);
      if (existing) {
        fileRepo.createVersion({
          fileId: existing.id,
          storageRelPath,
          size: buf.length,
          sha256,
          createdByType: 'user',
          createdById: 'local-user',
          changeNote: 'upload',
        });
        importedFileIds.push(existing.id);
      } else {
        const parentPath = normalizeRelativePath(input.relativePath);
        const file = fileRepo.create({
          scopeType: st,
          scopeId: sid,
          parentId: parentPath || null,
          type: 'file',
          name: destName,
          normalizedPath,
          mimeType: '',
          origin: 'upload',
        });
        fileRepo.createVersion({
          fileId: file.id,
          storageRelPath,
          size: buf.length,
          sha256,
          createdByType: 'user',
          createdById: 'local-user',
          changeNote: 'upload',
        });
        fileRepo.markReady(file.id);
        importedFileIds.push(file.id);
      }
    }
    importedFileIds.forEach((fid) => knowledgeIngestForFile(db, fid));
    return { cancelled: false, importedCount: sources.length };
  });

  registerIpc('workspace:createFolder', async (_event, input: CreateFolderRequest) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const parent = resolveInside(root, input.relativePath);
    await assertNoSymlink(parent);
    await mkdir(join(parent, validateFolderName(input.name)), { recursive: false });
    const parentPath = normalizeRelativePath(input.relativePath);
    const normalizedPath = join(parentPath, input.name).replaceAll('\\', '/');
    if (!fileRepo.existsByPath(st, sid, normalizedPath)) {
      fileRepo.create({
        scopeType: st,
        scopeId: sid,
        parentId: parentPath || null,
        type: 'directory',
        name: input.name,
        normalizedPath,
      });
    }
    return { ok: true };
  });

  registerIpc('workspace:listVersions', async (_event, input: { fileId: string }) => {
    const versions = fileRepo.listVersions(input.fileId);
    return {
      ok: true,
      data: versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        size: v.size,
        sha256: v.sha256,
        createdByType: v.createdByType,
        createdById: v.createdById,
        runId: v.runId,
        changeNote: v.changeNote,
        createdAt: v.createdAt,
      })),
    };
  });

  registerIpc('workspace:rename', async (_event, input: { projectId: string; relativePath: string; name: string; scopeType?: 'project' | 'shared' }) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const oldPath = resolveInside(root, input.relativePath);
    await assertNoSymlink(oldPath);
    const safeName = safeFileName(input.name);
    const newPath = join(dirname(oldPath), safeName);
    let conflict = false;
    try { await access(newPath); conflict = true; } catch { /* ok */ }
    if (conflict) return { ok: false, error: '目标文件或文件夹已存在' };
    await rename(oldPath, newPath);
    const oldNorm = normalizeRelativePath(input.relativePath);
    const newNorm = join(dirname(oldNorm), safeName).replaceAll('\\', '/');
    const file = fileRepo.getByPath(st, sid, oldNorm);
    if (file) {
      if (file.type === 'directory') {
        const children = db.prepare(
          "SELECT id, normalized_path FROM files WHERE scope_type = ? AND scope_id = ? AND normalized_path LIKE ?",
        ).all(st, sid, `${oldNorm}/%`) as { id: string; normalized_path: string }[];
        for (const child of children) {
          fileRepo.update(child.id, { normalizedPath: child.normalized_path.replace(oldNorm, newNorm) });
        }
      }
      fileRepo.update(file.id, { name: safeName, normalizedPath: newNorm });
    }
    return { ok: true };
  });

  registerIpc('workspace:move', async (_event, input: { projectId: string; sourcePaths: string[]; targetDir: string; scopeType?: 'project' | 'shared' }) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const targetNorm = normalizeRelativePath(input.targetDir);
    const targetPath = resolveInside(root, input.targetDir);
    await assertNoSymlink(targetPath);
    for (const src of input.sourcePaths) {
      const sourcePath = resolveInside(root, src);
      await assertNoSymlink(sourcePath);
      const safeName = safeFileName(basename(sourcePath));
      const destPath = join(targetPath, safeName);
      let conflict = false;
      try { await access(destPath); conflict = true; } catch { /* ok */ }
      if (conflict) return { ok: false, error: `目标已存在: ${safeName}` };
      await rename(sourcePath, destPath);
      const srcNorm = normalizeRelativePath(src);
      const destNorm = join(targetNorm, safeName).replaceAll('\\', '/');
      const file = fileRepo.getByPath(st, sid, srcNorm);
      if (file) {
        if (file.type === 'directory') {
          const children = db.prepare(
            "SELECT id, normalized_path FROM files WHERE scope_type = ? AND scope_id = ? AND normalized_path LIKE ?",
          ).all(st, sid, `${srcNorm}/%`) as { id: string; normalized_path: string }[];
          for (const child of children) {
            fileRepo.update(child.id, { normalizedPath: child.normalized_path.replace(srcNorm, destNorm) });
          }
        }
        fileRepo.update(file.id, { name: safeName, normalizedPath: destNorm });
      }
    }
    return { ok: true };
  });

  registerIpc('workspace:softDelete', async (_event, input: { projectId: string; paths: string[]; scopeType?: 'project' | 'shared' }) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const trashDir = join(root, '.runtime', 'trash');
    await mkdir(trashDir, { recursive: true });
    for (const src of input.paths) {
      const sourcePath = resolveInside(root, src);
      await assertNoSymlink(sourcePath);
      const ts = Date.now();
      const safeName = safeFileName(basename(sourcePath));
      const trashTarget = join(trashDir, `${ts}-${safeName}`);
      await rename(sourcePath, trashTarget);
      const norm = normalizeRelativePath(src);
      const file = fileRepo.getByPath(st, sid, norm);
      if (file) {
        if (file.type === 'directory') {
          const children = db.prepare(
            "SELECT id FROM files WHERE scope_type = ? AND scope_id = ? AND normalized_path LIKE ?",
          ).all(st, sid, `${norm}/%`) as { id: string }[];
          for (const child of children) fileRepo.softDelete(child.id);
        }
        fileRepo.softDelete(file.id);
      }
    }
    return { ok: true };
  });

  const sanitizeHtml = (html: string): string => {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<script\b[^>]*\/>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
      .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
      .replace(/href\s*=\s*"javascript:/gi, 'href="#"')
      .replace(/href\s*=\s*'javascript:/gi, "href='#'")
      .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
      .replace(/<embed\b[^>]*>/gi, '');
  };

  registerIpc('workspace:getPreview', async (_event, input: WorkspaceRequest) => {
    const st = input.scopeType ?? 'project';
    const sid = st === 'shared' ? 'shared-knowledge' : input.projectId;
    const root = await getScopeRoot(input);
    const target = resolveInside(root, input.relativePath);
    await assertNoSymlink(target);
    const info = await lstat(target);
    if (!info.isFile()) return { ok: true, data: null };
    if (info.size > MAX_FILE_BYTES) return { ok: true, data: { error: '文件超出预览大小限制' } };
    const dbRow = fileRepo.getByPath(st, sid, normalizeRelativePath(input.relativePath).replaceAll('\\', '/'));
    const fileId = dbRow?.id;
    const versionId = dbRow?.currentVersionId;
    const ext = basename(target).toLowerCase().split('.').pop() ?? '';
    const textExts = ['txt', 'md', 'json', 'csv', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sh', 'bat', 'ps1', 'py', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'svg'];
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'];
    if (textExts.includes(ext)) {
      const MAX_TEXT_BYTES = 10 * 1024 * 1024;
      let content = await readFile(target, { encoding: 'utf8', flag: 'r' });
      if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) return { ok: true, data: { error: '文本文件超出预览大小限制' } };
      if (ext === 'html' || ext === 'htm') return { ok: true, data: { kind: 'html' as const, content, fileName: basename(target), size: info.size, fileId, versionId } };
      return { ok: true, data: { kind: 'text' as const, content, mimeType: ext === 'md' ? 'text/markdown' : 'text/plain', fileName: basename(target), size: info.size, fileId, versionId } };
    }
    if (imageExts.includes(ext)) {
      let buf = await readFile(target);
      if (ext === 'svg') {
        const svgStr = sanitizeHtml(buf.toString('utf8'));
        buf = Buffer.from(svgStr, 'utf8');
      }
      const b64 = buf.toString('base64');
      const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' };
      return { ok: true, data: { kind: 'image' as const, dataUri: `data:${mimeMap[ext] ?? 'application/octet-stream'};base64,${b64}`, fileName: basename(target), size: info.size, fileId, versionId } };
    }
    return { ok: true, data: { kind: 'unknown' as const, fileName: basename(target), size: info.size, mimeType: '', fileId, versionId } };
  });
};

const registerDraftIpc = (db: ReturnType<typeof getDatabase>): void => {
  const draftRepo = new DraftRepository(db);
  registerIpc('drafts:get', async (_event, input: { scope: string; scopeId: string }) => {
    const data = draftRepo.get(input.scope, input.scopeId);
    return { ok: true, data };
  });
  registerIpc('drafts:update', async (_event, input: { scope: string; scopeId: string; contentJson: string }) => {
    const data = draftRepo.upsert(input.scope, input.scopeId, input.contentJson);
    return { ok: true, data };
  });
  registerIpc('drafts:chooseAttachments', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: true, data: [] };
    const stagingRoot = join(getStudioRoot(), '.kstudio', 'temp', 'staged-uploads');
    const staged: Array<{ id: string }> = [];
    for (const filePath of result.filePaths) {
      const id = randomUUID().replace(/-/g, '').slice(0, 24);
      await copyFile(filePath, join(stagingRoot, id));
      await writeFile(join(stagingRoot, `${id}.meta`), JSON.stringify({ originalName: basename(filePath) }), 'utf8');
      staged.push({ id });
    }
    return { ok: true, data: staged };
  });
  registerIpc('drafts:removeAttachment', async (_event, input: { stagedUploadId: string }) => {
    const stagingRoot = join(getStudioRoot(), '.kstudio', 'temp', 'staged-uploads');
    const { unlink } = await import('node:fs/promises');
    await unlink(join(stagingRoot, input.stagedUploadId)).catch(() => {});
    await unlink(join(stagingRoot, `${input.stagedUploadId}.meta`)).catch(() => {});
    return { ok: true };
  });
};

const registerProjectIpc = (db: ReturnType<typeof getDatabase>): void => {
  const projectRepo = new ProjectRepository(db);
  registerIpc('projects:list', async (_event, input: { status?: string; limit?: number; offset?: number }) => {
    const data = projectRepo.list(input.status, input.limit ?? 50, input.offset ?? 0);
    return { ok: true, data };
  });
  registerIpc('projects:create', async (event, input: { idempotencyKey: string; content: { schemaVersion?: number; text?: string; mentions?: unknown[]; stagedUploadIds?: string[] }; templateId?: string; requestedAgentProfileIds: string[] }) => {
    const result = await createProject(db, Object.assign({ idempotencyKey: input.idempotencyKey, content: input.content }, input.templateId ? { templateId: input.templateId } : {}));
    if (result.ok && result.data?.id && _fileWatcher) {
      _fileWatcher.addWatch(getProjectRoot(result.data.id as string), 'project', result.data.id as string);
    }
    if (result.ok && result.data.firstMessageId && input.content?.text) {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) {
        const { getLogger: gl } = await import('./logger');
        const { runAgentsForUserMessage } = await import('./fake-agent');
        const controller = new AbortController();
        runAgentsForUserMessage(db, window, result.data.id, input.content.text, controller.signal).catch((err) => { gl()?.warn({ err, projectId: result.data.id }, '项目创建后 agent run 失败'); });
      }
    }
    return result;
  });
  registerIpc('projects:get', async (_event, input: { projectId: string }) => {
    try {
      const data = projectRepo.getById(input.projectId);
      return { ok: true, data };
    } catch {
      return { ok: true, data: null };
    }
  });
  registerIpc('projects:rename', async (_event, input: { projectId: string; name: string }) => {
    projectRepo.rename(input.projectId, input.name);
    return { ok: true };
  });
  registerIpc('projects:archive', async (_event, input: { projectId: string }) => {
    projectRepo.archive(input.projectId);
    return { ok: true };
  });
  registerIpc('projects:restore', async (_event, input: { projectId: string }) => {
    projectRepo.restore(input.projectId);
    return { ok: true };
  });
  registerIpc('projects:setSharedKnowledge', async (_event, input: { projectId: string; enabled: boolean }) => {
    projectRepo.setSharedKnowledgeEnabled(input.projectId, input.enabled);
    return { ok: true };
  });
};

const registerMessageIpc = (db: ReturnType<typeof getDatabase>): void => {
  const messageRepo = new MessageRepository(db);
  const runRepo = new AgentRunRepository(db);
  registerIpc('messages:list', async (_event, input: { projectId: string; before?: string; limit?: number }) => {
    const data = messageRepo.listByProject(input.projectId, input.before, input.limit ?? 50);
    return { ok: true, data };
  });
  registerIpc('messages:send', async (_event, input: { idempotencyKey: string; projectId: string; content: { text?: string } }) => {
    const data = messageRepo.createUserMessage(input.projectId, JSON.stringify(input.content));
    if (_scheduler) {
      const leaderInstance = db.prepare(
        `SELECT id FROM project_agent_instances WHERE project_id = ? AND role = 'leader' LIMIT 1`,
      ).get(input.projectId) as { id: string } | undefined;
      if (leaderInstance) {
        const run = runRepo.create({
          projectId: input.projectId,
          agentInstanceId: leaderInstance.id,
          requestedByType: 'user',
          requestedById: 'local-user',
          instruction: input.content?.text ?? '',
          triggerMessageId: data.id,
        });
        _scheduler.enqueue({ runId: run.id, projectId: input.projectId, agentInstanceId: leaderInstance.id, instruction: input.content?.text ?? '', triggerMessageId: data.id });
      }
    }
    return { ok: true, data };
  });
  registerIpc('messages:cancelRun', async (_event, input: { runId?: string; projectId?: string }) => {
    if (_scheduler && input.projectId) _scheduler.cancelProject(input.projectId);
    return { ok: true, data: null };
  });
  registerIpc('messages:retryRun', async () => {
    return { ok: true, data: { runId: '' } };
  });
};

const registerAgentIpc = (db: ReturnType<typeof getDatabase>): void => {
  registerIpc('agents:listDefinitions', async () => {
    const data = db.prepare('SELECT id, version, kind, is_builtin as isBuiltin, installed_at as installedAt FROM agent_definitions ORDER BY id').all();
    return { ok: true, data };
  });
  registerIpc('agents:listProfiles', async () => {
    const data = db.prepare('SELECT id, name, definition_id as definitionId, runtime_mode as runtimeMode, enabled, delegatable FROM agent_profiles ORDER BY name').all();
    return { ok: true, data };
  });
  registerIpc('agents:getProjectInstances', async (_event, input: { projectId: string }) => {
    const data = db.prepare(
      `SELECT pai.id, pai.project_id as projectId, ap.name as agentName, pai.role, pai.runtime_mode as runtimeMode
       FROM project_agent_instances pai
       JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
       WHERE pai.project_id = ? ORDER BY pai.ordinal`,
    ).all(input.projectId);
    return { ok: true, data };
  });
  registerIpc('agents:detectCli', async () => ({ ok: true, data: [] }));
  registerIpc('agents:saveCliConnection', async () => ({ ok: true, data: null }));
  registerIpc('agents:testCliConnection', async () => ({ ok: true, data: { success: true, capabilities: [] } }));
  registerIpc('agents:saveProfile', async () => ({ ok: true, data: null }));
  registerIpc('agents:setDefaultLeader', async () => ({ ok: true }));
  registerIpc('agents:setProfileEnabled', async () => ({ ok: true }));
  registerIpc('agents:upgradeProjectInstance', async () => ({ ok: true, data: null }));
};

const registerModelIpc = (db: ReturnType<typeof getDatabase>): void => {
  registerIpc('models:listProviders', async () => {
    const data = db.prepare('SELECT id, name, type, base_url as baseUrl, status FROM model_providers ORDER BY name').all();
    return { ok: true, data };
  });
  registerIpc('models:listProfiles', async () => {
    const data = db.prepare(
      `SELECT mp.id, mp.name, mp.provider_id as providerId, mp.model_id as modelId, mp.model_slot as modelSlot, mp.enabled,
              prv.name as providerName, prv.type as providerType
       FROM model_profiles mp
       JOIN model_providers prv ON prv.id = mp.provider_id
       ORDER BY mp.name`,
    ).all();
    return { ok: true, data };
  });
  registerIpc('models:saveProvider', async (_event, input: { name: string; type: string; baseUrl?: string; authType?: string }) => {
    const repo = new ModelProviderRepository(db);
    const row = repo.create({ name: input.name, type: input.type, baseUrl: input.baseUrl, authType: input.authType ?? 'api-key' } as never);
    return { ok: true, data: row };
  });
  registerIpc('models:testProvider', async (_event, input: { providerId: string }) => {
    if (!_gateway) return { ok: true, data: { success: false, latencyMs: 0, error: 'ModelGateway 未初始化' } };
    const start = Date.now();
    try {
      const caps = await _gateway.testCapabilities(input.providerId);
      const repo = new ModelProviderRepository(db);
      repo.update(input.providerId, { status: caps.streaming ? 'available' : 'error', lastCheckedAt: new Date().toISOString() });
      return { ok: true, data: { success: caps.streaming, latencyMs: Date.now() - start, capabilities: caps, error: caps.streaming ? undefined : '测试失败' } };
    } catch (err) {
      return { ok: true, data: { success: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) } };
    }
  });
  registerIpc('models:saveProfile', async (_event, input: { name: string; providerId: string; modelId: string; modelSlot?: string }) => {
    const repo = new ModelProfileRepository(db);
    const row = repo.create({ name: input.name, providerId: input.providerId, modelId: input.modelId, modelSlot: input.modelSlot } as never);
    return { ok: true, data: row };
  });
  registerIpc('models:testCapabilities', async (_event, input: { profileId: string }) => {
    if (!_gateway) return { ok: true, data: { capabilities: ['streaming'], profileId: input.profileId } };
    const profile = new ModelProfileRepository(db).getById(input.profileId);
    const caps = await _gateway.testCapabilities(profile.providerId);
    const capsList = Object.entries(caps).filter(([, v]) => v).map(([k]) => k);
    new ModelProfileRepository(db).updateVerification(input.profileId, capsList, new Date().toISOString());
    return { ok: true, data: { capabilities: capsList, profileId: input.profileId } };
  });
  registerIpc('models:setSlot', async (_event, input: { slot: string; modelProfileId: string }) => {
    db.prepare('INSERT OR REPLACE INTO model_slot_bindings (slot, model_profile_id, updated_at) VALUES (?, ?, ?)').run(input.slot, input.modelProfileId, new Date().toISOString());
    return { ok: true };
  });
};

const registerMemoryIpc = (db: ReturnType<typeof getDatabase>): void => {
  const repo = new MemoryRepository(db);
  registerIpc('memory:list', async (_event, input: { projectId: string; agentInstanceId: string; scope?: string; status?: string }) => {
    const data = repo.list(input.projectId, input.agentInstanceId, input.scope, input.status);
    return { ok: true, data };
  });
  registerIpc('memory:update', async (_event, input: { recordId: string; content?: string; confidence?: number }) => {
    const changes: { content?: string; confidence?: number } = {};
    if (input.content !== undefined) changes.content = input.content;
    if (input.confidence !== undefined) changes.confidence = input.confidence;
    repo.update(input.recordId, changes);
    return { ok: true, data: repo.get(input.recordId) };
  });
  registerIpc('memory:remove', async (_event, input: { recordId: string }) => {
    repo.remove(input.recordId);
    return { ok: true };
  });
};

const registerKnowledgeIpc = (db: ReturnType<typeof getDatabase>): void => {
  const repo = new KnowledgeRepository(db);
  const sharedEnabled = (projectId: string): boolean => {
    try { return !!new ProjectRepository(db).getById(projectId).sharedKnowledgeEnabled; } catch { return false; }
  };
  registerIpc('knowledge:listJobs', async (_event, input: { scopeType?: string; scopeId?: string; status?: string; projectId?: string }) => {
    if (input.scopeType === 'shared' && input.projectId && !sharedEnabled(input.projectId)) return { ok: true, data: [] };
    const data = repo.listJobs(input.scopeType, input.scopeId, input.status);
    return { ok: true, data };
  });
  registerIpc('knowledge:ingest', async (_event, input: { fileId: string }) => {
    const result = knowledgeIngestForFile(db, input.fileId);
    return { ok: true, data: result };
  });
  registerIpc('knowledge:retryJob', async (_event, input: { jobId: string }) => {
    const job = repo.getJob(input.jobId);
    if (!job) return { ok: true, data: null };
    repo.setJobStatus(job.id, 'queued');
    repo.setSourceStatus(job.sourceId, 'pending');
    return { ok: true, data: repo.getJob(job.id) };
  });
  registerIpc('knowledge:search', async (_event, input: { query: string; projectId?: string; scopeType?: string; scopeId?: string; limit?: number }) => {
    if (input.projectId) {
      const shared = new ProjectRepository(db).getById(input.projectId).sharedKnowledgeEnabled;
      if (!shared) {
        const st = input.scopeType ?? '';
        if (st === 'shared') return { ok: true, data: { nodes: [], chunks: [] } };
        if (!st) { input.scopeType = 'project'; input.scopeId = input.projectId; }
      }
    }
    const data = repo.search(input.query, input.scopeType, input.scopeId, input.limit ?? 50);
    return { ok: true, data };
  });
  registerIpc('knowledge:getGraph', async (_event, input: { scopeType: string; scopeId: string; projectId?: string }) => {
    if (input.scopeType === 'shared' && input.projectId && !sharedEnabled(input.projectId)) return { ok: true, data: { nodes: [], edges: [] } };
    const data = repo.getGraph(input.scopeType, input.scopeId);
    return { ok: true, data };
  });
  registerIpc('knowledge:getSourceDetail', async (_event, input: { fileId: string }) => {
    const detail = repo.getSourceDetail(input.fileId);
    return { ok: true, data: detail };
  });
  registerIpc('knowledge:getGraphProjection', async (_event, input: { scopeType: string; scopeId: string; projectId: string; scopeType2?: 'project' | 'shared' }) => {
    if ((input.scopeType === 'shared' || input.scopeType2 === 'shared') && !sharedEnabled(input.projectId)) return { ok: true, data: null };
    const graph = repo.getGraph(input.scopeType, input.scopeId);
    const elements: unknown[] = [
      ...graph.nodes.map((n) => ({
        data: { id: n.id, label: n.canonicalName, nodeType: n.nodeType, summary: n.summary ?? undefined, confidence: n.confidence },
      })),
      ...graph.edges.map((e) => ({
        data: { id: e.id, source: e.sourceNodeId, target: e.targetNodeId, edgeType: e.edgeType, label: e.edgeType, confidence: e.confidence },
      })),
    ];
    const nodeTypes = [...new Set(graph.nodes.map((n) => n.nodeType))];
    const edgeTypes = [...new Set(graph.edges.map((e) => e.edgeType))];
    const projection: { schemaVersion: number; scope: { type: string; id: string }; graphVersion: string; elements: unknown[]; filters: { nodeTypes: string[]; edgeTypes: string[] }; constraints?: string } = {
      schemaVersion: 1,
      scope: { type: input.scopeType === 'shared' ? 'shared' : 'group', id: input.scopeId },
      graphVersion: new Date().toISOString(),
      elements,
      filters: { nodeTypes, edgeTypes },
    };
    if (graph.constraints) projection.constraints = graph.constraints;
    const graphRoot = getGraphRoot({ projectId: input.projectId, ...(input.scopeType2 ? { scopeType: input.scopeType2 } : {}) });
    const visDir = join(graphRoot, 'graph-visualization');
    await mkdir(visDir, { recursive: true });
    await writeFile(join(visDir, 'current.graph.json'), JSON.stringify(projection, null, 2));
    return { ok: true, data: projection };
  });
  registerIpc('knowledge:getNodeProvenance', async (_event, input: { targetType: string; targetId: string }) => {
    const data = repo.listProvenanceDetail(input.targetType, input.targetId);
    return { ok: true, data };
  });
  const wri = new WikiRepository(db);
  registerIpc('wiki:list', async (_event, input: { scopeType: string; scopeId: string; projectId: string }) => {
    if (input.scopeType === 'shared' && !sharedEnabled(input.projectId)) return { ok: true, data: [] };
    const data = wri.list(input.scopeType, input.scopeId);
    return { ok: true, data };
  });
  registerIpc('wiki:get', async (_event, input: { scopeType: string; scopeId: string; slug: string; projectId?: string }) => {
    if (input.scopeType === 'shared' && input.projectId && !sharedEnabled(input.projectId)) return { ok: true, data: null };
    const data = wri.getBySlug(input.scopeType, input.scopeId, input.slug);
    return { ok: true, data };
  });
};

const registerSettingsIpc = (): void => {
  registerIpc('settings:getAll', async () => ({ ok: true, data: {} }));
  registerIpc('settings:update', async () => ({ ok: true, data: {} }));
  registerIpc('settings:saveSecret', async () => ({ ok: true, data: { secretRef: '' } }));
  registerIpc('settings:deleteSecret', async () => ({ ok: true }));
  registerIpc('settings:exportDiagnostics', async () => ({ ok: true }));
};

const registerChannelIpc = (): void => {
  registerIpc('channels:list', async () => ({ ok: true, data: [] }));
  registerIpc('channels:save', async () => ({ ok: true, data: null }));
  registerIpc('channels:test', async () => ({ ok: true, data: { success: true, message: '渠道测试功能尚未实现' } }));
  registerIpc('channels:setEnabled', async () => ({ ok: true }));
};

const registerMissingIpc = (db: ReturnType<typeof getDatabase>): void => {
  registerIpc('app:search', async (_event, input: { query: string; limit?: number }) => {
    const data = new SearchRepository(db).search(input.query, input.limit);
    return { ok: true, data };
  });
  registerIpc('app:openExternal', async (_event, input: { url: string }) => {
    if (isSafeExternalUrl(input.url)) { await shell.openExternal(input.url); return { ok: true }; }
    throw new DatabaseError('VALIDATION_FAILED', '不允许打开非 HTTPS 外部链接');
  });
  registerIpc('studio:getStatus', async () => {
    const markerPath = join(getStudioRoot(), '.kstudio', 'workspace.json');
    const initialized = existsSync(markerPath);
    let marker: { workspaceId?: string; schemaVersion?: number } = {};
    if (initialized) {
      try { marker = JSON.parse(await readFile(markerPath, 'utf8')); } catch { /* ignore */ }
    }
    return { ok: true, data: { initialized, workspaceId: marker.workspaceId ?? '', schemaVersion: marker.schemaVersion ?? 0, rootPath: getStudioRoot() } };
  });
  registerIpc('studio:chooseAndInitialize', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择 K_Studio 工作区根目录' });
    if (result.canceled || result.filePaths.length === 0) return { ok: true, data: null };
    setStudioRoot(result.filePaths[0]!);
    const { workspaceId, isNew } = await ensureStudioWorkspace();
    const acquired = await tryAcquireLock(result.filePaths[0]!);
    if (!acquired) throw new DatabaseError('STUDIO_WORKSPACE_LOCKED', '工作区已被其他进程占用');
    return { ok: true, data: { workspaceId, isNew, rootPath: result.filePaths[0] } };
  });
  registerIpc('studio:chooseAndOpenExisting', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择已有 K_Studio 工作区' });
    if (result.canceled || result.filePaths.length === 0) return { ok: true, data: null };
    const markerPath = join(result.filePaths[0]!, '.kstudio', 'workspace.json');
    if (!existsSync(markerPath)) throw new DatabaseError('STUDIO_WORKSPACE_INVALID', '所选目录不是有效的 K_Studio 工作区');
    setStudioRoot(result.filePaths[0]!);
    const acquired = await tryAcquireLock(result.filePaths[0]!);
    if (!acquired) throw new DatabaseError('STUDIO_WORKSPACE_LOCKED', '工作区已被其他进程占用');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { workspaceId: string };
    return { ok: true, data: { workspaceId: marker.workspaceId, rootPath: result.filePaths[0]!, isNew: false } };
  });
  registerIpc('studio:validate', async () => {
    const markerPath = join(getStudioRoot(), '.kstudio', 'workspace.json');
    if (!existsSync(markerPath)) return { ok: true, data: { valid: false, reason: '未找到 workspace.json' } };
    return { ok: true, data: { valid: true } };
  });
  registerIpc('studio:migrate', async () => ({ ok: true, data: { success: true } }));
  registerIpc('workspace:list', async () => ({ ok: true, data: [] }));
};

const isSafeExternalUrl = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

const createWindow = (): void => {
  const window = new BrowserWindow({
    width: 1720,
    height: 1040,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    backgroundColor: '#f9f9fe',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
};

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

app.whenReady().then(async () => {
  const initialRoot = join(app.getPath('documents'), 'K_Studio');
  const logger = getLogger(initialRoot);

  const defaultRoot = initialRoot;
  if (existsSync(join(defaultRoot, '.kstudio', 'workspace.json'))) {
    const acquired = await tryAcquireLock(defaultRoot);
    if (acquired) setStudioRoot(defaultRoot);
  }

  let _dbInitialized = false;
  let _db: ReturnType<typeof getDatabase> | null = null;
  const ensureDb = (): ReturnType<typeof getDatabase> => {
    if (!_db) {
      const dbPath = join(getStudioRoot(), '.kstudio', 'k_studio.db');
      runMigrations(dbPath);
      _db = getDatabase(dbPath);
      logger.info({ workspaceId: getStudioRoot(), dbPath }, '数据库已初始化');
    }
    return _db;
  };

  registerIpc('app:getVersion', () => app.getVersion());
  registerIpc('app:bootstrap', async () => ({
    ok: true,
    data: { studioInitialized: existsSync(join(getStudioRoot(), '.kstudio', 'workspace.json')), version: app.getVersion(), workspacePath: getStudioRoot() },
  }));

  registerWorkspaceIpc();

  const delayedRegisters = (): void => {
    const db = ensureDb();
    seedDefaultProfiles(db);
    registerDraftIpc(db);
    registerProjectIpc(db);
    registerMessageIpc(db);
    registerFileIpc(db);
    registerAgentIpc(db);
    registerModelIpc(db);
    registerMemoryIpc(db);
    registerKnowledgeIpc(db);
    registerSettingsIpc();
    registerChannelIpc();
    registerMissingIpc(db);
  };

  registerIpc('app:ensureStudio', async () => {
    const studioRoot = getStudioRoot();
    const markerPath = join(studioRoot, '.kstudio', 'workspace.json');
    if (!existsSync(markerPath)) throw new DatabaseError('STUDIO_WORKSPACE_INVALID', 'K_Studio 尚未初始化');
    if (!_dbInitialized) {
      delayedRegisters();
      _dbInitialized = true;
      const db = ensureDb();
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        _gateway = new ModelGateway(db as never);
        const executor = createAgentExecutor(db, win, _gateway);
        _scheduler = new Scheduler(db, executor);
      }
      const memoryCleanup = startMemoryCleanup(db);
      app.on('before-quit', () => { memoryCleanup(); });
      ensureProjectWorkspace({ projectId: 'annual-finance', name: '年度财务报销审核' }).catch((err) => { logger?.warn({ err }, '种子项目目录创建失败'); });

      const watcher = new FileWatcher(db);
      watcher.onIngest = (fileId) => {
        try {
          knowledgeIngestForFile(db, fileId);
        } catch (err) {
          getLogger().error({ err, fileId }, 'Watcher 触发的知识入库失败');
        }
      };
      const allProjects = new ProjectRepository(db).list();
      const projectRoots = allProjects.map((p: { id: string }) => ({ projectId: p.id, rootPath: getProjectRoot(p.id) }));
      watcher.start(studioRoot, projectRoots);
      _fileWatcher = watcher;
    }
    return { ok: true, data: { studioRoot } };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('before-quit', async () => {
    await releaseLock(getStudioRoot());
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
