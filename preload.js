const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  list: opts => ipcRenderer.invoke('vault:list', opts),
  get: id => ipcRenderer.invoke('vault:get', id),
  delete: id => ipcRenderer.invoke('vault:delete', id),
  pin: id => ipcRenderer.invoke('vault:pin', id),
  update: (id, fields) => ipcRenderer.invoke('vault:update', id, fields),
  versions: id => ipcRenderer.invoke('vault:versions', id),
  restoreVersion: vid => ipcRenderer.invoke('vault:restore-version', vid),
  deleteVersion: vid => ipcRenderer.invoke('vault:delete-version', vid),
  revision: () => ipcRenderer.invoke('vault:revision'),
  stats: () => ipcRenderer.invoke('vault:stats'),
  copy: text => ipcRenderer.invoke('vault:copy', text),
  train: (id, label) => ipcRenderer.invoke('vault:train', id, label),
  trainStats: () => ipcRenderer.invoke('vault:train-stats'),
  trainLabels: () => ipcRenderer.invoke('vault:train-labels'),
  phrases: () => ipcRenderer.invoke('vault:phrases'),
  optimalPrompt: () => ipcRenderer.invoke('vault:optimal-prompt'),
  shareImage: (base64, promptId) => ipcRenderer.invoke('vault:share-image', base64, promptId),
  recentCaptures: (limit) => ipcRenderer.invoke('vault:recent-captures', limit),
  saveRecent: (id) => ipcRenderer.invoke('vault:save-recent', id),
  deleteRecent: (id) => ipcRenderer.invoke('vault:delete-recent', id),
  reanalyze: () => ipcRenderer.invoke('vault:reanalyze'),
  trainingStatus: () => ipcRenderer.invoke('vault:training-status'),
  onChanged: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('vault:changed', fn);
    return () => ipcRenderer.removeListener('vault:changed', fn);
  }
});

contextBridge.exposeInMainWorld('picker', {
  search: q => ipcRenderer.invoke('picker:search', q),
  copy: (id, paste) => ipcRenderer.invoke('picker:copy', id, paste),
  close: () => ipcRenderer.invoke('picker:close')
});

contextBridge.exposeInMainWorld('popup', {
  onData: cb => ipcRenderer.on('popup:data', (_e, d) => cb(d)),
  onCursor: cb => ipcRenderer.on('popup:cursor', (_e, d) => cb(d)),
  setIgnoreMouse: ignore => ipcRenderer.invoke('popup:setIgnoreMouse', ignore),
  save: overrides => ipcRenderer.invoke('popup:save', overrides),
  skip: () => ipcRenderer.invoke('popup:skip'),
  openVault: () => ipcRenderer.invoke('popup:openVault'),
  enterEditor: () => ipcRenderer.invoke('popup:enterEditor')
});
