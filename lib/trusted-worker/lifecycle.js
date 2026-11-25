'use strict';

const { AsyncResource } = require('node:async_hooks');
// Explicit startup, schema and recovery verification runs outside the tenant
// that requests it. Clinical/delivery schedulers own their real pending work.
module.exports = async function lifecycle (reader, { verifyWorker } = {}) {
  if (verifyWorker !== undefined && typeof verifyWorker !== 'function') throw new TypeError('Trusted worker operational verifier required');
  const verifyAll = verifyWorker || (() => reader.verify());
  require('../tenant-lifecycle/generation-scope').assertNoAmbientScope();
  if (require('../storage/tenant-scope').currentTenant() !== undefined) throw new Error('Trusted worker must open outside tenant scope');
  const context = new AsyncResource('nightscout-trusted-worker-operational');
  let closed = false, running;
  function verify () {
    if (closed) return Promise.reject(new Error('Trusted worker operational lifecycle closed'));
    if (!running) running = context.runInAsyncScope(async () => { await verifyAll(); }).finally(() => { running = null; });
    return running;
  }
  try { await verify(); } catch (error) { context.emitDestroy(); throw error; }
  return Object.freeze({ verify,
    async close () { closed = true; await Promise.allSettled([running]); context.emitDestroy(); }
  });
};
