'use strict';

const c = require('./contract');
// Drain addressed output/control demand and known cold work. Durable receipts
// own delivery retry/recovery; no timer discovers changed tenants.
module.exports = async function start ({ tenants, readCurrent, confirmCold, create, fanout, retryMs = 1000,
  operationWindow, prepareTenant, eligible, detect, isWatched, workerState, concurrency = Infinity, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
  startupConcurrency = require('../serve/pool-config').startupConcurrency(), readiness = 'all', failureRetryMs = 30000, refreshDeadlineMs = 30000, onReady, checkBatchSize = 64, dynamic = false, maxTenants = 10000, durableOutput = false }) {
  if (!Array.isArray(tenants) || (!dynamic && !tenants.length) || new Set(tenants).size !== tenants.length || tenants.some(id => !c.uuid(id)) ||
      [readCurrent, create, fanout, now, schedule, cancel].some(fn => typeof fn !== 'function') || !c.integer(retryMs, 2147483647)) throw new TypeError('Realtime requires explicit bounded runtime dependencies');
  if (operationWindow !== undefined && [operationWindow.run, operationWindow.current].some(fn => typeof fn !== 'function')) throw new TypeError('Realtime operation window required');
  if (eligible !== undefined && typeof eligible !== 'function') throw new TypeError('Explicit realtime startup eligibility required');
  if (workerState !== undefined && typeof workerState !== 'function') throw new TypeError('Trusted realtime worker state required');
  if (isWatched !== undefined && typeof isWatched !== 'function') throw new TypeError('Realtime watched tenant predicate required');
  if (detect !== undefined && typeof detect !== 'function') throw new TypeError('Realtime change detection must be a function');
  if (concurrency !== Infinity && !c.integer(concurrency)) throw new TypeError('Realtime refresh concurrency must be a positive integer');
  if (!['all', 'serve'].includes(readiness) || !c.integer(failureRetryMs, 2147483647)) throw new TypeError('Realtime readiness must be all or serve, with a failure retry interval');
  if(typeof dynamic!=='boolean' || !Number.isSafeInteger(maxTenants) || maxTenants<1)throw new TypeError('Explicit dynamic tenant bound required');
  if (!c.integer(checkBatchSize,1024) || !c.integer(refreshDeadlineMs, 2147483647)) throw new TypeError('Bounded realtime event scheduler required');
  tenants = [...tenants];
  const dirty = new Set(), cold = new Set(tenants);
  let closed = false;
  const makeCell = () => ({ generation: 0,healthy:false,last:null,component:null,woken:false,waiters:[],failures:0,failedAt:null,availableAt:null,publishingAt:null });
  // M1/M2 (lib/metrics): the oldest instant this process learned a completed
  // output was available and has not yet published it. Kept, never moved later.
  const noteAvailable = (cell, at) => { if (cell.availableAt === null || at < cell.availableAt) cell.availableAt = at; };
  const cells = new Map(tenants.map(tenant => [tenant,makeCell()]));
  const epoch = () => workerState ? workerState() : { available: true, generation: 0 };
  const workerReady = cell => { const current = epoch(); return current.available && (cell?.workerGeneration === undefined || cell.workerGeneration === current.generation); };
  function assertWorker (expected) { const current = epoch(); if (!current.available || current.generation !== expected.generation) c.fail('TRUSTED_WORKER_UNAVAILABLE'); }
  const counters = { ticks: 0, refreshes: 0, detected: 0, detectFailures: 0 }; let deadlines = 0;
  const notWarm = () => Object.assign(new Error('REALTIME_TENANT_NOT_WARM'), { code: 'REALTIME_TENANT_NOT_WARM' });
  async function refresh (tenant) {
    const cell = cells.get(tenant); if (!cell || closed) c.fail('REALTIME_CLOSED_OR_UNKNOWN');
    if (cell.pending) return cell.pending;
    const generation = cell.generation, worker = epoch();
    const assertCurrent = () => {
      if (closed || generation !== cell.generation) c.fail('REALTIME_CYCLE_CHANGED');
      assertWorker(worker);
    };
    const cycle = async () => {
      // Sockets waiting for fresh data take the first cycle that starts after
      // they asked (fresh): its reads follow their arrival.
      const waiting = cell.waiters.splice(0); cell.taken = waiting;
      // Notices before this cycle's read are covered by it; later ones wait for the next.
      const availableAt = cell.availableAt; cell.availableAt = null; cell.publishingAt = availableAt;
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
        // A first projection may wait on the API or storage. Check committed
        // activity and settings again before publishing this cold acquisition.
        const checked = await (!cell.healthy && confirmCold ? confirmCold(tenant) : readCurrent(tenant));
        if (closed || generation !== cell.generation || !checked || checked.identity !== current.identity) c.fail('REALTIME_CYCLE_CHANGED');
        assertWorker(worker);
        const next = Object.freeze({ ...result, identity: current.identity });
        try { await fanout({ tenant, previous: cell.last, next, assertCurrent, availableAt }); } finally { cell.publishingAt = null; }
        if (closed || generation !== cell.generation) c.fail('REALTIME_CYCLE_CHANGED');
        assertWorker(worker);
        const wasCold = !cell.healthy || !workerReady(cell);
        cell.workerGeneration = worker.generation;
        cell.last = next; cell.healthy = true; cold.delete(tenant); cell.verifiedAt = now(); cell.failedAt = null; cell.failures = 0;
        if (wasCold && onReady) { try { onReady(tenant); } catch { /* a listener never fails a refresh */ } }
        for (const waiter of waiting) waiter.resolve(next);
        return next;
      } catch (error) { cell.publishingAt = null; if(availableAt!==null)noteAvailable(cell,availableAt); if(cells.get(tenant)===cell)cold.add(tenant); cell.healthy = false; cell.failedAt = now(); cell.failures++; for (const waiter of waiting) waiter.reject(error); throw error; }
    };
    const inner = (operationWindow ? operationWindow.run(tenant, cycle) : cycle()).catch(error => {
      cell.healthy = false;
      if (require('../../tenant-lifecycle/generation-scope').isSuspension(error)) { cell.last = null; cell.component = null; cell.suspended = true; }
      throw error;
    });
    // One tenant's refresh is bounded. A read that never answers gives up its
    // cell (a late answer meets a changed generation and publishes nothing),
    // so the next demand starts a new refresh instead of waiting on it.
    cell.pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (generation === cell.generation) cell.generation++;
        cell.healthy = false; cell.failedAt = now(); cell.failures++; if (cells.get(tenant) === cell) cold.add(tenant);
        inner.catch(() => {}); // abandoned: shutdown and removal do not wait for it
        const error = Object.assign(new Error('REALTIME_REFRESH_DEADLINE'), { code: 'REALTIME_REFRESH_DEADLINE' });
        deadlines++;
        for (const waiter of (cell.taken || []).splice(0)) waiter.reject(error);
        reject(error);
      }, refreshDeadlineMs); timer.unref?.();
      inner.then(resolve, reject).finally(() => clearTimeout(timer));
    }).finally(() => {
      cell.pending = null;
      if (!cell.waiters.length) return;
      // Waiters that arrived during this cycle need the next one; a tenant
      // gone cold sends them back to wait for the runtime's warm instead.
      if (closed || !cell.healthy || !cell.last) for (const waiter of cell.waiters.splice(0)) waiter.reject(notWarm());
      else { cell.woken = true; dirty.add(tenant); pump().catch(() => {}); }
    });
    return cell.pending;
  }
  // A later input can leave a completed output waiting. Covering that input
  // with identical content produces no new output revision, so its existing
  // receipt must survive until watched viewers can receive it.
  function owesPendingPublication (cell) {
    const stamp = cell.upstreamPending?.stamp;
    return durableOutput && stamp !== undefined && stamp !== String(cell.last?.checkpoint);
  }
  // Compare the addressed stamp with the checkpoint of the last publication.
  function due (tenant, seen) {
    const cell = cells.get(tenant);
    if (seen?.get(tenant)?.deferred || seen?.get(tenant)?.pending) return false;
    if (workerState && !workerReady(cell)) return epoch().available && !!seen?.get(tenant) && seen.get(tenant).identity !== null;
    if (cell.woken && !cell.healthy && !cell.disabled && seen?.get(tenant)?.identity) return true;
    if (cell.woken && cell.healthy && cell.last && (!detect || cell.waiters.length)) return true;
    if (!cell.healthy || !cell.last) return !!cell.disabled && !!seen?.get(tenant) && seen.get(tenant).identity !== null; // warm-up and retries take a share (tick)
    if (!seen) return true;
    const token = seen.get(tenant);
    if (!token) return false;
    return token.identity !== cell.identity || token.stamp === null || String(token.stamp) !== String(cell.last.checkpoint);
  }
  // Refreshes run per tenant, at most `concurrency` at a time across the
  // process. The scheduling loop never waits for one: a tenant whose refresh
  // is slow or hung delays no other tenant's detection or publication.
  const flights = new Map(), rerun = new Set(), slots = [];
  let active = 0;
  function slot (fn) {
    return new Promise((resolve, reject) => {
      const run = () => { active++; let result; try { result = fn(); } catch (error) { result = Promise.reject(error); }
        Promise.resolve(result).then(resolve, reject).finally(() => { active--; slots.shift()?.(); }); };
      if (active < concurrency) run(); else slots.push(run);
    });
  }
  function launch (tenant) {
    if (flights.has(tenant)) { rerun.add(tenant); return; }
    const flight = slot(() => closed || !cells.has(tenant) ? undefined : refresh(tenant)).then(() => {}, () => {}).finally(() => {
      flights.delete(tenant); armCold();
      // Demand that arrived during this refresh is covered by the next one.
      if (rerun.delete(tenant) && !closed && cells.has(tenant)) { cells.get(tenant).woken = true; dirty.add(tenant); pump().catch(() => {}); }
    });
    flights.set(tenant, flight);
  }
  // Tests and shutdown wait for the scheduling loop and every refresh it started.
  async function tick () {
    await pump();
    while (ticking || flights.size) await Promise.allSettled([ticking, ...flights.values()]);
  }
  let ticking = null, again = false;
  function pump () {
    if (closed) return Promise.resolve();
    if (ticking) { again = true; return ticking; }
    // The loop's end and the release of `ticking` are one synchronous step:
    // demand arriving after the last pass starts a new loop, never a lost one.
    let finished = false, run = null;
    run = (async () => { try {
      do {
        again = false; counters.ticks++;
        let wanted = [];
        for (const tenant of dirty) { if (wanted.length >= checkBatchSize) break; wanted.push(tenant); dirty.delete(tenant); }
        let seen = null;
        // Keep the addressed audience stable across the asynchronous detector read.
        const watched = isWatched && new Set(wanted.filter(isWatched));
        if (detect && wanted.length) {
          const observed = new Map(wanted.map(tenant => [tenant, cells.get(tenant)]));
          const interested=wanted.filter(tenant=>!watched||watched.has(tenant)||(!durableOutput && cold.has(tenant))||cells.get(tenant).waiters.length||cells.get(tenant).demand);
          try { seen = await detect(wanted,{interested}); counters.detected++; }
          catch(error){counters.detectFailures++;throw error;}
          // A detector result for a removed cell cannot change its successor.
          wanted = wanted.filter(tenant => cells.get(tenant) === observed.get(tenant));
        }
        if (closed) return;
        if (seen) for (const tenant of wanted) {
          const cell = cells.get(tenant), token = seen.get(tenant);
          cell.upstreamPending = token?.pending ? token : null;
          cell.deferred = token?.deferred === true;
        }
        // A committed control refusal invalidates the cached frame without
        // treating a paused tenant as failed work that retries forever.
        if (seen) for (const tenant of wanted) if (seen.get(tenant)?.identity === null) {
          const cell = cells.get(tenant); cell.generation++; cell.last = null; cell.component = null;
          cell.healthy = false; cell.disabled = true; cold.delete(tenant);
        }
        const selected = wanted.filter(tenant => due(tenant,seen) && (!watched || watched.has(tenant) || cells.get(tenant).waiters.length || cells.get(tenant).demand));
        const at = now(), retryLimit = Math.max(1,Math.min(checkBatchSize,Number.isFinite(concurrency) ? concurrency * 2 : checkBatchSize));
        const retryAfter = cell => cell.woken ? Math.min(failureRetryMs,retryMs * 2 ** Math.min(Math.max(cell.failures-1,0),20)) : failureRetryMs;
        // Only known cold tenants have startup/retry demand. Warm tenants
        // leave this set and have no discovery timer.
        let visited=0;
        for(const tenant of durableOutput?[]:cold){if(visited++>=retryLimit)break;cold.delete(tenant);cold.add(tenant);
          const cell=cells.get(tenant);if(flights.has(tenant))continue;
          if(cell.failedAt===null||at-cell.failedAt>=retryAfter(cell))if(!selected.includes(tenant))selected.push(tenant);
        }
        // No periodic refresh of an unchanged tenant (decision
        // write-clock-complete): every write, hard deletes included, moves
        // the stamp, so an unmoved stamp is an unchanged tenant.
        for (const tenant of selected) {cells.get(tenant).woken=false;cells.get(tenant).demand=false;}
        const chosen = new Set(selected);
        for (const tenant of wanted) {
          const cell = cells.get(tenant);
          if (!chosen.has(tenant) && !(watched?.has(tenant) && owesPendingPublication(cell))) cell.availableAt = null;
        }
        for (const tenant of new Set(selected)) launch(tenant);
        if (dirty.size) again = true;
      } while (again && !closed);
    } finally { finished = true; if (ticking === run) ticking = null; armCold(); } })();
    if (!finished) ticking = run;
    return run;
  }
  let timer=null,timerAt=null;
  function armCold(){
    if(closed)return;
    if(durableOutput)return; // Durable receipts own retries; demand calls tick directly.
    let due=dirty.size?now():Infinity;
    for(const tenant of cold){const cell=cells.get(tenant);if(cell.disabled||cell.suspended||flights.has(tenant))continue;
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
    if(readiness==='serve')pump().catch(()=>{});
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
      async removeTenant (tenant) { if(!dynamic)c.fail('REALTIME_DYNAMIC_TENANT_REFUSED');const cell=cells.get(tenant);if(!cell)return;cell.generation++;cells.delete(tenant);cold.delete(tenant);dirty.delete(tenant);const index=tenants.indexOf(tenant);if(index>=0)tenants.splice(index,1);for(const waiter of cell.waiters.splice(0))waiter.reject(notWarm());await Promise.allSettled([cell.pending, cell.retiring]); },
      async check (requested) {
        if (!Array.isArray(requested) || requested.some(t => !cells.has(t))) throw new TypeError('Known realtime tenants required');
        const admitted = new Map(requested.map(tenant => [tenant, cells.get(tenant)]));
        const at = now();
        for (const [tenant, cell] of admitted) { dirty.add(tenant); cell.woken = true; noteAvailable(cell, at); }
        await pump();
        // Only this page's tenants are awaited, each bounded by its own deadline.
        for (;;) {
          const own = requested.map(tenant => flights.get(tenant)).filter(Boolean);
          if (!own.length && !ticking) break;
          await Promise.allSettled([ticking, ...own]);
        }
        return new Map(requested.map(tenant => {
          const cell = cells.get(tenant);
          if (!cell || cell !== admitted.get(tenant) || !workerReady(cell)) return [tenant, false];
          const hasViewer = isWatched?.(tenant);
          if (hasViewer && owesPendingPublication(cell)) return [tenant, false];
          return [tenant, !!(cell.healthy || cell.upstreamPending || cell.deferred || cell.disabled || cell.suspended || !hasViewer && cell.failedAt === null)];
        }));
      },
      // Aggregate backlog for the metrics scrape: in memory, no SQL, no tenant id leaves.
      pendingSummary () { let pending = 0, oldest = null; const at = now();
        for (const cell of cells.values()) { const since = cell.publishingAt === null ? cell.availableAt : cell.availableAt === null ? cell.publishingAt : Math.min(cell.availableAt, cell.publishingAt);
          if (since !== null) { pending++; if (oldest === null || since < oldest) oldest = since; } }
        return { tenants: cells.size, pending, oldestAgeMs: oldest === null ? 0 : Math.max(0, at - oldest) }; },
      // Known cells only: addressed delivery never names a staged/removed tenant.
      has (tenant) { return !closed && cells.has(tenant); },
      wake (tenant) { const cell = cells.get(tenant); if (!cell || closed) return; cell.woken = true; dirty.add(tenant); pump().catch(() => {}); },
      // Warm: initialized and holding a published projection.
      warm (tenant) { const cell = cells.get(tenant); return !!cell && !closed && workerReady(cell) && cell.healthy && !!cell.last; },
      // Connection/explicit delivery demand can arrive before a protocol peer
      // exists. Queue only that tenant through the bounded scheduler; readiness
      // inspection remains a pure warm() read and never admits a stale epoch.
      requestWarm (tenant) {
        const cell=cells.get(tenant);
        if(!cell || closed)return false;
        if(workerReady(cell) && cell.healthy && cell.last)return true;
        if(epoch().available){cell.woken=true;cell.demand=true;dirty.add(tenant);pump().catch(()=>{});}
        return false;
      },
      async invalidateTenant (tenant, { restoring = false } = {}) {
        const cell = cells.get(tenant); if (!cell || closed) c.fail('REALTIME_CLOSED_OR_UNKNOWN');
        cell.generation++;
        if (restoring) {
          const next = makeCell();
          next.disabled = cell.disabled; next.suspended = cell.suspended;
          cells.set(tenant, next);
          for (const waiter of cell.waiters.splice(0)) waiter.reject(notWarm());
          // Retired operations still belong to shutdown and removal. Their
          // fanout checks the old cell generation before sending each frame.
          if (cell.pending || cell.retiring) {
            next.retiring = Promise.allSettled([cell.pending, cell.retiring]).then(() => { delete next.retiring; });
          }
        } else {
          await Promise.allSettled([cell.pending, cell.retiring]);
          cell.last = null; cell.component = null; cell.identity = null; cell.healthy = false;
        }
        cold.add(tenant); armCold();
      },
      last (tenant) { const cell = cells.get(tenant); return !closed && workerReady(cell) && cell?.healthy && (!operationWindow || operationWindow.current(tenant)) ? cell.last : null; },
      // Fresh data for a socket that primes on a warm tenant: the tenant is
      // woken into the tick's bounded share and the socket takes the first
      // cycle that starts after it asked. All sockets of a tenant share that
      // cycle; a socket never acquires its tenant itself.
      fresh (tenant) {
        const cell = cells.get(tenant);
        if (!cell || closed || !workerReady(cell) || !cell.healthy || !cell.last) return Promise.reject(notWarm());
        return new Promise((resolve, reject) => { cell.waiters.push({ resolve, reject }); cell.woken = true; dirty.add(tenant); pump().catch(() => {}); });
      },
      stats: () => Object.freeze({ ...counters }),
      probe () { return { live: !closed, readiness, ready: !closed && workerReady(), configured: cells.size }; },
      refreshDeadlines: () => deadlines,
      health () { const healthy = [...cells.values()].filter(cell => workerReady(cell) && cell.healthy).length, deferred = [...cells.values()].filter(cell => !cell.healthy && (cell.disabled || cell.suspended)).length;
        return Object.freeze({ live: !closed, readiness, ready: !closed && workerReady() && (readiness === 'serve' || healthy + (eligible ? deferred : 0) === cells.size), configured: cells.size,
        healthy, deferred, upstreamPending:[...cells.values()].filter(cell=>cell.upstreamPending).length, failed: [...cells.values()].filter(cell => !cell.healthy && cell.failedAt!==null).length,
        tenants: [...cells].map(([tenant, cell]) => ({ tenant, ready: !closed && workerReady(cell) && cell.healthy, ...(!cell.healthy && (cell.disabled || cell.suspended) ? { deferred: true } : {}) })) }); },
      async close () {
        if (closed) return; closed = true; cancel(timer);
        for (const cell of cells.values()) cell.generation++;
        await Promise.allSettled([...cells.values()].flatMap(cell => [cell.pending, cell.retiring]).filter(Boolean));
        await Promise.allSettled([...flights.values()]);
        for (const cell of cells.values()) for (const waiter of cell.waiters.splice(0)) waiter.reject(notWarm());
      }
    });
  } catch (error) { closed = true; if (timer) cancel(timer); for (const cell of cells.values()) for (const waiter of cell.waiters.splice(0)) waiter.reject(notWarm()); await Promise.allSettled([...cells.values()].flatMap(cell => [cell.pending, cell.retiring]).filter(Boolean)); throw error; }
};
