'use strict';
// Signed download links: when they expire, and matching fresh links to the
// downloads whose old links died.

const EXPIRY_KEYS = ['expires', 'expire', 'expiry', 'expiration', 'expires_at', 'expiresat', 'exp', 'e', 'validto', 'valid_until', 'deadline'];
const Y2000 = 946684800000;
const Y2100 = 4102444800000;

function toMs(v) {
  if (!/^\d{10}(\d{3})?$/.test(v)) return null;
  const ms = v.length === 13 ? Number(v) : Number(v) * 1000;
  return ms > Y2000 && ms < Y2100 ? ms : null; // only plausible dates
}

/** Expiry time (ms) encoded in a signed URL, or null when the link has none we recognise. */
function linkExpiry(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const params = new Map([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
  // AWS S3 / Google Cloud Storage v4: signing time + lifetime in seconds.
  for (const p of ['x-amz', 'x-goog']) {
    const date = params.get(`${p}-date`);
    const life = params.get(`${p}-expires`);
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date || '');
    if (m && /^\d+$/.test(life || '')) return Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) + Number(life) * 1000;
  }
  for (const k of EXPIRY_KEYS) {
    const ms = params.has(k) ? toMs(params.get(k)) : null;
    if (ms) return ms;
  }
  return null;
}

function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ \(\d+\)(?=\.[^.]+$|$)/, ''); // "file (2).mkv" was renamed by us to avoid a clash
}

function urlKey(url) {
  try {
    return nameKey(decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''));
  } catch {
    return '';
  }
}

/**
 * Pairs fresh links with existing downloads by file name.
 * Names shared by several links or several downloads are ambiguous and left unmatched.
 * @param {{id, url, fileName}[]} items
 * @param {string[]} urls
 * @returns {Record<string, string>} id → new url
 */
function matchNewLinks(items, urls) {
  const links = new Map();
  for (const u of urls) {
    const k = urlKey(u);
    if (k) links.set(k, !links.has(k) || links.get(k) === u ? u : null); // same name, different link → ambiguous
  }
  const claims = new Map();
  const want = items.map((it) => {
    const keys = [...new Set([urlKey(it.url), nameKey(it.fileName)].filter(Boolean))];
    const key = keys.find((k) => links.get(k));
    if (key) claims.set(key, (claims.get(key) || 0) + 1);
    return [it.id, key];
  });
  const out = {};
  for (const [id, key] of want) if (key && claims.get(key) === 1) out[id] = links.get(key);
  return out;
}

module.exports = { linkExpiry, matchNewLinks };
