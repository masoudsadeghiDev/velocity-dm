'use strict';
// Polls the clipboard and reports newly copied links to downloadable files.
// `read` is async (Electron's clipboard.readText() returns a Promise since v44).

const { extOf } = require('./engine/files');

/**
 * @param {object} o
 *   read(): Promise<string>     reads the clipboard text
 *   enabled(): boolean          whether monitoring is switched on
 *   accepts(ext): boolean       whether a file extension should be captured
 *   onLink(url): void           called for each newly copied downloadable link
 * @returns {{ poll(): Promise<void>, start(ms?): void, stop(): void }}
 */
function createClipboardWatcher({ read, enabled, accepts, onLink }) {
  let last = null; // null until the first read: whatever was copied before is ignored
  let busy = false;
  let timer = null;

  async function poll() {
    if (busy || !enabled()) return;
    busy = true;
    let text;
    try {
      text = String((await read()) ?? '').trim();
    } catch {
      return; // clipboard temporarily unavailable; try again next tick
    } finally {
      busy = false;
    }
    if (last === null || text === last) {
      last = text;
      return;
    }
    last = text;
    if (!/^https?:\/\/\S+$/i.test(text)) return;
    let ext;
    try {
      ext = extOf(new URL(text).pathname);
    } catch {
      return;
    }
    if (ext === 'm3u8' || (ext && accepts(ext))) onLink(text);
  }

  return {
    poll,
    start(ms = 1000) {
      timer = setInterval(poll, ms);
    },
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { createClipboardWatcher };
