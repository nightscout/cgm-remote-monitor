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

function create (tenants, operationWindow, initialize) {
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
      const results = await Promise.allSettled([...cells.keys()].map(tenant => attempt(operationWindow, tenant, () => ensure(tenant))));
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
module.exports = { attempt, create };
