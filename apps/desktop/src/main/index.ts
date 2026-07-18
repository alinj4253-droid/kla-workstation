import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { access, copyFile, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, normalize, resolve, sep } from 'node:path';

type WorkspaceRequest = { projectId: string; relativePath?: string };
type EnsureProjectRequest = { projectId: string; name: string };
type CreateFolderRequest = WorkspaceRequest & { name: string };

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_BATCH_BYTES = 500 * 1024 * 1024;
const invalidFileName = /[<>:"/\\|?*\u0000-\u001f]/;
const reservedFileName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const assertProjectId = (projectId: string): string => {
  if (!/^[a-z0-9-]{1,64}$/i.test(projectId)) throw new Error('群聊标识不合法');
  return projectId;
};

const normalizeRelativePath = (input = ''): string => {
  if (!input) return '';
  if (isAbsolute(input)) throw new Error('不允许使用绝对路径');
  const cleaned = normalize(input.replaceAll('/', sep));
  if (cleaned === '..' || cleaned.startsWith(`..${sep}`)) throw new Error('路径超出当前群聊工作区');
  return cleaned === '.' ? '' : cleaned;
};

const resolveInside = (root: string, relativePath = ''): string => {
  const target = resolve(root, normalizeRelativePath(relativePath));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) throw new Error('路径超出当前群聊工作区');
  return target;
};

const validateFolderName = (input: string): string => {
  const name = input.trim();
  if (!name || name === '.' || name === '..') throw new Error('文件夹名称不能为空');
  if (invalidFileName.test(name) || reservedFileName.test(name) || /[. ]$/.test(name)) throw new Error('文件夹名称包含 Windows 不支持的字符或保留名称');
  return name;
};

const getStudioRoot = (): string => join(app.getPath('documents'), 'K_Studio');
const getProjectRoot = (projectId: string): string => join(getStudioRoot(), 'group-chats', `${assertProjectId(projectId)}-workspace`);

const writeIfMissing = async (path: string, content: string): Promise<void> => {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
};

const ensureStudioWorkspace = async (): Promise<void> => {
  const root = getStudioRoot();
  await Promise.all([
    mkdir(join(root, '.kstudio', 'logs'), { recursive: true }),
    mkdir(join(root, '.kstudio', 'cache'), { recursive: true }),
    mkdir(join(root, '.kstudio', 'temp', 'staged-uploads'), { recursive: true }),
    mkdir(join(root, 'agent-definitions', 'built-in'), { recursive: true }),
    mkdir(join(root, 'agent-definitions', 'custom'), { recursive: true }),
    mkdir(join(root, 'group-chats'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'original-files'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'knowledge'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', 'graph-visualization'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', '.runtime', 'trash'), { recursive: true }),
    mkdir(join(root, 'shared-knowledge', '.runtime', 'versions'), { recursive: true }),
  ]);
  await writeIfMissing(join(root, '.kstudio', 'workspace.json'), JSON.stringify({ schemaVersion: 1, workspaceId: randomUUID(), product: 'K_Studio', createdAt: new Date().toISOString() }, null, 2));
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
  if (info.isSymbolicLink()) throw new Error('不允许通过符号链接访问群聊工作区外部');
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
  ipcMain.handle('workspace:ensureProject', async (_event, input: EnsureProjectRequest) => {
    await ensureProjectWorkspace(input);
    return { ok: true };
  });

  ipcMain.handle('workspace:listFiles', async (_event, input: WorkspaceRequest) => {
    const root = await getOriginalFilesRoot(input.projectId);
    const directory = resolveInside(root, input.relativePath);
    await assertNoSymlink(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const result = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry) => {
      const entryPath = join(directory, entry.name);
      const info = await lstat(entryPath);
      const relativePath = join(normalizeRelativePath(input.relativePath), entry.name).replaceAll('\\', '/');
      return { name: entry.name, relativePath, kind: entry.isDirectory() ? 'directory' as const : 'file' as const, size: entry.isDirectory() ? 0 : info.size, modifiedAt: info.mtime.toISOString() };
    }));
    return result.sort((left, right) => left.kind === right.kind ? right.modifiedAt.localeCompare(left.modifiedAt) : left.kind === 'directory' ? -1 : 1);
  });

  ipcMain.handle('workspace:uploadFiles', async (event, input: WorkspaceRequest) => {
    const root = await getOriginalFilesRoot(input.projectId);
    const targetDirectory = resolveInside(root, input.relativePath);
    await assertNoSymlink(targetDirectory);
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { title: '导入到群聊用户原始文件', properties: ['openFile', 'multiSelections'] };
    const selection = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options);
    if (selection.canceled) return { cancelled: true, importedCount: 0 };
    const sources = await Promise.all(selection.filePaths.map(async (sourcePath) => ({ sourcePath, info: await lstat(sourcePath) })));
    if (sources.some(({ info }) => !info.isFile() || info.isSymbolicLink())) throw new Error('只能导入普通文件');
    if (sources.some(({ info }) => info.size > MAX_FILE_BYTES)) throw new Error('单个文件不能超过 100 MB');
    if (sources.reduce((total, { info }) => total + info.size, 0) > MAX_BATCH_BYTES) throw new Error('单次导入总量不能超过 500 MB');
    for (const { sourcePath } of sources) {
      const destination = await nextAvailablePath(targetDirectory, basename(sourcePath));
      await copyFile(sourcePath, destination);
    }
    return { cancelled: false, importedCount: sources.length };
  });

  ipcMain.handle('workspace:createFolder', async (_event, input: CreateFolderRequest) => {
    const root = await getOriginalFilesRoot(input.projectId);
    const parent = resolveInside(root, input.relativePath);
    await assertNoSymlink(parent);
    await mkdir(join(parent, validateFolderName(input.name)), { recursive: false });
    return { ok: true };
  });

  ipcMain.handle('workspace:openItem', async (_event, input: WorkspaceRequest) => {
    const root = await getOriginalFilesRoot(input.projectId);
    const target = resolveInside(root, input.relativePath);
    await assertNoSymlink(target);
    const message = await shell.openPath(target);
    if (message) throw new Error(message);
    return { ok: true };
  });

  ipcMain.handle('workspace:openInExplorer', async (_event, input: { projectId: string }) => {
    const root = await getOriginalFilesRoot(input.projectId);
    const message = await shell.openPath(root);
    if (message) throw new Error(message);
    return { ok: true };
  });
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

app.whenReady().then(() => {
  ipcMain.handle('app:getVersion', () => app.getVersion());
  registerWorkspaceIpc();
  void ensureProjectWorkspace({ projectId: 'annual-finance', name: '年度财务报销审核' });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
