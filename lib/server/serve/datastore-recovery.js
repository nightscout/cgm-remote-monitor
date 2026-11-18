'use strict';

// Decision datastore-loss-recover-in-place. One supervisor per role process.
// A role probes the datastore it admitted at boot. A failed observation closes
// the health gate until a new connection confirms the same database and cluster.
// A new postmaster also invalidates cached tenant state before the role resumes.
//
// A process that has not recovered within `boundMs` of the first failed probe
// calls `exhausted` once; the caller stops the roles and exits non-zero, and
// the platform's restart policy takes over.
//
//   NS_DATASTORE_PROBE_INTERVAL_MS    probe interval while serving (default 5000, 250..60000)
//   NS_DATASTORE_RECOVERY_BOUND_MS    give up and exit after this long unavailable (default 120000, 1000..3600000)
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

// The role's health and request gates read the same availability transition.
function availability (contexts, admitted) {
  let available = true, epoch = Symbol('datastore availability');
  return Object.freeze({
    contexts,
    get epoch () { return epoch; },
    get current () { return admitted(); },
    get available () { return available; },
    datastoreUnavailable () {
      if (available) epoch = Symbol('datastore availability');
      available = false;
    },
    datastoreRecovered () { available = true; }
  });
}

function create ({ target, probe, intervalMs = DEFAULTS.intervalMs, boundMs = DEFAULTS.boundMs, baseDelayMs = DEFAULTS.baseDelayMs,
  maxDelayMs = DEFAULTS.maxDelayMs, attemptTimeoutMs = DEFAULTS.attemptTimeoutMs, exhausted,
  now = () => performance.now(), random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout,
  log = (...args) => console.warn(...args) } = {}) {
  if (!target || typeof target.datastoreUnavailable !== 'function' || typeof target.datastoreRecovered !== 'function' || typeof target.contexts !== 'function') {
    throw new TypeError('Datastore recovery requires an availability target');
  }
  if (typeof probe?.probe !== 'function' || typeof probe.readmit !== 'function' || typeof probe.adopt !== 'function') {
    throw new TypeError('Datastore recovery requires a plain connection probe');
  }
  if (typeof exhausted !== 'function') throw new TypeError('Datastore recovery requires an exhaustion handler');
  for (const value of [intervalMs, boundMs, baseDelayMs, maxDelayMs, attemptTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Datastore recovery timings must be positive integers');
  if (maxDelayMs < baseDelayMs) throw new TypeError('Datastore recovery backoff must be bounded');
  let state = 'serving', since = null, attempts = 0, timer = null, running = null, closing, closed = false, signalled = false, last = null;
  const steps = new Map();
  const cancelled = () => Object.assign(new Error('DATASTORE_RECOVERY_CANCELLED'), { code: 'DATASTORE_RECOVERY_CANCELLED' });
  function active (signal) { if (closed || state === 'exhausted' || signal?.aborted) throw cancelled(); }
  const counters = { probes: 0, losses: 0, attempts: 0, recoveries: 0, restarts: 0, exhausted: 0 };
  // A probe or recovery step that never answers (a half-open connection) must
  // not hold the supervisor: each step races one monotonic deadline.
  function bounded (invoke) {
    if (closed || state === 'exhausted') return Promise.reject(cancelled());
    // A timed-out physical step retains custody until it settles. A retry may
    // check its bound, but cannot start another connection/query beside it.
    if (steps.size) return Promise.reject(Object.assign(new Error('DATASTORE_RECOVERY_STEP_PENDING'), { code: 'DATASTORE_RECOVERY_STEP_PENDING' }));
    const controller = new AbortController(); let handle;
    const work = Promise.resolve().then(() => { active(controller.signal); return invoke(controller.signal); });
    steps.set(work, controller);
    work.then(() => steps.delete(work), () => steps.delete(work));
    const deadline = new Promise((resolve, reject) => {
      handle = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('DATASTORE_RECOVERY_STEP_TIMEOUT'), { code: 'DATASTORE_RECOVERY_STEP_TIMEOUT' }));
      }, attemptTimeoutMs);
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(handle));
  }
  async function invalidateAll (signal) {
    active(signal);
    // The selected controller plan belongs to one exact resource epoch. A
    // restarted postmaster needs a new worker/resource disposition; this
    // supervisor cannot forgive old transport uncertainty or rebind its plan.
    for (const context of target.contexts()) {
      active(signal);
      if (typeof context.invalidateAll !== 'function') throw Object.assign(new Error('DATASTORE_RECOVERY_CONTEXT_UNSUPPORTED'), { code: 'DATASTORE_RECOVERY_CONTEXT_UNSUPPORTED' });
      await context.invalidateAll();
      active(signal);
    }
  }
  async function attempt () {
    counters.attempts++; attempts++;
    const seen = await bounded(() => probe.readmit());
    if (seen.restarted) await bounded(invalidateAll);
    active();
    probe.adopt(seen.current);
    return seen;
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
        try {
          await bounded(() => probe.probe());
          return plan(signalled ? 0 : intervalMs);
        }
        catch (error) {
          if (closed) return;
          state = 'recovering'; since = now(); attempts = 0; last = code(error); counters.losses++;
          target.datastoreUnavailable();
          log('Datastore unavailable; recovering in place:', last);
        }
      }
      try {
        const result = await attempt();
        if (closed) return;
        target.datastoreRecovered(result);
        counters.recoveries++; if (result.restarted) counters.restarts++;
        // Tenants whose warm failed during the loss are retried now, not after their failure back-off.
        for (const context of target.contexts()) { try { context.resume?.(); } catch { /* a warm failure is that tenant's, reported by its own alert */ } }
        log('Datastore recovered in place after', Math.round(now() - since), 'ms,', attempts, 'attempt(s);',
          result.restarted ? 'postmaster restarted, cached tenant state dropped' : 'same postmaster');
        state = 'serving'; since = null; last = null;
        return plan(signalled ? 0 : intervalMs);
      } catch (error) {
        if (closed) return;
        last = code(error);
        if (now() - since >= boundMs) {
          state = 'exhausted'; counters.exhausted++;
          for (const controller of steps.values()) controller.abort();
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
    state: () => Object.freeze({ state, pendingSteps: steps.size, lastRefusal: last, unavailableMs: since === null ? 0 : Math.round(now() - since), ...counters }),
    close () {
      if (closing) return closing;
      closed = true; if (timer) clearTimer(timer); timer = null;
      for (const controller of steps.values()) controller.abort();
      closing = (async () => {
        await running?.catch(() => {});
        // Do not deadlock before the owning role pools get their close call.
        // Their shutdown drains physical work. Unsettled work cannot support
        // a graceful retirement acknowledgement, even if it completes later.
        if (steps.size) throw Object.assign(new Error('DATASTORE_RECOVERY_DRAIN_UNCONFIRMED'), { code: 'DATASTORE_RECOVERY_DRAIN_UNCONFIRMED' });
      })();
      return closing;
    }
  });
}

module.exports = { create, availability, settings, DEFAULTS };
