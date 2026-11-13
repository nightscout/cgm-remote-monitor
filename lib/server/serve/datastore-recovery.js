'use strict';

// Decision datastore-loss-recover-in-place. One supervisor per role process
// that belongs to an operation cohort. It asks a tenant-level question on a
// fixed interval and whenever a pool reports a lost backend: can this process
// admit a tenant operation now (operation-window.js probe)? While the answer is
// no the cohort answers no status (the health check reads that), and the
// supervisor tries to recover in place with jittered exponential backoff:
//
//   1. the operation window re-admits the datastore on a new backend and
//      replaces its lost lifetime sessions (operation-window.js recover);
//   2. when the postmaster changed, every role context first drops the tenant
//      state it cached from the old one (context.invalidateAll);
//   3. every storage pool of the cohort is brought to the re-admitted datastore
//      (postgres-connection.js readopt);
//   4. the probe passes, and the process serves again.
//
// A process that has not recovered within `boundMs` of the first failed probe
// calls `exhausted` once; the caller stops the roles and exits non-zero, and
// the platform's restart policy takes over.
//
//   NS_DATASTORE_PROBE_INTERVAL_MS    probe interval while serving (default 5000, 250..60000)
//   NS_DATASTORE_RECOVERY_BOUND_MS    give up and exit after this long unavailable (default 120000, 1000..3600000)
const connect = require('../../storage/postgres-connection');
const { PreviewConfigError } = require('./preview-config-error');

const DEFAULTS = Object.freeze({ intervalMs: 5000, boundMs: 120000, baseDelayMs: 250, maxDelayMs: 5000, attemptTimeoutMs: 15000 });
function integer (source, name, fallback, lower, upper) {
  const raw = source?.[name];
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,8}$/.test(raw) || Number(raw) < lower || Number(raw) > upper) {
    throw new PreviewConfigError('invalid ' + name + ': a whole number from ' + lower + ' to ' + upper + ' is required');
  }
  return Number(raw);
}
function settings (source = process.env) {
  return Object.freeze({
    intervalMs: integer(source, 'NS_DATASTORE_PROBE_INTERVAL_MS', DEFAULTS.intervalMs, 250, 60000),
    boundMs: integer(source, 'NS_DATASTORE_RECOVERY_BOUND_MS', DEFAULTS.boundMs, 1000, 3600000)
  });
}
const code = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'DATASTORE_UNREACHABLE';

function create ({ cohort, intervalMs = DEFAULTS.intervalMs, boundMs = DEFAULTS.boundMs, baseDelayMs = DEFAULTS.baseDelayMs,
  maxDelayMs = DEFAULTS.maxDelayMs, attemptTimeoutMs = DEFAULTS.attemptTimeoutMs, exhausted, readopt = connect.readopt,
  now = () => performance.now(), random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout,
  log = (...args) => console.warn(...args) } = {}) {
  const window = cohort?.window;
  if (!window || typeof window.probe !== 'function' || typeof window.recover !== 'function' ||
      typeof cohort.datastoreUnavailable !== 'function' || typeof cohort.datastoreRecovered !== 'function' || typeof cohort.contexts !== 'function') {
    throw new TypeError('Datastore recovery requires an operation cohort');
  }
  if (typeof exhausted !== 'function') throw new TypeError('Datastore recovery requires an exhaustion handler');
  for (const value of [intervalMs, boundMs, baseDelayMs, maxDelayMs, attemptTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Datastore recovery timings must be positive integers');
  if (maxDelayMs < baseDelayMs) throw new TypeError('Datastore recovery backoff must be bounded');
  let state = 'serving', since = null, attempts = 0, timer = null, running = null, closed = false, signalled = false, last = null;
  const counters = { probes: 0, losses: 0, attempts: 0, recoveries: 0, restarts: 0, exhausted: 0 };
  // A probe or recovery step that never answers (a half-open connection) must
  // not hold the supervisor: each step races one monotonic deadline.
  function bounded (promise) {
    let handle;
    const deadline = new Promise((resolve, reject) => {
      handle = setTimeout(() => reject(Object.assign(new Error('DATASTORE_RECOVERY_STEP_TIMEOUT'), { code: 'DATASTORE_RECOVERY_STEP_TIMEOUT' })), attemptTimeoutMs);
    });
    promise.catch(() => {});
    return Promise.race([promise, deadline]).finally(() => clearTimeout(handle));
  }
  async function invalidateAll () {
    for (const context of cohort.contexts()) {
      if (typeof context.invalidateAll !== 'function') throw Object.assign(new Error('DATASTORE_RECOVERY_CONTEXT_UNSUPPORTED'), { code: 'DATASTORE_RECOVERY_CONTEXT_UNSUPPORTED' });
      await context.invalidateAll();
    }
  }
  async function attempt () {
    counters.attempts++; attempts++;
    const result = await bounded(window.recover({ beforeAdopt: invalidateAll }));
    await bounded(readopt(window));
    await bounded(window.probe());
    return result;
  }
  function plan (delay) {
    if (closed) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; tick(); }, delay);
    timer?.unref?.();
  }
  function backoff () {
    const step = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempts, 20));
    return Math.max(1, Math.floor(step / 2 + random() * step / 2));
  }
  function tick () {
    if (closed || state === 'exhausted') return Promise.resolve();
    if (running) return running;
    running = (async () => {
      signalled = false;
      if (state === 'serving') {
        counters.probes++;
        try { await bounded(window.probe()); return plan(signalled ? 0 : intervalMs); }
        catch (error) {
          if (closed) return;
          state = 'recovering'; since = now(); attempts = 0; last = code(error); counters.losses++;
          cohort.datastoreUnavailable();
          log('Datastore unavailable; recovering in place:', last);
        }
      }
      try {
        const result = await attempt();
        if (closed) return;
        cohort.datastoreRecovered(result);
        counters.recoveries++; if (result.restarted) counters.restarts++;
        log('Datastore recovered in place after', Math.round(now() - since), 'ms,', attempts, 'attempt(s);',
          result.restarted ? 'postmaster restarted, cached tenant state dropped;' : 'same postmaster;', result.sessionsReplaced, 'lifetime session(s) replaced');
        state = 'serving'; since = null; last = null;
        return plan(signalled ? 0 : intervalMs);
      } catch (error) {
        if (closed) return;
        last = code(error);
        if (now() - since >= boundMs) {
          state = 'exhausted'; counters.exhausted++;
          log('Datastore not recovered within', boundMs, 'ms (' + last + '); stopping for the restart policy');
          try { exhausted(last); } catch { /* the handler owns the exit */ }
          return;
        }
        return plan(backoff());
      }
    })().finally(() => { running = null; });
    return running;
  }
  return Object.freeze({
    start () { plan(intervalMs); },
    // A pool reported a lost backend: ask now instead of at the next interval.
    signal () { if (closed || state !== 'serving') return; signalled = true; if (!running) plan(0); },
    tick,
    state: () => Object.freeze({ state, lastRefusal: last, unavailableMs: since === null ? 0 : Math.round(now() - since), ...counters }),
    async close () { closed = true; if (timer) clearTimer(timer); timer = null; await running?.catch(() => {}); }
  });
}

module.exports = { create, settings, DEFAULTS };
