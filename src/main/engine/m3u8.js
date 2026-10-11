'use strict';
// HLS playlist parsing (RFC 8216 subset needed for downloading VOD streams).

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

function parseByteRange(s, prevEnd) {
  const [len, off] = s.split('@');
  const length = Number(len);
  const offset = off != null ? Number(off) : prevEnd;
  return { offset, length };
}

function isMaster(text) {
  return /#EXT-X-STREAM-INF/.test(text);
}

/** Master playlist → variants (sorted best first) and alternate audio renditions. */
function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const media = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice(18));
      let uri = '';
      while (++i < lines.length && (!lines[i] || lines[i].startsWith('#')));
      uri = lines[i];
      if (!uri) continue;
      const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        url: new URL(uri, baseUrl).href,
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || 0),
        width: w || 0,
        height: h || 0,
        codecs: a.CODECS || '',
        audio: a.AUDIO || null,
        name: a.RESOLUTION ? `${h}p` : `${Math.round(Number(a.BANDWIDTH || 0) / 1000)} kbps`,
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      media.push({
        type: a.TYPE,
        groupId: a['GROUP-ID'],
        name: a.NAME,
        language: a.LANGUAGE,
        isDefault: a.DEFAULT === 'YES',
        url: a.URI ? new URL(a.URI, baseUrl).href : null,
      });
    }
  }
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return { variants, media };
}

/** Media playlist → ordered list of segments with encryption info. */
function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const segments = [];
  let seq = 0;
  let key = null;
  let map = null;
  let duration = 0;
  let byterange = null;
  let prevEnd = 0;
  let endList = false;
  let total = 0;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(line.slice(22)) || 0;
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      key =
        a.METHOD === 'NONE'
          ? null
          : { method: a.METHOD, url: a.URI ? new URL(a.URI, baseUrl).href : null, iv: a.IV || null };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      map = { url: new URL(a.URI, baseUrl).href, byterange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8)) || 0;
    else if (line.startsWith('#EXT-X-BYTERANGE:')) byterange = parseByteRange(line.slice(17), prevEnd);
    else if (line.startsWith('#EXT-X-ENDLIST')) endList = true;
    else if (!line.startsWith('#')) {
      const seg = { url: new URL(line, baseUrl).href, duration, seq, key, byterange };
      if (byterange) prevEnd = byterange.offset + byterange.length;
      segments.push(seg);
      total += duration;
      seq++;
      duration = 0;
      byterange = null;
    }
  }
  return { segments, map, endList, duration: total };
}

/** IV is explicit (0x…) or defaults to the media sequence number, big-endian. */
function segmentIv(seg) {
  if (seg.key?.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
    return Buffer.from(hex, 'hex');
  }
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seg.seq >>> 0, 12);
  iv.writeUInt32BE(Math.floor(seg.seq / 2 ** 32), 8);
  return iv;
}

module.exports = { isMaster, parseMaster, parseMedia, parseAttrs, segmentIv };
