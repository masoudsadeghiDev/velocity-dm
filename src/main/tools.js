'use strict';
// Site Grabber (crawl a site and collect downloadable links) and
// Batch Download (expand "file*.zip" style templates), as in IDM.

const { fetchBuffer } = require('./engine/http');
const { extOf, fileNameFromUrl } = require('./engine/files');

const LINK_RE = /(?:href|src|data-src|data-href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;

function extractLinks(html, baseUrl) {
  const out = new Set();
  let m;
  while ((m = LINK_RE.exec(html))) {
    const raw = (m[1] || m[2] || m[3] || '').trim();
    if (!raw || /^(javascript|mailto|tel|data):/i.test(raw) || raw.startsWith('#')) continue;
    try {
      const u = new URL(raw.replace(/&amp;/g, '&'), baseUrl);
      u.hash = '';
      if (u.protocol === 'http:' || u.protocol === 'https:') out.add(u.href);
    } catch {}
  }
  return [...out];
}

function isPageUrl(url) {
  const ext = extOf(new URL(url).pathname);
  return !ext || ['html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'cgi'].includes(ext);
}

/**
 * Crawls from startUrl (breadth first) and returns files whose extension matches.
 * @param {object} o { startUrl, depth, sameHost, exts: string[], maxPages, headers, proxy, timeout, onProgress, signal }
 */
async function grabSite(o) {
  const start = new URL(o.startUrl);
  const exts = new Set((o.exts || []).map((e) => e.toLowerCase().replace(/^\./, '')));
  const maxPages = o.maxPages || 200;
  const visited = new Set();
  const files = new Map();
  let frontier = [start.href];

  for (let level = 0; level <= (o.depth ?? 1) && frontier.length; level++) {
    const next = [];
    for (const pageUrl of frontier) {
      if (o.signal?.aborted || visited.size >= maxPages) break;
      if (visited.has(pageUrl)) continue;
      visited.add(pageUrl);
      o.onProgress?.({ pages: visited.size, files: files.size, current: pageUrl });
      let body;
      let finalUrl;
      let type;
      try {
        const r = await fetchBuffer(pageUrl, { headers: o.headers, proxy: o.proxy, timeout: o.timeout || 20000, signal: o.signal }, 10 * 1024 * 1024);
        body = r.body;
        finalUrl = r.url;
        type = String(r.headers['content-type'] || '');
      } catch {
        continue;
      }
      if (!/html|xml/i.test(type)) continue;
      for (const link of extractLinks(body.toString('utf8'), finalUrl)) {
        const u = new URL(link);
        const ext = extOf(u.pathname);
        if (exts.size ? exts.has(ext) : ext && !isPageUrl(link)) {
          if (!o.sameHost || u.host === start.host || o.filesAnyHost) {
            if (!files.has(link)) files.set(link, { url: link, fileName: fileNameFromUrl(link), ext, foundOn: finalUrl });
          }
        } else if (isPageUrl(link) && (!o.sameHost || u.host === start.host) && !visited.has(link)) {
          next.push(link);
        }
      }
    }
    frontier = next;
  }
  o.onProgress?.({ pages: visited.size, files: files.size, current: null });
  return [...files.values()];
}

/**
 * Expands a batch template. The "*" in the template is replaced by every value
 * from `from` to `to` (numbers or single letters), zero-padded to `width`.
 *   expandBatch('http://x/img*.jpg', 1, 3, 3) → img001.jpg, img002.jpg, img003.jpg
 */
function expandBatch(template, from, to, width = 0) {
  if (!template.includes('*')) throw new Error('The address must contain a * wildcard');
  const out = [];
  const isLetter = (v) => typeof v === 'string' && /^[a-z]$/i.test(v);
  if (isLetter(from) && isLetter(to)) {
    const a = from.charCodeAt(0);
    const b = to.charCodeAt(0);
    for (let c = Math.min(a, b); c <= Math.max(a, b); c++) out.push(template.replace('*', String.fromCharCode(c)));
    return out;
  }
  const a = Number(from);
  const b = Number(to);
  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('From/To must be whole numbers or single letters');
  if (Math.abs(b - a) > 10000) throw new Error('Batch is limited to 10,000 files');
  const step = a <= b ? 1 : -1;
  for (let i = a; step > 0 ? i <= b : i >= b; i += step) out.push(template.replace('*', String(i).padStart(width, '0')));
  return out;
}

module.exports = { grabSite, extractLinks, expandBatch };
