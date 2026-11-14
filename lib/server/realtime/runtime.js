'use strict';

const c = require('./contract');
// Drain addressed output/control demand and known cold work. Durable receipts
// own delivery retry/recovery; no timer discovers changed tenants.
const { limited } = require('../serve/tenant-startup');
module.exports = async function start ({ tenants, readCurrent, create, fanout, retryMs = 1000,
  operationWindow, prepareTenant, eligible, detect, watchedTenants, workerState, concurrency = Infinity, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
  startupConcurrency = require('../serve/pool-config').startupConcurrency(), readiness = 'all', failureRetryMs = 30000, onReady, checkBatchSize = 64, dynamic = false, maxTenants = 10000 }) {
  if (!Array.isArray(tenants) || (!dynamic && !tenants.length) || new Set(tenants).size !== tenants.length || tenants.some(id => !c.uuid(id)) ||
      [readCurrent, create, fanout, now, schedule, cancel].some(fn => typeof fn !== 'function') || !c.integer(retryMs, 2147483647)) throw new TypeError('Realtime requires explicit bounded runtime dependencies');
  if (operationWindow !== undefined && [operationWindow.run, operationWindow.current].some(fn => typeof fn !== 'function')) throw new TypeError('Realtime operation window required');
  if (eligible !== undefined && typeof eligible !== 'function') throw new TypeError('Explicit realtime startup eligibility required');
  if (workerState !== undefined && typeof workerState !== 'function') throw new TypeError('Trusted realtime worker state required');
  if (watchedTenants !== undefined && typeof watchedTenants !== 'function') throw new TypeError('Realtime watched tenant reader required');
  if (detect !== undefined && typeof detect !== 'function') throw new TypeError('Realtime change detection must be a function');
  if (concurrency !== Infinity && !c.integer(concurrency)) throw new TypeError('Realtime refresh concurrency must be a positive integer');
  if (!['all', 'serve'].includes(readiness) || !c.integer(failureRetryMs, 2147483647)) throw new TypeError('Realtime readiness must be all or serve, with a failure retry interval');
  if(typeof dynamic!=='boolean' || !Number.isSafeInteger(maxTenants) || maxTenants<1)throw new TypeError('Explicit dynamic tenant bound required');
  if (!c.integer(checkBatchSize,1024)) throw new TypeError('Bounded realtime event scheduler required');
  tenants = [...tenants];
  const dirty = new Set(), cold = new Set(tenants);
  let closed = false;
  const makeCell = () => ({ generation: 0,healthy:false,last:null,component:null,woken:false,waiters:[],failures:0,failedAt:null });
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
        cell.last = next; cell.healthy = true; cold.delete(tenant); cell.verifiedAt = now(); cell.failedAt = null; cell.failures = 0;
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
    if (cell.woken && !cell.healthy && !cell.disabled && seen?.get(tenant)?.identity) return true;
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
        for (const tenant of dirty) { if (wanted.length >= checkBatchSize) break; wanted.push(tenant); dirty.delete(tenant); }
        let seen = null;
        if (detect && wanted.length) {
          try { seen = await detect(wanted); counters.detected++; }
          catch(error){counters.detectFailures++;throw error;}
        }
        if (closed) return;
        // A committed control refusal invalidates the cached frame without
        // treating a paused tenant as failed work that retries forever.
        if (seen) for (const tenant of wanted) if (seen.get(tenant)?.identity === null) {
          const cell = cells.get(tenant); cell.generation++; cell.last = null; cell.component = null;
          cell.healthy = false; cell.disabled = true; cold.delete(tenant);
        }
        const watched = watchedTenants ? new Set(watchedTenants()) : null;
        const selected = wanted.filter(tenant => due(tenant,seen) && (!watched || watched.has(tenant) || cells.get(tenant).waiters.length || cells.get(tenant).demand));
        const at = now(), retryLimit = Math.max(1,Math.min(checkBatchSize,Number.isFinite(concurrency) ? concurrency * 2 : checkBatchSize));
        const retryAfter = cell => cell.woken ? Math.min(failureRetryMs,retryMs * 2 ** Math.min(Math.max(cell.failures-1,0),20)) : failureRetryMs;
        // Only known cold tenants have startup/retry demand. Warm tenants
        // leave this set and have no discovery timer.
        let visited=0;
        for(const tenant of cold){if(visited++>=retryLimit)break;cold.delete(tenant);cold.add(tenant);
          const cell=cells.get(tenant);
          if(cell.failedAt===null||at-cell.failedAt>=retryAfter(cell))if(!selected.includes(tenant))selected.push(tenant);
        }
        // No periodic refresh of an unchanged tenant (decision
        // write-clock-complete): every write, hard deletes included, moves
        // the stamp, so an unmoved stamp is an unchanged tenant.
        for (const tenant of selected) {cells.get(tenant).woken=false;cells.get(tenant).demand=false;}
        await limited([...new Set(selected)], concurrency, refresh);
        if (dirty.size) again = true;
      } while (again && !closed);
    })().finally(() => { ticking = null; armCold(); });
    return ticking;
  }
  let timer=null,timerAt=null;
  function armCold(){
    if(closed)return;
    let due=dirty.size?now():Infinity;
    for(const tenant of cold){const cell=cells.get(tenant);if(cell.disabled||cell.suspended)continue;
      if(cell.failedAt===null){due=now();break;}
      due=Math.min(due,cell.failedAt+(cell.woken?Math.min(failureRetryMs,retryMs*2**Math.min(Math.max(cell.failures-1,0),20)):failureRetryMs));
      if(due<=now())break;
    }
    if(!Number.isFinite(due)){if(timer)cancel(timer);timer=null;timerAt=null;return;}
    if(timer&&timerAt<=due)return;
    if(timer)cancel(timer);timerAt=due;
    timer=schedule(()=>{timer=null;timerAt=null;return tick().catch(()=>{});},Math.min(2147483647,Math.max(0,due-now())));timer?.unref?.();
  }

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
    if(readiness==='serve')tick().catch(()=>{});
    return Object.freeze({ refresh, tick,
      addTenant (tenant, prepared) {
        if (!dynamic || closed || !c.uuid(tenant) || cells.size >= maxTenants && !cells.has(tenant)) c.fail('REALTIME_DYNAMIC_TENANT_REFUSED');
        if(cells.has(tenant))return;
        const cell=makeCell();
        if(prepared!==undefined){
          if(workerState && (!epoch().available || prepared.workerGeneration !== epoch().generation)) c.fail('TRUSTED_WORKER_UNAVAILABLE');
          cell.workerGeneration = prepared.workerGeneration;
          if(prepared.current?.tenant!==tenant || typeof prepared.current.identity!=='string' || typeof prepared.component?.acquire!=='function' || prepared.next?.tenant!==tenant || !c.object(prepared.next.frame))c.fail('REALTIME_PREPARED_TENANT_REFUSED');
          cell.component=prepared.component;cell.identity=prepared.current.identity;cell.last=Object.freeze({...prepared.next,identity:cell.identity});cell.healthy=true;cell.verifiedAt=now();cell.failedAt=null;
        }
        cells.set(tenant,cell);tenants.push(tenant);
        if(prepared){try{onReady?.(tenant);}catch{/* observation cannot fail activation */}}else {cold.add(tenant);armCold();}
      },
      async removeTenant (tenant) { if(!dynamic)c.fail('REALTIME_DYNAMIC_TENANT_REFUSED');const cell=cells.get(tenant);if(!cell)return;cell.generation++;cells.delete(tenant);cold.delete(tenant);dirty.delete(tenant);const index=tenants.indexOf(tenant);if(index>=0)tenants.splice(index,1);for(const waiter of cell.waiters.splice(0))waiter.reject(notWarm());await Promise.allSettled([cell.pending]); },
      async check (requested) {
        if (!Array.isArray(requested) || requested.some(t => !cells.has(t))) throw new TypeError('Known realtime tenants required');
        for (const tenant of requested) { dirty.add(tenant); cells.get(tenant).woken = true; }
        await tick();
        const watched = new Set(watchedTenants?.() || []);
        return new Map(requested.map(tenant => { const cell=cells.get(tenant);
          return [tenant, !!cell && workerReady(cell) && (cell.healthy || cell.disabled || cell.suspended || !watched.has(tenant) && cell.failedAt===null)]; }));
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
        if(epoch().available){cell.woken=true;cell.demand=true;dirty.add(tenant);tick().catch(()=>{});}
        return false;
      },
      async invalidateTenant (tenant) {
        const cell = cells.get(tenant); if (!cell || closed) c.fail('REALTIME_CLOSED_OR_UNKNOWN');
        cell.generation++;
        await Promise.allSettled([cell.pending]);
        cell.last = null; cell.component = null; cell.identity = null; cell.healthy = false; cold.add(tenant);armCold();
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
        healthy, deferred, failed: [...cells.values()].filter(cell => !cell.healthy && cell.failedAt!==null).length,
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
