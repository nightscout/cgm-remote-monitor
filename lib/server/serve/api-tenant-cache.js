'use strict';

const { AsyncResource } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');

const refusal = code => Object.assign(new Error(code), { code, retryAfter: 1 });

// One API-local LRU owns both registry metadata and its optional service. A
// request may retain its selected record after eviction; eviction drops only
// this cache's reference and never closes ports borrowed by in-flight work.
function create ({ capacity, concurrency, pendingLimit, waitMs } = {}) {
  if (![capacity, concurrency, waitMs].every(value => Number.isSafeInteger(value) && value > 0) ||
      !Number.isSafeInteger(pendingLimit) || pendingLimit < 0 || waitMs > 2147483647) {
    throw new TypeError('API tenant cache requires explicit positive bounds');
  }
  const records = new Map(), building = new WeakMap(), jobs = new Set(), waiting = [];
  const counters = { hits: 0, misses: 0, evictions: 0, builds: 0, coalesced: 0, completed: 0, failed: 0, overloaded: 0, expired: 0 };
  let active = 0, closed = false, closing;

  function get (key) {
    const record = records.get(key);
    if (record === undefined) { counters.misses++; return undefined; }
    counters.hits++;
    records.delete(key); records.set(key, record);
    return record;
  }
  function set (key, record) {
    if (closed) throw refusal('API_TENANT_CACHE_CLOSED');
    if (typeof key !== 'string' || !key || !record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError('API tenant cache requires a named record');
    }
    records.delete(key); records.set(key, record);
    while (records.size > capacity) { records.delete(records.keys().next().value); counters.evictions++; }
    return record;
  }
  function removeWaiting (job) {
    const index = waiting.indexOf(job);
    if (index === -1) return false;
    waiting.splice(index, 1); clearTimeout(job.timer);
    return true;
  }
  function finish (job) {
    building.delete(job.record); jobs.delete(job);
  }
  function expire (job) {
    clearTimeout(job.timer); counters.expired++; counters.overloaded++;
    finish(job); job.reject(refusal('API_TENANT_BUILD_OVERLOADED'));
  }
  function expireWaiting () {
    // All slots use the same wait budget, so FIFO also orders deadlines. An
    // overdue timer may not have run yet after an event-loop stall; check the
    // monotonic deadline before admitting any queued constructor.
    while (waiting.length && waiting[0].deadline <= performance.now()) expire(waiting.shift());
  }
  function pump () {
    expireWaiting();
    while (!closed && active < concurrency && waiting.length) {
      expireWaiting();
      if (waiting.length) start(waiting.shift());
    }
  }
  function start (job) {
    clearTimeout(job.timer); job.running = true; active++; counters.builds++;
    const settle = (error, service) => {
      active--; finish(job);
      if (error) { counters.failed++; job.reject(error); }
      else { counters.completed++; job.resolve(service); }
      pump();
    };
    Promise.resolve().then(job.build).then(service => {
      // This object remains usable by its caller even if it was evicted while
      // building. Never reinsert it over a newer record for the same tenant.
      try { job.record.service = service; } catch (error) { settle(error); return; }
      settle(null, service);
    }, error => settle(error));
  }
  function load (record, build) {
    if (closed) return Promise.reject(refusal('API_TENANT_CACHE_CLOSED'));
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof build !== 'function') {
      return Promise.reject(new TypeError('API tenant service requires a record and builder'));
    }
    if (record.service !== undefined) return Promise.resolve(record.service);
    expireWaiting();
    const existing = building.get(record);
    if (existing) { counters.coalesced++; return existing.promise; }
    if (active >= concurrency && waiting.length >= pendingLimit) {
      counters.overloaded++; return Promise.reject(refusal('API_TENANT_BUILD_OVERLOADED'));
    }
    // Queued work runs in the requesting operation's context, rather than the
    // context of whichever different tenant releases the preceding slot.
    const job = { record, build: AsyncResource.bind(build), running: false, timer: null };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    building.set(record, job); jobs.add(job);
    if (active < concurrency && !waiting.length) start(job);
    else {
      job.deadline = performance.now() + waitMs;
      waiting.push(job);
      job.timer = setTimeout(() => {
        if (!removeWaiting(job)) return;
        expire(job);
      }, waitMs);
      job.timer.unref?.();
    }
    return job.promise;
  }
  function stats () {
    return Object.freeze({ capacity, concurrency, pendingLimit, waitMs, entries: records.size,
      active, queued: waiting.length, closed, ...counters });
  }
  function close () {
    if (closing) return closing;
    const pending = [...jobs].map(job => job.promise);
    expireWaiting();
    closed = true; records.clear();
    for (const job of [...waiting]) if (removeWaiting(job)) {
      finish(job); job.reject(refusal('API_TENANT_CACHE_CLOSED'));
    }
    closing = Promise.allSettled(pending).then(() => undefined);
    return closing;
  }
  return Object.freeze({ get, peek: key => records.get(key), set, load,
    delete: key => records.delete(key), clear: () => records.clear(), stats, close });
}

module.exports = { create };
