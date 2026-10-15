const { app, BrowserWindow, shell, ipcMain } = require('electron');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { LocalRuntime } = require('./local-runtime.cjs');
const { createLocalApprovalBridge } = require('./local-approval.cjs');
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
const localApproval = createLocalApprovalBridge(ipcMain, trusted);
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
  localRuntime = new LocalRuntime(app.getPath('userData'), clientConfig.apiBaseUrl, (call, signal) =>
    localApproval.request(BrowserWindow.getAllWindows()[0], call, signal));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('before-quit',()=>{void localRuntime?.disconnect();});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
