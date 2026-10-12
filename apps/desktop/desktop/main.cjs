const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { LocalRuntime } = require('./local-runtime.cjs');
let localRuntime;
function loadClientConfig() {
  if (process.defaultApp) {
    return { apiBaseUrl: process.env.KLA_API_BASE_URL || 'http://127.0.0.1:8787/api', knowledgeServiceUrl: process.env.KLA_KNOWLEDGE_BASE_URL || '' };
  }
  const file = join(process.resourcesPath, 'client-config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const apiBaseUrl = typeof config.apiBaseUrl === 'string' ? config.apiBaseUrl.trim().replace(/\/$/, '') : '';
  const knowledgeServiceUrl = typeof config.knowledgeServiceUrl === 'string' ? config.knowledgeServiceUrl.trim().replace(/\/$/, '') : '';
  if (!/^https:\/\/[^/]+\/api$/i.test(apiBaseUrl)) throw new Error('client-config.json 的 apiBaseUrl 必须是 HTTPS /api 地址');
  if (knowledgeServiceUrl && !/^https?:\/\/[^/]+/i.test(knowledgeServiceUrl)) throw new Error('client-config.json 的 knowledgeServiceUrl 无效');
  return { apiBaseUrl, knowledgeServiceUrl };
}
const clientConfig = loadClientConfig();
function trusted(event) { return BrowserWindow.getAllWindows().some(w => w.webContents === event.sender && event.senderFrame === w.webContents.mainFrame); }
ipcMain.handle('kla:runtime-connect', async (event,session) => { if(!trusted(event))throw new Error('UNTRUSTED_FRAME'); return localRuntime.connect(session); });
ipcMain.handle('kla:runtime-disconnect', async event => {if(!trusted(event))throw new Error('UNTRUSTED_FRAME');await localRuntime.disconnect();});
ipcMain.handle('kla:runtime-status', async event => {if(!trusted(event))throw new Error('UNTRUSTED_FRAME');return localRuntime.status();});

function createWindow() {
  const devUrl = process.env.KLA_RENDERER_URL;
  const allowedOrigin = devUrl ? new URL(devUrl).origin : null;
  const packagedIndex = pathToFileURL(join(__dirname, '..', 'dist', 'index.html')).href;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
      additionalArguments: [`--kla-api-base-url=${clientConfig.apiBaseUrl}`, `--kla-knowledge-service-url=${clientConfig.knowledgeServiceUrl}`],
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = allowedOrigin ? new URL(url).origin === allowedOrigin : url === packagedIndex;
    if (!allowed) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '..', 'dist', 'index.html'));
}

ipcMain.handle('kla:operation-open-external', async (_event, payload) => {
  const url = typeof payload?.url === 'string' ? payload.url : '';
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'URL_INVALID' };
  await shell.openExternal(url);
  return { ok: true };
});
ipcMain.handle('kla:operation-health', async () => ({ ok: true, runtime: 'electron', capabilities: ['external-navigation', 'task-bridge'] }));

app.whenReady().then(() => {
  localRuntime = new LocalRuntime(app.getPath('userData'), clientConfig.apiBaseUrl, async call => {
    const action = { local_read: '读取本地文件', local_list: '查看本地目录', local_write: '写入本地文件', local_code: '保存代码文件', local_bat: '运行 BAT 脚本', local_cli: '运行命令行程序', local_file_fetch: '下载群聊共享文件到本地工作区', local_file_publish: '发布本地文件为群聊成果', local_ppt_doctor: '检查本地 PPT 环境', local_ppt_build: '生成 PPTX 并进行质量检查与渲染', local_ppt_inspect: '读取 PPTX 的页面内容与备注', local_ppt_render: '检查并渲染本地 PPTX' }[call.tool];
    if (!action) return false;
    const summary = call.tool === 'local_file_fetch' ? `${call.arguments.fileId ? '附件' : '成果'} ID：${String(call.arguments.fileId || call.arguments.artifactId)}` : call.tool === 'local_cli' ? `${String(call.arguments.executable)} ${(call.arguments.args || []).join(' ')}` : call.tool === 'local_bat' ? String(call.arguments.script).slice(0, 400) : String(call.arguments.path || call.arguments.documentId || call.arguments.fileName || 'Python 依赖、中文字体、Office/WPS 渲染器');
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return false;
    const choice = await dialog.showMessageBox(window, { type: 'warning', buttons: ['拒绝', '允许本次操作'], defaultId: 0, cancelId: 0,
      title: '鲲擎本地执行审批', message: action, detail: `当前身份的智能体请求以本机用户权限执行：\n${summary}\n\n读取内容或命令输出会回传服务端供智能体继续处理；新建文件默认回传可预览副本。\n任务 ${call.runId}` });
    return choice.response === 1;
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('before-quit',()=>{void localRuntime?.disconnect();});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
