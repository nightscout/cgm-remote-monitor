'use strict';

const { AsyncResource } = require('node:async_hooks');
const refusal = code => Object.assign(new Error(code), { code });

// Process-local cold work only. The deployment's declared aggregate plan owns
// these explicit bounds; this queue grants no database or tenant authority.
function create ({ activeLimit, pendingLimit, minDelayMs, maxDelayMs, random = Math.random,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (![activeLimit, pendingLimit].every(n => Number.isSafeInteger(n) && n > 0) ||
      ![minDelayMs, maxDelayMs].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647) || maxDelayMs < minDelayMs ||
      [random, schedule, cancel].some(fn => typeof fn !== 'function')) throw new TypeError('Explicit bounded cold admission required');
  const waiting = [], entries = new Map(), drainers = [];
  let admitted = 0, closed = false, closing;
  // Observational lifetime totals only: no admission/authority or credit input.
  // Active includes delaying+running; queued peaks sample stable post-pump
  // waiting rows, never an uncontended transient enqueue. Never clamp to limits.
  const observed = { version: 1, peakActive: 0, peakQueued: 0, accepted: 0, started: 0,
    completed: 0, failed: 0, duplicates: 0, deferred: 0, overloaded: 0,
    schedulerRefused: 0, cancelled: 0, closeCancelled: 0, closedRefused: 0, invalidRefused: 0 };
  function observe () {
    observed.peakActive = Math.max(observed.peakActive, admitted);
    observed.peakQueued = Math.max(observed.peakQueued, waiting.length);
  }
  function settled () {
    if (entries.size) return;
    for (const resolve of drainers.splice(0)) resolve();
  }
  function release (row) {
    entries.delete(row.key); admitted--; pump(); settled();
  }
  function rejectQueued (row, code) {
    if (row.state === 'running') return false;
    if (row.state === 'waiting') waiting.splice(waiting.indexOf(row), 1);
    else { cancel(row.timer); admitted--; }
    entries.delete(row.key); row.reject(refusal(code));
    if (code === 'COLD_START_CANCELLED') observed.cancelled++;
    else if (code === 'COLD_START_CLOSED') observed.closeCancelled++;
    pump(); settled(); return true;
  }
  function pump () {
    while (!closed && admitted < activeLimit && waiting.length) {
      const row = waiting.shift(); row.state = 'delaying'; admitted++;
      let value;
      try { value = random(); if (!Number.isFinite(value) || value < 0 || value >= 1) throw Error(); }
      catch { entries.delete(row.key); admitted--; observed.schedulerRefused++; row.reject(refusal('COLD_START_SCHEDULER_REFUSED')); continue; }
      const delay = minDelayMs + Math.floor(value * (maxDelayMs - minDelayMs + 1));
      try {
        row.timer = schedule(() => {
          if (closed || !entries.has(row.key)) return;
          row.state = 'running'; observed.started++;
          Promise.resolve().then(row.invoke).then(value => { observed.completed++; row.resolve(value); }, error => { observed.failed++; row.reject(error); }).finally(() => release(row));
        }, delay);
      } catch { entries.delete(row.key); admitted--; observed.schedulerRefused++; row.reject(refusal('COLD_START_SCHEDULER_REFUSED')); }
    }
    observe();
    settled();
  }
  function submit (key, fn) {
      if (closed) { observed.closedRefused++; return Promise.reject(refusal('COLD_START_CLOSED')); }
      if (!key || typeof fn !== 'function') { observed.invalidRefused++; return Promise.reject(refusal('COLD_START_INVALID')); }
      if (entries.has(key)) { observed.duplicates++; return entries.get(key).promise; }
      if (admitted >= activeLimit && waiting.length >= pendingLimit) { observed.overloaded++; return Promise.reject(refusal('COLD_START_OVERLOADED')); }
      // Bound queued tickets even when a caller-provided scheduler refuses.
      if (waiting.length >= pendingLimit) { observed.overloaded++; return Promise.reject(refusal('COLD_START_OVERLOADED')); }
      const row = { key, invoke: AsyncResource.bind(fn), state: 'waiting', timer: null };
      row.promise = new Promise((resolve, reject) => { row.resolve = resolve; row.reject = reject; });
      observed.accepted++; entries.set(key, row); waiting.push(row); pump(); return row.promise;
  }
  return Object.freeze({
    run: submit,
    tryRun (key, fn) {
      if (closed) { observed.closedRefused++; return Promise.reject(refusal('COLD_START_CLOSED')); }
      if (admitted >= activeLimit || waiting.length || entries.has(key)) { observed.deferred++; return null; }
      return submit(key, fn);
    },
    cancel (key) { const row = entries.get(key); return row ? rejectQueued(row, 'COLD_START_CANCELLED') : false; },
    drained () { return entries.size ? new Promise(resolve => drainers.push(resolve)) : Promise.resolve(); },
    close () {
      if (closing) return closing;
      closed = true;
      for (const row of [...entries.values()]) rejectQueued(row, 'COLD_START_CLOSED');
      closing = entries.size ? new Promise(resolve => drainers.push(resolve)) : Promise.resolve(); return closing;
    },
    health () {
      const states = { queued: 0, delaying: 0, running: 0 };
      for (const row of entries.values()) states[row.state === 'waiting' ? 'queued' : row.state]++;
      return Object.freeze({ closed, activeLimit, pendingLimit, ...states, observed: Object.freeze({ ...observed }) });
    }
  });
}
module.exports = { create };
