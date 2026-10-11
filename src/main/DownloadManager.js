'use strict';
// Owns every download: creation, start/pause, queues, persistence and events.
// Pure Node (no Electron) so it can be tested headlessly.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { HttpDownload, humanError } = require('./engine/HttpDownload');
const { HlsDownload } = require('./engine/HlsDownload');
const { SpeedLimiter } = require('./engine/limiter');
const { request, fetchBuffer, parseContentRange } = require('./engine/http');
const { isMaster, parseMaster } = require('./engine/m3u8');
const { linkExpiry, matchNewLinks } = require('./engine/links');
const {
  categoryFor,
  resolveFileName,
  sanitizeFileName,
  fileNameFromUrl,
  uniquePath,
  writeJsonAtomic,
  readJson,
  extOf,
} = require('./engine/files');

const ACTIVE = new Set(['connecting', 'downloading', 'finishing']);
// Failures that a fresh link (not a retry) fixes: expired or revoked signed links.
const LINK_ERROR = /HTTP (401|403|404|410)\b|link has expired/i;
const EXPIRED_MSG = 'The download link has expired. Use "Resume All" to paste a new link and continue.';
const PERSIST_KEYS = [
  'id', 'url', 'finalUrl', 'type', 'fileName', 'savePath', 'tempPath', 'fileNameLocked', 'suggestedName', 'category',
  'size', 'downloaded', 'resumable', 'status', 'error', 'mime', 'etag', 'lastModified', 'segments', 'hls', 'hlsVariant',
  'referer', 'cookies', 'userAgent', 'auth', 'description', 'queueId', 'maxConnections', 'speedLimit', 'addedAt',
  'completedAt', 'lastTry', 'sizeEstimated', 'hlsProgress', 'duration', 'pageTitle', 'autoCategory',
];

function isHlsUrl(url, mime) {
  return /mpegurl/i.test(mime || '') || /\.m3u8(\?|#|$)/i.test(url);
}

class DownloadManager extends EventEmitter {
  /**
   * @param {object} opts
   *   dataDir: where downloads.json / queues.json live
   *   settings: Settings instance ({get(), on('change')})
   *   trashItem(path): moves a finished file to the trash (Electron shell)
   *   ffmpegPath(): path to ffmpeg or null
   */
  constructor({ dataDir, settings, trashItem, ffmpegPath }) {
    super();
    this.dataDir = dataDir;
    this.settings = settings;
    this.trashItem = trashItem || (async () => {});
    this.ffmpegPath = ffmpegPath || (() => null);
    this.items = new Map();
    this.tasks = new Map(); // id -> HttpDownload | HlsDownload
    this.itemLimiters = new Map();
    this.globalLimiter = new SpeedLimiter(0);
    this.queues = [];
    this._dirty = new Set();
    this._saveTimer = null;
    this._applySettings();
    settings.on?.('change', () => this._applySettings());
  }

  get cfg() {
    return this.settings.get();
  }

  _applySettings() {
    const s = this.cfg;
    this.globalLimiter.setRate(s.speedLimitEnabled ? s.speedLimit * 1024 : 0);
    for (const t of this.tasks.values()) t.rebalance();
  }

  // ------------------------------------------------------------ persistence

  load() {
    const list = readJson(path.join(this.dataDir, 'downloads.json'), []);
    for (const raw of list) {
      // Anything that was running when the app quit is now paused (resumable).
      if (ACTIVE.has(raw.status) || raw.status === 'queued') raw.status = 'paused';
      this.items.set(raw.id, raw);
    }
    this.queues = readJson(path.join(this.dataDir, 'queues.json'), null) || [
      { id: 'main', name: 'Main Download Queue', maxConcurrent: 2, items: [], schedule: defaultSchedule() },
    ];
    for (const q of this.queues) {
      q.running = false;
      q.items = q.items.filter((id) => this.items.has(id));
      q.schedule = { ...defaultSchedule(), ...(q.schedule || {}) };
    }
    return this;
  }

  _serialize(item) {
    const out = {};
    for (const k of PERSIST_KEYS) if (item[k] !== undefined) out[k] = item[k];
    if (out.segments) out.segments = out.segments.map(({ inflight, ...s }) => s);
    return out;
  }

  /** Saves are serialized and coalesced: at most one write in flight plus one pending. */
  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (this._savePending) return this._savePending;
    const run = async () => {
      this._savePending = null;
      const list = [...this.items.values()].map((i) => this._serialize(i));
      const queues = this.queues.map(({ running, retries, ...q }) => q);
      await Promise.all([
        writeJsonAtomic(path.join(this.dataDir, 'downloads.json'), list),
        writeJsonAtomic(path.join(this.dataDir, 'queues.json'), queues),
      ]).catch((err) => console.error('save failed', err));
    };
    this._savePending = (this._saveChain || Promise.resolve()).then(run);
    this._saveChain = this._savePending;
    return this._savePending;
  }

  saveSoon(ms = 1500) {
    if (!this._saveTimer) this._saveTimer = setTimeout(() => this.save(), ms);
  }

  // ------------------------------------------------------------ public view

  toPublic(item) {
    const t = this.tasks.get(item.id);
    const stats = t ? t.stats : { speed: 0, eta: -1, connections: 0 };
    return {
      id: item.id,
      url: item.url,
      finalUrl: item.finalUrl,
      type: item.type,
      fileName: item.fileName,
      savePath: item.savePath,
      category: item.category,
      size: item.size,
      sizeEstimated: !!item.sizeEstimated,
      downloaded: item.downloaded,
      status: item.status,
      error: this._errorText(item),
      lastError: item.lastError,
      resumable: item.resumable,
      queueId: item.queueId,
      description: item.description || '',
      referer: item.referer || '',
      addedAt: item.addedAt,
      completedAt: item.completedAt,
      lastTry: item.lastTry,
      maxConnections: item.maxConnections || null,
      speedLimit: item.speedLimit || 0,
      hlsProgress: item.hlsProgress,
      hlsVariant: item.hls?.variant || null,
      duration: item.duration,
      segments: item.type === 'hls' ? [] : (item.segments || []).map((s) => [s.start, s.end, s.downloaded, t?.workers?.has(s) ? 1 : 0]),
      speed: stats.speed,
      eta: stats.eta,
      connections: stats.connections,
      auth: item.auth ? { username: item.auth.username } : null,
      linkExpiresAt: linkExpiry(item.url),
      needsNewLink: item.status === 'failed' && LINK_ERROR.test(item.error || ''),
    };
  }

  _errorText(item) {
    if (item.status !== 'failed' || !item.error) return item.error;
    const exp = linkExpiry(item.url);
    return exp && exp < Date.now() && LINK_ERROR.test(item.error) ? EXPIRED_MSG : item.error;
  }

  list() {
    return [...this.items.values()].map((i) => this.toPublic(i));
  }

  get(id) {
    const it = this.items.get(id);
    return it ? this.toPublic(it) : null;
  }

  getQueues() {
    return this.queues.map((q) => ({ ...q, items: q.items.slice() }));
  }

  _changed(item) {
    this._dirty.add(item.id);
    this.emit('changed', this.toPublic(item));
  }

  // ------------------------------------------------------------ paths

  dirForCategory(category) {
    const s = this.cfg;
    const cat = s.categories.find((c) => c.id === category);
    if (cat?.dir) return cat.dir;
    if (!s.useCategoryFolders || category === 'general') return s.downloadDir;
    return path.join(s.downloadDir, cat?.name || 'General');
  }

  _reservedPaths(exceptId) {
    const set = new Set();
    for (const it of this.items.values()) if (it.id !== exceptId && it.status !== 'completed') set.add(it.savePath);
    return set;
  }

  /** The server revealed the real file name: re-categorise unless the user chose the folder. */
  _serverNamed(item, fileName) {
    if (item.autoCategory) {
      item.category = categoryFor(fileName, this.cfg.categories);
      return uniquePath(this.dirForCategory(item.category), sanitizeFileName(fileName), this._reservedPaths(item.id));
    }
    return this.resolveSavePath(item, fileName);
  }

  resolveSavePath(item, fileName) {
    const dir = path.dirname(item.savePath);
    return uniquePath(dir, sanitizeFileName(fileName), this._reservedPaths(item.id));
  }

  // ------------------------------------------------------------ probing

  /** Fetches name/size/resume info without downloading (Add URL dialog). */
  async probe(url, extra = {}) {
    const s = this.cfg;
    const headers = {};
    if (extra.referer) headers.Referer = extra.referer;
    if (extra.cookies) headers.Cookie = extra.cookies;
    if (extra.userAgent || s.userAgent) headers['User-Agent'] = extra.userAgent || s.userAgent;
    const opts = { headers, proxy: s.proxy, timeout: s.timeout * 1000, auth: extra.auth };

    if (isHlsUrl(url, extra.mime)) return this._probeHls(url, opts, extra);
    const { res, url: finalUrl, status, headers: h } = await request(url, { ...opts, range: 'bytes=0-0' });
    res.destroy();
    if (status >= 400) throw new Error(`Server returned HTTP ${status}`);
    const mime = String(h['content-type'] || '').split(';')[0];
    if (isHlsUrl(finalUrl, mime)) return this._probeHls(url, opts, extra);
    let size = -1;
    let resumable = false;
    if (status === 206) {
      const cr = parseContentRange(h['content-range']);
      size = cr ? cr.total : -1;
      resumable = size >= 0;
    } else if (h['content-length']) size = Number(h['content-length']);
    const fileName = resolveFileName({ url: finalUrl, headers: h, suggested: extra.fileName });
    return { type: 'http', url, finalUrl, fileName, size, resumable, mime, category: categoryFor(fileName, s.categories) };
  }

  async _probeHls(url, opts, extra) {
    const { body, url: finalUrl } = await fetchBuffer(url, opts);
    const text = body.toString('utf8');
    let variants = [];
    if (isMaster(text)) variants = parseMaster(text, finalUrl).variants.map((v) => ({ url: v.url, name: v.name, bandwidth: v.bandwidth }));
    const fileName = this._hlsName(url, extra.title || extra.fileName);
    return { type: 'hls', url, finalUrl, fileName, size: -1, resumable: true, mime: 'application/vnd.apple.mpegurl', variants, category: 'video' };
  }

  _hlsName(url, title) {
    let base = title ? sanitizeFileName(title) : fileNameFromUrl(url).replace(/\.m3u8$/i, '');
    if (!base || /^(index|playlist|master|manifest|chunklist.*)$/i.test(base)) base = title ? base : 'video';
    base = base.replace(/\.(m3u8|mp4|ts)$/i, '');
    return sanitizeFileName(`${base}.${this.ffmpegPath() && this.cfg.remuxToMp4 !== false ? 'mp4' : 'ts'}`);
  }

  // ------------------------------------------------------------ CRUD

  /**
   * @param {object} o url, fileName, saveDir, category, referer, cookies, userAgent, auth,
   *                   description, queueId, start(bool), type, mime, hlsVariant, title, maxConnections
   */
  add(o) {
    if (!o.url || !/^https?:\/\//i.test(o.url)) throw new Error('Only http(s) addresses can be downloaded');
    const s = this.cfg;
    const type = o.type || (isHlsUrl(o.url, o.mime) ? 'hls' : 'http');
    let fileName = o.fileName ? sanitizeFileName(o.fileName) : '';
    if (type === 'hls' && (!fileName || /\.m3u8$/i.test(fileName))) fileName = this._hlsName(o.url, o.title || fileName.replace(/\.m3u8$/i, ''));
    if (!fileName) fileName = sanitizeFileName(fileNameFromUrl(o.url) || 'download');
    const category = o.category || (type === 'hls' ? 'video' : categoryFor(fileName, s.categories));
    const dir = o.saveDir || this.dirForCategory(category);
    const id = crypto.randomUUID();
    const item = {
      id,
      url: o.url,
      type,
      fileName,
      suggestedName: o.fileName || null,
      fileNameLocked: !!o.fileName,
      savePath: uniquePath(dir, fileName, this._reservedPaths()),
      category,
      autoCategory: !o.category && !o.saveDir,
      size: o.size > 0 ? o.size : -1,
      downloaded: 0,
      resumable: null,
      status: 'paused',
      error: null,
      referer: o.referer || null,
      cookies: o.cookies || null,
      userAgent: o.userAgent || null,
      auth: o.auth?.username ? o.auth : null,
      description: o.description || '',
      hlsVariant: o.hlsVariant || null,
      pageTitle: o.title || null,
      maxConnections: o.maxConnections || null,
      queueId: o.queueId || null,
      addedAt: Date.now(),
      segments: [],
    };
    item.fileName = path.basename(item.savePath);
    this.items.set(id, item);
    if (item.queueId) this._queue(item.queueId)?.items.push(id);
    this.emit('added', this.toPublic(item));
    this.save();
    if (o.start) this.start(id);
    else if (item.queueId && this._queue(item.queueId)?.running) {
      item.status = 'queued';
      this._pumpQueues();
    }
    return this.toPublic(item);
  }

  start(id) {
    const item = this.items.get(id);
    if (!item || item.status === 'completed') return false;
    const running = this.tasks.get(id);
    if (running) {
      // Paused (or failed) a moment ago and still winding down: start again once it has stopped.
      if (!running.stopped) return false;
      item._run = (item._run || 0) + 1; // supersede the run that is winding down
      item.status = 'connecting';
      item.error = null;
      this._changed(item);
      const later = () => (this.tasks.has(id) ? setTimeout(later, 20) : this.start(id));
      later();
      return true;
    }
    const ctx = {
      options: () => ({
        maxConnections: this.cfg.maxConnections,
        timeout: this.cfg.timeout,
        retries: this.cfg.maxRetries,
        proxy: this.cfg.proxy,
        userAgent: this.cfg.userAgent,
        remuxToMp4: this.cfg.remuxToMp4,
      }),
      limiters: [this._itemLimiter(item), this.globalLimiter],
      resolveSavePath: (it, name) => this.resolveSavePath(it, name),
      serverNamed: (it, name) => this._serverNamed(it, name),
      ffmpegPath: this.ffmpegPath,
    };
    const Task = item.type === 'hls' ? HlsDownload : HttpDownload;
    const task = new Task(item, ctx);
    this.tasks.set(id, task);
    item.lastTry = Date.now();
    item.lastError = null;
    task.on('status', () => {
      this._changed(item);
      this.save();
    });
    task.on('renamed', () => this._changed(item));
    task.on('progress', () => {
      this._dirty.add(id);
      this.saveSoon();
    });
    task.on('connections', () => this._dirty.add(id));

    // A newer run (e.g. resumed while this one was still winding down) owns the item's
    // state from then on; this run's late completion must not overwrite it.
    const run = (item._run = (item._run || 0) + 1);
    const superseded = () => item._run !== run;
    const release = () => this.tasks.get(id) === task && this.tasks.delete(id);
    task
      .start()
      .then((result) => {
        release();
        if (superseded()) return;
        this._changed(item);
        if (result === 'completed') this.emit('completed', this.toPublic(item));
      })
      .catch((err) => {
        release();
        if (superseded()) return;
        item.status = 'failed';
        item.error = item.error || humanError(err);
        this._changed(item);
        this.emit('failed', this.toPublic(item));
      })
      .finally(() => {
        this.save();
        this._pumpQueues();
      });
    this._changed(item);
    return true;
  }

  _itemLimiter(item) {
    let l = this.itemLimiters.get(item.id);
    if (!l) {
      l = new SpeedLimiter(0);
      this.itemLimiters.set(item.id, l);
    }
    l.setRate((item.speedLimit || 0) * 1024);
    return l;
  }

  pause(id) {
    const item = this.items.get(id);
    if (!item) return;
    const t = this.tasks.get(id);
    if (t) t.pause();
    else if (item.status === 'queued') {
      item.status = 'paused';
      this._changed(item);
    }
  }

  pauseAll() {
    for (const q of this.queues) q.running = false;
    for (const item of this.items.values()) this.pause(item.id);
    this.emit('queues', this.getQueues());
  }

  /** Which of these downloads a list of fresh links belongs to (by file name). */
  matchLinks(ids, urls) {
    const items = ids.map((id) => this.items.get(id)).filter(Boolean);
    return matchNewLinks(items, urls.filter((u) => /^https?:\/\//i.test(u)));
  }

  /**
   * Resumes many downloads at once, swapping in fresh links where given (id → url).
   * Downloads that belong to a queue go back through it, so its "at a time" limit holds.
   * @returns {number} how many were resumed
   */
  resumeMany(ids, urls = {}) {
    const queues = new Set();
    let n = 0;
    for (const id of ids) {
      const it = this.items.get(id);
      if (!it || it.status === 'completed' || (this.tasks.has(id) && !this.tasks.get(id).stopped)) continue;
      const fresh = urls[id];
      if (fresh && fresh !== it.url && /^https?:\/\//i.test(fresh)) {
        it.url = fresh;
        it.finalUrl = null;
        if (it.hls) it.hls.stale = true;
      }
      it.error = null;
      const q = it.queueId && this._queue(it.queueId);
      if (q) {
        it.status = 'queued';
        this._changed(it);
        queues.add(q);
      } else this.start(id);
      n++;
    }
    for (const q of queues) {
      if (!q.running) {
        q.running = true;
        q.retries = {};
      }
    }
    if (queues.size) {
      this.emit('queues', this.getQueues());
      this._pumpQueues();
    }
    this.save();
    return n;
  }

  startAll() {
    for (const item of this.items.values()) if (item.status === 'paused' || item.status === 'failed') this.start(item.id);
  }

  /** Waits for every running download to stop (used on app quit). */
  async stopEverything() {
    const running = [...this.tasks.entries()];
    for (const [, t] of running) t.pause();
    await Promise.race([
      new Promise((resolve) => {
        const check = () => (this.tasks.size === 0 ? resolve() : setTimeout(check, 50));
        check();
      }),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    await this.save();
  }

  async remove(id, { deleteFile = false } = {}) {
    const item = this.items.get(id);
    if (!item) return;
    const t = this.tasks.get(id);
    if (t) {
      t.pause();
      await new Promise((resolve) => {
        const check = () => (!this.tasks.has(id) ? resolve() : setTimeout(check, 30));
        check();
      });
    }
    await this._removeTemp(item);
    if (deleteFile && item.status === 'completed' && fs.existsSync(item.savePath)) {
      await this.trashItem(item.savePath).catch(() => {});
    }
    this.items.delete(id);
    this.itemLimiters.delete(id);
    for (const q of this.queues) q.items = q.items.filter((x) => x !== id);
    this.emit('removed', id);
    this.save();
  }

  async _removeTemp(item) {
    // These are our own partial files (.vdm / .vdm.parts), never user files.
    const temp = item.tempPath || item.savePath + '.vdm';
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    await fs.promises.rm(item.savePath + '.vdm.parts', { recursive: true, force: true }).catch(() => {});
  }

  /** Discards partial data and downloads from scratch. */
  async restart(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (this.tasks.has(id)) {
      this.tasks.get(id).pause();
      await new Promise((resolve) => {
        const check = () => (!this.tasks.has(id) ? resolve() : setTimeout(check, 30));
        check();
      });
    }
    await this._removeTemp(item);
    Object.assign(item, { segments: [], downloaded: 0, size: -1, resumable: null, hls: null, error: null, status: 'paused', completedAt: null });
    // A previously finished file stays where it is; the new copy gets a free name.
    item.savePath = this.resolveSavePath(item, item.fileName);
    item.fileName = path.basename(item.savePath);
    this.start(id);
  }

  /** Properties dialog: rename, new address, per-download limits, description, credentials. */
  update(id, patch) {
    const item = this.items.get(id);
    if (!item) return null;
    const running = this.tasks.has(id);
    if (patch.url && patch.url !== item.url) {
      item.url = patch.url;
      item.finalUrl = null;
      if (item.hls) item.hls.stale = true; // re-resolve the playlist, keep finished segments
    }
    if (patch.fileName && patch.fileName !== item.fileName && !running && item.status !== 'completed' && item.downloaded === 0) {
      item.fileName = sanitizeFileName(patch.fileName);
      item.savePath = this.resolveSavePath(item, item.fileName);
      item.fileName = path.basename(item.savePath);
      item.fileNameLocked = true;
      item.suggestedName = item.fileName;
    }
    if (patch.saveDir && !running && item.downloaded === 0 && item.status !== 'completed') {
      item.savePath = uniquePath(patch.saveDir, item.fileName, this._reservedPaths(item.id));
    }
    for (const k of ['description', 'referer', 'cookies', 'userAgent', 'category']) if (k in patch) item[k] = patch[k];
    if ('maxConnections' in patch) item.maxConnections = Number(patch.maxConnections) || null;
    if ('speedLimit' in patch) {
      item.speedLimit = Number(patch.speedLimit) || 0;
      this._itemLimiter(item);
    }
    if ('auth' in patch) item.auth = patch.auth?.username ? patch.auth : null;
    if ('queueId' in patch) this.moveToQueue(id, patch.queueId);
    this.tasks.get(id)?.rebalance();
    this._changed(item);
    this.save();
    return this.toPublic(item);
  }

  /** Recomputes a SHA/MD5 checksum of a finished file. */
  checksum(id, algorithm = 'sha256') {
    const item = this.items.get(id);
    if (!item || item.status !== 'completed') return Promise.reject(new Error('Download is not complete'));
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(algorithm);
      fs.createReadStream(item.savePath)
        .on('error', reject)
        .on('data', (d) => hash.update(d))
        .on('end', () => resolve(hash.digest('hex')));
    });
  }

  // ------------------------------------------------------------ queues

  _queue(id) {
    return this.queues.find((q) => q.id === id);
  }

  createQueue(name) {
    const q = { id: crypto.randomUUID(), name: name || 'New Queue', maxConcurrent: 1, items: [], running: false, schedule: defaultSchedule() };
    this.queues.push(q);
    this.save();
    this.emit('queues', this.getQueues());
    return q;
  }

  updateQueue(id, patch) {
    const q = this._queue(id);
    if (!q) return;
    if (patch.name) q.name = patch.name;
    if (patch.maxConcurrent) q.maxConcurrent = Math.max(1, Math.min(20, Number(patch.maxConcurrent)));
    if (patch.schedule) q.schedule = { ...q.schedule, ...patch.schedule };
    if (Array.isArray(patch.items)) q.items = patch.items.filter((x) => this.items.has(x));
    this.save();
    this.emit('queues', this.getQueues());
    this._pumpQueues();
  }

  deleteQueue(id) {
    if (id === 'main') return;
    const q = this._queue(id);
    if (!q) return;
    this.stopQueue(id);
    for (const itemId of q.items) {
      const it = this.items.get(itemId);
      if (it) it.queueId = null;
    }
    this.queues = this.queues.filter((x) => x.id !== id);
    this.save();
    this.emit('queues', this.getQueues());
  }

  moveToQueue(itemId, queueId) {
    const item = this.items.get(itemId);
    if (!item) return;
    for (const q of this.queues) q.items = q.items.filter((x) => x !== itemId);
    item.queueId = queueId || null;
    if (queueId) this._queue(queueId)?.items.push(itemId);
    if (item.status === 'queued' && !this._queue(queueId)?.running) item.status = 'paused';
    this._changed(item);
    this.emit('queues', this.getQueues());
    this.save();
  }

  /** Moves an item up/down inside its queue (delta = -1 / +1). */
  reorder(itemId, delta) {
    const item = this.items.get(itemId);
    const q = item && this._queue(item.queueId);
    if (!q) return;
    const i = q.items.indexOf(itemId);
    const j = Math.max(0, Math.min(q.items.length - 1, i + delta));
    if (i < 0 || i === j) return;
    q.items.splice(i, 1);
    q.items.splice(j, 0, itemId);
    this.save();
    this.emit('queues', this.getQueues());
  }

  startQueue(id) {
    const q = this._queue(id);
    if (!q) return;
    q.running = true;
    q.retries = {};
    for (const itemId of q.items) {
      const it = this.items.get(itemId);
      if (it && (it.status === 'paused' || it.status === 'failed')) {
        it.status = 'queued';
        this._changed(it);
      }
    }
    this.emit('queues', this.getQueues());
    this._pumpQueues();
  }

  stopQueue(id) {
    const q = this._queue(id);
    if (!q) return;
    q.running = false;
    for (const itemId of q.items) this.pause(itemId);
    this.emit('queues', this.getQueues());
  }

  _pumpQueues() {
    for (const q of this.queues) {
      if (!q.running) continue;
      let running = q.items.filter((x) => this.tasks.has(x)).length;
      for (const itemId of q.items) {
        if (running >= q.maxConcurrent) break;
        const it = this.items.get(itemId);
        if (it?.status === 'queued' && this.start(itemId)) running++;
      }
      // Optionally retry failed items a few times before calling the queue done.
      if (running === 0 && q.schedule?.retryFailed) {
        q.retries = q.retries || {};
        for (const itemId of q.items) {
          const it = this.items.get(itemId);
          if (it?.status === 'failed' && (q.retries[itemId] || 0) < (q.schedule.retryCount || 3)) {
            q.retries[itemId] = (q.retries[itemId] || 0) + 1;
            it.status = 'queued';
            if (running < q.maxConcurrent && this.start(itemId)) running++;
          }
        }
      }
      const waiting = q.items.some((x) => this.items.get(x)?.status === 'queued');
      if (running === 0 && !waiting) {
        q.running = false;
        this.emit('queues', this.getQueues());
        this.emit('queue-finished', q);
      }
    }
  }

  // ------------------------------------------------------------ progress pump

  /** Returns public snapshots of items that changed since the last call (UI polling). */
  drainChanges() {
    for (const id of this.tasks.keys()) this._dirty.add(id);
    const out = [];
    for (const id of this._dirty) {
      const it = this.items.get(id);
      if (it) out.push(this.toPublic(it));
    }
    this._dirty.clear();
    return out;
  }

  totals() {
    let speed = 0;
    let active = 0;
    let size = 0;
    let done = 0;
    for (const [id, t] of this.tasks) {
      const it = this.items.get(id);
      speed += t.stats.speed;
      active++;
      if (it.size > 0) {
        size += it.size;
        done += it.downloaded;
      }
    }
    return { speed, active, progress: size > 0 ? done / size : -1 };
  }
}

function defaultSchedule() {
  return {
    enabled: false,
    startTime: '02:00',
    stopEnabled: false,
    stopTime: '07:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    once: false,
    onComplete: 'none', // none | quit | sleep | shutdown
    retryFailed: true,
    retryCount: 3,
  };
}

module.exports = { DownloadManager, isHlsUrl, defaultSchedule };
