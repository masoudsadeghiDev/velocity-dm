'use strict';
// Minimal HTTP(S) client built on node:http/https so we have full control over
// ranges, redirects, socket timeouts, proxies and streaming bodies.

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

class HttpError extends Error {
  constructor(message, { status, code, retryable = true } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

// Status codes that will not get better by retrying the same request.
const FATAL_STATUSES = new Set([400, 401, 403, 404, 405, 410, 411, 412, 451]);

function proxyAuthHeader(proxy) {
  if (!proxy || !proxy.username) return null;
  return 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
}

// Opens a CONNECT tunnel through an HTTP proxy and returns a TLS socket to the target.
function connectTunnel(proxy, target, timeout, signal) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${target.hostname}:${target.port}` };
    const auth = proxyAuthHeader(proxy);
    if (auth) headers['Proxy-Authorization'] = auth;
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port}`,
      headers,
      timeout,
    });
    const onAbort = () => req.destroy(new HttpError('Aborted', { code: 'ABORTED', retryable: false }));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('connect', (res, socket) => {
      signal?.removeEventListener('abort', onAbort);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new HttpError(`Proxy CONNECT failed: ${res.statusCode}`, { status: res.statusCode }));
        return;
      }
      const secure = tls.connect({ socket, servername: target.hostname });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', reject);
    });
    req.once('timeout', () => req.destroy(new HttpError('Proxy connect timed out', { code: 'ETIMEDOUT' })));
    req.once('error', reject);
    req.end();
  });
}

/**
 * Sends a request and resolves once response headers arrive. Redirects are followed.
 * The caller owns the returned response stream and must consume or destroy it.
 *
 * @returns {Promise<{res: http.IncomingMessage, url: string, status: number, headers: object}>}
 */
async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    range,
    proxy,
    timeout = 30000,
    signal,
    maxRedirects = 10,
    auth,
  } = opts;

  let current = new URL(url);
  const originalOrigin = current.origin;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (signal?.aborted) throw new HttpError('Aborted', { code: 'ABORTED', retryable: false });
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new HttpError(`Unsupported protocol ${current.protocol}`, { retryable: false });
    }

    const sameOrigin = current.origin === originalOrigin;
    const h = {
      'User-Agent': DEFAULT_UA,
      Accept: '*/*',
      'Accept-Encoding': 'identity', // compressed bodies break byte ranges
      Connection: 'close',
      ...headers,
    };
    // Never leak credentials across origins on redirect.
    if (!sameOrigin) {
      delete h.Cookie;
      delete h.cookie;
      delete h.Authorization;
    } else if (auth?.username) {
      h.Authorization = 'Basic ' + Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64');
    }
    if (range) h.Range = range;

    const res = await sendOnce(current, method, h, { proxy, timeout, signal });
    const status = res.statusCode;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current);
      continue;
    }
    return { res, url: current.href, status, headers: res.headers };
  }
  throw new HttpError('Too many redirects', { retryable: false });
}

async function sendOnce(target, method, headers, { proxy, timeout, signal }) {
  const isHttps = target.protocol === 'https:';
  const port = target.port || (isHttps ? 443 : 80);
  const useProxy = proxy && proxy.enabled && proxy.host;
  let reqOpts;

  if (useProxy && !isHttps) {
    // Plain HTTP via proxy: absolute-form request line.
    const pAuth = proxyAuthHeader(proxy);
    reqOpts = {
      host: proxy.host,
      port: proxy.port,
      path: target.href,
      method,
      headers: { ...headers, Host: target.host, ...(pAuth ? { 'Proxy-Authorization': pAuth } : {}) },
    };
  } else {
    reqOpts = {
      host: target.hostname,
      port,
      path: target.pathname + target.search,
      method,
      headers: { ...headers, Host: target.host },
      servername: target.hostname,
    };
    if (useProxy && isHttps) {
      // createConnection is only honoured when no agent is set.
      const socket = await connectTunnel(proxy, { hostname: target.hostname, port }, timeout, signal);
      reqOpts.createConnection = () => socket;
    } else {
      reqOpts.agent = false;
    }
  }

  const mod = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(reqOpts);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    };
    const onAbort = () => {
      req.destroy();
      fail(new HttpError('Aborted', { code: 'ABORTED', retryable: false }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    req.setTimeout(timeout, () => req.destroy(new HttpError('Connection timed out', { code: 'ETIMEDOUT' })));
    req.once('error', (err) => fail(err instanceof HttpError ? err : new HttpError(err.message, { code: err.code })));
    req.once('response', (res) => {
      settled = true;
      // Keep the abort wired to the response body for streaming consumers.
      const onBodyAbort = () => res.destroy(new HttpError('Aborted', { code: 'ABORTED', retryable: false }));
      signal?.removeEventListener('abort', onAbort);
      if (signal) {
        signal.addEventListener('abort', onBodyAbort, { once: true });
        res.once('close', () => signal.removeEventListener('abort', onBodyAbort));
      }
      // Idle timeout while streaming the body.
      res.setTimeout?.(timeout, () => res.destroy(new HttpError('Read timed out', { code: 'ETIMEDOUT' })));
      if (!res.setTimeout) req.setTimeout(timeout, () => req.destroy(new HttpError('Read timed out', { code: 'ETIMEDOUT' })));
      resolve(res);
    });
    req.end();
  });
}

/** Fetches a whole (small) resource into memory. Used for playlists, keys and HTML pages. */
async function fetchBuffer(url, opts = {}, maxBytes = 50 * 1024 * 1024) {
  const { res, url: finalUrl, status, headers } = await request(url, opts);
  if (status >= 400) {
    res.resume();
    throw new HttpError(`HTTP ${status}`, { status, retryable: !FATAL_STATUSES.has(status) });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res) {
    total += chunk.length;
    if (total > maxBytes) {
      res.destroy();
      throw new HttpError('Response too large', { retryable: false });
    }
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), url: finalUrl, status, headers };
}

/** Parses "bytes 0-99/1234" → { start, end, total } (total may be -1 for "*"). */
function parseContentRange(value) {
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(value || '');
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? -1 : Number(m[3]) };
}

module.exports = { request, fetchBuffer, parseContentRange, HttpError, FATAL_STATUSES, DEFAULT_UA };
