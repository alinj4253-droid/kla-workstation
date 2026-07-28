const { contextBridge, ipcRenderer } = require('electron');

function generateRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function rpc(channel, payload) {
  return ipcRenderer.invoke(channel, { ...payload, requestId: generateRequestId() });
}

contextBridge.exposeInMainWorld('kunqing', {
  app: {
    bootstrap: () => rpc('app:bootstrap'),
    getVersion: () => rpc('app:getVersion'),
    ensureStudio: () => rpc('app:ensureStudio'),
    search: (input) => rpc('app:search', input),
    openExternal: (input) => rpc('app:openExternal', input),
  },
  studio: {
    getStatus: () => rpc('studio:getStatus'),
    chooseAndInitialize: () => rpc('studio:chooseAndInitialize'),
    chooseAndOpenExisting: () => rpc('studio:chooseAndOpenExisting'),
    validate: (input) => rpc('studio:validate', input),
    migrate: (input) => rpc('studio:migrate', input),
  },
  drafts: {
    get: (input) => rpc('drafts:get', input),
    update: (input) => rpc('drafts:update', input),
    chooseAttachments: (input) => rpc('drafts:chooseAttachments', input),
    removeAttachment: (input) => rpc('drafts:removeAttachment', input),
  },
  projects: {
    list: (input) => rpc('projects:list', input),
    create: (input) => rpc('projects:create', input),
    get: (input) => rpc('projects:get', input),
    rename: (input) => rpc('projects:rename', input),
    archive: (input) => rpc('projects:archive', input),
    restore: (input) => rpc('projects:restore', input),
    setSharedKnowledge: (input) => rpc('projects:setSharedKnowledge', input),
  },
  messages: {
    list: (input) => rpc('messages:list', input),
    send: (input) => rpc('messages:send', input),
    cancelRun: (input) => rpc('messages:cancelRun', input),
    retryRun: (input) => rpc('messages:retryRun', input),
  },
  workspace: {
    list: (input) => rpc('workspace:list', input),
    listFiles: (input) => rpc('workspace:listFiles', input),
    ensureProject: (input) => rpc('workspace:ensureProject', input),
    uploadFiles: (input) => rpc('workspace:uploadFiles', input),
    openItem: (input) => rpc('workspace:openItem', input),
    createFolder: (input) => rpc('workspace:createFolder', input),
    rename: (input) => rpc('workspace:rename', input),
    move: (input) => rpc('workspace:move', input),
    softDelete: (input) => rpc('workspace:softDelete', input),
    getPreview: (input) => rpc('workspace:getPreview', input),
    listVersions: (input) => rpc('workspace:listVersions', input),
    openWithSystem: (input) => rpc('workspace:openWithSystem', input),
  },
  agents: {
    listDefinitions: () => rpc('agents:listDefinitions'),
    listProfiles: () => rpc('agents:listProfiles'),
    getProjectInstances: (input) => rpc('agents:getProjectInstances', input),
    detectCli: () => rpc('agents:detectCli'),
    listCliConnections: () => rpc('agents:listCliConnections'),
    saveCliConnection: (input) => rpc('agents:saveCliConnection', input),
    testCliConnection: (input) => rpc('agents:testCliConnection', input),
    deleteCliConnection: (input) => rpc('agents:deleteCliConnection', input),
    saveProfile: (input) => rpc('agents:saveProfile', input),
    setDefaultLeader: (input) => rpc('agents:setDefaultLeader', input),
    setProfileEnabled: (input) => rpc('agents:setProfileEnabled', input),
    updateProfileModel: (input) => rpc('agents:updateProfileModel', input),
    updateProfileSkills: (input) => rpc('agents:updateProfileSkills', input),
    updateProfilePermissions: (input) => rpc('agents:updateProfilePermissions', input),
    cloneProfile: (input) => rpc('agents:cloneProfile', input),
    upgradeProjectInstance: (input) => rpc('agents:upgradeProjectInstance', input),
    startProcess: (input) => rpc('agents:startProcess', input),
    cancelProcess: (input) => rpc('agents:cancelProcess', input),
    getWizardSnapshot: () => rpc('agents:getWizardSnapshot'),
    wizardStartManual: (input) => rpc('agents:wizardStartManual', input),
    wizardStartAuto: (input) => rpc('agents:wizardStartAuto', input),
    wizardReadVersion: () => rpc('agents:wizardReadVersion'),
    wizardProbeAuth: () => rpc('agents:wizardProbeAuth'),
    wizardPrepareSmokeWorkspace: () => rpc('agents:wizardPrepareSmokeWorkspace'),
    wizardRunSmokeTest: () => rpc('agents:wizardRunSmokeTest'),
    wizardSave: () => rpc('agents:wizardSave'),
    wizardCancel: () => rpc('agents:wizardCancel'),
    wizardSetExecutable: (input) => rpc('agents:wizardSetExecutable', input),
    wizardSetTrustTier: (input) => rpc('agents:wizardSetTrustTier', input),
    wizardRetry: () => rpc('agents:wizardRetry'),
  },
  models: {
    listProviders: () => rpc('models:listProviders'),
    listProfiles: () => rpc('models:listProfiles'),
    saveProvider: (input) => rpc('models:saveProvider', input),
    updateProvider: (input) => rpc('models:updateProvider', input),
    testProvider: (input) => rpc('models:testProvider', input),
    saveProfile: (input) => rpc('models:saveProfile', input),
    testCapabilities: (input) => rpc('models:testCapabilities', input),
    setSlot: (input) => rpc('models:setSlot', input),
    deleteProfile: (input) => rpc('models:deleteProfile', input),
    deleteProvider: (input) => rpc('models:deleteProvider', input),
  },
  memory: {
    list: (input) => rpc('memory:list', input),
    update: (input) => rpc('memory:update', input),
    remove: (input) => rpc('memory:remove', input),
  },
  knowledge: {
    search: (input) => rpc('knowledge:search', input),
    listJobs: (input) => rpc('knowledge:listJobs', input),
    ingest: (input) => rpc('knowledge:ingest', input),
    retryJob: (input) => rpc('knowledge:retryJob', input),
    getGraph: (input) => rpc('knowledge:getGraph', input),
    getSourceDetail: (input) => rpc('knowledge:getSourceDetail', input),
    getGraphProjection: (input) => rpc('knowledge:getGraphProjection', input),
    getNodeProvenance: (input) => rpc('knowledge:getNodeProvenance', input),
    wikiList: (input) => rpc('wiki:list', input),
    wikiGet: (input) => rpc('wiki:get', input),
  },
  settings: {
    getAll: () => rpc('settings:getAll'),
    update: (input) => rpc('settings:update', input),
    saveSecret: (input) => rpc('settings:saveSecret', input),
    deleteSecret: (input) => rpc('settings:deleteSecret', input),
    exportDiagnostics: () => rpc('settings:exportDiagnostics'),
    scanSecrets: () => rpc('settings:scanSecrets'),
    listSkills: () => rpc('settings:listSkills'),
    setSkillEnabled: (input) => rpc('settings:setSkillEnabled', input),
    listMcpServers: () => rpc('settings:listMcpServers'),
    addMcpServer: (input) => rpc('settings:addMcpServer', input),
    setMcpServerEnabled: (input) => rpc('settings:setMcpServerEnabled', input),
  },
  channels: {
    list: () => rpc('channels:list'),
    save: (input) => rpc('channels:save', input),
    test: (input) => rpc('channels:test', input),
    setEnabled: (input) => rpc('channels:setEnabled', input),
  },
  events: {
    subscribe: (handler) => {
      const listener = (_event, data) => handler(data);
      ipcRenderer.on('event:dispatch', listener);
      return () => ipcRenderer.removeListener('event:dispatch', listener);
    },
    subscribeChannels: (handler) => {
      ipcRenderer.send('debug:preload', 'subscribeChannels called');
      const listener = (_event, data) => {
        ipcRenderer.send('debug:preload', 'channel:event received: ' + JSON.stringify(data));
        handler(data);
      };
      ipcRenderer.on('channel:event', listener);
      return () => ipcRenderer.removeListener('channel:event', listener);
    },
  },
});