'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const { createServer, data, sha256, hlsSegment } = require('./server');
const { DownloadManager } = require('../src/main/DownloadManager');
const { Settings } = require('../src/main/Settings');

let srv;
let base;

before(async () => {
  srv = createServer();
  base = await srv.listen();
});
after(() => srv.close());

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-test-'));
}

function makeManager(dir, overrides = {}) {
  const settings = new Settings(null);
  Object.assign(settings.data, { downloadDir: dir, useCategoryFolders: false, maxRetries: 4 }, overrides);
  return new DownloadManager({ dataDir: dir, settings, ffmpegPath: () => overrides.ffmpeg || null }).load();
}

function waitFor(mgr, id, statuses = ['completed', 'failed'], timeout = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${statuses}; now ${mgr.get(id)?.status}`)), timeout);
    const check = (item) => {
      if (item.id === id && statuses.includes(item.status)) {
        clearTimeout(t);
        mgr.off('changed', check);
        resolve(item);
      }
    };
    mgr.on('changed', check);
    check(mgr.get(id));
  });
}

const fileHash = (p) => sha256(fs.readFileSync(p));

test('multi-connection download produces an identical file', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir, { maxConnections: 8 });
  const size = 8 * 1024 * 1024 + 123;
  srv.stats.maxActive = 0;
  const item = mgr.add({ url: `${base}/file/${size}?rate=3000000`, start: true });
  const done = await waitFor(mgr, item.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.size, size);
  assert.equal(fileHash(done.savePath), sha256(data(size)));
  assert.ok(srv.stats.maxActive >= 4, `expected parallel connections, saw ${srv.stats.maxActive}`);
  assert.ok(!fs.existsSync(done.savePath + '.vdm'), 'temp file removed');
});

test('pause, then resume after an app restart', async () => {
  const dir = tmpDir();
  const size = 6 * 1024 * 1024;
  let mgr = makeManager(dir, { maxConnections: 4 });
  const item = mgr.add({ url: `${base}/file/${size}?rate=1000000`, fileName: 'resume.bin', start: true });
  await new Promise((r) => setTimeout(r, 1200));
  mgr.pause(item.id);
  const paused = await waitFor(mgr, item.id, ['paused']);
  assert.ok(paused.downloaded > 0 && paused.downloaded < size, `partial: ${paused.downloaded}`);
  assert.ok(paused.segments.length > 1, 'was segmented');
  await mgr.save();

  // Simulate quitting and relaunching the app.
  mgr = makeManager(dir, { maxConnections: 4 });
  const reloaded = mgr.get(item.id);
  assert.equal(reloaded.status, 'paused');
  assert.equal(reloaded.downloaded, paused.downloaded);
  const ranges = srv.stats.ranges.length;
  mgr.start(item.id);
  const done = await waitFor(mgr, item.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(path.basename(done.savePath), 'resume.bin');
  assert.equal(fileHash(done.savePath), sha256(data(size)));
  // Resumed connections must not start again from byte 0.
  const resumed = srv.stats.ranges.slice(ranges);
  assert.ok(resumed.every(([s]) => s > 0), 'resumed with non-zero ranges');
});

test('server without range support downloads with one connection', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir);
  const size = 2 * 1024 * 1024;
  const item = mgr.add({ url: `${base}/norange/${size}/setup.zip`, start: true });
  const done = await waitFor(mgr, item.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.resumable, false);
  assert.equal(fileHash(done.savePath), sha256(data(size)));
});

test('unknown size (chunked) download', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir);
  const size = 1500000;
  const item = mgr.add({ url: `${base}/chunked/${size}/report`, start: true });
  const done = await waitFor(mgr, item.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.size, size);
  assert.equal(path.basename(done.savePath), 'report.pdf', 'extension from Content-Type');
  assert.equal(fileHash(done.savePath), sha256(data(size)));
});

test('redirects and Content-Disposition (RFC 5987) filenames', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir);
  const info = await mgr.probe(`${base}/cd/700000`);
  assert.equal(info.fileName, 'résumé final.pdf');
  assert.equal(info.size, 700000);
  assert.equal(info.resumable, true);
  assert.equal(info.category, 'documents');

  // Name only known from Content-Disposition → must still land in the Documents folder.
  const mgr2 = makeManager(tmpDir(), { useCategoryFolders: true });
  const cd = mgr2.add({ url: `${base}/cd/700000`, start: true });
  const cdDone = await waitFor(mgr2, cd.id);
  assert.equal(cdDone.category, 'documents');
  assert.equal(path.basename(path.dirname(cdDone.savePath)), 'Documents');
  assert.equal(path.basename(cdDone.savePath), 'résumé final.pdf');

  const item = mgr.add({ url: `${base}/redirect/900000`, start: true });
  const done = await waitFor(mgr, item.id);
  assert.equal(done.status, 'completed', done.error);
  assert.match(done.finalUrl, /\/file\/900000$/);
  assert.equal(fileHash(done.savePath), sha256(data(900000)));
});

test('recovers from dropped connections', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir, { maxConnections: 4 });
  const size = 3 * 1024 * 1024;
  const item = mgr.add({ url: `${base}/flaky/${size}`, start: true });
  const done = await waitFor(mgr, item.id, ['completed', 'failed'], 40000);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(fileHash(done.savePath), sha256(data(size)));
});

test('respects a server that limits connections (503)', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir, { maxConnections: 8 });
  const size = 4 * 1024 * 1024;
  const item = mgr.add({ url: `${base}/file/${size}?maxconn=2&rate=4000000`, start: true });
  const done = await waitFor(mgr, item.id, ['completed', 'failed'], 30000);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(fileHash(done.savePath), sha256(data(size)));
});

test('a host that answers extra connections with 403 still completes', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir, { maxConnections: 8 });
  const size = 4 * 1024 * 1024;
  const item = mgr.add({ url: `${base}/file/${size}?maxconn=3&limitstatus=403&rate=4000000`, start: true });
  const done = await waitFor(mgr, item.id, ['completed', 'failed'], 30000);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(fileHash(done.savePath), sha256(data(size)));
});

test('a pasted list of signed episode links downloads in order into the chosen folder', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir, { useCategoryFolders: true });
  const season = path.join(dir, 'Example Show S02');
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const names = ['Show.S02E01.720p.WEB-DL.x264.mkv', 'Show.S02E02.720p.WEB-DL.x264-Pahe.mkv', 'Show.S02E03.720p.WEB-DL.x264-Pahe.mkv'];
  mgr.updateQueue('main', { maxConcurrent: 1 });
  const ids = names.map((n, i) => mgr.add({ url: `${base}/signed/${600000 + i}/${n}?md5=tok${i}AbC-_x&u=1001&expires=${expires}`, queueId: 'main', saveDir: season }).id);
  const finished = new Promise((r) => mgr.once('queue-finished', r));
  mgr.startQueue('main');
  await finished;
  ids.forEach((id, i) => {
    const it = mgr.get(id);
    assert.equal(it.status, 'completed', it.error);
    assert.equal(it.savePath, path.join(season, names[i]), 'name from the URL path, not the query string');
    assert.equal(it.category, 'video');
    assert.equal(fileHash(it.savePath), sha256(data(600000 + i)));
  });
  const order = ids.map((id) => mgr.get(id).completedAt);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'episodes finished in queue order');

  // An expired link fails with a clear error instead of hanging.
  const old = mgr.add({ url: `${base}/signed/5000/Show.S02E04.mkv?md5=x&u=1&expires=1000`, start: true });
  const failed = await waitFor(mgr, old.id, ['failed'], 5000);
  assert.match(failed.error, /403/);
});

test('global speed limiter throttles the transfer', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir, { speedLimitEnabled: true, speedLimit: 1024, maxConnections: 4 }); // 1 MB/s
  const size = 2 * 1024 * 1024;
  const t0 = Date.now();
  const item = mgr.add({ url: `${base}/file/${size}`, start: true });
  const done = await waitFor(mgr, item.id);
  const secs = (Date.now() - t0) / 1000;
  assert.equal(done.status, 'completed', done.error);
  assert.ok(secs >= 1.5 && secs < 4, `2 MB at 1 MB/s took ${secs}s`);
});

test('basic authentication', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir);
  const bad = mgr.add({ url: `${base}/auth/50000/secret.zip`, start: true });
  const failed = await waitFor(mgr, bad.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /401/);

  const good = mgr.add({ url: `${base}/auth/50000/secret.zip`, auth: { username: 'user', password: 'secret' }, start: true });
  const done = await waitFor(mgr, good.id);
  assert.equal(done.status, 'completed', done.error);
});

test('404 fails fast with a readable error', async () => {
  const mgr = makeManager(tmpDir());
  const item = mgr.add({ url: `${base}/missing/file.zip`, start: true });
  const done = await waitFor(mgr, item.id, ['failed'], 5000);
  assert.match(done.error, /404/);
});

test('HLS: picks the best variant, decrypts AES-128 and joins segments', async () => {
  for (const route of ['hls', 'hls-enc']) {
    const dir = tmpDir();
    const mgr = makeManager(dir);
    const info = await mgr.probe(`${base}/${route}/master.m3u8`);
    assert.equal(info.type, 'hls');
    assert.deepEqual(info.variants.map((v) => v.name), ['720p', '360p']);

    const item = mgr.add({ url: `${base}/${route}/master.m3u8`, title: 'My Video', start: true });
    const done = await waitFor(mgr, item.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(path.basename(done.savePath), 'My Video.ts');
    const expected = Buffer.concat(Array.from({ length: 12 }, (_, i) => hlsSegment('high', i)));
    assert.ok(fs.readFileSync(done.savePath).equals(expected), `${route} content matches`);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.vdm')), [], 'no temp files left');
  }
});

test('queue runs items one at a time and reports completion', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir);
  mgr.updateQueue('main', { maxConcurrent: 1 });
  const ids = [1, 2, 3].map((n) => mgr.add({ url: `${base}/file/${300000 + n}?rate=2000000`, queueId: 'main' }).id);
  let maxRunning = 0;
  mgr.on('changed', () => {
    maxRunning = Math.max(maxRunning, mgr.tasks.size);
  });
  const finished = new Promise((r) => mgr.once('queue-finished', r));
  mgr.startQueue('main');
  await finished;
  assert.equal(maxRunning, 1);
  for (const id of ids) assert.equal(mgr.get(id).status, 'completed');
});

test('works through an HTTP proxy', async () => {
  let proxied = 0;
  const proxy = http.createServer((req, res) => {
    proxied++;
    const target = new URL(req.url);
    const up = http.request(
      { host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      }
    );
    req.pipe(up);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const mgr = makeManager(tmpDir(), { proxy: { enabled: true, host: '127.0.0.1', port: proxy.address().port } });
  const item = mgr.add({ url: `${base}/file/1200000`, start: true });
  const done = await waitFor(mgr, item.id);
  proxy.closeAllConnections();
  proxy.close();
  assert.equal(done.status, 'completed', done.error);
  assert.ok(proxied >= 1);
  assert.equal(fileHash(done.savePath), sha256(data(1200000)));
});

test('restart re-downloads from scratch', async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir);
  const item = mgr.add({ url: `${base}/file/400000/x.bin`, start: true });
  const first = await waitFor(mgr, item.id);
  await mgr.restart(item.id);
  const second = await waitFor(mgr, item.id);
  assert.equal(second.status, 'completed');
  assert.notEqual(second.savePath, first.savePath, 'does not clobber the finished file');
  assert.equal(fileHash(second.savePath), sha256(data(400000)));
});

test('real HLS stream is remuxed to MP4 with ffmpeg', { skip: !findFfmpeg() && 'ffmpeg not installed' }, async () => {
  const ffmpeg = findFfmpeg();
  const hlsDir = tmpDir();
  const { execFileSync } = require('node:child_process');
  execFileSync(ffmpeg, [
    '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '4', '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
    path.join(hlsDir, 'index.m3u8'),
  ]);
  const static_ = http.createServer((req, res) => {
    const f = path.join(hlsDir, path.basename(req.url));
    if (!fs.existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200);
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => static_.listen(0, '127.0.0.1', r));
  const mgr = makeManager(tmpDir(), { ffmpeg });
  const item = mgr.add({ url: `http://127.0.0.1:${static_.address().port}/index.m3u8`, title: 'clip', start: true });
  const done = await waitFor(mgr, item.id, ['completed', 'failed'], 30000);
  static_.close();
  assert.equal(done.status, 'completed', done.error);
  assert.equal(path.basename(done.savePath), 'clip.mp4');
  const probe = execFileSync(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', done.savePath]).toString();
  assert.match(probe, /video/);
  assert.match(probe, /audio/);
});

test('HLS falls back to .ts and cleans up when ffmpeg cannot remux', { skip: !findFfmpeg() && 'ffmpeg not installed' }, async () => {
  const dir = tmpDir();
  const mgr = makeManager(dir, { ffmpeg: findFfmpeg() });
  const item = mgr.add({ url: `${base}/hls/master.m3u8`, title: 'Fake Stream', start: true });
  const done = await waitFor(mgr, item.id);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(path.basename(done.savePath), 'Fake Stream.ts');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.vdm')), [], 'no temp files left');
});

function findFfmpeg() {
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (fs.existsSync(p)) return p;
  return null;
}
