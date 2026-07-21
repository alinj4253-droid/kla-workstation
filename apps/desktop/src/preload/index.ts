import { contextBridge, ipcRenderer } from 'electron';

function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function rpc<T>(channel: string, payload?: Record<string, unknown>): Promise<T> {
  return ipcRenderer.invoke(channel, { ...payload, requestId: generateRequestId() }) as Promise<T>;
}

const api = {
  app: {
    bootstrap: (): Promise<unknown> => rpc('app:bootstrap'),
    getVersion: (): Promise<string> => rpc('app:getVersion') as Promise<string>,
    ensureStudio: (): Promise<unknown> => rpc('app:ensureStudio'),
    search: (input: { query: string; scope?: string }): Promise<unknown> => rpc('app:search', input),
    openExternal: (input: { url: string }): Promise<unknown> => rpc('app:openExternal', input),
  },
  studio: {
    getStatus: (): Promise<unknown> => rpc('studio:getStatus'),
    chooseAndInitialize: (): Promise<unknown> => rpc('studio:chooseAndInitialize'),
    chooseAndOpenExisting: (): Promise<unknown> => rpc('studio:chooseAndOpenExisting'),
    validate: (input: { rootPath: string }): Promise<unknown> => rpc('studio:validate', input),
    migrate: (input: { rootPath: string }): Promise<unknown> => rpc('studio:migrate', input),
  },
  drafts: {
    get: (input: { scope: string; scopeId: string }): Promise<unknown> => rpc('drafts:get', input),
    update: (input: { scope: string; scopeId: string; contentJson: string }): Promise<unknown> => rpc('drafts:update', input),
    chooseAttachments: (input: { scope: string; scopeId: string }): Promise<unknown> => rpc('drafts:chooseAttachments', input),
    removeAttachment: (input: { scope: string; scopeId: string; stagedUploadId: string }): Promise<unknown> => rpc('drafts:removeAttachment', input),
  },
  projects: {
    list: (input: { status?: string; limit?: number; offset?: number }): Promise<unknown> => rpc('projects:list', input),
    create: (input: { idempotencyKey: string; content: unknown; templateId?: string; requestedAgentProfileIds: string[] }): Promise<unknown> => rpc('projects:create', input),
    get: (input: { projectId: string }): Promise<unknown> => rpc('projects:get', input),
    rename: (input: { projectId: string; name: string }): Promise<unknown> => rpc('projects:rename', input),
    archive: (input: { projectId: string }): Promise<unknown> => rpc('projects:archive', input),
    restore: (input: { projectId: string }): Promise<unknown> => rpc('projects:restore', input),
    setSharedKnowledge: (input: { projectId: string; enabled: boolean }): Promise<unknown> => rpc('projects:setSharedKnowledge', input),
  },
  messages: {
    list: (input: { projectId: string; before?: string; limit?: number }): Promise<unknown> => rpc('messages:list', input),
    send: (input: { idempotencyKey: string; projectId: string; content: unknown }): Promise<unknown> => rpc('messages:send', input),
    cancelRun: (input: { runId: string }): Promise<unknown> => rpc('messages:cancelRun', input),
    retryRun: (input: { runId: string; idempotencyKey: string }): Promise<unknown> => rpc('messages:retryRun', input),
  },
  workspace: {
    list: (input: { projectId: string; relativePath?: string; filter?: string }): Promise<unknown> => rpc('workspace:list', input),
    listFiles: (input: { projectId: string; relativePath?: string }): Promise<unknown> => rpc('workspace:listFiles', input),
    ensureProject: (input: { projectId: string; name: string }): Promise<{ ok: true }> => rpc('workspace:ensureProject', input) as Promise<{ ok: true }>,
    uploadFiles: (input: { projectId: string; relativePath?: string }): Promise<{ cancelled: boolean; importedCount: number }> => rpc('workspace:uploadFiles', input) as Promise<{ cancelled: boolean; importedCount: number }>,
    openItem: (input: { projectId: string; relativePath: string }): Promise<{ ok: true }> => rpc('workspace:openItem', input),
    createFolder: (input: { projectId: string; name: string; relativePath?: string }): Promise<unknown> => rpc('workspace:createFolder', input),
    rename: (input: { projectId: string; relativePath: string; name: string }): Promise<unknown> => rpc('workspace:rename', input),
    move: (input: { projectId: string; sourcePaths: string[]; targetDir: string }): Promise<unknown> => rpc('workspace:move', input),
    softDelete: (input: { projectId: string; paths: string[] }): Promise<unknown> => rpc('workspace:softDelete', input),
    getPreview: (input: { projectId: string; relativePath: string }): Promise<unknown> => rpc('workspace:getPreview', input),
    listVersions: (input: { fileId: string }): Promise<unknown> => rpc('workspace:listVersions', input),
    openWithSystem: (input: { projectId: string; relativePath: string }): Promise<unknown> => rpc('workspace:openWithSystem', input),
  },
  agents: {
    listDefinitions: (): Promise<unknown> => rpc('agents:listDefinitions'),
    listProfiles: (): Promise<unknown> => rpc('agents:listProfiles'),
    getProjectInstances: (input: { projectId: string }): Promise<unknown> => rpc('agents:getProjectInstances', input),
    detectCli: (): Promise<unknown> => rpc('agents:detectCli'),
    saveCliConnection: (input: { name: string; adapterType: string; executablePath: string }): Promise<unknown> => rpc('agents:saveCliConnection', input),
    testCliConnection: (input: { connectionId: string }): Promise<unknown> => rpc('agents:testCliConnection', input),
    saveProfile: (input: { id?: string; name: string; definitionId: string; runtimeMode: string }): Promise<unknown> => rpc('agents:saveProfile', input),
    setDefaultLeader: (input: { profileId: string }): Promise<unknown> => rpc('agents:setDefaultLeader', input),
    setProfileEnabled: (input: { profileId: string; enabled: boolean }): Promise<unknown> => rpc('agents:setProfileEnabled', input),
    upgradeProjectInstance: (input: { projectId: string; instanceId: string }): Promise<unknown> => rpc('agents:upgradeProjectInstance', input),
  },
  models: {
    listProviders: (): Promise<unknown> => rpc('models:listProviders'),
    listProfiles: (): Promise<unknown> => rpc('models:listProfiles'),
    saveProvider: (input: { name: string; type: string; baseUrl: string; authType: string }): Promise<unknown> => rpc('models:saveProvider', input),
    testProvider: (input: { providerId: string }): Promise<unknown> => rpc('models:testProvider', input),
    saveProfile: (input: { id?: string; name: string; providerId: string; modelId: string; modelSlot: string }): Promise<unknown> => rpc('models:saveProfile', input),
    testCapabilities: (input: { profileId: string }): Promise<unknown> => rpc('models:testCapabilities', input),
    setSlot: (input: { slot: string; modelProfileId: string }): Promise<unknown> => rpc('models:setSlot', input),
  },
  memory: {
    list: (input: { projectId: string; agentInstanceId: string; scope?: string; status?: string }): Promise<unknown> => rpc('memory:list', input),
    update: (input: { recordId: string; content: string; confidence?: number }): Promise<unknown> => rpc('memory:update', input),
    remove: (input: { recordId: string }): Promise<unknown> => rpc('memory:remove', input),
  },
  knowledge: {
    search: (input: { query: string; scopeType?: string; scopeId?: string; limit?: number }): Promise<unknown> => rpc('knowledge:search', input),
    listJobs: (input: { scopeType?: string; scopeId?: string; status?: string; projectId?: string }): Promise<unknown> => rpc('knowledge:listJobs', input),
    ingest: (input: { fileId: string }): Promise<unknown> => rpc('knowledge:ingest', input),
    retryJob: (input: { jobId: string }): Promise<unknown> => rpc('knowledge:retryJob', input),
    getGraph: (input: { scopeType: string; scopeId: string; projectId?: string }): Promise<unknown> => rpc('knowledge:getGraph', input),
    getSourceDetail: (input: { fileId: string }): Promise<unknown> => rpc('knowledge:getSourceDetail', input),
    getGraphProjection: (input: { scopeType: string; scopeId: string; projectId: string; scopeType2?: 'project' | 'shared' }): Promise<unknown> => rpc('knowledge:getGraphProjection', input),
    getNodeProvenance: (input: { targetType: string; targetId: string }): Promise<unknown> => rpc('knowledge:getNodeProvenance', input),
    wikiList: (input: { scopeType: string; scopeId: string; projectId: string }): Promise<unknown> => rpc('wiki:list', input),
    wikiGet: (input: { scopeType: string; scopeId: string; slug: string; projectId?: string }): Promise<unknown> => rpc('wiki:get', input),
  },
  settings: {
    getAll: (): Promise<unknown> => rpc('settings:getAll'),
    update: (input: Record<string, unknown>): Promise<unknown> => rpc('settings:update', input),
    saveSecret: (input: { kind: string; value: string }): Promise<unknown> => rpc('settings:saveSecret', input),
    deleteSecret: (input: { secretRef: string }): Promise<unknown> => rpc('settings:deleteSecret', input),
    exportDiagnostics: (): Promise<unknown> => rpc('settings:exportDiagnostics'),
  },
  channels: {
    list: (): Promise<unknown> => rpc('channels:list'),
    save: (input: { id?: string; type: string; name: string; config: Record<string, unknown> }): Promise<unknown> => rpc('channels:save', input),
    test: (input: { channelId: string }): Promise<unknown> => rpc('channels:test', input),
    setEnabled: (input: { channelId: string; enabled: boolean }): Promise<unknown> => rpc('channels:setEnabled', input),
  },
  events: {
    subscribe: (handler: (event: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown): void => handler(data);
      ipcRenderer.on('event:dispatch', listener);
      return () => ipcRenderer.removeListener('event:dispatch', listener);
    },
  },
} as const;

contextBridge.exposeInMainWorld('kunqing', api);

export type KunqingDesktopApi = typeof api;
