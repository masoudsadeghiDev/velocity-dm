'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('./server');
const { expandBatch, grabSite, extractLinks } = require('../src/main/tools');
const { Scheduler } = require('../src/main/Scheduler');
const { parseContentDisposition, sanitizeFileName, categoryFor } = require('../src/main/engine/files');

let srv;
let base;
before(async () => {
  srv = createServer();
  base = await srv.listen();
});
after(() => srv.close());

test('batch patterns expand numbers (zero-padded) and letters', () => {
  assert.deepEqual(expandBatch('http://x/img*.jpg', 8, 10, 3), ['http://x/img008.jpg', 'http://x/img009.jpg', 'http://x/img010.jpg']);
  assert.deepEqual(expandBatch('http://x/part-*.rar', 'a', 'c'), ['http://x/part-a.rar', 'http://x/part-b.rar', 'http://x/part-c.rar']);
  assert.throws(() => expandBatch('http://x/no-wildcard', 1, 2), /wildcard/);
});

test('site grabber crawls by depth, filters types and stays on the site', async () => {
  const shallow = await grabSite({ startUrl: `${base}/site/index.html`, depth: 0, sameHost: true, exts: ['zip', 'pdf', 'mp3'] });
  assert.deepEqual(shallow.map((f) => f.fileName).sort(), ['a.zip', 'b.pdf']);
  const deep = await grabSite({ startUrl: `${base}/site/index.html`, depth: 2, sameHost: true, exts: ['zip', 'mp3'] });
  assert.deepEqual(deep.map((f) => f.fileName).sort(), ['a.zip', 'deep.mp3', 'deeper.zip']);
  assert.equal(extractLinks('<a href="/a?x=1&amp;y=2#f">', 'http://h/p/')[0], 'http://h/a?x=1&y=2');
});

test('scheduler starts and stops queues at the configured minute, once per minute', () => {
  const calls = [];
  let now = new Date(2026, 9, 12, 1, 59); // Monday
  const mgr = {
    queues: [{ id: 'main', running: false, schedule: { enabled: true, startTime: '02:00', stopEnabled: true, stopTime: '07:00', days: [1], once: false } }],
    startQueue: (id) => (calls.push(`start ${id}`), (mgr.queues[0].running = true)),
    stopQueue: (id) => (calls.push(`stop ${id}`), (mgr.queues[0].running = false)),
    updateQueue: () => {},
  };
  const s = new Scheduler(mgr, { now: () => now });
  s.tick();
  now = new Date(2026, 9, 12, 2, 0);
  s.tick();
  s.tick(); // same minute: no double start
  now = new Date(2026, 9, 12, 7, 0);
  s.tick();
  now = new Date(2026, 9, 13, 2, 0); // Tuesday: not scheduled
  s.tick();
  assert.deepEqual(calls, ['start main', 'stop main']);
  assert.equal(new Date(s.nextRun(mgr.queues[0])).getDay(), 1);
});

test('file name helpers', () => {
  assert.equal(parseContentDisposition(`attachment; filename*=UTF-8''%E2%82%AC%20rates.pdf`), '€ rates.pdf');
  assert.equal(parseContentDisposition('attachment; filename="a \\"b\\".zip"'), 'a "b".zip');
  assert.equal(sanitizeFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.equal(categoryFor('Movie.MKV'), 'video');
  assert.equal(categoryFor('notes.unknownext'), 'general');
});
