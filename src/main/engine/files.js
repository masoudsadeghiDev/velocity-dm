'use strict';
// File naming, categories and small fs helpers.

const fs = require('node:fs');
const path = require('node:path');

// IDM-style default categories. Order matters: the first match wins.
const DEFAULT_CATEGORIES = [
  {
    id: 'compressed',
    name: 'Compressed',
    exts: ['zip', 'rar', '7z', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'arj', 'ace', 'sit', 'sitx', 'sea', 'z', 'lz', 'zst', 'cab'],
  },
  {
    id: 'documents',
    name: 'Documents',
    exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pps', 'txt', 'rtf', 'odt', 'ods', 'odp', 'epub', 'mobi', 'csv', 'key', 'pages', 'numbers', 'djvu', 'chm'],
  },
  {
    id: 'music',
    name: 'Music',
    exts: ['mp3', 'wav', 'wma', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'mpa', 'ra', 'ram', 'mid', 'midi', 'ape'],
  },
  {
    id: 'programs',
    name: 'Programs',
    exts: ['exe', 'msi', 'msix', 'dmg', 'pkg', 'app', 'apk', 'aab', 'deb', 'rpm', 'appimage', 'iso', 'img', 'bin', 'jar', 'run', 'sh', 'bat'],
  },
  {
    id: 'video',
    name: 'Video',
    exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'mpe', '3gp', 'ts', 'm2ts', 'ogv', 'ogm', 'asf', 'qt', 'rm', 'rmvb', 'vob', 'm3u8'],
  },
];

const MIME_EXT = {
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-tar': 'tar',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/epub+zip': 'epub',
  'application/x-apple-diskimage': 'dmg',
  'application/vnd.android.package-archive': 'apk',
  'application/x-msdownload': 'exe',
  'application/x-msi': 'msi',
  'application/x-iso9660-image': 'iso',
  'application/json': 'json',
  'application/xml': 'xml',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/webm': 'weba',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/mp2t': 'ts',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
};

function extOf(name) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function categoryFor(fileName, categories = DEFAULT_CATEGORIES) {
  const ext = extOf(fileName);
  for (const c of categories) if (c.exts.includes(ext)) return c.id;
  return 'general';
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

function sanitizeFileName(name) {
  let n = String(name || '')
    .replace(ILLEGAL, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();
  if (!n) n = 'download';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n; // Windows reserved names
  // Keep names well under common 255-byte limits while preserving the extension.
  if (Buffer.byteLength(n) > 200) {
    const ext = extOf(n);
    const base = n.slice(0, 180 - ext.length);
    n = ext ? `${base}.${ext}` : base;
  }
  return n;
}

function decodeRfc5987(value) {
  const m = /^([\w-]+)'[^']*'(.*)$/.exec(value);
  if (!m) return null;
  try {
    const bytes = m[2].replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const charset = m[1].toLowerCase();
    return Buffer.from(bytes, 'latin1').toString(charset === 'utf-8' || charset === 'utf8' ? 'utf8' : 'latin1');
  } catch {
    return null;
  }
}

/** Extracts a filename from a Content-Disposition header value. */
function parseContentDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*("?)([^";]+)\1/i.exec(header);
  if (star) {
    const v = decodeRfc5987(star[2].trim());
    if (v) return v;
  }
  const quoted = /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header);
  if (quoted) return fixMojibake(quoted[1].replace(/\\(.)/g, '$1'));
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare) return fixMojibake(bare[1].trim());
  return null;
}

// Node decodes header bytes as latin1; many servers send raw UTF-8 filenames.
function fixMojibake(s) {
  if (!/[\u0080-\u00ff]/.test(s)) return s;
  const utf8 = Buffer.from(s, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? s : utf8;
}

function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
    return u.hostname;
  } catch {
    return '';
  }
}

/** Decides the best filename from response headers + URL. */
function resolveFileName({ url, headers = {}, suggested }) {
  let name = suggested || parseContentDisposition(headers['content-disposition']) || fileNameFromUrl(url);
  name = sanitizeFileName(name);
  if (!extOf(name)) {
    const mime = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = MIME_EXT[mime];
    if (ext && ext !== 'html') name = `${name}.${ext}`;
  }
  return name;
}

/** Returns a path that does not exist on disk and is not in `reserved`, IDM style: "name (2).ext". */
function uniquePath(dir, fileName, reserved = new Set()) {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  let candidate = path.join(dir, fileName);
  for (let i = 2; exists(candidate) || exists(candidate + '.vdm') || reserved.has(candidate); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Writes JSON atomically (temp file + rename) so a crash never leaves a truncated file. */
let tmpCounter = 0;
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.promises.rename(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function formatBytes(n) {
  if (n == null || n < 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${units[i]}`;
}

module.exports = {
  DEFAULT_CATEGORIES,
  MIME_EXT,
  extOf,
  categoryFor,
  sanitizeFileName,
  parseContentDisposition,
  fileNameFromUrl,
  resolveFileName,
  uniquePath,
  exists,
  writeJsonAtomic,
  readJson,
  formatBytes,
};
