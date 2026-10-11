'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer, data, sha256, hlsSegment } = require('./server');
const { linkExpiry, matchNewLinks } = require('../src/main/engine/links');
const { DownloadManager } = require('../src/main/DownloadManager');
const { Settings } = require('../src/main/Settings');

let srv;
let base;
before(async () => {
  srv = createServer();
  base = await srv.listen();
});
after(() => srv.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

function makeManager(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-links-'));
  const settings = new Settings(null);
  Object.assign(settings.data, { downloadDir: dir, useCategoryFolders: false, maxRetries: 2 }, overrides);
  return new DownloadManager({ dataDir: dir, settings }).load();
}

function waitFor(mgr, id, statuses, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout; status ${mgr.get(id)?.status}`)), timeout);
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

test('reads expiry times from signed links', () => {
  const u = 'https://h/dl5/Example.Show.S02E01.mkv?md5=Zm9vYmFyYmF6cXV4MTIz&u=1001&expires=1791887900';
  assert.equal(linkExpiry(u), 1791887900000);
  assert.equal(linkExpiry('https://h/a.zip?Expires=1791887900123'), 1791887900123);
  assert.equal(
    linkExpiry('https://b.s3.amazonaws.com/k.zip?X-Amz-Date=20261013T103800Z&X-Amz-Expires=3600&X-Amz-Signature=x'),
    Date.UTC(2026, 9, 13, 11, 38, 0)
  );
  assert.equal(linkExpiry('https://h/a.zip?id=1791887900'), null, 'unrelated parameter');
  assert.equal(linkExpiry('https://h/a.zip?e=42'), null, 'not a plausible date');
  assert.equal(linkExpiry('https://h/a.zip'), null);
});

test('matches fresh links to downloads by file name', () => {
  const old = (n, e) => `https://sn2.host/dl5/S02/${n}?md5=old${e}&u=1&expires=1700000000`;
  const neu = (n, e) => `https://sn3.host/dl5/S02/${n}?md5=new${e}&u=1&expires=1800000000`;
  const names = ['Example.Show.S02E01.720p.WEB-DL.x264.mkv', 'Example.Show.S02E02.720p.WEB-DL.x264-Pahe.mkv', 'Example.Show.S02E03.720p.WEB-DL.x264-Pahe.mkv'];
  const items = names.map((n, i) => ({ id: `id${i}`, url: old(n, i), fileName: n }));
  items.push({ id: 'renamed', url: 'https://h/x/Other.mkv?expires=1', fileName: 'Other (2).mkv' });
  // Pasted in a different order, with an unrelated link and a duplicate.
  const pasted = [neu(names[2], 2), 'https://h/notes.txt', neu(names[0], 0), neu(names[0], 0), 'https://h/y/Other.mkv?expires=2'];
  assert.deepEqual(matchNewLinks(items, pasted), {
    id0: neu(names[0], 0),
    id2: neu(names[2], 2),
    renamed: 'https://h/y/Other.mkv?expires=2',
  });
  // Ambiguous: two different links with the same name are never guessed.
  assert.deepEqual(matchNewLinks(items.slice(0, 1), [neu(names[0], 'a'), neu(names[0], 'b')]), {});
});

test('an expired link is reported clearly, and a fresh link resumes it from where it stopped', async () => {
  const mgr = makeManager({ maxConnections: 4 });
  const size = 5 * 1024 * 1024;
  const soon = now() + 2;
  const item = mgr.add({ url: `${base}/signed/${size}/Episode.mkv?md5=old&u=1&expires=${soon}&rate=500000`, start: true });
  await sleep(1200);
  mgr.pause(item.id);
  const paused = await waitFor(mgr, item.id, ['paused']);
  assert.ok(paused.downloaded > 0 && paused.downloaded < size);
  assert.equal(paused.linkExpiresAt, soon * 1000);

  await sleep(Math.max(0, soon * 1000 - Date.now()) + 1200); // let the link expire
  mgr.start(item.id);
  const failed = await waitFor(mgr, item.id, ['failed']);
  assert.match(failed.error, /link has expired/);
  assert.equal(failed.needsNewLink, true);
  assert.equal(failed.downloaded, paused.downloaded, 'partial data kept');

  const fresh = `${base}/signed/${size}/Episode.mkv?md5=new&u=1&expires=${now() + 3600}&rate=4000000`;
  const before = srv.stats.ranges.length;
  assert.deepEqual(mgr.matchLinks([item.id], [fresh]), { [item.id]: fresh });
  assert.equal(mgr.resumeMany([item.id], { [item.id]: fresh }), 1);
  const done = await waitFor(mgr, item.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.url, fresh);
  assert.ok(srv.stats.ranges.slice(before).every(([s]) => s > 0), 'continued, not restarted');
  assert.equal(sha256(fs.readFileSync(done.savePath)), sha256(data(size)));
});

test('resumeMany sends queued downloads back through their queue', async () => {
  const mgr = makeManager();
  mgr.updateQueue('main', { maxConcurrent: 1 });
  const ids = [1, 2, 3].map((i) => mgr.add({ url: `${base}/signed/${400000 + i}/E0${i}.mkv?md5=x&u=1&expires=1000`, queueId: 'main' }).id);
  let maxRunning = 0;
  mgr.on('changed', () => (maxRunning = Math.max(maxRunning, mgr.tasks.size)));
  const urls = Object.fromEntries(ids.map((id, i) => [id, `${base}/signed/${400001 + i}/E0${i + 1}.mkv?md5=y&u=1&expires=${now() + 3600}&rate=3000000`]));
  const finished = new Promise((r) => mgr.once('queue-finished', r));
  assert.equal(mgr.resumeMany(ids, urls), 3);
  await finished;
  assert.equal(maxRunning, 1, 'queue limit respected');
  ids.forEach((id) => assert.equal(mgr.get(id).status, 'completed'));
});

test('HLS: a refreshed stream link keeps the segments already downloaded', async () => {
  const mgr = makeManager({ maxConnections: 2 });
  const item = mgr.add({ url: `${base}/hls/master.m3u8?token=old&delay=150`, title: 'Talk', start: true });
  await sleep(600);
  mgr.pause(item.id);
  const paused = await waitFor(mgr, item.id, ['paused']);
  const doneBefore = Math.round(paused.hlsProgress * 13); // 12 segments + key-less playlist
  assert.ok(paused.hlsProgress > 0 && paused.hlsProgress < 1, `partial: ${paused.hlsProgress}`);

  const segsBefore = srv.stats.segments;
  mgr.resumeMany([item.id], { [item.id]: `${base}/hls/master.m3u8?token=new&delay=10` });
  const done = await waitFor(mgr, item.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.ok(srv.stats.segments - segsBefore <= 12 - doneBefore + 2, 'finished segments were not fetched again');
  const expected = Buffer.concat(Array.from({ length: 12 }, (_, i) => hlsSegment('high', i)));
  assert.ok(fs.readFileSync(done.savePath).equals(expected));
});
