'use strict';

const c = require('./contract');
// Publish on change (decision cost-proportional-to-activity, D6). Each
// interval the runtime asks `detect` for every tenant's write-clock stamp and
// configuration identity in one call, and refreshes only a tenant whose stamp
// moved past the checkpoint it last published, whose configuration changed,
// or whose last refresh failed. Without `detect` every tenant is refreshed
// each interval (the earlier backstop); the protocol still sends nothing when
// the view is unchanged. `wake(tenant)` is the seam for a later NOTIFY or slot
// reader: a hint that the next check should run now; it never carries data.
const { limited } = require('../serve/tenant-startup');
module.exports = async function start ({ tenants, readCurrent, create, fanout, recoveryIntervalMs,
  operationWindow, prepareTenant, detect, concurrency = Infinity, now = Date.now, schedule = setInterval, cancel = clearInterval,
  startupConcurrency = require('../serve/pool-config').startupConcurrency(), readiness = 'all', failureRetryMs = 30000, onReady }) {
  if (!Array.isArray(tenants) || !tenants.length || new Set(tenants).size !== tenants.length || tenants.some(id => !c.uuid(id)) ||
      [readCurrent, create, fanout, now, schedule, cancel].some(fn => typeof fn !== 'function') || !c.integer(recoveryIntervalMs, 2147483647)) throw new TypeError('Realtime requires explicit bounded runtime dependencies');
  if (operationWindow !== undefined && [operationWindow.run, operationWindow.current].some(fn => typeof fn !== 'function')) throw new TypeError('Realtime operation window required');
  if (detect !== undefined && typeof detect !== 'function') throw new TypeError('Realtime change detection must be a function');
  if (concurrency !== Infinity && !c.integer(concurrency)) throw new TypeError('Realtime refresh concurrency must be a positive integer');
  if (!['all', 'serve'].includes(readiness) || !c.integer(failureRetryMs, 2147483647)) throw new TypeError('Realtime readiness must be all or serve, with a failure retry interval');
  let closed = false;
  const cells = new Map(tenants.map(tenant => [tenant, { generation: 0, healthy: false, last: null, component: null, woken: false, waiters: [], failures: 0 }]));
  const counters = { ticks: 0, refreshes: 0, detected: 0, detectFailures: 0 };
  const notWarm = () => Object.assign(new Error('REALTIME_TENANT_NOT_WARM'), { code: 'REALTIME_TENANT_NOT_WARM' });
  async function refresh (tenant) {
    const cell = cells.get(tenant); if (!cell || closed) c.fail('REALTIME_CLOSED_OR_UNKNOWN');
    if (cell.pending) return cell.pending;
    const generation = cell.generation;
    const cycle = async () => {
      // Sockets waiting for fresh data take the first cycle that starts after
      // they asked (fresh): its reads follow their arrival.
      const waiting = cell.waiters.splice(0);
      try {
        if (prepareTenant) await prepareTenant(tenant);
        const current = await readCurrent(tenant);
        if (!current) { cell.last = null; cell.component = null; cell.healthy = false; c.fail('REALTIME_TENANT_DISABLED'); }
        if (!cell.component || cell.identity !== current.identity) {
          cell.last = null; cell.healthy = false; cell.component = create(current); cell.identity = current.identity;
        }
        counters.refreshes++;
        const result = await cell.component.acquire({ at: now() });
        const checked = await readCurrent(tenant);
        if (closed || generation !== cell.generation || !checked || checked.identity !== current.identity) c.fail('REALTIME_CYCLE_CHANGED');
        const next = Object.freeze({ ...result, identity: current.identity });
        await fanout({ tenant, previous: cell.last, next });
        if (closed || generation !== cell.generation) c.fail('REALTIME_CYCLE_CHANGED');
        const wasCold = !cell.healthy;
        cell.last = next; cell.healthy = true; cell.verifiedAt = now(); cell.failedAt = 0; cell.failures = 0;
        if (wasCold && onReady) { try { onReady(tenant); } catch { /* a listener never fails a refresh */ } }
        for (const waiter of waiting) waiter.resolve(next);
        return next;
      } catch (error) { cell.healthy = false; cell.failedAt = now(); cell.failures++; for (const waiter of waiting) waiter.reject(error); throw error; }
    };
    cell.pending = (operationWindow ? operationWindow.run(tenant, cycle) : cycle()).catch(error => {
      cell.healthy = false;
      if (require('../../tenant-lifecycle/operation-window').isSuspension(error)) { cell.last = null; cell.component = null; }
      throw error;
    }).finally(() => {
      cell.pending = null;
      if (!cell.waiters.length) return;
      // Waiters that arrived during this cycle need the next one; a tenant
      // gone cold sends them back to wait for the runtime's warm instead.
      if (closed || !cell.healthy || !cell.last) for (const waiter of cell.waiters.splice(0)) waiter.reject(notWarm());
      else { cell.woken = true; tick().catch(() => {}); }
    });
    return cell.pending;
  }
  // The stamp read for the tick against the checkpoint of the last published
  // refresh (the clock floor read in the same snapshot as its rows).
  function due (tenant, seen) {
    const cell = cells.get(tenant);
    if (cell.woken && cell.healthy && cell.last) return true;
    if (!cell.healthy || !cell.last) return false; // warm-up and retries take a share (tick)
    if (!seen) return true;
    const token = seen.get(tenant);
    if (!token) return false;
    return token.identity !== cell.identity || token.stamp === null || String(token.stamp) !== String(cell.last.checkpoint);
  }
  let ticking = null, again = false;
  function tick () {
    if (closed) return Promise.resolve();
    if (ticking) { again = true; return ticking; }
    ticking = (async () => {
      do {
        again = false; counters.ticks++;
        let seen = null;
        if (detect) {
          try { seen = await detect(tenants); counters.detected++; }
          catch { counters.detectFailures++; seen = new Map(); } // retry only failed cells until detection answers
        }
        if (closed) return;
        const selected = tenants.filter(tenant => due(tenant, seen));
        // Cold tenants (serve-then-warm) and failed ones (after failureRetryMs)
        // warm a bounded number per tick, so warm-up never holds up the
        // changes of tenants already serving. One broken tenant is retried,
        // the others serve.
        const at = now();
        // A cold tenant a socket is waiting for (woken) goes first.
        // A failed tenant waits failureRetryMs, unless sockets wait for it
        // (woken): then it backs off from the tick interval up to that bound,
        // so a transient refusal (pool pressure) does not dark it for the
        // whole interval.
        const retryAfter = cell => cell.woken ? Math.min(failureRetryMs, recoveryIntervalMs * 2 ** Math.min(Math.max(cell.failures - 1, 0), 20)) : failureRetryMs;
        selected.push(...tenants.filter(tenant => { const cell = cells.get(tenant);
          return (!cell.healthy || !cell.last) && (!cell.failedAt || at - cell.failedAt >= retryAfter(cell)); })
          .sort((a, b) => Number(cells.get(b).woken) - Number(cells.get(a).woken))
          .slice(0, Math.max(1, Number.isFinite(concurrency) ? concurrency * 2 : tenants.length)));
        // No periodic refresh of an unchanged tenant (decision
        // write-clock-complete): every write, hard deletes included, moves
        // the stamp, so an unmoved stamp is an unchanged tenant.
        for (const tenant of selected) cells.get(tenant).woken = false;
        await limited(selected, concurrency, refresh);
      } while (again && !closed);
    })().finally(() => { ticking = null; });
    return ticking;
  }
  let timer;
  try {
    // Active tenants initialize before sockets open. Genuine suspended tenants
    // retry through the same gate on refresh; other startup failures remain hard.
    // Decision readiness-serve-then-warm. 'all': configured tenants initialize
    // before sockets open, and a failure refuses the boot (as before). 'serve':
    // the role opens at once; ticks warm cold tenants a bounded number at a
    // time, and a socket for a cold tenant waits in the priming queue.
    if (readiness === 'all') {
      const startup = require('../serve/tenant-startup');
      const results = await startup.settleLimited(tenants, startupConcurrency, tenant => startup.attempt(operationWindow, tenant, () => refresh(tenant)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    timer = schedule(() => tick(), recoveryIntervalMs);
    if (readiness === 'serve') tick().catch(() => {});
    return Object.freeze({ refresh, tick,
      wake (tenant) { const cell = cells.get(tenant); if (!cell || closed) return; cell.woken = true; tick().catch(() => {}); },
      // Warm: initialized and holding a published projection.
      warm (tenant) { const cell = cells.get(tenant); return !!cell && !closed && cell.healthy && !!cell.last; },
      async invalidateTenant (tenant) {
        const cell = cells.get(tenant); if (!cell || closed) c.fail('REALTIME_CLOSED_OR_UNKNOWN');
        cell.generation++;
        await Promise.allSettled([cell.pending]);
        cell.last = null; cell.component = null; cell.identity = null; cell.healthy = false;
      },
      last (tenant) { const cell = cells.get(tenant); return !closed && cell?.healthy && (!operationWindow || operationWindow.current(tenant)) ? cell.last : null; },
      // Fresh data for a socket that primes on a warm tenant: the tenant is
      // woken into the tick's bounded share and the socket takes the first
      // cycle that starts after it asked. All sockets of a tenant share that
      // cycle; a socket never acquires its tenant itself.
      fresh (tenant) {
        const cell = cells.get(tenant);
        if (!cell || closed || !cell.healthy || !cell.last) return Promise.reject(notWarm());
        return new Promise((resolve, reject) => { cell.waiters.push({ resolve, reject }); cell.woken = true; tick().catch(() => {}); });
      },
      stats: () => Object.freeze({ ...counters }),
      health () { const healthy = [...cells.values()].filter(cell => cell.healthy).length;
        return Object.freeze({ live: !closed, readiness, ready: !closed && (readiness === 'serve' || healthy === cells.size), configured: cells.size,
        healthy, failed: [...cells.values()].filter(cell => !cell.healthy && cell.failedAt).length,
        tenants: [...cells].map(([tenant, cell]) => ({ tenant, ready: !closed && cell.healthy })) }); },
      async close () {
        if (closed) return; closed = true; cancel(timer);
        for (const cell of cells.values()) cell.generation++;
        await Promise.allSettled([...cells.values()].map(cell => cell.pending).filter(Boolean));
        for (const cell of cells.values()) for (const waiter of cell.waiters.splice(0)) waiter.reject(notWarm());
      }
    });
  } catch (error) { closed = true; if (timer) cancel(timer); for (const cell of cells.values()) for (const waiter of cell.waiters.splice(0)) waiter.reject(notWarm()); await Promise.allSettled([...cells.values()].map(cell => cell.pending).filter(Boolean)); throw error; }
};
