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
  localApproval: Object.freeze({
    pending: () => ipcRenderer.invoke('kla:approval-pending'),
    decide: decision => ipcRenderer.invoke('kla:approval-decide', decision),
    onChange: listener => {
      const handler = (_event, request) => listener(request);
      ipcRenderer.on('kla:approval-changed', handler);
      return () => ipcRenderer.removeListener('kla:approval-changed', handler);
    },
  }),
  operations: Object.freeze({
    openExternal: (url) => ipcRenderer.invoke('kla:operation-open-external', { url }),
    health: () => ipcRenderer.invoke('kla:operation-health'),
  }),
}));
