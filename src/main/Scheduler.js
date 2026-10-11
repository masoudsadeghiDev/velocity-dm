'use strict';
// Starts/stops queues at scheduled times (IDM "Scheduler").

class Scheduler {
  constructor(manager, { now = () => new Date() } = {}) {
    this.manager = manager;
    this.now = now;
    this.fired = new Map(); // `${queueId}:start|stop` -> 'YYYY-MM-DD HH:MM'
  }

  start(intervalMs = 15000) {
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    const d = this.now();
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const stamp = `${d.toDateString()} ${hhmm}`;
    for (const q of this.manager.queues) {
      const s = q.schedule;
      if (!s?.enabled) continue;
      const dayOk = s.once || (s.days || []).includes(d.getDay());
      if (dayOk && s.startTime === hhmm && this.fired.get(`${q.id}:start`) !== stamp) {
        this.fired.set(`${q.id}:start`, stamp);
        if (!q.running) this.manager.startQueue(q.id);
        if (s.once) this.manager.updateQueue(q.id, { schedule: { enabled: s.stopEnabled } });
      }
      if (s.stopEnabled && s.stopTime === hhmm && this.fired.get(`${q.id}:stop`) !== stamp) {
        this.fired.set(`${q.id}:stop`, stamp);
        if (q.running) this.manager.stopQueue(q.id);
        if (s.once) this.manager.updateQueue(q.id, { schedule: { enabled: false } });
      }
    }
  }

  /** Next start time for display, or null. */
  nextRun(q) {
    const s = q.schedule;
    if (!s?.enabled || !s.startTime) return null;
    const [h, m] = s.startTime.split(':').map(Number);
    const base = this.now();
    for (let i = 0; i < 8; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      d.setHours(h, m, 0, 0);
      if (d > base && (s.once || (s.days || []).includes(d.getDay()))) return d.getTime();
    }
    return null;
  }
}

module.exports = { Scheduler };
