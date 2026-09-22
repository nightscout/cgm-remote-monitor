'use strict';

const ConnectError = require('../errors');
const policy = require('./policy');
const fs = require('node:fs');

module.exports = function browserClient() {
  let sequence = 0;
  function available() { return process.env.NIGHTSCOUT_BROWSER_BROKER === '1' && typeof process.send === 'function'; }
  function headroom() {
    try {
      const limit = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      const used = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
      if (limit !== 'max' && Number(limit) - used < 512 * 1048576) throw new ConnectError('insufficient_memory', 503);
    } catch (err) { if (err instanceof ConnectError) throw err; }
  }
  async function open(options) {
    if (!available()) throw new ConnectError('worker_unavailable', 503);
    headroom();
    const pending = new Map();
    let closed = false;
    function message(m) {
      if (!m || !m.carelink) return;
      if (m.request && pending.has(m.request)) {
        const p = pending.get(m.request); pending.delete(m.request); clearTimeout(p.timer);
        if (m.error) p.reject(new ConnectError(m.error, 503)); else p.resolve(m.result);
      }
      if (closed) return;
      if (m.event === 'frame') options.onFrame(m.frame);
      if (m.event === 'redirect') options.onRedirect(m.url);
      if (m.event === 'blocked-host') options.onBlocked?.(m.host);
      if (m.event === 'failed') {
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new ConnectError('worker_unavailable', 503)); }
        pending.clear(); options.onError();
      }
    }
    process.on('message', message);
    function send(command, extra = {}) {
      const request = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(request); reject(new ConnectError('worker_unavailable', 503)); }, 30000);
        pending.set(request, { resolve, reject, timer });
        process.send({ carelink: true, command, request, ...extra });
      });
    }
    async function close() {
      if (closed) return;
      closed = true;
      try { await send('stop'); } finally {
        process.removeListener('message', message);
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new ConnectError('worker_unavailable', 503)); }
        pending.clear();
      }
    }
    try {
      await send('start', { options: { url: options.url, width: options.width, height: options.height } });
    } catch (err) { await close().catch(() => {}); throw err; }
    return { close, input: value => {
      let input;
      try { input = policy.input(value, options.width, options.height); }
      catch (_) { throw new ConnectError('invalid_input'); }
      return send('input', { input });
    } };
  }
  return { available, open };
};
