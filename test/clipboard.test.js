'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClipboardWatcher } = require('../src/main/clipboardWatcher');

function setup({ enabled = true } = {}) {
  const state = { text: 'https://example.com/already-copied.zip', enabled, links: [] };
  const watcher = createClipboardWatcher({
    read: async () => state.text, // async, like Electron 44's clipboard.readText()
    enabled: () => state.enabled,
    accepts: (ext) => ['zip', 'mp4', 'pdf'].includes(ext),
    onLink: (url) => state.links.push(url),
  });
  return { state, watcher };
}

test('ignores whatever was on the clipboard before monitoring started', async () => {
  const { state, watcher } = setup();
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(state.links, []);
});

test('reports newly copied download links, and ignores other text', async () => {
  const { state, watcher } = setup();
  await watcher.poll(); // baseline
  for (const t of ['hello world', '  https://cdn.example.com/movie.mp4  ', 'https://example.com/page.html', 'https://x.test/live/index.m3u8?token=1']) {
    state.text = t;
    await watcher.poll();
  }
  assert.deepEqual(state.links, ['https://cdn.example.com/movie.mp4', 'https://x.test/live/index.m3u8?token=1']);
});

test('a link sitting on the clipboard fires once; copying it again later fires again', async () => {
  const { state, watcher } = setup();
  await watcher.poll(); // baseline
  state.text = 'https://cdn.example.com/movie.mp4';
  await watcher.poll();
  await watcher.poll();
  await watcher.poll();
  assert.equal(state.links.length, 1);
  state.text = 'some other text';
  await watcher.poll();
  state.text = 'https://cdn.example.com/movie.mp4';
  await watcher.poll();
  assert.equal(state.links.length, 2);
});

test('does nothing while disabled, and turning it on does not replay old content', async () => {
  const { state, watcher } = setup({ enabled: false });
  state.text = 'https://example.com/new.zip';
  await watcher.poll();
  state.enabled = true;
  await watcher.poll(); // first read after enabling is only a baseline
  assert.deepEqual(state.links, []);
  state.text = 'https://example.com/newer.pdf';
  await watcher.poll();
  assert.deepEqual(state.links, ['https://example.com/newer.pdf']);
});

test('survives a clipboard read failure', async () => {
  let fail = true;
  const links = [];
  const watcher = createClipboardWatcher({
    read: async () => {
      if (fail) throw new Error('clipboard busy');
      return 'https://example.com/a.zip';
    },
    enabled: () => true,
    accepts: () => true,
    onLink: (u) => links.push(u),
  });
  await watcher.poll(); // rejected read must not throw
  fail = false;
  await watcher.poll(); // baseline
  assert.deepEqual(links, []);
});
