'use strict';
// Local HTTP endpoint used by the browser extension to hand downloads over.
//
// Security: it only listens on 127.0.0.1, rejects foreign Host headers (DNS
// rebinding) and only accepts requests whose Origin is a browser extension.
// Browsers always attach Origin to cross-origin POSTs, so ordinary web pages
// cannot push downloads into the app.

const http = require('node:http');
const EventEmitter = require('node:events');

const EXT_ORIGIN = /^(chrome|moz|safari-web|ms-browser)-extension:\/\//i;

class BrowserBridge extends EventEmitter {
  constructor({ port, info }) {
    super();
    this.port = port;
    this.info = info; // () => object returned from /ping
    this.server = null;
  }

  start() {
    if (this.server) return Promise.resolve();
    this.server = http.createServer((req, res) => this._handle(req, res));
    return new Promise((resolve) => {
      this.server.once('error', (err) => {
        console.error(`Browser bridge could not listen on ${this.port}:`, err.message);
        this.server = null;
        this.emit('error', err);
        resolve();
      });
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  stop() {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    this.server.close();
    this.server = null;
  }

  async restart(port) {
    this.stop();
    this.port = port;
    await this.start();
  }

  _handle(req, res) {
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return send(res, 403, { error: 'bad host' });

    const origin = req.headers.origin;
    // No Origin = a local non-browser client (curl, scripts); those already have local access.
    if (origin && !EXT_ORIGIN.test(origin)) return send(res, 403, { error: 'forbidden origin' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return send(res, 204);

    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    if (req.method === 'GET' && url.pathname === '/ping') return send(res, 200, this.info());

    if (req.method === 'POST' && ['/download', '/batch', '/media'].includes(url.pathname)) {
      // HTML forms can't send JSON, and JSON from a page needs a preflight we refuse.
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json required' });
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 5 * 1024 * 1024) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(res, 400, { error: 'invalid json' });
        }
        const event = url.pathname.slice(1);
        if (event === 'batch') {
          if (!Array.isArray(body.links) || !body.links.length) return send(res, 400, { error: 'links required' });
        } else if (!body.url || !/^https?:\/\//i.test(body.url)) {
          return send(res, 400, { error: 'http(s) url required' });
        }
        this.emit(event, body);
        send(res, 200, { ok: true });
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  }
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    return res.end();
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

module.exports = { BrowserBridge };
