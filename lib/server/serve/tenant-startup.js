'use strict';

const windows = require('../../tenant-lifecycle/operation-window');
const { AsyncResource } = require('node:async_hooks');

// Only actual gate refusals defer tenant-local initialization. Metadata, binding,
// transport and application errors remain hard failures, including code lookalikes.
// Run fn over items, at most `concurrency` at a time; settled results in order.
async function limited (items, concurrency, fn) {
  const results = new Array(items.length); let next = 0;
  async function worker () { while (next < items.length) { const index = next++; try { results[index] = { status: 'fulfilled', value: await fn(items[index]) }; } catch (reason) { results[index] = { status: 'rejected', reason }; } } }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}

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

// Warm against a peer that is restarting (the api restarting with realtime):
// a not-ready answer is retried with bounded, jittered backoff; a refusal is
// never retried. Not ready is only what the internal transport marks
// (`notReady`: no listener, reset, SOCKET_IPC_NOT_READY, TENANT_WARMING) or a
// TENANT_WARMING code; a denial, a refused tenant, a suspended tenant or any
// other error is thrown at once.
//
// The deadline is shared by every caller of one retry: it runs from the first
// not-ready answer of an outage and resets on any success. Within it a caller
// backs off and tries again; past it every caller fails at once, as before, and
// the tenant is marked failed (retried after failureRetryMs). A peer that is
// down longer than the deadline therefore costs each tenant one fast failure,
// not one deadline each. A caller holds its own warm slot while it backs off,
// so retries never exceed the warm's bounded concurrency
// (NS_TENANT_STARTUP_CONCURRENCY): no mass retry reaches the peer.
const isNotReady = error => !!error && (error.notReady === true || error.code === 'TENANT_WARMING');
function notReadyRetry ({ deadlineMs, baseDelayMs = 100, maxDelayMs = 2000, now = Date.now, random = Math.random,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) throw new TypeError('Warm retry deadline must be a non-negative integer');
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1 || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new TypeError('Warm retry backoff must be bounded positive integers');
  }
  let outageSince = null;
  const counters = { retries: 0, exhausted: 0 };
  async function run (fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await fn();
        outageSince = null;
        return value;
      } catch (error) {
        if (!isNotReady(error)) throw error;
        const at = now();
        if (outageSince === null) outageSince = at;
        const left = outageSince + deadlineMs - at;
        if (left <= 0) { counters.exhausted++; throw error; }
        // Equal jitter: half the exponential step, plus up to the other half.
        const step = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt, 20));
        counters.retries++;
        await sleep(Math.max(1, Math.min(left, Math.floor(step / 2 + random() * step / 2))));
      }
    }
  }
  return Object.freeze({ run, stats: () => Object.freeze({ ...counters, outage: outageSince !== null }) });
}

// Readiness (decision readiness-serve-then-warm):
//  'all'   warm() resolves after every tenant initialized or was deferred by its
//          window, and rejects on the first tenant failure (boot fails). The
//          behaviour before the decision; an operator flag selects it.
//  'serve' warm() starts a bounded background warm and resolves at once. A
//          request for a tenant not yet warm is refused with TENANT_WARMING (503,
//          Retry-After) and moves that tenant to the front of the warm queue. A
//          tenant whose initialization fails is marked failed with an alert; it
//          is retried by its next request after `failureRetryMs`, others serve.
// A selected demand-only role (warmOnStart:false) never queues an idle roster.
// Cold alerts begin after useful work requests initialization; idle tenants do
// not create an unmet warm obligation. The strict 'all' path always warms all.
const READINESS = Object.freeze(['all', 'serve']);
const refusal = (code, retryAfter) => Object.assign(new Error(code), { code, retryAfter });
function create (tenants, operationWindow, initialize, { concurrency = require('./pool-config').startupConcurrency(),
  readiness = 'all', warmOnStart = true, retryAfterSeconds = 5, failureRetryMs = 30000, coldAlertMs = require('./pool-config').coldAlertMs(),
  alert = (code, tenant) => console.warn('Tenant readiness alert', code, tenant),
  drainedLog = (counts, ms) => console.log('Tenant warm drained: ready', counts.ready, 'failed', counts.failed, 'deferred', counts.deferred, 'after', ms, 'ms'),
  now = Date.now, accept, eligible, dynamic = false, maxTenants = 10000, coldAdmission } = {}) {
  if (!READINESS.includes(readiness)) throw new TypeError('Tenant readiness must be all or serve');
  if (typeof warmOnStart !== 'boolean') throw new TypeError('Explicit tenant warm-on-start policy required');
  if (eligible !== undefined && typeof eligible !== 'function') throw new TypeError('Explicit startup eligibility function required');
  if (accept !== undefined && typeof accept !== 'function') throw new TypeError('Tenant startup acceptance must be a function');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('Positive startup concurrency required');
  if (coldAdmission !== undefined && [coldAdmission.run, coldAdmission.tryRun, coldAdmission.cancel].some(fn => typeof fn !== 'function')) throw new TypeError('Explicit cold admission gate required');
  // Created by trusted boot, before any request/tenant callback. Background
  // admission obtains a fresh window; a request's expired parent is never its
  // permanent scheduling context. Direct ensure still keeps caller causality.
  if (require('../../storage/tenant-scope').currentTenant() !== undefined) throw refusal('COLD_START_AMBIENT_SCOPE', retryAfterSeconds);
  windows.assertNoAmbientScope();
  const coldBackground = new AsyncResource('nightscout-tenant-startup-background', {requireManualDestroy:true});
  const coldJobs = new Map();
  const deferrals = new WeakSet();
  const born = now();
  const cell0 = since => ({ generation: 0, complete: false, pending: null, state: 'cold', ticket: null, since, failedAt: 0, code: null, alerts: new Set() });
  const cells = new Map([...tenants].map(tenant => [tenant, cell0(born)]));
  // Registry mode (decision tenant-registry): a tenant first seen on a request
  // gets its cell then, when `accept` admits it (it is materialized from the
  // registry). The static set stays the only set without `accept`.
  function cellOf (tenant) {
    let cell = cells.get(tenant);
    if (!cell && accept && accept(tenant) === true) { cell = cell0(now()); cells.set(tenant, cell); }
    return cell;
  }
  function raise (cell, tenant, code) {
    if (cell.alerts.has(code)) return;
    cell.alerts.add(code); try { alert(code, tenant); } catch { /* an alert sink failure never fails a tenant */ }
  }
  function beginCold (tenant, cell, background) {
    if (cell.pending) return cell.pending;
    const generation = cell.generation, ticket = {};
    cell.ticket = ticket; cell.state = 'queued';
    const initializeCurrent = async () => {
      if (closed || generation !== cell.generation || cells.get(tenant) !== cell) throw refusal('COLD_START_CANCELLED', retryAfterSeconds);
      if (operationWindow) operationWindow.assertCurrent(tenant);
      cell.state = 'warming';
      if (eligible && await eligible(tenant) !== true) { const error = refusal('TENANT_ACTIVITY_DEFERRED', retryAfterSeconds); deferrals.add(error); throw error; }
      await initialize(tenant);
      if (generation !== cell.generation || cells.get(tenant) !== cell) throw refusal('COLD_START_CANCELLED', retryAfterSeconds);
      cell.complete = true; cell.state = 'ready'; cell.code = null; cell.alerts.clear();
    };
    // A background task waits for its cold slot BEFORE acquiring a window.
    // A direct caller already holding a window may use a free slot in that
    // context, but must never queue behind a job which needs its held lane.
    const execute = background ? () => attempt(operationWindow, tenant, initializeCurrent)
      : async () => { await initializeCurrent(); return true; };
    const pending = background ? coldBackground.runInAsyncScope(() => coldAdmission.run(ticket, execute)) : coldAdmission.tryRun(ticket, execute);
    if (pending === null) { cell.ticket = null; cell.state = 'cold'; throw refusal('TENANT_WARMING', retryAfterSeconds); }
    cell.pending = pending.then(admitted => {
      if (!admitted && generation === cell.generation && cells.get(tenant) === cell) cell.state = 'deferred';
      return admitted;
    }, error => {
      if (generation === cell.generation && cells.get(tenant) === cell) {
        cell.state = deferrals.has(error) ? 'deferred' : ['COLD_START_CANCELLED', 'COLD_START_CLOSED'].includes(error?.code) ? 'cold' : 'failed';
        cell.failedAt = now(); cell.code = typeof error?.code === 'string' ? error.code : 'TENANT_WARM_FAILED';
      }
      throw error;
    }).finally(() => { coldJobs.delete(ticket); if (cell.ticket === ticket) { cell.pending = null; cell.ticket = null; } });
    coldJobs.set(ticket, cell.pending);
    return cell.pending;
  }
  async function ensureCold (tenant) {
    const cell = cellOf(tenant);
    if (!cell) throw new Error('Unknown startup tenant');
    if (closed) throw refusal('COLD_START_CLOSED', retryAfterSeconds);
    if (operationWindow) operationWindow.assertCurrent(tenant);
    if (cell.complete) return;
    if (cell.pending && cell.state !== 'warming') throw refusal('TENANT_WARMING', retryAfterSeconds);
    await beginCold(tenant, cell, false);
    if (!cell.complete) throw refusal('TENANT_WARMING', retryAfterSeconds);
  }
  async function ensure (tenant) {
    if (coldAdmission) return ensureCold(tenant);
    const cell = cellOf(tenant);
    if (!cell) throw new Error('Unknown startup tenant');
    if (operationWindow) operationWindow.assertCurrent(tenant);
    if (cell.complete) return;
    if (eligible && await eligible(tenant) !== true) { const error = refusal('TENANT_ACTIVITY_DEFERRED', retryAfterSeconds); deferrals.add(error); throw error; }
    if (!cell.pending) {
      const generation = cell.generation;
      cell.state = 'warming';
      cell.pending = Promise.resolve().then(() => initialize(tenant)).then(() => {
        if (generation !== cell.generation) throw new Error('Tenant startup invalidated');
        cell.complete = true; cell.state = 'ready'; cell.code = null; cell.alerts.clear();
      }).finally(() => { cell.pending = null; });
    }
    return cell.pending;
  }
  async function attemptWarm (tenant) {
    if (coldAdmission && closed) throw refusal('COLD_START_CLOSED', retryAfterSeconds);
    let admitted;
    try {
      const cell = coldAdmission ? cellOf(tenant) : undefined;
      if (coldAdmission && cell && !cell.complete) {
        if (closed) throw refusal('COLD_START_CLOSED', retryAfterSeconds);
        admitted = await beginCold(tenant, cell, true);
      } else admitted = await attempt(operationWindow, tenant, () => ensure(tenant));
    }
    catch (error) { if (!deferrals.has(error)) throw error; admitted = false; }
    if (!admitted && cells.has(tenant) && !cells.get(tenant).complete) cells.get(tenant).state = 'deferred';
    return admitted;
  }
  // Background warm queue: at most `concurrency` tenants initialize at once;
  // a request moves its tenant to the front in the default path. Opt-in cold
  // admission preserves FIFO, including when fresh requests arrive.
  const queue = [], queued = new Set();
  let running = 0, closed = false, idle = null, settle = null, timer = null, closing;
  function enqueue (tenant, front = false) {
    const cell = cells.get(tenant);
    if (closed || !cell || cell.complete) return;
    if (queued.has(tenant)) {
      if (!front || coldAdmission) return;
      queue.splice(queue.indexOf(tenant), 1);
    }
    queued.add(tenant); if (front && !coldAdmission) queue.unshift(tenant); else queue.push(tenant);
    pump();
  }
  function pump () {
    while (!closed && running < concurrency && queue.length) {
      const tenant = queue.shift(); queued.delete(tenant);
      const cell = cells.get(tenant);
      if (cell.complete) continue;
      const generation = cell.generation;
      running++;
      coldBackground.runInAsyncScope(() => attemptWarm(tenant)).then(admitted => {
        if (!admitted && !cell.complete && (!coldAdmission || generation === cell.generation)) cell.state = 'deferred';
      }, error => {
        if (cell.complete || coldAdmission && (generation !== cell.generation || cells.get(tenant) !== cell)) return;
        cell.state = 'failed'; cell.failedAt = now();
        cell.code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'TENANT_WARM_FAILED';
        raise(cell, tenant, 'TENANT_WARM_FAILED');
      }).finally(() => {
        running--; pump();
        if (!running && !queue.length) {
          // One line per drained warm round: the operator's view of serve-then-warm.
          const counts = { ready: 0, failed: 0, deferred: 0 };
          for (const row of cells.values()) if (row.complete) counts.ready++; else if (row.state in counts) counts[row.state]++;
          try { drainedLog(counts, now() - born); } catch { /* logging never fails a tenant */ }
          if (settle) { settle(); settle = null; idle = null; }
        }
      });
    }
  }
  function watch () {
    if (timer || !Number.isSafeInteger(coldAlertMs)) return;
    timer = setInterval(check, Math.min(10000, Math.max(250, Math.floor(coldAlertMs / 4))));
    timer.unref?.();
  }
  function check () {
    const at = now();
    for (const [tenant, cell] of cells) if (!cell.complete && (warmOnStart || cell.state !== 'cold') && cell.state !== 'deferred' && at - cell.since >= coldAlertMs) raise(cell, tenant, 'TENANT_COLD_BEYOND_BOUND');
  }
  watch();
  return Object.freeze({ ensure, readiness,
    addTenant (tenant) { if (!dynamic || closed || typeof tenant !== 'string' || !tenant || cells.size >= maxTenants && !cells.has(tenant)) throw new Error('Dynamic startup tenant refused'); if (!cells.has(tenant)) cells.set(tenant,cell0(now())); },
    async removeTenant (tenant) { if (!dynamic) throw new Error('Dynamic startup tenant refused'); const cell=cells.get(tenant); if(!cell)return;cell.generation++;if(coldAdmission && cell.ticket)coldAdmission.cancel(cell.ticket);cells.delete(tenant);queued.delete(tenant);const index=queue.indexOf(tenant);if(index>=0)queue.splice(index,1);await Promise.allSettled([cell.pending]); },
    // Every tenant holding a startup cell (decision datastore-loss-recover-in-place:
    // a role drops all of them after the datastore's postmaster changed).
    tenants: () => [...cells.keys()],
    // Whether a tenant's startup initialization is complete (the evaluator's
    // boot acquires warm tenants first).
    isReady: tenant => cells.get(tenant)?.complete === true,
    // Request admission in 'serve' mode (inside the request's window lifetime).
    async admit (tenant) {
      const cell = cellOf(tenant);
      if (!cell) throw new Error('Unknown startup tenant');
      if (readiness === 'all') return ensure(tenant);
      if (operationWindow) operationWindow.assertCurrent(tenant);
      if (cell.complete) return;
      if (cell.state === 'failed' && now() - cell.failedAt < failureRetryMs) {
        throw refusal('TENANT_UNAVAILABLE', Math.max(1, Math.ceil((failureRetryMs - (now() - cell.failedAt)) / 1000)));
      }
      enqueue(tenant, true);
      throw refusal('TENANT_WARMING', retryAfterSeconds);
    },
    warm: async () => {
      if (readiness === 'serve') { if (warmOnStart) for (const tenant of cells.keys()) enqueue(tenant); return null; }
      const results = await settleLimited(cells.keys(), concurrency, tenant => attemptWarm(tenant));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      return results.map(result => result.value);
    },
    // Resolves when the background queue is empty (tests, measurements).
    drained () {
      const background = () => {
        if (!running && !queue.length) return Promise.resolve();
        if (!idle) idle = new Promise(resolve => { settle = resolve; });
        return idle;
      };
      return coldAdmission ? Promise.allSettled([...coldJobs.values()]).then(background) : background();
    },
    health () {
      const counts = { ready: 0, warming: 0, cold: 0, deferred: 0, failed: 0, ...(coldAdmission ? { queued: 0 } : {}) }, alerts = [];
      for (const [tenant, cell] of cells) {
        counts[cell.complete ? 'ready' : cell.state === 'ready' ? 'cold' : cell.state]++;
        for (const code of cell.alerts) alerts.push({ tenant, code, ...(cell.code ? { cause: cell.code } : {}) });
      }
      return Object.freeze({ readiness, configured: cells.size, ...counts, alerts,
        ready: readiness === 'serve' || counts.ready + counts.deferred === cells.size, warmOnStart });
    },
    // warm: false leaves the tenant cold without queueing its warm (decision
    // datastore-loss-recover-in-place: state is dropped before the datastore is
    // re-admitted, when a warm could only fail; warm() queues it afterwards).
    invalidateTenant (tenant, { warm = true } = {}) {
      const cell = cellOf(tenant);
      if (!cell) throw new Error('Unknown startup tenant');
      const pending = cell.pending;
      cell.generation++; if (coldAdmission && cell.ticket) coldAdmission.cancel(cell.ticket); cell.complete = false; cell.state = 'cold'; cell.since = now();
      const generation = cell.generation;
      if (!warm) {
        queued.delete(tenant); const index = queue.indexOf(tenant); if (index >= 0) queue.splice(index, 1);
      }
      if (warm && warmOnStart && readiness === 'serve') {
        if (coldAdmission && pending) pending.catch(() => {}).finally(() => { if (!closed && cells.get(tenant) === cell && generation === cell.generation) enqueue(tenant); });
        else enqueue(tenant);
      }
    },
    close () {
      if (closed) return closing;
      closed = true; queue.length = 0; queued.clear(); if (timer) clearInterval(timer); timer = null;
      if (coldAdmission) {
        for (const ticket of coldJobs.keys()) coldAdmission.cancel(ticket);
        closing = Promise.allSettled([...coldJobs.values()]).then(() => { coldBackground.emitDestroy(); }); return closing;
      }
      coldBackground.emitDestroy();
    }
  });
}
module.exports = { attempt, create, settleLimited, READINESS, limited, notReadyRetry, isNotReady };
