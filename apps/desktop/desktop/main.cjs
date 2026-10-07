const { app, BrowserWindow, shell, ipcMain } = require('electron');
const { join } = require('node:path');

function createWindow() {
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
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.KLA_RENDERER_URL;
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
