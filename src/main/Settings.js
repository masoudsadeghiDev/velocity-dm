'use strict';

const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const { DEFAULT_CATEGORIES, readJson, writeJsonAtomic } = require('./engine/files');

// The file types IDM captures from the browser by default.
const DEFAULT_CAPTURE_EXTS =
  '3gp 7z aac ace aif apk arj asf avi bin bz2 deb dmg exe flac flv gz gzip iso jar lzh m4a m4v mkv mov mp3 mp4 mpeg mpg msi msu ogg ogv pdf pkg ppt pptx qt r0* r1* ra rar rm rmvb rpm sea sit sitx tar tgz tif tiff wav webm wma wmv xz z zip';

function defaults() {
  return {
    downloadDir: path.join(os.homedir(), 'Downloads'),
    useCategoryFolders: true,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c, dir: '' })),
    maxConnections: 8,
    maxRetries: 8,
    timeout: 30,
    speedLimitEnabled: false,
    speedLimit: 1024, // KB/s
    userAgent: '',
    proxy: { enabled: false, host: '', port: 8080, username: '', password: '' },
    showStartDialog: true,
    showProgressWindow: true,
    showCompleteDialog: true,
    notifications: true,
    clipboardMonitor: true,
    browserIntegration: true,
    bridgePort: 9614,
    captureExts: DEFAULT_CAPTURE_EXTS,
    captureMinSizeKB: 0,
    remuxToMp4: true,
    launchAtLogin: false,
    startMinimized: false,
    confirmDelete: true,
    theme: 'system',
  };
}

class Settings extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    const stored = file ? readJson(file, {}) : {};
    this.data = { ...defaults(), ...stored, proxy: { ...defaults().proxy, ...(stored.proxy || {}) } };
    // New default categories appear for users with older settings files.
    for (const c of DEFAULT_CATEGORIES) if (!this.data.categories.some((x) => x.id === c.id)) this.data.categories.push({ ...c, dir: '' });
  }

  get() {
    return this.data;
  }

  async set(patch) {
    this.data = { ...this.data, ...patch };
    if (patch.proxy) this.data.proxy = { ...this.data.proxy, ...patch.proxy };
    this.emit('change', this.data, patch);
    if (this.file) await writeJsonAtomic(this.file, this.data);
    return this.data;
  }

  captureExtensions() {
    return this.data.captureExts
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean);
  }
}

module.exports = { Settings, defaults, DEFAULT_CAPTURE_EXTS };
