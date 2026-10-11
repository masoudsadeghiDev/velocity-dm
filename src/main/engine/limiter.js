'use strict';
// Token-bucket speed limiter. Many connections can share one limiter; each
// consumer takes tokens for the bytes it read and sleeps while the bucket is in
// debt, which back-pressures the socket and throttles the real transfer rate.

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

class SpeedLimiter {
  constructor(bytesPerSecond = 0) {
    this.setRate(bytesPerSecond);
  }

  /** 0 or negative disables limiting. */
  setRate(bytesPerSecond) {
    this.rate = bytesPerSecond > 0 ? bytesPerSecond : 0;
    this.tokens = this.rate / 4;
    this.last = Date.now();
  }

  get enabled() {
    return this.rate > 0;
  }

  async take(bytes, signal) {
    if (!this.rate) return;
    const now = Date.now();
    // Allow a burst of at most a quarter second so the rate stays smooth.
    this.tokens = Math.min(this.rate / 4, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    this.tokens -= bytes;
    if (this.tokens < 0) await sleep((-this.tokens / this.rate) * 1000, signal);
  }
}

module.exports = { SpeedLimiter, sleep };
