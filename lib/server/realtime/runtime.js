'use strict';

const c = require('./contract');
module.exports = async function start ({ tenants, readCurrent, create, fanout, recoveryIntervalMs,
  operationWindow, prepareTenant, now = Date.now, schedule = setInterval, cancel = clearInterval }) {
  if (!Array.isArray(tenants) || !tenants.length || new Set(tenants).size !== tenants.length || tenants.some(id => !c.uuid(id)) ||
      [readCurrent, create, fanout, now, schedule, cancel].some(fn => typeof fn !== 'function') || !c.integer(recoveryIntervalMs, 2147483647)) throw new TypeError('Realtime requires explicit bounded runtime dependencies');
  if (operationWindow !== undefined && [operationWindow.run, operationWindow.current].some(fn => typeof fn !== 'function')) throw new TypeError('Realtime operation window required');
  let closed = false;
  const cells = new Map(tenants.map(tenant => [tenant, { generation: 0, healthy: false, last: null, component: null }]));
  async function refresh (tenant) {
    const cell = cells.get(tenant); if (!cell || closed) c.fail('REALTIME_CLOSED_OR_UNKNOWN');
    if (cell.pending) return cell.pending;
    const generation = cell.generation;
    const cycle = async () => {
      try {
        if (prepareTenant) await prepareTenant(tenant);
        const current = await readCurrent(tenant);
        if (!current) { cell.last = null; cell.component = null; cell.healthy = false; c.fail('REALTIME_TENANT_DISABLED'); }
        if (!cell.component || cell.identity !== current.identity) {
          cell.last = null; cell.healthy = false; cell.component = create(current); cell.identity = current.identity;
        }
        const result = await cell.component.acquire({ at: now() });
        const checked = await readCurrent(tenant);
        if (closed || generation !== cell.generation || !checked || checked.identity !== current.identity) c.fail('REALTIME_CYCLE_CHANGED');
        const next = Object.freeze({ ...result, identity: current.identity });
        await fanout({ tenant, previous: cell.last, next });
        if (closed || generation !== cell.generation) c.fail('REALTIME_CYCLE_CHANGED');
        cell.last = next; cell.healthy = true; return next;
      } catch (error) { cell.healthy = false; throw error; }
    };
    cell.pending = (operationWindow ? operationWindow.run(tenant, cycle) : cycle()).catch(error => {
      cell.healthy = false;
      if (require('../../tenant-lifecycle/operation-window').isSuspension(error)) { cell.last = null; cell.component = null; }
      throw error;
    }).finally(() => { cell.pending = null; });
    return cell.pending;
  }
  let timer;
  try {
    // Active tenants initialize before sockets open. Genuine suspended tenants
    // retry through the same gate on refresh; other startup failures remain hard.
    const results = await Promise.allSettled(tenants.map(tenant => require('../serve/tenant-startup').attempt(operationWindow, tenant, () => refresh(tenant))));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    timer = schedule(() => Promise.allSettled(tenants.map(refresh)), recoveryIntervalMs);
    return Object.freeze({ refresh,
      async invalidateTenant (tenant) {
        const cell = cells.get(tenant); if (!cell || closed) c.fail('REALTIME_CLOSED_OR_UNKNOWN');
        cell.generation++;
        await Promise.allSettled([cell.pending]);
        cell.last = null; cell.component = null; cell.identity = null; cell.healthy = false;
      },
      last (tenant) { const cell = cells.get(tenant); return !closed && cell?.healthy && (!operationWindow || operationWindow.current(tenant)) ? cell.last : null; },
      health () { return Object.freeze({ live: !closed, ready: !closed && [...cells.values()].every(cell => cell.healthy), configured: cells.size,
        tenants: [...cells].map(([tenant, cell]) => ({ tenant, ready: !closed && cell.healthy })) }); },
      async close () {
        if (closed) return; closed = true; cancel(timer);
        for (const cell of cells.values()) cell.generation++;
        await Promise.allSettled([...cells.values()].map(cell => cell.pending).filter(Boolean));
      }
    });
  } catch (error) { closed = true; if (timer) cancel(timer); await Promise.allSettled([...cells.values()].map(cell => cell.pending).filter(Boolean)); throw error; }
};
