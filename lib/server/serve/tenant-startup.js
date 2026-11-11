'use strict';

const windows = require('../../tenant-lifecycle/operation-window');

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

// Readiness (decision readiness-serve-then-warm):
//  'all'   warm() resolves after every tenant initialized or was deferred by its
//          window, and rejects on the first tenant failure (boot fails). The
//          behaviour before the decision; an operator flag selects it.
//  'serve' warm() starts a bounded background warm and resolves at once. A
//          request for a tenant not yet warm is refused with TENANT_WARMING (503,
//          Retry-After) and moves that tenant to the front of the warm queue. A
//          tenant whose initialization fails is marked failed with an alert; it
//          is retried by its next request after `failureRetryMs`, others serve.
// In both modes a tenant cold longer than `coldAlertMs` raises an alert.
const READINESS = Object.freeze(['all', 'serve']);
const refusal = (code, retryAfter) => Object.assign(new Error(code), { code, retryAfter });
function create (tenants, operationWindow, initialize, { concurrency = require('./pool-config').startupConcurrency(),
  readiness = 'all', retryAfterSeconds = 5, failureRetryMs = 30000, coldAlertMs = require('./pool-config').coldAlertMs(),
  alert = (code, tenant) => console.warn('Tenant readiness alert', code, tenant),
  drainedLog = (counts, ms) => console.log('Tenant warm drained: ready', counts.ready, 'failed', counts.failed, 'deferred', counts.deferred, 'after', ms, 'ms'),
  now = Date.now, accept } = {}) {
  if (!READINESS.includes(readiness)) throw new TypeError('Tenant readiness must be all or serve');
  if (accept !== undefined && typeof accept !== 'function') throw new TypeError('Tenant startup acceptance must be a function');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('Positive startup concurrency required');
  const born = now();
  const cell0 = since => ({ generation: 0, complete: false, pending: null, state: 'cold', since, failedAt: 0, code: null, alerts: new Set() });
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
  async function ensure (tenant) {
    const cell = cellOf(tenant);
    if (!cell) throw new Error('Unknown startup tenant');
    if (operationWindow) operationWindow.assertCurrent(tenant);
    if (cell.complete) return;
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
  // Background warm queue: at most `concurrency` tenants initialize at once;
  // a request moves its tenant to the front.
  const queue = [], queued = new Set();
  let running = 0, closed = false, idle = null, settle = null, timer = null;
  function enqueue (tenant, front = false) {
    const cell = cells.get(tenant);
    if (closed || !cell || cell.complete) return;
    if (queued.has(tenant)) {
      if (!front) return;
      queue.splice(queue.indexOf(tenant), 1);
    }
    queued.add(tenant); if (front) queue.unshift(tenant); else queue.push(tenant);
    pump();
  }
  function pump () {
    while (!closed && running < concurrency && queue.length) {
      const tenant = queue.shift(); queued.delete(tenant);
      const cell = cells.get(tenant);
      if (cell.complete) continue;
      running++;
      attempt(operationWindow, tenant, () => ensure(tenant)).then(admitted => {
        if (!admitted && !cell.complete) cell.state = 'deferred';
      }, error => {
        if (cell.complete) return;
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
    for (const [tenant, cell] of cells) if (!cell.complete && at - cell.since >= coldAlertMs) raise(cell, tenant, 'TENANT_COLD_BEYOND_BOUND');
  }
  watch();
  return Object.freeze({ ensure, readiness,
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
      if (readiness === 'serve') { for (const tenant of cells.keys()) enqueue(tenant); return null; }
      const results = await settleLimited(cells.keys(), concurrency, tenant => attempt(operationWindow, tenant, () => ensure(tenant)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      return results.map(result => result.value);
    },
    // Resolves when the background queue is empty (tests, measurements).
    drained () {
      if (!running && !queue.length) return Promise.resolve();
      if (!idle) idle = new Promise(resolve => { settle = resolve; });
      return idle;
    },
    health () {
      const counts = { ready: 0, warming: 0, cold: 0, deferred: 0, failed: 0 }, alerts = [];
      for (const [tenant, cell] of cells) {
        counts[cell.complete ? 'ready' : cell.state === 'ready' ? 'cold' : cell.state]++;
        for (const code of cell.alerts) alerts.push({ tenant, code, ...(cell.code ? { cause: cell.code } : {}) });
      }
      return Object.freeze({ readiness, configured: cells.size, ...counts, alerts,
        ready: readiness === 'serve' || counts.ready + counts.deferred === cells.size });
    },
    invalidateTenant (tenant) {
      const cell = cellOf(tenant);
      if (!cell) throw new Error('Unknown startup tenant');
      cell.generation++; cell.complete = false; cell.state = 'cold'; cell.since = now();
      if (readiness === 'serve') enqueue(tenant);
    },
    close () { closed = true; queue.length = 0; queued.clear(); if (timer) clearInterval(timer); timer = null; }
  });
}
module.exports = { attempt, create, settleLimited, READINESS, limited };
