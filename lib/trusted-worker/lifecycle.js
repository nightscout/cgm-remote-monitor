'use strict';

const { AsyncResource } = require('node:async_hooks');
// Operational verification is worker-owned, never inherited from a clinical
// timer, routed request or the tenant that happened to release a pool client.
module.exports = async function lifecycle (reader, { intervalMs = 600000, retryMs = 1000, now = Date.now, schedule = setInterval, cancel = clearInterval, verifyWorker, refreshWorker, refreshMs = intervalMs } = {}) {
  if (verifyWorker !== undefined && typeof verifyWorker !== 'function') throw new TypeError('Trusted worker operational verifier required');
  if (refreshWorker !== undefined && (typeof refreshWorker !== 'function' || !Number.isSafeInteger(refreshMs) || refreshMs < 1)) throw new TypeError('Trusted worker refresh cadence required');
  const verifyAll = verifyWorker || (() => reader.verify());
  require('../tenant-lifecycle/operation-window').assertNoAmbientScope();
  if (require('../storage/tenant-scope').currentTenant() !== undefined) throw new Error('Trusted worker must open outside tenant scope');
  const context = new AsyncResource('nightscout-trusted-worker-operational');
  let closed = false, running, refreshing, last = null, lastRefresh, verified = 0, refreshed = 0;
  function verify (periodic = false) {
    if (closed) return Promise.reject(new Error('Trusted worker operational lifecycle closed'));
    if (!running) running = context.runInAsyncScope(async () => {
      await verifyAll(periodic); last = now(); verified++;
    }).finally(() => { running = null; });
    return running;
  }
  try { await verify(); } catch (error) { context.emitDestroy(); throw error; }
  lastRefresh = now(); refreshed = verified;
  const needsVerification = () => !reader.health().available || now() - last >= intervalMs;
  // One periodic pass owns verification followed by clinical epoch adoption.
  // Manual schema/transport verification remains verification-only: its caller
  // must first reopen its feed before clinical work is allowed to complete.
  function refresh () {
    if (!refreshing) refreshing = (async () => {
      if (needsVerification()) await verify(true);
      else if (running) await running;
      const version = verified;
      await refreshWorker();
      refreshed = version; lastRefresh = now();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  const timer = schedule(() => {
    if (closed) return;
    if (refreshWorker) {
      if (needsVerification() || refreshed !== verified || now() - lastRefresh >= refreshMs) refresh().catch(() => {});
    } else if (needsVerification()) verify(true).catch(() => {});
  }, retryMs);
  timer?.unref?.();
  return Object.freeze({ verify: () => verify(),
    version: () => verified,
    // Activate only after the initial model boot. A verification that completed
    // during boot still needs epoch adoption; never mark that newer pass done.
    activateRefresh (callback, cadence, bootVersion) {
      if (closed || typeof callback !== 'function' || !Number.isSafeInteger(cadence) || cadence < 1 ||
          !Number.isSafeInteger(bootVersion) || bootVersion < 1 || bootVersion > verified) throw new TypeError('Trusted worker refresh activation required');
      if (refreshWorker) throw new Error('Trusted worker refresh already active');
      refreshWorker = callback; refreshMs = cadence; refreshed = bootVersion; lastRefresh = now();
    },
    async close () { closed = true; cancel(timer); await Promise.allSettled([running, refreshing]); context.emitDestroy(); }
  });
};
