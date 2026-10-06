const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('klaPlatform', Object.freeze({
  runtime: 'electron',
  apiBaseUrl: process.env.KLA_API_BASE_URL || 'http://127.0.0.1:8787/api',
  operations: Object.freeze({
    openExternal: (url) => ipcRenderer.invoke('kla:operation-open-external', { url }),
    health: () => ipcRenderer.invoke('kla:operation-health'),
  }),
}));
