'use strict';
// HLS (m3u8) stream downloader — the "video grabber" back end.
// Downloads every media segment in parallel (resumable per segment), decrypts
// AES-128 segments, joins them, and remuxes to MP4 with ffmpeg when available.
// Separate audio renditions are downloaded and merged too.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { spawn } = require('node:child_process');
const { request, fetchBuffer, HttpError, FATAL_STATUSES } = require('./http');
const { isMaster, parseMaster, parseMedia, segmentIv } = require('./m3u8');
const { sleep } = require('./limiter');
const { humanError } = require('./HttpDownload');

class HlsDownload extends EventEmitter {
  constructor(item, ctx) {
    super();
    this.item = item;
    this.ctx = ctx;
    this.stopped = false;
    this.controller = new AbortController();
    this.sessionBytes = 0;
    this.speed = 0;
    this._samples = [];
    this.active = 0;
    this.keys = new Map();
  }

  get options() {
    return this.ctx.options();
  }

  reqOpts(extra = {}) {
    const it = this.item;
    const h = {};
    const ua = it.userAgent || this.options.userAgent;
    if (ua) h['User-Agent'] = ua;
    if (it.referer) h.Referer = it.referer;
    if (it.cookies) h.Cookie = it.cookies;
    return {
      headers: h,
      proxy: this.options.proxy,
      timeout: (this.options.timeout || 30) * 1000,
      signal: this.controller.signal,
      auth: it.auth,
      ...extra,
    };
  }

  pause() {
    this.stopped = true;
    this.controller.abort();
  }

  rebalance() {}

  async start() {
    const it = this.item;
    this.stopped = false;
    it.error = null;
    it.status = 'connecting';
    this.emit('status');
    this._samples = [{ t: Date.now(), b: this.sessionBytes }];
    this._tick = setInterval(() => this._sample(), 500);
    try {
      const tracks = await this._loadTracks();
      if (this.stopped) return this._paused();
      it.resumable = true;
      it.status = 'downloading';
      this.emit('status');
      await this._downloadAll(tracks);
      if (this.stopped) return this._paused();
      await this._assemble(tracks);
      return 'completed';
    } catch (err) {
      if (this.stopped && !this._fatal) return this._paused();
      it.status = 'failed';
      it.error = humanError(this._fatal || err);
      this.emit('status');
      throw this._fatal || err;
    } finally {
      clearInterval(this._tick);
      this.speed = 0;
    }
  }

  _paused() {
    this.item.status = 'paused';
    this.emit('status');
    return 'paused';
  }

  get partsDir() {
    return this.item.savePath + '.vdm.parts';
  }

  /** Resolves the master playlist once; on resume the chosen variant is reused. */
  async _loadTracks() {
    const it = this.item;
    const prev = it.hls?.stale ? it.hls : null; // link was refreshed
    if (!it.hls || prev) {
      const { body, url } = await fetchBuffer(it.url, this.reqOpts());
      const text = body.toString('utf8');
      if (!text.includes('#EXTM3U')) throw new HttpError('Not a valid HLS playlist', { retryable: false });
      const trackUrls = [];
      let variantName = null;
      if (isMaster(text)) {
        const { variants, media } = parseMaster(text, url);
        if (!variants.length) throw new HttpError('Playlist has no playable streams', { retryable: false });
        // After a link refresh, variant URLs carry new tokens: find the same quality by name.
        const pick =
          (prev && variants.find((v) => v.name === prev.variant)) ||
          (it.hlsVariant && variants.find((v) => v.url === it.hlsVariant)) ||
          variants[0];
        variantName = pick.name;
        trackUrls.push({ kind: 'video', url: pick.url });
        if (pick.audio) {
          const group = media.filter((m) => m.type === 'AUDIO' && m.groupId === pick.audio && m.url);
          const audio = group.find((m) => m.isDefault) || group[0];
          if (audio) trackUrls.push({ kind: 'audio', url: audio.url });
        }
      } else {
        trackUrls.push({ kind: 'video', url });
      }
      // Same stream behind a new link: finished segments still count (checked against the count below).
      const sameStream = prev && prev.variant === variantName && prev.tracks.length === trackUrls.length;
      it.hls = { variant: variantName, tracks: trackUrls.map((t, i) => ({ ...t, done: sameStream ? prev.tracks[i].done : '' })) };
    }

    const tracks = [];
    for (const t of it.hls.tracks) {
      const { body, url } = await fetchBuffer(t.url, this.reqOpts());
      const pl = parseMedia(body.toString('utf8'), url);
      if (!pl.endList) throw new HttpError('Live streams are not supported (no end of playlist)', { retryable: false });
      if (pl.segments.some((s) => s.key && s.key.method !== 'AES-128')) {
        throw new HttpError('This stream uses DRM/SAMPLE-AES encryption, which cannot be downloaded', { retryable: false });
      }
      const items = pl.segments.slice();
      if (pl.map) items.unshift({ url: pl.map.url, byterange: pl.map.byterange, isInit: true });
      if (t.done.length !== items.length) t.done = '0'.repeat(items.length);
      tracks.push({ meta: t, items, fmp4: !!pl.map, duration: pl.duration });
    }
    it.duration = Math.round(tracks[0]?.duration || 0);
    return tracks;
  }

  async _downloadAll(tracks) {
    const it = this.item;
    await fs.promises.mkdir(this.partsDir, { recursive: true });
    const queue = [];
    let totalCount = 0;
    let doneCount = 0;
    tracks.forEach((t, ti) => {
      t.items.forEach((s, si) => {
        totalCount++;
        if (t.meta.done[si] === '1' && fs.existsSync(this._partFile(ti, si))) doneCount++;
        else queue.push({ ti, si, seg: s });
      });
    });
    this._counts = { total: totalCount, done: doneCount };
    this._estimate();

    const conns = Math.max(1, Math.min(this.item.maxConnections || this.options.maxConnections || 8, 16));
    const worker = async () => {
      while (!this.stopped && queue.length) {
        const job = queue.shift();
        await this._fetchSegment(tracks, job);
        if (this.stopped) return;
        const t = tracks[job.ti].meta;
        t.done = t.done.slice(0, job.si) + '1' + t.done.slice(job.si + 1);
        this._counts.done++;
        this._estimate();
      }
    };
    const workers = Array.from({ length: Math.min(conns, queue.length) }, () => {
      this.active++;
      return worker().finally(() => this.active--);
    });
    const results = await Promise.allSettled(workers);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed && !this.stopped) throw failed.reason;
    if (failed && this.stopped && this._fatal) throw this._fatal;
    if (!this.stopped) it.downloaded = it.size; // exact once everything is on disk
  }

  _estimate() {
    const it = this.item;
    const { total, done } = this._counts;
    it.hlsProgress = total ? done / total : 0;
    // Size is unknown up front: extrapolate from the segments we have.
    it.size = done > 0 ? Math.round((it.downloaded / Math.max(it.hlsProgress, 1e-9)) || 0) : -1;
    it.sizeEstimated = done < total;
    if (done === total) it.size = it.downloaded;
  }

  _partFile(ti, si) {
    return path.join(this.partsDir, `t${ti}_${String(si).padStart(6, '0')}`);
  }

  async _key(url) {
    if (!this.keys.has(url)) {
      const { body } = await fetchBuffer(url, this.reqOpts(), 1024);
      if (body.length !== 16) throw new HttpError('Invalid AES-128 key', { retryable: false });
      this.keys.set(url, body);
    }
    return this.keys.get(url);
  }

  async _fetchSegment(tracks, { ti, si, seg }) {
    const limiters = this.ctx.limiters || [];
    const signal = this.controller.signal;
    const maxRetries = this.options.retries ?? 8;
    for (let attempt = 0; ; attempt++) {
      let counted = 0;
      try {
        const range = seg.byterange ? `bytes=${seg.byterange.offset}-${seg.byterange.offset + seg.byterange.length - 1}` : undefined;
        const { res, status } = await request(seg.url, this.reqOpts({ range }));
        if (status >= 400) {
          res.resume();
          throw new HttpError(`Segment returned HTTP ${status}`, { status, retryable: !FATAL_STATUSES.has(status) });
        }
        const chunks = [];
        for await (const chunk of res) {
          for (const l of limiters) await l.take(chunk.length, signal);
          chunks.push(chunk);
          counted += chunk.length;
          this.item.downloaded += chunk.length;
          this.sessionBytes += chunk.length;
        }
        if (this.stopped) throw new HttpError('Aborted', { code: 'ABORTED', retryable: false });
        let data = Buffer.concat(chunks);
        if (seg.key) {
          const key = await this._key(seg.key.url);
          const d = crypto.createDecipheriv('aes-128-cbc', key, segmentIv(seg));
          data = Buffer.concat([d.update(data), d.final()]);
        }
        const file = this._partFile(ti, si);
        await fs.promises.writeFile(file + '.tmp', data);
        await fs.promises.rename(file + '.tmp', file);
        return;
      } catch (err) {
        this.item.downloaded -= counted;
        if (this.stopped) throw err;
        if (err.code === 'ENOSPC' || err.retryable === false || attempt >= maxRetries) {
          this._fatal = err;
          this.pause();
          throw err;
        }
        this.item.lastError = humanError(err);
        await sleep(Math.min(1000 * 2 ** attempt, 15000), signal);
      }
    }
  }

  async _assemble(tracks) {
    const it = this.item;
    const partsDir = this.partsDir; // savePath may change below (e.g. .mp4 → .ts)
    it.status = 'finishing';
    this.emit('status');
    const joined = [];
    for (let ti = 0; ti < tracks.length; ti++) {
      const out = path.join(this.partsDir, `track${ti}${tracks[ti].fmp4 ? '.mp4' : '.ts'}`);
      const ws = fs.createWriteStream(out);
      for (let si = 0; si < tracks[ti].items.length; si++) {
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(this._partFile(ti, si));
          rs.once('error', reject);
          rs.once('end', resolve);
          rs.pipe(ws, { end: false });
        });
      }
      await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
      joined.push(out);
    }

    const ffmpeg = this.ctx.ffmpegPath?.();
    let dest = it.savePath;
    let produced = null;
    if (ffmpeg && this.options.remuxToMp4 !== false) {
      if (!/\.mp4$/i.test(dest)) dest = dest.replace(/\.[^./\\]+$/, '') + '.mp4';
      const tmpOut = path.join(this.partsDir, 'output.mp4');
      const args = ['-y', '-loglevel', 'error'];
      joined.forEach((f) => args.push('-i', f));
      if (joined.length > 1) args.push('-map', '0:v?', '-map', '0:a?', '-map', '1:a?');
      args.push('-c', 'copy', '-movflags', '+faststart', tmpOut);
      const ok = await runProcess(ffmpeg, args);
      if (ok) produced = tmpOut;
    }
    if (!produced) {
      // No ffmpeg: keep the joined transport stream (plays in VLC/most players).
      produced = joined[0];
      const ext = path.extname(joined[0]);
      dest = dest.replace(/\.[^./\\]+$/, '') + ext;
      if (joined.length > 1) {
        const audioDest = dest.replace(/(\.[^./\\]+)$/, '.audio$1');
        await fs.promises.rename(joined[1], this.ctx.resolveSavePath(it, path.basename(audioDest)));
      }
    }
    if (dest !== it.savePath || fs.existsSync(dest)) dest = this.ctx.resolveSavePath(it, path.basename(dest));
    await fs.promises.rename(produced, dest);
    it.savePath = dest;
    it.fileName = path.basename(dest);
    it.size = it.downloaded = (await fs.promises.stat(dest)).size;
    it.sizeEstimated = false;
    await fs.promises.rm(partsDir, { recursive: true, force: true });
    it.status = 'completed';
    it.completedAt = Date.now();
    this.emit('status');
  }

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
      connections: this.active,
    };
  }
}

function runProcess(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.once('error', () => resolve(false));
    p.once('close', (code) => {
      if (code !== 0) console.warn('[ffmpeg]', err.trim());
      resolve(code === 0);
    });
  });
}

module.exports = { HlsDownload };
