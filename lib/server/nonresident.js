'use strict';

// Single-tenant, nonresident execution (research prototype on
// proto/views-nonresident; not for any release).
//
// Two axes: tenancy (one tenant or many) and execution (resident ddata, or
// views computed from bounded queries). `single` is one tenant, resident;
// this is one tenant, nonresident: bootevent's `views` profile, started by
// scripts/views-profile-server.js. It holds no ctx.ddata data, cache, data
// loader or sbx. The evaluator below is triggered by events inside the one
// process and computes the views of lib/data/views.

const ddataFactory = require('../data/ddata');

// What the v1 storage modules take from ctx.ddata when they write: the pure
// helper that derives `mills` (and `endmills`) for the data-update event.
// Every other read throws, so a resident read cannot pass for an empty one.
const HELPERS = ['processRawDataForRuntime'];

function ddataHelpersOnly () {
  const real = ddataFactory();
  const helpers = {};
  HELPERS.forEach(function bind (name) { helpers[name] = real[name]; });
  return new Proxy(helpers, {
    get (target, key) {
      if (typeof key === 'symbol' || key === 'inspect' || key === 'toJSON' || key === 'then') return target[key];
      if (Object.prototype.hasOwnProperty.call(target, key)) return target[key];
      throw new Error('views profile: no resident ddata (read of ctx.ddata.' + String(key) + ')');
    }
    , set (target, key) {
      throw new Error('views profile: no resident ddata (write of ctx.ddata.' + String(key) + ')');
    }
  });
}

// The collections whose writes change what the alarms view reads. A write
// to any other collection (authorization's roles and subjects, settings)
// does not trigger an evaluation.
const WATCHED = new Set(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity']);

// As bootevent's setupListeners coalesces data loads for `single`
// (UPDATE_DEBOUNCE_WAIT, UPDATE_MAX_WAIT): a burst of writes is one
// evaluation, taken once the writes have been quiet for SETTLE_MS, and never
// later than MAX_WAIT_MS after the first.
const SETTLE_MS = 1000;
const MAX_WAIT_MS = 5000;

function monotonicMs () {
  return Number(process.hrtime.bigint() / 1000000n);
}

/**
 * The evaluator of the views profile.
 *
 * Triggers, both inside the one process:
 *   - `storage-write-committed` (lib/storage/write-step.js publish), emitted on
 *     ctx.bus once per driver call that changed something, by every write
 *     path that crosses the persistence boundary (v1 and in-process callers,
 *     API v3, the socket). Its payload is the collection, the source, the
 *     operation and counts; the evaluator reads only the collection.
 *   - the heartbeat bus's `tick` (lib/bus.js, settings.heartbeat, 60 s by
 *     default): the timer fallback, so time-driven alarms (stale data, a loop
 *     that stopped) fire with no writes, at single's cadence.
 *
 * Each evaluation computes the alarms view and hands its requests to
 * ctx.notifications (handOff below). Each trigger marks the evaluator dirty; one evaluation runs per settled
 * burst, and a trigger that arrives while one runs makes it run once more.
 *
 * @param {Object} env
 * @param {Object} ctx the views profile's context
 * @param {Object} [opts]
 * @param {number} [opts.settleMs] quiet time before an evaluation; Infinity:
 *   never by itself, only on flush() (the replay lab drives it)
 * @param {number} [opts.maxWaitMs]
 * @param {boolean} [opts.tick] false: ignore the heartbeat (break-it control)
 * @param {Object|Function} [opts.viewsCtx] the context the views read
 *   through, or a function of ctx giving it (the lab's controls wrap it);
 *   ctx by default
 */
function init (env, ctx, opts) {
  opts = opts || {};
  const settleMs = opts.settleMs === undefined ? SETTLE_MS : opts.settleMs;
  const maxWaitMs = opts.maxWaitMs === undefined ? MAX_WAIT_MS : opts.maxWaitMs;
  const viewsCtx = typeof opts.viewsCtx === 'function' ? opts.viewsCtx(ctx) : opts.viewsCtx;
  const views = require('../data/views')(env, viewsCtx || ctx);

  const stats = { writes: 0, ticks: 0, ignoredWrites: 0, evaluations: 0, errors: 0, coalesced: 0 };
  let dirty = false;
  let reasons = {};
  let running = false;
  let timer = null;
  let firstPendingAt = null;
  let closed = false;
  let idleWaiters = [];

  function request (reason) {
    if (closed) return;
    stats[reason + 's'] += 1;
    if (dirty) stats.coalesced += 1;
    dirty = true;
    reasons[reason] = (reasons[reason] || 0) + 1;
    arm();
  }

  function arm () {
    if (running || !Number.isFinite(settleMs)) return;
    const nowMs = monotonicMs();
    if (firstPendingAt === null) firstPendingAt = nowMs;
    const wait = Math.max(0, Math.min(settleMs, firstPendingAt + maxWaitMs - nowMs));
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, wait);
  }

  function settled () {
    if (running || dirty) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach(fn => fn());
  }

  function run () {
    if (timer) { clearTimeout(timer); timer = null; }
    firstPendingAt = null;
    if (closed || running || !dirty) return settled();
    running = true;
    dirty = false;
    const why = reasons;
    reasons = {};
    const now = Date.now();
    evaluate(now, why, function evaluated () {
      running = false;
      if (dirty && !closed) {
        if (Number.isFinite(settleMs)) arm(); else return run();
      }
      settled();
    });
  }

  function evaluate (now, why, done) {
    views.compute('alarms', { now }, function computed (err, result) {
      stats.evaluations += 1;
      if (err) {
        stats.errors += 1;
        console.error('views profile: the alarms view failed;', err && err.message);
      } else {
        handOff(now, result);
        evaluator.last = { now, why, requested: result.requested.length };
      }
      ctx.bus.emit('views-evaluated', { now, why, ok: !err });
      done();
    });
  }

  // The server's step after a view (lib/data/views): the durable service
  // (ctx.notifications) is handed the plugins' requests as single's
  // 'data-loaded' handler hands them (bootevent setupListeners): initRequests,
  // each notify or snooze in the order the plugins asked, then process, which
  // applies the acks and snoozes it holds and emits on ctx.bus.
  function handOff (now, result) {
    ctx.notificationsClock.lastUpdated = now;
    ctx.notifications.initRequests();
    result.requested.forEach(function eachRequest (r) {
      const request = Object.assign({}, r);
      delete request.kind;
      if (r.kind === 'snooze') ctx.notifications.requestSnooze(request);
      else ctx.notifications.requestNotify(request);
    });
    ctx.notifications.process();
  }

  // GET /api/v2/properties: the properties view, computed for the request
  // at the instant it is asked (single answers from the sbx of its last
  // data-loaded cycle).
  function properties (done) {
    views.compute('properties', { now: Date.now() }, function computed (err, result) {
      if (err) return done(err);
      done(null, result.properties);
    });
  }

  function onWrite (event) {
    if (event && WATCHED.has(event.collection)) return request('write');
    stats.ignoredWrites += 1;
  }

  function onTick () {
    request('tick');
  }

  ctx.bus.on('storage-write-committed', onWrite);
  if (opts.tick !== false) ctx.bus.on('tick', onTick);

  function close () {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    ctx.bus.removeListener('storage-write-committed', onWrite);
    ctx.bus.removeListener('tick', onTick);
    dirty = false;
    settled();
  }
  ctx.bus.once('teardown', close);

  const evaluator = {
    stats
    , last: null
    // run now if anything is pending; cb once nothing is pending or running
    , flush (cb) {
      if (cb) idleWaiters.push(cb);
      if (!running) run();
    }
    , idle (cb) {
      idleWaiters.push(cb);
      settled();
    }
    , properties
    , close
  };
  return evaluator;
}

init.ddataHelpersOnly = ddataHelpersOnly;
init.HELPERS = HELPERS;
init.WATCHED = WATCHED;
init.SETTLE_MS = SETTLE_MS;
init.MAX_WAIT_MS = MAX_WAIT_MS;
module.exports = init;
