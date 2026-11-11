'use strict';

const windows = require('../../tenant-lifecycle/operation-window');

// Only actual gate refusals defer tenant-local initialization. Metadata, binding,
// transport and application errors remain hard failures, including code lookalikes.
async function attempt (operationWindow, tenant, initialize) {
  if (operationWindow === undefined) { await initialize(); return true; }
  if (!windows.isWindow(operationWindow)) throw new TypeError('Actual operation window required for tenant startup');
  await operationWindow.ready();
  try { await operationWindow.run(tenant, initialize); return true; }
  catch (error) { if (windows.isSuspension(error)) return false; throw error; }
}

// Settles fn over items with at most `limit` in flight, in item order, with the
// shape of Promise.allSettled. Startup warm uses it so that N tenants never queue
// N callers on a pool whose connect timeout would refuse the excess.
async function settleLimited (items, limit, fn) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Positive startup concurrency required');
  const list = [...items], results = new Array(list.length);
  let next = 0;
  async function worker () {
    while (next < list.length) {
      const index = next++;
      try { results[index] = { status: 'fulfilled', value: await fn(list[index]) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return results;
}

function create (tenants, operationWindow, initialize, { concurrency = require('./pool-config').startupConcurrency() } = {}) {
  const cells = new Map([...tenants].map(tenant => [tenant, { generation: 0, complete: false, pending: null }]));
  async function ensure (tenant) {
    const cell = cells.get(tenant);
    if (!cell) throw new Error('Unknown startup tenant');
    if (operationWindow) operationWindow.assertCurrent(tenant);
    if (cell.complete) return;
    if (!cell.pending) {
      const generation = cell.generation;
      cell.pending = Promise.resolve().then(() => initialize(tenant)).then(() => {
        if (generation !== cell.generation) throw new Error('Tenant startup invalidated');
        cell.complete = true;
      }).finally(() => { cell.pending = null; });
    }
    return cell.pending;
  }
  return Object.freeze({ ensure,
    warm: async () => {
      const results = await settleLimited(cells.keys(), concurrency, tenant => attempt(operationWindow, tenant, () => ensure(tenant)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      return results.map(result => result.value);
    },
    invalidateTenant (tenant) {
      const cell = cells.get(tenant);
      if (!cell) throw new Error('Unknown startup tenant');
      cell.generation++; cell.complete = false;
    }
  });
}
module.exports = { attempt, create, settleLimited };
