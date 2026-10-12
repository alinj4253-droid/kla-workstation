const { contextBridge, ipcRenderer } = require('electron');
function argumentValue(prefix, fallback = '') {
  const value = process.argv.find(item => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}
const apiBaseUrl = argumentValue('--kla-api-base-url=', 'http://127.0.0.1:8787/api');
const knowledgeServiceUrl = argumentValue('--kla-knowledge-service-url=', '');

contextBridge.exposeInMainWorld('klaPlatform', Object.freeze({
  runtime: 'electron',
  apiBaseUrl,
  knowledgeServiceUrl,
  agentRuntime: Object.freeze({
    connect: session => ipcRenderer.invoke('kla:runtime-connect', session),
    disconnect: () => ipcRenderer.invoke('kla:runtime-disconnect'),
    status: () => ipcRenderer.invoke('kla:runtime-status'),
  }),
  operations: Object.freeze({
    openExternal: (url) => ipcRenderer.invoke('kla:operation-open-external', { url }),
    health: () => ipcRenderer.invoke('kla:operation-health'),
  }),
}));
