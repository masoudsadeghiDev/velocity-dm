'use strict';
// Velocity DM browser integration: captures downloads, adds context menus and
// detects video/audio streams on pages (the "video grabber").

const DEFAULT_PORT = 9614;
const media = new Map(); // tabId -> Map(url -> entry)
let appInfoCache = { at: 0, info: null };

// The service worker can be suspended at any time; keep detected media in session storage.
const mediaReady = (chrome.storage.session?.get('media') || Promise.resolve({}))
  .then(({ media: saved }) => {
    for (const [tabId, entries] of Object.entries(saved || {})) media.set(Number(tabId), new Map(entries.map((e) => [e.url, e])));
  })
  .catch(() => {});
let saveTimer = null;
function saveMedia() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    for (const [tabId, list] of media) out[tabId] = [...list.values()];
    chrome.storage.session?.set({ media: out }).catch(() => {});
  }, 300);
}

// ------------------------------------------------------------------ app connection

async function prefs() {
  const p = await chrome.storage.local.get({ enabled: true, port: DEFAULT_PORT });
  return p;
}

async function base() {
  return `http://127.0.0.1:${(await prefs()).port}`;
}

/** Returns the app's /ping info, or null when the app isn't running. Cached briefly. */
async function appInfo(force = false) {
  if (!force && Date.now() - appInfoCache.at < 3000) return appInfoCache.info;
  let info = null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`${await base()}/ping`, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (r.ok) info = await r.json();
  } catch {}
  appInfoCache = { at: Date.now(), info };
  return info;
}

async function send(path, body) {
  const r = await fetch(`${await base()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Velocity DM returned ${r.status}`);
}

async function cookieHeader(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ') || undefined;
  } catch {
    return undefined;
  }
}

function notify(message) {
  chrome.notifications?.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'Velocity DM', message });
}

async function handOver(path, payload) {
  if (!(await appInfo(true))) {
    notify('Velocity Download Manager is not running. Start the app and try again.');
    return false;
  }
  try {
    await send(path, payload);
    return true;
  } catch (e) {
    notify(`Could not send to Velocity DM: ${e.message}`);
    return false;
  }
}

// ------------------------------------------------------------------ download capture

function extOf(name) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function nameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

function matchesExt(ext, list) {
  if (!ext) return false;
  return list.some((pattern) => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(ext));
}

const recentlyHandled = new Set();

async function maybeCapture(item, fileName) {
  const { enabled } = await prefs();
  if (!enabled) return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url) || recentlyHandled.has(item.id)) return;
  const info = await appInfo();
  if (!info?.capture) return;
  const name = fileName || item.filename?.split(/[\\/]/).pop() || nameFromUrl(url);
  if (!matchesExt(extOf(name), info.exts || [])) return;
  const size = item.fileSize > 0 ? item.fileSize : item.totalBytes;
  if (info.minSizeKB > 0 && size > 0 && size < info.minSizeKB * 1024) return;

  recentlyHandled.add(item.id);
  setTimeout(() => recentlyHandled.delete(item.id), 60000);
  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch {}
  const ok = await handOver('/download', {
    url,
    fileName: name || undefined,
    fileSize: size > 0 ? size : undefined,
    mime: item.mime,
    referer: item.referrer || undefined,
    pageUrl: item.referrer || undefined,
    cookies: await cookieHeader(url),
    userAgent: navigator.userAgent,
  });
  if (!ok) {
    // App went away: let the browser download it after all.
    chrome.downloads.download({ url });
  }
}

if (chrome.downloads.onDeterminingFilename) {
  // Chrome: the filename (incl. Content-Disposition) is known here.
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    suggest();
    if (item.byExtensionId === chrome.runtime.id) return;
    maybeCapture(item, item.filename);
  });
} else {
  chrome.downloads.onCreated.addListener((item) => {
    if (item.byExtensionId === chrome.runtime.id) return;
    maybeCapture(item);
  });
}

// ------------------------------------------------------------------ context menus

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'vdm-link', title: 'Download with Velocity DM', contexts: ['link', 'video', 'audio', 'image'] });
    chrome.contextMenus.create({ id: 'vdm-selection', title: 'Download selected links with Velocity DM', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'vdm-page', title: 'Download all links with Velocity DM', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'vdm-link') {
    const url = info.linkUrl || info.srcUrl;
    if (!url || !/^https?:/i.test(url)) return notify('This link cannot be downloaded (only http/https).');
    await handOver('/download', {
      url,
      referer: tab?.url,
      pageUrl: tab?.url,
      title: info.mediaType === 'video' ? tab?.title : undefined,
      cookies: await cookieHeader(url),
      userAgent: navigator.userAgent,
    });
  } else if (info.menuItemId === 'vdm-page' || info.menuItemId === 'vdm-selection') {
    await sendPageLinks(tab, info.menuItemId === 'vdm-selection');
  }
});

async function sendPageLinks(tab, selectionOnly) {
  if (!tab?.id) return;
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: collectLinks, args: [selectionOnly] });
  } catch (e) {
    return notify(`Cannot read links on this page: ${e.message}`);
  }
  const seen = new Set();
  const links = [];
  for (const r of results || []) {
    for (const l of r.result || []) {
      if (!seen.has(l.url) && /^https?:/i.test(l.url)) {
        seen.add(l.url);
        links.push(l);
      }
    }
  }
  if (!links.length) return notify('No links found.');
  // Cookies are attached per host so no site gets another site's cookies.
  const hosts = [...new Set(links.map((l) => new URL(l.url).origin))].slice(0, 50);
  const jar = {};
  for (const origin of hosts) jar[origin] = await cookieHeader(origin + '/');
  for (const l of links) l.cookies = jar[new URL(l.url).origin];
  await handOver('/batch', { links, referer: tab.url, pageTitle: tab.title, userAgent: navigator.userAgent });
}

// Runs inside the page.
function collectLinks(selectionOnly) {
  let root = document;
  const out = [];
  const sel = window.getSelection();
  const inSelection = (node) => !selectionOnly || (sel && sel.rangeCount && sel.containsNode(node, true));
  for (const a of root.querySelectorAll('a[href]')) {
    if (!inSelection(a)) continue;
    out.push({ url: a.href, text: (a.textContent || '').trim().slice(0, 120) });
  }
  if (!selectionOnly) {
    for (const m of root.querySelectorAll('img[src], video[src], audio[src], source[src]')) {
      out.push({ url: m.currentSrc || m.src, text: m.alt || m.title || '' });
    }
  }
  return out.filter((l) => l.url && !l.url.startsWith('javascript:'));
}

// ------------------------------------------------------------------ video grabber

const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|flv|mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|$)/i;
const SEGMENT = /\.(ts|m4s|cmfv|cmfa)(\?|$)|[/_-](seg|segment|chunk|frag)[-_]?\d+/i;
const SKIP_HOSTS = /(^|\.)googlevideo\.com$|(^|\.)doubleclick\.net$|(^|\.)googlesyndication\.com$/i;

function header(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value || '';
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    let u;
    try {
      u = new URL(d.url);
    } catch {
      return;
    }
    if (SKIP_HOSTS.test(u.hostname)) return;
    const type = header(d.responseHeaders, 'content-type').toLowerCase();
    const isHls = /mpegurl/.test(type) || /\.m3u8(\?|$)/i.test(u.pathname);
    const isMedia = !isHls && (/^(video|audio)\//.test(type) || MEDIA_EXT.test(u.pathname)) && !SEGMENT.test(u.pathname) && !/mp2t/.test(type);
    if (!isHls && !isMedia) return;
    const len = Number(header(d.responseHeaders, 'content-length')) || 0;
    const range = header(d.responseHeaders, 'content-range');
    const total = range ? Number(range.split('/')[1]) || 0 : len;
    if (isMedia && total > 0 && total < 300 * 1024) return; // tiny clips, ads, beeps
    addMedia(d.tabId, { url: d.url, kind: isHls ? 'hls' : type.startsWith('audio') ? 'audio' : 'video', mime: type.split(';')[0], size: total || 0 });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object', 'sub_frame'] },
  ['responseHeaders']
);

async function addMedia(tabId, entry) {
  await mediaReady;
  let list = media.get(tabId);
  if (!list) media.set(tabId, (list = new Map()));
  if (list.has(entry.url)) return;
  // Ignore variant playlists that belong to a master we already have.
  for (const e of list.values()) if (e.children?.includes(entry.url)) return;
  entry.at = Date.now();
  try {
    entry.title = (await chrome.tabs.get(tabId)).title;
  } catch {}
  list.set(entry.url, entry);
  if (entry.kind === 'hls') inspectPlaylist(tabId, entry);
  trim(list);
  updateBadge(tabId);
  saveMedia();
}

async function inspectPlaylist(tabId, entry) {
  try {
    const text = await (await fetch(entry.url, { credentials: 'include' })).text();
    if (/#EXT-X-STREAM-INF/.test(text)) {
      entry.master = true;
      const lines = text.split(/\r?\n/);
      entry.children = [];
      const heights = [];
      lines.forEach((l, i) => {
        if (l.startsWith('#EXT-X-STREAM-INF')) {
          const res = /RESOLUTION=\d+x(\d+)/.exec(l);
          if (res) heights.push(Number(res[1]));
          const next = lines.slice(i + 1).find((x) => x.trim() && !x.startsWith('#'));
          if (next) entry.children.push(new URL(next.trim(), entry.url).href);
        }
      });
      entry.quality = heights.length ? `up to ${Math.max(...heights)}p` : `${entry.children.length} qualities`;
      const list = media.get(tabId);
      for (const child of entry.children) list?.delete(child);
    } else {
      const secs = [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
      entry.duration = Math.round(secs);
      if (!/#EXT-X-ENDLIST/.test(text)) entry.live = true;
    }
    updateBadge(tabId);
    saveMedia();
  } catch {}
}

function trim(list) {
  while (list.size > 30) list.delete(list.keys().next().value);
}

function mediaFor(tabId) {
  return [...(media.get(tabId)?.values() || [])].filter((e) => !e.live).sort((a, b) => (b.master ? 1 : 0) - (a.master ? 1 : 0) || b.size - a.size);
}

function updateBadge(tabId) {
  const n = mediaFor(tabId).length;
  chrome.action.setBadgeBackgroundColor?.({ color: '#2f6fed', tabId });
  chrome.action.setBadgeText({ text: n ? String(n) : '', tabId });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await mediaReady;
  media.delete(tabId);
  saveMedia();
});
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status === 'loading' && change.url) {
    await mediaReady;
    media.delete(tabId);
    updateBadge(tabId);
    saveMedia();
  }
});

async function downloadMedia(entry, tab) {
  return handOver('/media', {
    url: entry.url,
    type: entry.kind === 'hls' ? 'hls' : undefined,
    mime: entry.mime,
    title: tab?.title || entry.title,
    referer: tab?.url,
    pageUrl: tab?.url,
    cookies: await cookieHeader(entry.url),
    userAgent: navigator.userAgent,
  });
}

// ------------------------------------------------------------------ messages from popup/content script

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await mediaReady;
    const tabId = msg.tabId ?? sender.tab?.id;
    const tab = sender.tab || (tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null);
    switch (msg.type) {
      case 'status':
        return reply({ info: await appInfo(true), prefs: await prefs(), media: mediaFor(tabId) });
      case 'media':
        if (msg.extra?.length) for (const e of msg.extra) if (/^https?:/i.test(e.url)) await addMedia(tabId, e);
        return reply({ media: mediaFor(tabId) });
      case 'downloadMedia':
        return reply({ ok: await downloadMedia(msg.entry, tab) });
      case 'downloadPage':
        await sendPageLinks(tab, false);
        return reply({ ok: true });
      case 'setPrefs':
        await chrome.storage.local.set(msg.prefs);
        appInfoCache.at = 0;
        return reply({ prefs: await prefs() });
      default:
        reply({});
    }
  })();
  return true;
});
