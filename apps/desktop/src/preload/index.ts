import { contextBridge, ipcRenderer } from 'electron';

const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion') as Promise<string>,
  },
  workspace: {
    ensureProject: (input: { projectId: string; name: string }): Promise<{ ok: true }> => ipcRenderer.invoke('workspace:ensureProject', input) as Promise<{ ok: true }>,
    listFiles: (input: { projectId: string; relativePath?: string }): Promise<Array<{ name: string; relativePath: string; kind: 'file' | 'directory'; size: number; modifiedAt: string }>> => ipcRenderer.invoke('workspace:listFiles', input) as Promise<Array<{ name: string; relativePath: string; kind: 'file' | 'directory'; size: number; modifiedAt: string }>>,
    uploadFiles: (input: { projectId: string; relativePath?: string }): Promise<{ cancelled: boolean; importedCount: number }> => ipcRenderer.invoke('workspace:uploadFiles', input) as Promise<{ cancelled: boolean; importedCount: number }>,
    createFolder: (input: { projectId: string; relativePath?: string; name: string }): Promise<{ ok: true }> => ipcRenderer.invoke('workspace:createFolder', input) as Promise<{ ok: true }>,
    openItem: (input: { projectId: string; relativePath: string }): Promise<{ ok: true }> => ipcRenderer.invoke('workspace:openItem', input) as Promise<{ ok: true }>,
    openInExplorer: (input: { projectId: string }): Promise<{ ok: true }> => ipcRenderer.invoke('workspace:openInExplorer', input) as Promise<{ ok: true }>,
  },
} as const;

contextBridge.exposeInMainWorld('kunqing', api);

export type KunqingDesktopApi = typeof api;
