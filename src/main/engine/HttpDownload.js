'use strict';
// Multi-connection HTTP download with IDM-style dynamic file segmentation.
//
// The file starts as one segment served by the probe connection. Additional
// connections are opened by splitting the segment with the most bytes left in
// half; whenever a connection finishes its part it steals half of the largest
// remaining segment, so every connection stays busy until the very end.
// Segment progress is persisted on the item, which makes downloads resumable
// across pauses and app restarts.

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { request, parseContentRange, HttpError, FATAL_STATUSES } = require('./http');
const { resolveFileName } = require('./files');
const { sleep } = require('./limiter');

const MIN_SPLIT = 512 * 1024; // never create segments smaller than this
const MAX_RETRIES = 8;

class HttpDownload extends EventEmitter {
  /**
   * @param {object} item  persisted download record (mutated in place)
   * @param {object} ctx   { options(): {maxConnections,timeout,proxy,userAgent,retries}, limiters: SpeedLimiter[],
   *                         resolveSavePath(item, fileName): string }
   */
  constructor(item, ctx) {
    super();
    this.item = item;
    this.ctx = ctx;
    this.workers = new Map(); // segment -> Promise
    this.stopped = false;
    this.controller = new AbortController();
    this.fh = null;
    this.sessionBytes = 0;
    this.connCap = Infinity; // lowered when the server refuses extra connections
    this.speed = 0;
    this._samples = [];
    this._fatal = null;
  }

  get options() {
    return this.ctx.options();
  }

  get maxConnections() {
    const n = this.item.maxConnections || this.options.maxConnections || 8;
    return Math.max(1, Math.min(n, this.connCap, 32));
  }

  headers() {
    const h = {};
    const it = this.item;
    const ua = it.userAgent || this.options.userAgent;
    if (ua) h['User-Agent'] = ua;
    if (it.referer) h.Referer = it.referer;
    if (it.cookies) h.Cookie = it.cookies;
    if (it.extraHeaders) Object.assign(h, it.extraHeaders);
    return h;
  }

  reqOpts(extra = {}) {
    const o = this.options;
    return {
      headers: this.headers(),
      proxy: o.proxy,
      timeout: (o.timeout || 30) * 1000,
      signal: this.controller.signal,
      auth: this.item.auth,
      ...extra,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    const it = this.item;
    this.stopped = false;
    it.error = null;
    it.status = 'connecting';
    this.emit('status');
    this._samples = [{ t: Date.now(), b: this.sessionBytes }];
    this._tick = setInterval(() => this._sample(), 500);

    try {
      const hasProgress = Array.isArray(it.segments) && it.segments.length > 0 && it.downloaded > 0;
      const tempExists = it.tempPath && fs.existsSync(it.tempPath);
      if (hasProgress && it.resumable && tempExists) {
        await this._openFile(false);
        this._resume();
      } else {
        await this._fresh();
      }
      await this._waitWorkers();
      if (this._fatal) throw this._fatal;
      if (this.stopped) return this._finishPaused();
      if (!this._allDone()) throw new HttpError('Download stopped before all data was received');
      await this._finalize();
      return 'completed';
    } catch (err) {
      await this._closeFile();
      if (this.stopped && !this._fatal) return this._finishPaused();
      it.status = 'failed';
      it.error = humanError(err);
      this.emit('status');
      throw err;
    } finally {
      clearInterval(this._tick);
      this.speed = 0;
    }
  }

  async _finishPaused() {
    await this._closeFile(true);
    this.item.status = 'paused';
    this.emit('status');
    return 'paused';
  }

  /** Stops all connections; start() resolves with 'paused'. */
  pause() {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
  }

  /** Called when the user changes max connections at runtime. */
  rebalance() {
    if (!this.stopped) this._spawn();
  }

  // ---------------------------------------------------------------- start paths

  async _fresh() {
    const it = this.item;
    const url = it.url;
    const { res, url: finalUrl, status, headers } = await request(url, this.reqOpts({ range: 'bytes=0-' }));
    if (status >= 400) {
      res.resume();
      throw new HttpError(`Server returned HTTP ${status}`, { status, retryable: !FATAL_STATUSES.has(status) });
    }
    if (this.stopped) {
      res.destroy();
      return;
    }

    it.finalUrl = finalUrl;
    it.mime = String(headers['content-type'] || '').split(';')[0];
    it.etag = headers.etag || null;
    it.lastModified = headers['last-modified'] || null;

    let size = -1;
    if (status === 206) {
      const cr = parseContentRange(headers['content-range']);
      size = cr && cr.total >= 0 ? cr.total : -1;
      it.resumable = size >= 0;
    } else {
      size = headers['content-length'] != null ? Number(headers['content-length']) : -1;
      it.resumable = false;
    }
    it.size = size;

    if (!it.fileNameLocked) {
      const name = resolveFileName({ url: finalUrl, headers, suggested: it.suggestedName });
      if (name !== it.fileName) {
        it.savePath = this.ctx.serverNamed ? this.ctx.serverNamed(it, name) : this.ctx.resolveSavePath(it, name);
        it.fileName = path.basename(it.savePath);
        this.emit('renamed');
      }
    }
    it.fileNameLocked = true; // the name is fixed once data hits the disk

    await this._openFile(true);
    it.downloaded = 0;
    it.segments = [{ start: 0, end: size > 0 ? size - 1 : -1, downloaded: 0 }];
    if (size === 0) {
      res.resume();
      it.segments[0].end = -1;
      it.segments[0].done = true;
      return;
    }
    it.status = 'downloading';
    this.emit('status');
    this._startWorker(it.segments[0], res);
    this._spawn();
  }

  _resume() {
    this._compact();
    this._spawn();
  }

  // ---------------------------------------------------------------- workers

  _remaining(seg) {
    if (seg.end < 0) return Infinity;
    return seg.end - (seg.start + seg.downloaded + (seg.inflight || 0)) + 1;
  }

  _allDone() {
    return this.item.segments.every((s) => s.done || (s.end >= 0 && s.start + s.downloaded > s.end));
  }

  /** Fills free connection slots: first idle segments, then by splitting the largest one. */
  _spawn() {
    const it = this.item;
    if (this.stopped || this._fatal) return;
    const canSplit = it.resumable && it.size > 0;

    for (const seg of it.segments) {
      if (this.workers.size >= this.maxConnections) return;
      if (!this.workers.has(seg) && !seg.done && this._remaining(seg) > 0) this._startWorker(seg);
    }
    if (!canSplit) return;

    while (this.workers.size < this.maxConnections) {
      let target = null;
      for (const seg of it.segments) {
        if (seg.done || !this.workers.has(seg)) continue;
        if (!target || this._remaining(seg) > this._remaining(target)) target = seg;
      }
      if (!target || this._remaining(target) < MIN_SPLIT * 2) return;
      const remaining = this._remaining(target);
      const pos = target.start + target.downloaded + (target.inflight || 0);
      const newStart = pos + Math.ceil(remaining / 2);
      const seg = { start: newStart, end: target.end, downloaded: 0 };
      target.end = newStart - 1;
      it.segments.splice(it.segments.indexOf(target) + 1, 0, seg);
      this._startWorker(seg);
    }
  }

  _startWorker(seg, initialRes) {
    const p = this._runSegment(seg, initialRes)
      .catch((err) => {
        if (this.stopped) return;
        // A connection gave up. If others are still running, they will pick the
        // segment up later; if it was the last one, the whole download fails.
        const others = [...this.workers.keys()].filter((s) => s !== seg).length;
        if (!err.retryable || others === 0 || err.code === 'ENOSPC') {
          this._fatal = this._fatal || err;
          this.pauseInternal();
        }
      })
      .finally(() => {
        this.workers.delete(seg);
        this.emit('connections');
        if (!this.stopped) this._spawn();
        this._maybeResolve();
      });
    this.workers.set(seg, p);
    this.emit('connections');
  }

  pauseInternal() {
    this.stopped = true;
    this.controller.abort();
  }

  _waitWorkers() {
    return new Promise((resolve) => {
      this._resolveWait = resolve;
      this._maybeResolve();
    });
  }

  _maybeResolve() {
    if (this.workers.size === 0 && this._resolveWait) {
      const r = this._resolveWait;
      this._resolveWait = null;
      r();
    }
  }

  async _openRange(seg) {
    const it = this.item;
    const pos = seg.start + seg.downloaded;
    const range = seg.end >= 0 ? `bytes=${pos}-${seg.end}` : `bytes=${pos}-`;
    let url = it.finalUrl || it.url;
    let r = await request(url, this.reqOpts({ range }));
    // Signed CDN links expire; fall back to the original URL to get a fresh redirect.
    if (r.status >= 400 && url !== it.url) {
      r.res.resume();
      r = await request(it.url, this.reqOpts({ range }));
      it.finalUrl = r.url;
    }
    const { res, status, headers } = r;
    if (status === 429 || status === 503) {
      res.resume();
      throw new HttpError(`Server busy (HTTP ${status})`, { status, code: 'BUSY' });
    }
    if (status >= 400) {
      res.resume();
      throw new HttpError(`Server returned HTTP ${status}`, { status, retryable: !FATAL_STATUSES.has(status) });
    }
    if (status === 200) {
      if (pos === 0 && it.segments.length === 1) return res; // whole file, fine
      res.destroy();
      throw new HttpError('The server no longer supports resuming this file. Use "Restart" to download it again.', {
        retryable: false,
        code: 'NO_RESUME',
      });
    }
    const cr = parseContentRange(headers['content-range']);
    if (!cr || cr.start !== pos) {
      res.destroy();
      throw new HttpError('Server sent an unexpected byte range');
    }
    if (it.size > 0 && cr.total >= 0 && cr.total !== it.size) {
      res.destroy();
      throw new HttpError('The file on the server has changed. Use "Restart" to download it again.', {
        retryable: false,
        code: 'CHANGED',
      });
    }
    return res;
  }

  async _runSegment(seg, initialRes) {
    let res = initialRes;
    let attempts = 0;
    const limiters = this.ctx.limiters || [];
    const signal = this.controller.signal;

    while (!this.stopped && !seg.done && this._remaining(seg) > 0) {
      try {
        if (!res) res = await this._openRange(seg);
        if (this.item.status !== 'downloading') {
          this.item.status = 'downloading';
          this.emit('status');
        }
        for await (const chunk of res) {
          if (this.stopped) break;
          for (const l of limiters) await l.take(chunk.length, signal);
          if (this.stopped) break;
          const pos = seg.start + seg.downloaded;
          const room = seg.end >= 0 ? seg.end - pos + 1 : chunk.length;
          const n = Math.min(chunk.length, room);
          if (n > 0) {
            seg.inflight = n;
            await this.fh.write(chunk, 0, n, pos);
            seg.inflight = 0;
            seg.downloaded += n;
            this.item.downloaded += n;
            this.sessionBytes += n;
            attempts = 0;
          }
          if (seg.end >= 0 && seg.start + seg.downloaded > seg.end) break; // reached (possibly shrunk) end
        }
        res.destroy();
        res = null;
        if (this.stopped) return;
        if (seg.end < 0) {
          // Unknown length: a clean end of stream means the file is complete.
          seg.end = seg.start + seg.downloaded - 1;
          seg.done = true;
          this.item.size = seg.end + 1;
          return;
        }
        if (seg.start + seg.downloaded > seg.end) return;
        throw new HttpError('Connection closed early');
      } catch (err) {
        res?.destroy();
        res = null;
        seg.inflight = 0;
        if (this.stopped) return;
        if (err.code === 'ENOSPC' || err.code === 'EACCES' || err.code === 'EROFS') {
          err.retryable = false;
          throw err;
        }
        // Many hosts answer extra connections with 403 (not 429/503) when they limit
        // connections per user. While other connections still work, treat it the same.
        if ((err.code === 'BUSY' || err.status === 403) && this.workers.size > 1) {
          // Too many connections for this server: retire this one; the segment
          // becomes idle and is picked up by a connection that finishes later.
          this.connCap = Math.max(1, this.workers.size - 1);
          return;
        }
        if (err.retryable === false) throw err;
        if (!this.item.resumable && seg.downloaded > 0) {
          // Can't resume mid-file: start over from byte 0.
          this.item.downloaded -= seg.downloaded;
          seg.downloaded = 0;
          if (seg.end >= 0 && this.item.size < 0) seg.end = -1;
        }
        const max = this.options.retries ?? MAX_RETRIES;
        if (++attempts > max) throw err;
        this.item.lastError = humanError(err);
        await sleep(Math.min(1000 * 2 ** (attempts - 1), 15000), signal);
      }
    }
  }

  // ---------------------------------------------------------------- file

  async _openFile(truncate) {
    const it = this.item;
    it.tempPath = it.savePath + '.vdm';
    await fs.promises.mkdir(path.dirname(it.savePath), { recursive: true });
    this.fh = await fs.promises.open(it.tempPath, truncate ? 'w+' : 'r+');
  }

  async _closeFile(sync = false) {
    if (!this.fh) return;
    const fh = this.fh;
    this.fh = null;
    try {
      if (sync) await fh.sync();
    } catch {}
    await fh.close().catch(() => {});
  }

  async _finalize() {
    const it = this.item;
    it.status = 'finishing';
    this.emit('status');
    if (it.size >= 0) await this.fh.truncate(it.size);
    await this._closeFile(true);
    let dest = it.savePath;
    if (fs.existsSync(dest)) {
      dest = this.ctx.resolveSavePath(it, path.basename(dest));
      it.savePath = dest;
      it.fileName = path.basename(dest);
    }
    await fs.promises.rename(it.tempPath, dest);
    it.downloaded = it.size >= 0 ? it.size : it.downloaded;
    it.segments = [{ start: 0, end: Math.max(0, it.downloaded - 1), downloaded: it.downloaded, done: true }];
    it.status = 'completed';
    it.completedAt = Date.now();
    this.emit('status');
  }

  /** Merges finished neighbouring segments to keep the persisted list short. */
  _compact() {
    const segs = this.item.segments.slice().sort((a, b) => a.start - b.start);
    const out = [];
    for (const s of segs) {
      const done = s.end >= 0 && s.start + s.downloaded > s.end;
      const prev = out[out.length - 1];
      if (done && prev && prev._done && prev.end + 1 === s.start) {
        prev.end = s.end;
        prev.downloaded += s.downloaded;
      } else {
        out.push({ start: s.start, end: s.end, downloaded: s.downloaded, _done: done });
      }
    }
    this.item.segments = out.map(({ _done, ...s }) => s);
    this.item.downloaded = this.item.segments.reduce((a, s) => a + s.downloaded, 0);
  }

  // ---------------------------------------------------------------- stats

  _sample() {
    const now = Date.now();
    this._samples.push({ t: now, b: this.sessionBytes });
    while (this._samples.length > 2 && now - this._samples[0].t > 5000) this._samples.shift();
    const first = this._samples[0];
    const dt = (now - first.t) / 1000;
    this.speed = dt > 0 ? (this.sessionBytes - first.b) / dt : 0;
    this.emit('progress');
  }

  get stats() {
    const it = this.item;
    const remaining = it.size > 0 ? it.size - it.downloaded : -1;
    return {
      speed: this.speed,
      eta: this.speed > 0 && remaining >= 0 ? remaining / this.speed : -1,
      connections: this.workers.size,
    };
  }
}

function humanError(err) {
  if (!err) return null;
  const map = {
    ENOTFOUND: 'Server not found (check the address or your connection)',
    ECONNREFUSED: 'Connection refused by server',
    ECONNRESET: 'Connection was reset',
    ETIMEDOUT: 'Connection timed out',
    ENOSPC: 'Not enough disk space',
    EACCES: 'Permission denied writing the file',
    EROFS: 'Destination is read-only',
    CERT_HAS_EXPIRED: 'The server certificate has expired',
  };
  return map[err.code] || err.message || String(err);
}

module.exports = { HttpDownload, humanError, MIN_SPLIT };
