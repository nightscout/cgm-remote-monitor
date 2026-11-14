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
  operationWindow, prepareTenant, eligible, detect, watchedTenants, workerState, concurrency = Infinity, now = Date.now, schedule = setInterval, cancel = clearInterval,
  startupConcurrency = require('../serve/pool-config').startupConcurrency(), readiness = 'all', failureRetryMs = 30000, onReady, eventDriven = false, durableOutput = false, checkBatchSize = 64, dynamic = false, maxTenants = 10000 }) {
  if (!Array.isArray(tenants) || (!dynamic && !tenants.length) || new Set(tenants).size !== tenants.length || tenants.some(id => !c.uuid(id)) ||
      [readCurrent, create, fanout, now, schedule, cancel].some(fn => typeof fn !== 'function') || !c.integer(recoveryIntervalMs, 2147483647)) throw new TypeError('Realtime requires explicit bounded runtime dependencies');
  if (operationWindow !== undefined && [operationWindow.run, operationWindow.current].some(fn => typeof fn !== 'function')) throw new TypeError('Realtime operation window required');
  if (eligible !== undefined && typeof eligible !== 'function') throw new TypeError('Explicit realtime startup eligibility required');
  if (workerState !== undefined && typeof workerState !== 'function') throw new TypeError('Trusted realtime worker state required');
  if (watchedTenants !== undefined && typeof watchedTenants !== 'function') throw new TypeError('Realtime watched tenant reader required');
  if (detect !== undefined && typeof detect !== 'function') throw new TypeError('Realtime change detection must be a function');
  if (concurrency !== Infinity && !c.integer(concurrency)) throw new TypeError('Realtime refresh concurrency must be a positive integer');
  if (!['all', 'serve'].includes(readiness) || !c.integer(failureRetryMs, 2147483647)) throw new TypeError('Realtime readiness must be all or serve, with a failure retry interval');
  if(typeof dynamic!=='boolean' || !Number.isSafeInteger(maxTenants) || maxTenants<1)throw new TypeError('Explicit dynamic tenant bound required');
  if (typeof durableOutput !== 'boolean' || typeof eventDriven !== 'boolean' || !c.integer(checkBatchSize,1024)) throw new TypeError('Bounded realtime event scheduler required');
  tenants = [...tenants];
  const dirty = new Set(), cold = new Set(tenants);
  let closed = false;
  const makeCell = () => ({ generation: 0,healthy:false,last:null,component:null,woken:false,waiters:[],failures:0 });
  const cells = new Map(tenants.map(tenant => [tenant,makeCell()]));
  const epoch = () => workerState ? workerState() : { available: true, generation: 0 };
  const workerReady = cell => { const current = epoch(); return current.available && (cell?.workerGeneration === undefined || cell.workerGeneration === current.generation); };
  function assertWorker (expected) { const current = epoch(); if (!current.available || current.generation !== expected.generation) c.fail('TRUSTED_WORKER_UNAVAILABLE'); }
  const counters = { ticks: 0, refreshes: 0, detected: 0, detectFailures: 0 };
  const notWarm = () => Object.assign(new Error('REALTIME_TENANT_NOT_WARM'), { code: 'REALTIME_TENANT_NOT_WARM' });
  async function refresh (tenant) {
    const cell = cells.get(tenant); if (!cell || closed) c.fail('REALTIME_CLOSED_OR_UNKNOWN');
    if (cell.pending) return cell.pending;
    const generation = cell.generation, worker = epoch();
    const cycle = async () => {
      // Sockets waiting for fresh data take the first cycle that starts after
      // they asked (fresh): its reads follow their arrival.
      const waiting = cell.waiters.splice(0);
      try {
        assertWorker(worker);
        const current = await readCurrent(tenant);
        if (!current) { cell.disabled = true; cell.last = null; cell.component = null; cell.healthy = false; c.fail('REALTIME_TENANT_DISABLED'); }
        cell.disabled = false; cell.suspended = false;
        if (prepareTenant) await prepareTenant(tenant);
        if (!cell.component || cell.identity !== current.identity) {
          cell.last = null; cell.healthy = false; cell.component = create(current); cell.identity = current.identity;
        }
        counters.refreshes++;
        const result = await cell.component.acquire({ at: now() });
        const checked = await readCurrent(tenant);
        if (closed || generation !== cell.generation || !checked || checked.identity !== current.identity) c.fail('REALTIME_CYCLE_CHANGED');
        assertWorker(worker);
        const next = Object.freeze({ ...result, identity: current.identity });
        await fanout({ tenant, previous: cell.last, next, assertCurrent: () => assertWorker(worker) });
        if (closed || generation !== cell.generation) c.fail('REALTIME_CYCLE_CHANGED');
        assertWorker(worker);
        const wasCold = !cell.healthy || !workerReady(cell);
        cell.workerGeneration = worker.generation;
        cell.last = next; cell.healthy = true; cold.delete(tenant); cell.verifiedAt = now(); cell.failedAt = 0; cell.failures = 0;
        if (wasCold && onReady) { try { onReady(tenant); } catch { /* a listener never fails a refresh */ } }
        for (const waiter of waiting) waiter.resolve(next);
        return next;
      } catch (error) { if(cells.get(tenant)===cell)cold.add(tenant); cell.healthy = false; cell.failedAt = now(); cell.failures++; for (const waiter of waiting) waiter.reject(error); throw error; }
    };
    cell.pending = (operationWindow ? operationWindow.run(tenant, cycle) : cycle()).catch(error => {
      cell.healthy = false;
      if (require('../../tenant-lifecycle/operation-window').isSuspension(error)) { cell.last = null; cell.component = null; cell.suspended = true; }
      throw error;
    }).finally(() => {
      cell.pending = null;
      if (!cell.waiters.length) return;
      // Waiters that arrived during this cycle need the next one; a tenant
      // gone cold sends them back to wait for the runtime's warm instead.
      if (closed || !cell.healthy || !cell.last) for (const waiter of cell.waiters.splice(0)) waiter.reject(notWarm());
      else { cell.woken = true; dirty.add(tenant); tick().catch(() => {}); }
    });
    return cell.pending;
  }
  // The stamp read for the tick against the checkpoint of the last published
  // refresh (the clock floor read in the same snapshot as its rows).
  function due (tenant, seen) {
    const cell = cells.get(tenant);
    if (workerState && !workerReady(cell)) return epoch().available && !!seen?.get(tenant) && seen.get(tenant).identity !== null;
    if (durableOutput && cell.woken && !cell.healthy && !cell.disabled && seen?.get(tenant)?.identity) return true;
    if (cell.woken && cell.healthy && cell.last && (!detect || cell.waiters.length)) return true;
    if (!cell.healthy || !cell.last) return !!cell.disabled && !!seen?.get(tenant) && seen.get(tenant).identity !== null; // warm-up and retries take a share (tick)
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
        const wanted = [];
        if (eventDriven) {
          for (const tenant of dirty) { if (wanted.length >= checkBatchSize) break; wanted.push(tenant); dirty.delete(tenant); }
        } else wanted.push(...tenants);
        let seen = null;
        if (detect && wanted.length) {
          try { seen = await detect(wanted); counters.detected++; }
          catch (error) { counters.detectFailures++; if (workerState) { for (const tenant of wanted) dirty.add(tenant); throw error; } seen = new Map(); }
        }
        if (closed) return;
        // A committed control refusal invalidates the cached frame without
        // treating a paused tenant as failed work that retries forever.
        if (durableOutput && seen) for (const tenant of wanted) if (seen.get(tenant)?.identity === null) {
          const cell = cells.get(tenant); cell.generation++; cell.last = null; cell.component = null;
          cell.healthy = false; cell.disabled = true; cold.delete(tenant);
        }
        const watched = durableOutput && watchedTenants ? new Set(watchedTenants()) : null;
        const selected = wanted.filter(tenant => due(tenant,seen) && (!watched || watched.has(tenant) || cells.get(tenant).waiters.length));
        const at = now(), retryLimit = Math.max(1,Math.min(checkBatchSize,Number.isFinite(concurrency) ? concurrency * 2 : checkBatchSize));
        const retryAfter = cell => cell.woken ? Math.min(failureRetryMs,recoveryIntervalMs * 2 ** Math.min(Math.max(cell.failures-1,0),20)) : failureRetryMs;
        if (eventDriven) {
          // Rotate a fixed slice of cold cells; no all-tenant filter/sort per tick.
          let visited = 0;
          for (const tenant of cold) { if (visited++ >= retryLimit) break; cold.delete(tenant); cold.add(tenant);
            const cell = cells.get(tenant);
            if (!cell.failedAt || at-cell.failedAt >= retryAfter(cell)) if (!selected.includes(tenant)) selected.push(tenant);
          }
        } else selected.push(...tenants.filter(tenant => { const cell = cells.get(tenant);
          return (!cell.healthy || !cell.last) && (!cell.failedAt || at-cell.failedAt >= retryAfter(cell)); })
          .sort((a,b) => Number(cells.get(b).woken)-Number(cells.get(a).woken)).slice(0,retryLimit));
        // No periodic refresh of an unchanged tenant (decision
        // write-clock-complete): every write, hard deletes included, moves
        // the stamp, so an unmoved stamp is an unchanged tenant.
        for (const tenant of selected) cells.get(tenant).woken = false;
        await limited([...new Set(selected)], concurrency, refresh);
        if (eventDriven && dirty.size) again = true;
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
      const results = await startup.settleLimited(tenants, startupConcurrency, async tenant => {
        const cell=cells.get(tenant);
        if(eligible && await eligible(tenant)!==true){cell.disabled=true;cold.delete(tenant);return false;}
        const admitted=await startup.attempt(operationWindow,tenant,()=>refresh(tenant));
        if(!admitted){cell.suspended=true;cold.delete(tenant);}return admitted;
      });
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    timer = schedule(() => {
      // Recover missed hints for connected tenants on the existing scheduler.
      if (eventDriven && !durableOutput && watchedTenants) for (const tenant of watchedTenants()) if (cells.has(tenant)) dirty.add(tenant);
      return tick().catch(() => {});
    }, recoveryIntervalMs);
    if (readiness === 'serve') tick().catch(() => {});
    return Object.freeze({ refresh, tick,
      addTenant (tenant, prepared) {
        if (!dynamic || closed || !c.uuid(tenant) || cells.size >= maxTenants && !cells.has(tenant)) c.fail('REALTIME_DYNAMIC_TENANT_REFUSED');
        if(cells.has(tenant))return;
        const cell=makeCell();
        if(prepared!==undefined){
          if(workerState && (!epoch().available || prepared.workerGeneration !== epoch().generation)) c.fail('TRUSTED_WORKER_UNAVAILABLE');
          cell.workerGeneration = prepared.workerGeneration;
          if(prepared.current?.tenant!==tenant || typeof prepared.current.identity!=='string' || typeof prepared.component?.acquire!=='function' || prepared.next?.tenant!==tenant || !c.object(prepared.next.frame))c.fail('REALTIME_PREPARED_TENANT_REFUSED');
          cell.component=prepared.component;cell.identity=prepared.current.identity;cell.last=Object.freeze({...prepared.next,identity:cell.identity});cell.healthy=true;cell.verifiedAt=now();cell.failedAt=0;
        }
        cells.set(tenant,cell);tenants.push(tenant);
        if(prepared){try{onReady?.(tenant);}catch{/* observation cannot fail activation */}}else cold.add(tenant);
      },
      async removeTenant (tenant) { if(!dynamic)c.fail('REALTIME_DYNAMIC_TENANT_REFUSED');const cell=cells.get(tenant);if(!cell)return;cell.generation++;cells.delete(tenant);cold.delete(tenant);dirty.delete(tenant);const index=tenants.indexOf(tenant);if(index>=0)tenants.splice(index,1);for(const waiter of cell.waiters.splice(0))waiter.reject(notWarm());await Promise.allSettled([cell.pending]); },
      async check (requested) {
        if (!Array.isArray(requested) || requested.some(t => !cells.has(t))) throw new TypeError('Known realtime tenants required');
        for (const tenant of requested) { dirty.add(tenant); cells.get(tenant).woken = true; }
        await tick();
        const watched = new Set(watchedTenants?.() || []);
        return new Map(requested.map(tenant => { const cell=cells.get(tenant);
          return [tenant, !!cell && workerReady(cell) && (cell.healthy || cell.disabled || cell.suspended || durableOutput && !watched.has(tenant) && !cell.failedAt)]; }));
      },
      wake (tenant) { const cell = cells.get(tenant); if (!cell || closed) return; cell.woken = true; dirty.add(tenant); tick().catch(() => {}); },
      // Warm: initialized and holding a published projection.
      warm (tenant) { const cell = cells.get(tenant); return !!cell && !closed && workerReady(cell) && cell.healthy && !!cell.last; },
      // Connection/explicit delivery demand can arrive before a protocol peer
      // exists. Queue only that tenant through the bounded scheduler; readiness
      // inspection remains a pure warm() read and never admits a stale epoch.
      requestWarm (tenant) {
        const cell=cells.get(tenant);
        if(!cell || closed)return false;
        if(workerReady(cell) && cell.healthy && cell.last)return true;
        if(epoch().available){cell.woken=true;dirty.add(tenant);tick().catch(()=>{});}
        return false;
      },
      async invalidateTenant (tenant) {
        const cell = cells.get(tenant); if (!cell || closed) c.fail('REALTIME_CLOSED_OR_UNKNOWN');
        cell.generation++;
        await Promise.allSettled([cell.pending]);
        cell.last = null; cell.component = null; cell.identity = null; cell.healthy = false; cold.add(tenant);
      },
      last (tenant) { const cell = cells.get(tenant); return !closed && workerReady(cell) && cell?.healthy && (!operationWindow || operationWindow.current(tenant)) ? cell.last : null; },
      // Fresh data for a socket that primes on a warm tenant: the tenant is
      // woken into the tick's bounded share and the socket takes the first
      // cycle that starts after it asked. All sockets of a tenant share that
      // cycle; a socket never acquires its tenant itself.
      fresh (tenant) {
        const cell = cells.get(tenant);
        if (!cell || closed || !workerReady(cell) || !cell.healthy || !cell.last) return Promise.reject(notWarm());
        return new Promise((resolve, reject) => { cell.waiters.push({ resolve, reject }); cell.woken = true; dirty.add(tenant); tick().catch(() => {}); });
      },
      stats: () => Object.freeze({ ...counters }),
      health () { const healthy = [...cells.values()].filter(cell => workerReady(cell) && cell.healthy).length, deferred = [...cells.values()].filter(cell => !cell.healthy && (cell.disabled || cell.suspended)).length;
        return Object.freeze({ live: !closed, readiness, ready: !closed && workerReady() && (readiness === 'serve' || healthy + (eligible ? deferred : 0) === cells.size), configured: cells.size,
        healthy, deferred, failed: [...cells.values()].filter(cell => !cell.healthy && cell.failedAt).length,
        tenants: [...cells].map(([tenant, cell]) => ({ tenant, ready: !closed && workerReady(cell) && cell.healthy, ...(!cell.healthy && (cell.disabled || cell.suspended) ? { deferred: true } : {}) })) }); },
      async close () {
        if (closed) return; closed = true; cancel(timer);
        for (const cell of cells.values()) cell.generation++;
        await Promise.allSettled([...cells.values()].map(cell => cell.pending).filter(Boolean));
        for (const cell of cells.values()) for (const waiter of cell.waiters.splice(0)) waiter.reject(notWarm());
      }
    });
  } catch (error) { closed = true; if (timer) cancel(timer); for (const cell of cells.values()) for (const waiter of cell.waiters.splice(0)) waiter.reject(notWarm()); await Promise.allSettled([...cells.values()].map(cell => cell.pending).filter(Boolean)); throw error; }
};
