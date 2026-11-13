'use strict';

const { AsyncResource } = require('node:async_hooks');
// Operational verification is worker-owned, never inherited from a clinical
// timer, routed request or the tenant that happened to release a pool client.
module.exports = async function lifecycle (reader, { intervalMs = 600000, retryMs = 1000, now = Date.now, schedule = setInterval, cancel = clearInterval } = {}) {
  require('../tenant-lifecycle/operation-window').assertNoAmbientScope();
  if (require('../storage/tenant-scope').currentTenant() !== undefined) throw new Error('Trusted worker must open outside tenant scope');
  const context = new AsyncResource('nightscout-trusted-worker-operational');
  let closed = false, running, last = null;
  function verify () {
    if (closed) return Promise.reject(new Error('Trusted worker operational lifecycle closed'));
    if (!running) running = context.runInAsyncScope(async () => {
      await reader.verify(); last = now();
    }).finally(() => { running = null; });
    return running;
  }
  try { await verify(); } catch (error) { context.emitDestroy(); throw error; }
  const timer = schedule(() => {
    if (!closed && (!reader.health().available || now() - last >= intervalMs)) verify().catch(() => {});
  }, retryMs);
  timer?.unref?.();
  return Object.freeze({ verify,
    async close () { closed = true; cancel(timer); await Promise.allSettled([running]); context.emitDestroy(); }
  });
};
