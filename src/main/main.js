'use strict';
// Electron entry point: windows, tray, menus, IPC and OS integration.

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  Notification,
  shell,
  dialog,
  clipboard,
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Settings } = require('./Settings');
const { DownloadManager } = require('./DownloadManager');
const { Scheduler } = require('./Scheduler');
const { BrowserBridge } = require('./BrowserBridge');
const { grabSite, expandBatch } = require('./tools');
const { createClipboardWatcher } = require('./clipboardWatcher');
const { formatBytes } = require('./engine/files');

const RENDERER = path.join(__dirname, '..', 'renderer');
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const isMac = process.platform === 'darwin';

if (process.env.VDM_USER_DATA) app.setPath('userData', process.env.VDM_USER_DATA);

let settings;
let manager;
let scheduler;
let bridge;
let tray;
let mainWindow;
let quitting = false;
let powerBlocker = null;
let grabController = null;
const progressWindows = new Map();
const pendingRequests = new Map();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    showMain();
    urlsFromArgv(argv).forEach((url) => handleIncoming({ url }));
  });
  app.whenReady().then(init);
}

// ------------------------------------------------------------------ setup

let ffmpegCache;
function ffmpegPath() {
  if (ffmpegCache !== undefined) return ffmpegCache;
  const candidates = isMac
    ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
    : process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe')]
      : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  }
  ffmpegCache = candidates.find((p) => p && fs.existsSync(p)) || null;
  return ffmpegCache;
}

async function init() {
  const dataDir = app.getPath('userData');
  settings = new Settings(path.join(dataDir, 'settings.json'));
  nativeTheme.themeSource = settings.get().theme || 'system';
  manager = new DownloadManager({
    dataDir,
    settings,
    trashItem: (p) => shell.trashItem(p),
    ffmpegPath,
  }).load();

  scheduler = new Scheduler(manager);
  scheduler.start();

  bridge = new BrowserBridge({ port: settings.get().bridgePort, info: bridgeInfo });
  bridge.on('download', (req) => handleIncoming(req));
  bridge.on('media', (req) => handleIncoming(req));
  bridge.on('batch', (req) => openLinksDialog(req));
  if (settings.get().browserIntegration) await bridge.start();

  // Packaged builds get their Dock icon from the bundle; `npm start` would show Electron's.
  if (isMac && !app.isPackaged) app.dock?.setIcon(appIcon());

  wireManager();
  wireSettings();
  registerIpc();
  buildAppMenu();
  createTray();
  createMainWindow(!settings.get().startMinimized);
  startClipboardMonitor();
  setInterval(pushProgress, 500);

  urlsFromArgv(process.argv).forEach((url) => handleIncoming({ url }));
}

function bridgeInfo() {
  const s = settings.get();
  return {
    app: 'Velocity Download Manager',
    version: app.getVersion(),
    capture: s.browserIntegration,
    exts: settings.captureExtensions(),
    minSizeKB: s.captureMinSizeKB,
  };
}

function urlsFromArgv(argv) {
  return argv.slice(1).filter((a) => /^https?:\/\//i.test(a));
}

// ------------------------------------------------------------------ windows

function webPrefs() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function appIcon() {
  // macOS uses the padded grid icon; Windows/Linux taskbars look best with the full-bleed tile.
  const p = path.join(ASSETS, isMac ? 'icon.png' : 'icon-tile.png');
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : undefined;
}

function createMainWindow(show = true) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 860,
    minHeight: 480,
    show: false,
    title: 'Velocity Download Manager',
    icon: appIcon(),
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d22' : '#f4f5f7',
    webPreferences: webPrefs(),
  });
  mainWindow.loadFile(path.join(RENDERER, 'index.html'));
  mainWindow.once('ready-to-show', () => show && mainWindow.show());
  mainWindow.on('close', (e) => {
    // Like IDM, closing the window keeps downloads running in the tray.
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  hardenWindow(mainWindow);
}

function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(true);
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function openProgressWindow(id) {
  const existing = progressWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 540,
    height: 470,
    minWidth: 460,
    minHeight: 300,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    title: 'Download progress',
    icon: appIcon(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d22' : '#f4f5f7',
    webPreferences: webPrefs(),
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(RENDERER, 'progress.html'), { query: { id } });
  win.on('closed', () => progressWindows.delete(id));
  hardenWindow(win);
  progressWindows.set(id, win);
}

/** "Download File Info" dialog for links captured from the browser/clipboard. */
function openNewDownloadWindow(req) {
  const token = crypto.randomUUID();
  pendingRequests.set(token, req);
  const win = new BrowserWindow({
    width: 600,
    height: 470,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Download File Info',
    icon: appIcon(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d22' : '#f4f5f7',
    webPreferences: webPrefs(),
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(RENDERER, 'newdownload.html'), { query: { token } });
  win.on('closed', () => pendingRequests.delete(token));
  hardenWindow(win);
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  app.focus({ steal: true });
}

function handleIncoming(req) {
  if (!req?.url) return;
  if (!settings.get().showStartDialog) {
    const item = manager.add({ ...req, start: true });
    if (settings.get().showProgressWindow) openProgressWindow(item.id);
    return;
  }
  openNewDownloadWindow(req);
}

function openLinksDialog(req) {
  showMain();
  const send = () => mainWindow.webContents.send('vdm:command', { name: 'links', payload: req });
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}

function sendCommand(name, payload) {
  showMain();
  const send = () => mainWindow.webContents.send('vdm:command', { name, payload });
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

// ------------------------------------------------------------------ manager events

function wireManager() {
  manager.on('added', (item) => broadcast('vdm:added', item));
  manager.on('removed', (id) => {
    broadcast('vdm:removed', id);
    progressWindows.get(id)?.close();
  });
  manager.on('changed', (item) => broadcast('vdm:changes', [item]));
  manager.on('queues', (queues) => {
    broadcast('vdm:queues', queues);
    refreshTrayMenu();
  });

  manager.on('completed', (item) => {
    const s = settings.get();
    if (s.notifications && Notification.isSupported()) {
      const n = new Notification({ title: 'Download complete', body: `${item.fileName} (${formatBytes(item.size)})`, silent: false });
      n.on('click', () => shell.showItemInFolder(item.savePath));
      n.show();
    }
    const win = progressWindows.get(item.id);
    if (s.showCompleteDialog && !win && item.queueId == null) openProgressWindow(item.id);
    if (!s.showCompleteDialog && win) win.close();
    if (isMac && !mainWindow?.isFocused()) app.dock?.bounce('informational');
  });

  manager.on('failed', (item) => {
    if (settings.get().notifications && Notification.isSupported()) {
      new Notification({ title: 'Download failed', body: `${item.fileName}: ${item.error || 'unknown error'}` }).show();
    }
  });

  manager.on('queue-finished', (q) => {
    if (settings.get().notifications && Notification.isSupported()) {
      new Notification({ title: 'Queue finished', body: `"${q.name}" has finished processing.` }).show();
    }
    runPostAction(q.schedule?.onComplete, q);
  });
}

function pushProgress() {
  const changes = manager.drainChanges();
  if (changes.length) broadcast('vdm:changes', changes);
  const t = manager.totals();
  broadcast('vdm:totals', t);

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(t.active ? Math.max(0, t.progress) : -1);
  if (isMac) app.dock?.setBadge(t.active ? String(t.active) : '');
  tray?.setToolTip(t.active ? `Velocity DM — ${t.active} active, ${formatBytes(t.speed)}/s` : 'Velocity DM');
  if (isMac && tray) tray.setTitle(t.active ? ` ${formatBytes(t.speed)}/s` : '');

  // Keep the machine awake while downloading.
  if (t.active && powerBlocker === null) powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!t.active && powerBlocker !== null) {
    powerSaveBlocker.stop(powerBlocker);
    powerBlocker = null;
  }
}

function runPostAction(action, q) {
  if (!action || action === 'none') return;
  const label = { quit: 'quit', sleep: 'put the computer to sleep', shutdown: 'shut down the computer' }[action];
  if (!label) return;
  const go = () => {
    if (action === 'quit') return app.quit();
    const cmds = {
      darwin: { sleep: ['pmset', ['sleepnow']], shutdown: ['osascript', ['-e', 'tell app "System Events" to shut down']] },
      win32: { sleep: ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']], shutdown: ['shutdown', ['/s', '/t', '0']] },
      linux: { sleep: ['systemctl', ['suspend']], shutdown: ['systemctl', ['poweroff']] },
    }[process.platform]?.[action];
    if (cmds) execFile(cmds[0], cmds[1], () => {});
  };
  const timer = setTimeout(go, 60000);
  dialog
    .showMessageBox({
      type: 'warning',
      message: `Queue "${q.name}" has finished`,
      detail: `Velocity DM will ${label} in 60 seconds.`,
      buttons: ['Cancel', `${action === 'quit' ? 'Quit' : action === 'sleep' ? 'Sleep' : 'Shut down'} now`],
      defaultId: 0,
      cancelId: 0,
    })
    .then(({ response }) => {
      clearTimeout(timer);
      if (response === 1) go();
    });
}

function wireSettings() {
  settings.on('change', async (s, patch) => {
    if ('browserIntegration' in patch || 'bridgePort' in patch) {
      if (s.browserIntegration) await bridge.restart(s.bridgePort);
      else bridge.stop();
    }
    if ('launchAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin, openAsHidden: true });
    if ('theme' in patch) nativeTheme.themeSource = s.theme;
    broadcast('vdm:settings', s);
    refreshTrayMenu();
  });
}

// ------------------------------------------------------------------ clipboard

function captureMatcher() {
  const exts = settings.captureExtensions();
  const res = exts.map((e) => new RegExp('^' + e.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));
  return (ext) => res.some((r) => r.test(ext));
}

function startClipboardMonitor() {
  createClipboardWatcher({
    read: () => clipboard.readText(),
    enabled: () => settings.get().clipboardMonitor,
    accepts: (ext) => captureMatcher()(ext),
    onLink: (url) => handleIncoming({ url, source: 'clipboard' }),
  }).start(1000);
}

// ------------------------------------------------------------------ tray & menus

function createTray() {
  const p = path.join(ASSETS, isMac ? 'trayTemplate.png' : 'tray.png');
  const img = fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
  if (isMac) img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Velocity DM');
  if (img.isEmpty()) tray.setTitle('VDM');
  tray.on('click', () => !isMac && showMain());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray || !manager) return;
  const s = settings.get();
  const main = manager.queues.find((q) => q.id === 'main');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Velocity DM', click: showMain },
      { label: 'Add URL…', click: () => sendCommand('add-url') },
      { type: 'separator' },
      main?.running
        ? { label: 'Stop Main Queue', click: () => manager.stopQueue('main') }
        : { label: 'Start Main Queue', click: () => manager.startQueue('main') },
      { label: 'Resume All Downloads', click: () => sendCommand('resume-all') },
      { label: 'Stop All Downloads', click: () => manager.pauseAll() },
      { type: 'separator' },
      {
        label: `Speed Limiter (${s.speedLimit} KB/s)`,
        type: 'checkbox',
        checked: s.speedLimitEnabled,
        click: (mi) => settings.set({ speedLimitEnabled: mi.checked }),
      },
      { label: 'Monitor Clipboard', type: 'checkbox', checked: s.clipboardMonitor, click: (mi) => settings.set({ clipboardMonitor: mi.checked }) },
      { label: 'Browser Integration', type: 'checkbox', checked: s.browserIntegration, click: (mi) => settings.set({ browserIntegration: mi.checked }) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function buildAppMenu() {
  const cmd = (name) => () => sendCommand(name);
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Options…', accelerator: 'Cmd+,', click: cmd('options') },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'Tasks',
      submenu: [
        { label: 'Add URL…', accelerator: 'CmdOrCtrl+N', click: cmd('add-url') },
        { label: 'Add Batch Download…', accelerator: 'CmdOrCtrl+B', click: cmd('batch') },
        { label: 'Add Batch Download from Clipboard', accelerator: 'CmdOrCtrl+Shift+B', click: cmd('batch-clipboard') },
        { label: 'Site Grabber…', accelerator: 'CmdOrCtrl+G', click: cmd('grabber') },
        { type: 'separator' },
        { label: 'Import Links from Text File…', click: () => importLinks() },
        { label: 'Export Download List…', click: () => exportList() },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'Options…', accelerator: 'Ctrl+,', click: cmd('options') }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Downloads',
      submenu: [
        { label: 'Resume', accelerator: 'CmdOrCtrl+R', click: cmd('resume') },
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: cmd('stop') },
        { label: 'Resume All', accelerator: 'CmdOrCtrl+Shift+R', click: cmd('resume-all') },
        { label: 'Refresh Links and Resume…', click: cmd('refresh-links') },
        { label: 'Stop All', accelerator: 'CmdOrCtrl+Shift+.', click: () => manager.pauseAll() },
        { type: 'separator' },
        { label: 'Delete', click: cmd('delete') },
        { label: 'Delete All Completed', click: cmd('delete-completed') },
        { type: 'separator' },
        { label: 'Speed Limiter', type: 'checkbox', checked: settings.get().speedLimitEnabled, click: (mi) => settings.set({ speedLimitEnabled: mi.checked }) },
      ],
    },
    {
      label: 'Queues',
      submenu: [
        { label: 'Start Main Queue', click: () => manager.startQueue('main') },
        { label: 'Stop Main Queue', click: () => manager.stopQueue('main') },
        { type: 'separator' },
        { label: 'Scheduler…', accelerator: 'CmdOrCtrl+K', click: cmd('scheduler') },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Browser Extension Setup', click: cmd('extension-help') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function importLinks() {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Text', extensions: ['txt', 'csv', 'html', 'htm'] }] });
  if (r.canceled || !r.filePaths[0]) return;
  const text = fs.readFileSync(r.filePaths[0], 'utf8');
  const links = [...new Set(text.match(/https?:\/\/[^\s"'<>]+/gi) || [])].map((url) => ({ url }));
  if (links.length) openLinksDialog({ links });
}

async function exportList() {
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: 'downloads.txt' });
  if (r.canceled || !r.filePath) return;
  fs.writeFileSync(r.filePath, manager.list().map((i) => i.url).join('\n') + '\n');
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  const h = (name, fn) => ipcMain.handle(`vdm:${name}`, (_e, ...args) => fn(...args));
  const he = (name, fn) => ipcMain.handle(`vdm:${name}`, (e, ...args) => fn(e, ...args)); // needs the sender
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  h('list', () => manager.list());
  h('get', (id) => manager.get(id));
  h('queues', () => manager.getQueues());
  h('settings', () => settings.get());
  h('setSettings', (patch) => settings.set(patch));
  h('env', () => ({ platform: process.platform, version: app.getVersion(), ffmpeg: !!ffmpegPath(), bridgeListening: !!bridge?.server }));
  h('probe', (url, extra) => manager.probe(url, extra));
  h('nextRun', (queueId) => scheduler.nextRun(manager.queues.find((q) => q.id === queueId) || {}));

  h('add', (opts) => {
    const item = manager.add(opts);
    if (opts.start && settings.get().showProgressWindow) openProgressWindow(item.id);
    return item;
  });
  h('start', (id) => {
    const ok = manager.start(id);
    if (ok && settings.get().showProgressWindow) openProgressWindow(id);
    return ok;
  });
  h('pause', (id) => manager.pause(id));
  h('startAll', () => manager.startAll());
  h('resumeMany', (ids, urls) => manager.resumeMany(ids, urls));
  h('matchLinks', (ids, urls) => manager.matchLinks(ids, urls));
  h('pauseAll', () => manager.pauseAll());
  h('remove', (id, opts) => manager.remove(id, opts));
  h('restart', (id) => manager.restart(id));
  h('update', (id, patch) => manager.update(id, patch));
  h('checksum', (id, algo) => manager.checksum(id, algo));

  h('startQueue', (id) => manager.startQueue(id));
  h('stopQueue', (id) => manager.stopQueue(id));
  h('createQueue', (name) => manager.createQueue(name));
  h('updateQueue', (id, patch) => manager.updateQueue(id, patch));
  h('deleteQueue', (id) => manager.deleteQueue(id));
  h('moveToQueue', (itemId, queueId) => manager.moveToQueue(itemId, queueId));
  h('reorder', (itemId, delta) => manager.reorder(itemId, delta));

  h('openFile', async (id) => {
    const it = manager.get(id);
    if (it?.status === 'completed') return shell.openPath(it.savePath);
  });
  h('showInFolder', (id) => {
    const it = manager.get(id);
    if (!it) return;
    if (fs.existsSync(it.savePath)) shell.showItemInFolder(it.savePath);
    else shell.openPath(path.dirname(it.savePath));
  });
  h('openProgress', (id) => openProgressWindow(id));
  he('chooseFolder', async (e, defaultPath) => {
    const r = await dialog.showOpenDialog(winOf(e), { properties: ['openDirectory', 'createDirectory'], defaultPath });
    return r.canceled ? null : r.filePaths[0];
  });
  he('chooseSaveAs', async (e, defaultPath) => {
    const r = await dialog.showSaveDialog(winOf(e), { defaultPath });
    return r.canceled ? null : r.filePath;
  });
  h('takeRequest', (token) => pendingRequests.get(token) || null);
  he('closeWindow', (e) => winOf(e)?.close());
  he('setTitle', (e, title) => winOf(e)?.setTitle(title));
  h('openExternal', (url) => /^https?:/i.test(url) && shell.openExternal(url));
  h('revealExtension', () => shell.openPath(extensionDir()));
  h('extensionPath', () => extensionDir());

  he('grab', async (e, opts) => {
    grabController?.abort();
    grabController = new AbortController();
    const s = settings.get();
    return grabSite({
      ...opts,
      proxy: s.proxy,
      timeout: s.timeout * 1000,
      signal: grabController.signal,
      onProgress: (p) => !e.sender.isDestroyed() && e.sender.send('vdm:grab-progress', p),
    });
  });
  h('cancelGrab', () => grabController?.abort());
  h('expandBatch', (template, from, to, width) => expandBatch(template, from, to, width));
}

function extensionDir() {
  const packaged = path.join(process.resourcesPath || '', 'extension');
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, '..', '..', 'extension');
}

// ------------------------------------------------------------------ app lifecycle

app.on('activate', () => showMain());

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  scheduler?.stop();
  bridge?.stop();
  // Pause running downloads cleanly so they can resume next launch.
  (manager ? manager.stopEverything() : Promise.resolve()).finally(() => app.quit());
});

// Ctrl+C / kill from a terminal: quit through the normal path so state is saved.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.quit());

app.on('window-all-closed', () => {
  // Stay alive in the tray/menu bar.
});
