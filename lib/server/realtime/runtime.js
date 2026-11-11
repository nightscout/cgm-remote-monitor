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
  operationWindow, prepareTenant, detect, concurrency = Infinity, absenceCheckMs, now = Date.now, schedule = setInterval, cancel = clearInterval,
  startupConcurrency = require('../serve/pool-config').startupConcurrency(), readiness = 'all', failureRetryMs = 30000 }) {
  if (!Array.isArray(tenants) || !tenants.length || new Set(tenants).size !== tenants.length || tenants.some(id => !c.uuid(id)) ||
      [readCurrent, create, fanout, now, schedule, cancel].some(fn => typeof fn !== 'function') || !c.integer(recoveryIntervalMs, 2147483647)) throw new TypeError('Realtime requires explicit bounded runtime dependencies');
  if (operationWindow !== undefined && [operationWindow.run, operationWindow.current].some(fn => typeof fn !== 'function')) throw new TypeError('Realtime operation window required');
  if (detect !== undefined && typeof detect !== 'function') throw new TypeError('Realtime change detection must be a function');
  if (concurrency !== Infinity && !c.integer(concurrency)) throw new TypeError('Realtime refresh concurrency must be a positive integer');
  if (absenceCheckMs !== undefined && !c.integer(absenceCheckMs, 2147483647)) throw new TypeError('Realtime absence check interval must be a positive integer');
  if (!['all', 'serve'].includes(readiness) || !c.integer(failureRetryMs, 2147483647)) throw new TypeError('Realtime readiness must be all or serve, with a failure retry interval');
  let closed = false;
  const cells = new Map(tenants.map(tenant => [tenant, { generation: 0, healthy: false, last: null, component: null, woken: false }]));
  const counters = { ticks: 0, refreshes: 0, detected: 0, detectFailures: 0 };
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
        counters.refreshes++;
        const result = await cell.component.acquire({ at: now() });
        const checked = await readCurrent(tenant);
        if (closed || generation !== cell.generation || !checked || checked.identity !== current.identity) c.fail('REALTIME_CYCLE_CHANGED');
        const next = Object.freeze({ ...result, identity: current.identity });
        await fanout({ tenant, previous: cell.last, next });
        if (closed || generation !== cell.generation) c.fail('REALTIME_CYCLE_CHANGED');
        cell.last = next; cell.healthy = true; cell.verifiedAt = now(); cell.failedAt = 0; return next;
      } catch (error) { cell.healthy = false; cell.failedAt = now(); throw error; }
    };
    cell.pending = (operationWindow ? operationWindow.run(tenant, cycle) : cycle()).catch(error => {
      cell.healthy = false;
      if (require('../../tenant-lifecycle/operation-window').isSuspension(error)) { cell.last = null; cell.component = null; }
      throw error;
    }).finally(() => { cell.pending = null; });
    return cell.pending;
  }
  // The stamp read for the tick against the checkpoint of the last published
  // refresh (the clock floor read in the same snapshot as its rows).
  function due (tenant, seen) {
    const cell = cells.get(tenant);
    if (cell.woken) return true;
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
        selected.push(...tenants.filter(tenant => { const cell = cells.get(tenant);
          return !cell.woken && (!cell.healthy || !cell.last) && (!cell.failedAt || at - cell.failedAt >= failureRetryMs); })
          .slice(0, Math.max(1, Number.isFinite(concurrency) ? concurrency * 2 : tenants.length)));
        // A hard delete leaves no stamp: every tenant is also refreshed (a
        // count when nothing changed, postgres-incremental-view) about every
        // absenceCheckMs. At most a fair share per tick, oldest first, after
        // the changed tenants, so absence checks never hold up change
        // detection (measured at 1,000 tenants: unbounded, one tick took
        // minutes and the stamp poll ran only between ticks).
        if (absenceCheckMs !== undefined) {
          const chosen = new Set(selected);
          const share = Math.max(1, Math.ceil(tenants.length * recoveryIntervalMs / absenceCheckMs));
          tenants.filter(tenant => !chosen.has(tenant) && at - (cells.get(tenant).verifiedAt || 0) >= absenceCheckMs)
            .sort((a, b) => (cells.get(a).verifiedAt || 0) - (cells.get(b).verifiedAt || 0)).slice(0, share)
            .forEach(tenant => selected.push(tenant));
        }
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
      async invalidateTenant (tenant) {
        const cell = cells.get(tenant); if (!cell || closed) c.fail('REALTIME_CLOSED_OR_UNKNOWN');
        cell.generation++;
        await Promise.allSettled([cell.pending]);
        cell.last = null; cell.component = null; cell.identity = null; cell.healthy = false;
      },
      last (tenant) { const cell = cells.get(tenant); return !closed && cell?.healthy && (!operationWindow || operationWindow.current(tenant)) ? cell.last : null; },
      stats: () => Object.freeze({ ...counters }),
      health () { const healthy = [...cells.values()].filter(cell => cell.healthy).length;
        return Object.freeze({ live: !closed, readiness, ready: !closed && (readiness === 'serve' || healthy === cells.size), configured: cells.size,
        healthy, failed: [...cells.values()].filter(cell => !cell.healthy && cell.failedAt).length,
        tenants: [...cells].map(([tenant, cell]) => ({ tenant, ready: !closed && cell.healthy })) }); },
      async close () {
        if (closed) return; closed = true; cancel(timer);
        for (const cell of cells.values()) cell.generation++;
        await Promise.allSettled([...cells.values()].map(cell => cell.pending).filter(Boolean));
      }
    });
  } catch (error) { closed = true; if (timer) cancel(timer); await Promise.allSettled([...cells.values()].map(cell => cell.pending).filter(Boolean)); throw error; }
};
