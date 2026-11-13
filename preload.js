'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  bootstrap: () => invoke('app:bootstrap'),
  snapshot: () => invoke('app:snapshot'),

  previewCapture: (payload) => invoke('capture:preview', payload),
  saveCapture: (payload) => invoke('capture:save', payload),
  pickFile: () => invoke('file:pick'),
  analyzeFile: (filePath) => invoke('file:analyze', filePath),
  importFile: (payload) => invoke('file:import', payload),

  updateItem: (id, patch) => invoke('item:update', { id, patch }),
  deleteItems: (ids) => invoke('item:delete', ids),
  recheckItem: (id, force) => invoke('item:recheck', { id, force }),
  refreshLinks: (id) => invoke('item:refreshLinks', id),
  reextract: (id) => invoke('item:reextract', id),
  findDuplicate: (payload) => invoke('item:findDuplicate', payload),
  scanAll: () => invoke('track:scanAll'),
  treeSummary: (payload) => invoke('tree:summary', payload),

  addCategory: (payload) => invoke('category:add', payload),
  updateCategory: (id, patch) => invoke('category:update', { id, patch }),
  deleteCategory: (id) => invoke('category:delete', id),

  exportMarkdown: (payload) => invoke('export:markdown', payload),
  exportBackup: () => invoke('export:backup'),
  importBackup: (payload) => invoke('import:backup', payload),

  saveSettings: (patch) => invoke('settings:save', patch),
  testLLM: (llm) => invoke('settings:testLLM', llm),

  openExternal: (url) => invoke('shell:open', url),
  openFile: (filePath) => invoke('file:open', filePath),
  readClipboard: () => invoke('clipboard:read'),
  openDataDir: () => invoke('app:openDataDir'),
  clearData: () => invoke('app:clearData'),

  onDataChanged: (cb) => ipcRenderer.on('data:changed', (e, p) => cb(p)),
  onTrackerEvent: (cb) => ipcRenderer.on('tracker:event', (e, p) => cb(p)),
  onClipboardFound: (cb) => ipcRenderer.on('clipboard:found', (e, p) => cb(p)),
  onLog: (cb) => ipcRenderer.on('log', (e, p) => cb(p)),
  onMenuAction: (cb) => ipcRenderer.on('menu:action', (e, p) => cb(p))
});
