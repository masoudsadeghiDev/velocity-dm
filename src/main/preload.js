'use strict';
// Exposes a narrow, explicit API to the renderer (no Node access in pages).

const { contextBridge, ipcRenderer } = require('electron');

const METHODS = [
  'list', 'get', 'queues', 'settings', 'setSettings', 'env', 'probe', 'nextRun',
  'add', 'start', 'pause', 'startAll', 'pauseAll', 'resumeMany', 'matchLinks', 'remove', 'restart', 'update', 'checksum',
  'startQueue', 'stopQueue', 'createQueue', 'updateQueue', 'deleteQueue', 'moveToQueue', 'reorder',
  'openFile', 'showInFolder', 'openProgress', 'chooseFolder', 'chooseSaveAs', 'takeRequest',
  'closeWindow', 'setTitle', 'openExternal', 'revealExtension', 'extensionPath',
  'grab', 'cancelGrab', 'expandBatch',
];

const EVENTS = ['added', 'removed', 'changes', 'queues', 'settings', 'totals', 'command', 'grab-progress'];

const api = {};
for (const m of METHODS) api[m] = (...args) => ipcRenderer.invoke(`vdm:${m}`, ...args);

api.on = (event, cb) => {
  if (!EVENTS.includes(event)) throw new Error(`Unknown event ${event}`);
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(`vdm:${event}`, listener);
  return () => ipcRenderer.removeListener(`vdm:${event}`, listener);
};

contextBridge.exposeInMainWorld('vdm', api);
