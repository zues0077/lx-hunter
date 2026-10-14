'use strict'
const { contextBridge, ipcRenderer } = require('electron')

const api = {
  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (patch) => ipcRenderer.invoke('config:set', patch),
  serviceTest: (cfg) => ipcRenderer.invoke('service:test', cfg),
  serviceList: () => ipcRenderer.invoke('service:list'),
  serviceReconcile: (platformId, liveIds) => ipcRenderer.invoke('service:reconcile', platformId, liveIds),
  sourcesGet: () => ipcRenderer.invoke('sources:get'),
  logsGet: () => ipcRenderer.invoke('logs:get'),
  logsClear: () => ipcRenderer.invoke('logs:clear'),
  crawlStart: () => ipcRenderer.invoke('crawl:start'),
  checkStart: (ids, opts) => ipcRenderer.invoke('check:start', ids, opts),
  hashStart: (ids) => ipcRenderer.invoke('hash:start', ids),
  importStart: (ids) => ipcRenderer.invoke('import:start', ids),
  jobCancel: () => ipcRenderer.invoke('job:cancel'),
  jobState: () => ipcRenderer.invoke('job:state'),
  patrolStart: () => ipcRenderer.invoke('patrol:start'),
  revoke: (ids) => ipcRenderer.invoke('revoke', ids),
  serverSync: () => ipcRenderer.invoke('server:sync'),
  dbClear: () => ipcRenderer.invoke('db:clear'),
  dbUndedupe: () => ipcRenderer.invoke('db:undedupe'),
  dbExport: (ids) => ipcRenderer.invoke('db:export', ids),
  dbImport: () => ipcRenderer.invoke('db:import'),
  sourceValidate: (id) => ipcRenderer.invoke('source:validate', id),
  importUrl: (url, name) => ipcRenderer.invoke('import:url', url, name),
  serviceToggle: (id, enabled, owner) => ipcRenderer.invoke('service:toggle', id, enabled, owner),
  serviceRemove: (id, owner) => ipcRenderer.invoke('service:remove', id, owner),
  servicePlatforms: (id, disabledSources, owner) => ipcRenderer.invoke('service:platforms', id, disabledSources, owner),
  serviceListPublic: () => ipcRenderer.invoke('service:listPublic'),
  serviceRemovePublicBatch: (ids) => ipcRenderer.invoke('service:removePublicBatch', ids),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  onLog: (cb) => { const h = (_, e) => cb(e); ipcRenderer.on('hunter:log', h); return () => ipcRenderer.removeListener('hunter:log', h) },
  onEvent: (cb) => { const h = (_, e) => cb(e); ipcRenderer.on('hunter:event', h); return () => ipcRenderer.removeListener('hunter:event', h) }
}

contextBridge.exposeInMainWorld('api', api)
