'use strict';
// Local HTTP server that imitates the behaviours real download servers have:
// byte ranges, throttling, connection limits, dropped connections, redirects,
// Content-Disposition names, basic auth, chunked bodies and HLS streams.
// Run directly (`node test/server.js`) to get a playground for the GUI.

const http = require('node:http');
const crypto = require('node:crypto');

const cache = new Map();
function data(size) {
  if (!cache.has(size)) {
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i++) b[i] = (i * 31 + (i >> 8) + (i >> 16)) & 0xff;
    cache.set(size, b);
  }
  return cache.get(size);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// HLS fixtures: N fake "TS" segments with recognisable content.
const HLS_KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
function hlsSegment(variant, i) {
  return Buffer.from(`[${variant}:segment-${i}:` + 'x'.repeat(5000 + i * 10) + ']');
}
function encrypt(buf, seq) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seq, 12);
  const c = crypto.createCipheriv('aes-128-cbc', HLS_KEY, iv);
  return Buffer.concat([c.update(buf), c.final()]);
}

function createServer() {
  const stats = { requests: 0, active: 0, maxActive: 0, ranges: [] };
  let flakyCount = 0;

  const server = http.createServer((req, res) => {
    stats.requests++;
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const route = parts[0];
    const q = Object.fromEntries(url.searchParams);

    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    res.once('close', () => stats.active--);

    if (q.maxconn && stats.active > Number(q.maxconn)) {
      res.writeHead(Number(q.limitstatus) || 503, { 'Retry-After': '1' });
      return res.end('busy');
    }

    // Signed, expiring links like many file hosts use: /signed/<size>/<name>?md5=…&u=…&expires=<unix>
    if (route === 'signed') {
      if (!q.md5 || !(Number(q.expires) > Date.now() / 1000)) {
        res.writeHead(403);
        return res.end('link expired');
      }
      parts[0] = 'file';
    }

    if (route === 'file' || route === 'signed' || route === 'cd' || route === 'flaky' || route === 'auth') {
      if (route === 'auth') {
        const expected = 'Basic ' + Buffer.from('user:secret').toString('base64');
        if (req.headers.authorization !== expected) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
          return res.end();
        }
      }
      const size = Number(parts[1]);
      const body = data(size);
      const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', ETag: '"v1"' };
      if (route === 'cd') headers['Content-Disposition'] = `attachment; filename="fallback.bin"; filename*=UTF-8''r%C3%A9sum%C3%A9%20final.pdf`;
      let start = 0;
      let end = size - 1;
      let status = 200;
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        stats.ranges.push([start, end]);
      }
      headers['Content-Length'] = end - start + 1;
      res.writeHead(status, headers);
      let dropAfter = Infinity;
      if (route === 'flaky' && flakyCount++ % 2 === 0) dropAfter = 150 * 1024;
      return stream(res, body.subarray(start, end + 1), Number(q.rate) || 0, dropAfter);
    }

    if (route === 'norange') {
      const size = Number(parts[1]);
      res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/zip' });
      return stream(res, data(size), Number(q.rate) || 0);
    }

    if (route === 'chunked') {
      const size = Number(parts[1]);
      res.writeHead(200, { 'Content-Type': 'application/pdf' }); // no length → chunked
      return stream(res, data(size), 0);
    }

    if (route === 'redirect') {
      res.writeHead(302, { Location: `/file/${parts[1]}${url.search}` });
      return res.end();
    }

    if (route === 'missing') {
      res.writeHead(404);
      return res.end('nope');
    }

    if (route === 'hls' || route === 'hls-enc') {
      const enc = route === 'hls-enc';
      const name = parts[1];
      const N = 12;
      if (name === 'master.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(
          '#EXTM3U\n' +
            `#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8${url.search}\n` +
            `#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720\nhigh.m3u8${url.search}\n`
        );
      }
      if (name === 'low.m3u8' || name === 'high.m3u8') {
        const v = name.replace('.m3u8', '');
        let pl = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n';
        if (enc) pl += '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n';
        for (let i = 0; i < N; i++) pl += `#EXTINF:4.0,\n${v}_${i}.ts${url.search}\n`; // tokens travel with segments
        pl += '#EXT-X-ENDLIST\n';
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(pl);
      }
      if (name === 'key.bin') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(HLS_KEY);
      }
      const sm = /^(low|high)_(\d+)\.ts$/.exec(name);
      if (sm) {
        let body = hlsSegment(sm[1], Number(sm[2]));
        if (enc) body = encrypt(body, Number(sm[2]));
        stats.segments = (stats.segments || 0) + 1;
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': body.length });
        return setTimeout(() => res.end(body), Number(q.delay) || 0);
      }
    }

    if (route === 'site') {
      const pages = {
        'index.html': `<html><body><a href="page2.html">next</a> <a href="/file/1000/a.zip">A</a>
          <a href='/norange/2000/b.pdf'>B</a> <img src="/file/300/pic.jpg"> <a href="https://elsewhere.example/c.zip">ext</a></body></html>`,
        'page2.html': `<a href="/file/4000/deep.mp3">deep</a> <a href="index.html">back</a> <a href="page3.html">3</a>`,
        'page3.html': `<a href="/file/5000/deeper.zip">deeper</a>`,
      };
      const page = pages[parts[1] || 'index.html'];
      if (!page) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(page);
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    stats,
    data,
    hlsSegment,
    listen: () =>
      new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
      ),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// Writes `buf` in small chunks, optionally throttled (bytes/sec), optionally dropping the socket.
function stream(res, buf, rate, dropAfter = Infinity) {
  const chunk = 16 * 1024;
  const t0 = Date.now();
  let off = 0;
  const pump = () => {
    if (res.destroyed) return;
    // Time-based budget so 'drain' events can't bypass the throttle.
    const allowed = rate ? Math.floor((rate * (Date.now() - t0)) / 1000) + chunk : Infinity;
    while (off < buf.length && off < allowed) {
      if (off >= dropAfter) return res.destroy();
      const n = Math.min(chunk, buf.length - off, dropAfter - off);
      const ok = res.write(buf.subarray(off, off + n));
      off += n;
      if (!ok) return res.once('drain', pump);
    }
    if (off >= buf.length) return res.end();
    setTimeout(pump, rate ? 20 : 0);
  };
  pump();
}

module.exports = { createServer, data, sha256, hlsSegment, HLS_KEY };

if (require.main === module) {
  const s = createServer();
  s.server.listen(Number(process.env.PORT) || 8765, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${s.server.address().port}`;
    console.log(`Test server on ${base}`);
    console.log(`  ${base}/file/52428800?rate=2000000   (50 MB, 2 MB/s per connection)`);
    console.log(`  ${base}/cd/5000000                   (Content-Disposition name)`);
    console.log(`  ${base}/hls/master.m3u8              (HLS stream)`);
  });
}
