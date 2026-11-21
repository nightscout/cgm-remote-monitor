'use strict';

// Computed views without a resident ddata (ST-VIEWS).
//
// A view reads what it needs through the storage interface (ctx.entries,
// ctx.treatments, ctx.devicestatus, ctx.profile; lib/server/storage-reads.js)
// with the bounded queries in ./bounds.js, materialises a ddata-shaped working
// set from them, computes from it, and drops it. It never reads or writes the
// server's resident state: ctx.ddata, ctx.sbx, ctx.cache, ctx.bus,
// ctx.notifications, ctx.dataloader and ctx.plugins are not touched.
//
// What is computed is the shipping derivation, not a re-implementation:
//
//   - the working set is filled by the shipping data loader
//     (lib/data/dataloader.js: field mapping, processRawDataForRuntime,
//     processTreatments, the treatment-to-curve fit), given a private context
//     whose reads are answered by the view's bounded queries. The loader needs
//     a cache and a ddata (for its merge helpers) on that context; the view
//     gives it a fresh lib/server/cache.js and a fresh lib/data/ddata.js of
//     its own, both dropped with the working set;
//   - the plugin pass is bootevent's 'data-loaded' cycle (sandbox serverInit,
//     setProperties, initRequests, checkNotifications, process) on a fresh
//     sandbox, with the view's own plugin set and a fresh
//     lib/notifications.js on a private bus.
//
// Notifications. The view reports what the plugins requested (notifies and
// snoozes, before highest-wins) and what a notifications service with no
// earlier acks or snoozes would emit for them. It does not call the server's
// ctx.notifications, so it neither reads nor changes ack or snooze state.
// Handing a result to that durable state is the server's step: initRequests,
// then each requested notify or snooze in order (requestNotify,
// requestSnooze), then process, which applies the acks and snoozes it holds.
//
// Usage:
//
//   const views = require('./lib/data/views')(env, ctx);
//   views.compute('alarms', { now }, function (err, result) {
//     // result.emitted, result.requested
//   });
//   views.compute('properties', { now }, function (err, result) {
//     // result.properties
//   });
//
// compute() is materialise() followed by evaluate(); they are separate so a
// caller can hold the instant fixed across the synchronous part.

const { EventEmitter } = require('events');
const acquisition = require('../private-acquisition');
const createNotifications = require('../../notifications');
const sandbox = require('../../sandbox');
const bounds = require('./bounds');
const workingSet = require('../working-set');
const createCache = require('../../server/cache');

const VIEW_NAMES = ['alarms', 'properties'];

// The plugins a view runs: the server's set, less those whose
// checkNotifications acts outside the process. webhook sends an HTTP request
// for each new reading; a view only computes.
const EXCLUDED_PLUGINS = ['webhook'];

/**
 * The kind of a data-loader read, by the shape of its query. A query the
 * loader does not issue is refused rather than answered with some other
 * kind's bound.
 * @param {string} collection entries | treatments | devicestatus | activity
 * @param {Object} q the loader's query
 * @returns {string|null} the kind, or null for a query the loader does not issue
 */
function kindOf (collection, q) {
  const find = (q && q.find) || {};
  const keys = Object.keys(find).sort().join(',');
  if (collection === 'entries') return keys === 'date' ? 'entries' : null;
  if (collection === 'devicestatus') return keys === 'created_at' ? 'devicestatus' : null;
  if (collection === 'activity') return keys === 'created_at' ? 'activity' : null;
  if (collection === 'treatments') {
    if (keys === 'created_at') return 'treatments';
    if (keys === 'created_at,duration,eventType' && find.eventType === 'Profile Switch' && q.count === 1) return 'profileSwitch';
    if (keys === 'created_at,eventType' && find.eventType && typeof find.eventType.$eq === 'string' && q.count === 1) return 'latest';
  }
  return null;
}

// The answers of several bounded queries are a set: a record two of them
// return is kept once. The cache merge removes a duplicate only between a
// batch and what it already holds, not within one batch.
function unionById (docs) {
  const seen = new Set();
  return docs.filter(function once (d) {
    const id = String(d && d._id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function init (env, ctx) {

  // The plugin set is the view's own: a plugin that keeps state between
  // cycles (xdripjs's state-change notice, webhook's last reading sent) keeps
  // it for this module, not for the server's resident cycle.
  const pluginSettings = Object.create(env.settings);
  pluginSettings.enable = (env.settings.enable || []).filter(function keep (name) {
    return EXCLUDED_PLUGINS.indexOf(name) < 0;
  });
  const plugins = require('../../plugins')({
    settings: pluginSettings
    , webhook: env.webhook
    , language: ctx.language
    , levels: ctx.levels
    , moment: ctx.moment
  }).registerServerDefaults();

  /**
   * Read a view's bounded queries and fill a fresh ddata from them.
   * @param {string} name a view name (alarms, properties)
   * @param {Object} opts { now: ms (default Date.now()), dbstats: a db.stats()
   *   result to use instead of asking the store }
   * @param {Function} done (err, { name, now, ddata, queries })
   */
  function materialise (name, opts, done) {
    if (typeof opts === 'function') { done = opts; opts = {}; }
    opts = opts || {};
    const spec = bounds[name];
    if (VIEW_NAMES.indexOf(name) < 0 || !spec) return done(new Error('views: no view named ' + name));
    const now = opts.now == null ? Date.now() : Number(opts.now);
    if (!Number.isFinite(now)) return done(new Error('views: not an instant: ' + opts.now));

    ctx.profile.last(function profileRead (err, profileDocs) {
      if (err) return done(err);
      fill(name, spec, now, profileDocs || [], opts, done);
    });
  }

  function fill (name, spec, now, profileDocs, opts, done) {
    const info = { devicestatusMs: bounds.devicestatusLookback(env) };
    const queries = [];
    const errors = [];

    function failed (err) {
      errors.push(err);
      return err;
    }

    // Answer one loader read of `collection` with the view's rule for its kind.
    function route (collection, q, cb) {
      const kind = kindOf(collection, q);
      if (!kind) return cb(failed(new Error('views: the data loader asked ' + collection + ' for a query this view has no bound for: ' + JSON.stringify(q && q.find))));
      const rule = spec[kind];
      const store = ctx[collection];
      if (rule === 'none') { queries.push({ kind, q: 'none' }); return cb(null, []); }
      if (rule === 'loader') {
        queries.push({ kind, q });
        return store.list(q, function answered (err, docs) {
          if (err) failed(err);
          cb(err, docs);
        });
      }
      const list = rule(now, info);
      let all = [];
      let pending = list.length;
      let firstErr = null;
      if (!pending) return cb(null, []);
      list.forEach(function eachBounded (bq) {
        queries.push({ kind, q: bq });
        store.list(bq, function answered (err, docs) {
          if (err && !firstErr) firstErr = failed(err);
          if (docs) all = all.concat(docs);
          if (--pending === 0) cb(firstErr, firstErr ? null : unionById(all));
        });
      });
    }

    function gate (kind, answer) {
      return function read (cb) {
        const rule = spec[kind];
        queries.push({ kind, q: rule === 'none' ? 'none' : 'loader' });
        if (rule === 'none') return cb(null, []);
        return answer(cb);
      };
    }

    const sources = {
      entries: (q, cb) => route('entries', q, cb)
      , treatments: (q, cb) => route('treatments', q, cb)
      , devicestatus: (q, cb) => route('devicestatus', q, cb)
      , activity: (q, cb) => route('activity', q, cb)
      // read once above; the loader is given the same documents
      , profile: gate('profile', cb => cb(null, profileDocs))
      , food: gate('food', cb => ctx.food.list(function answered (err, docs) {
        if (err) failed(err);
        cb(err, docs);
      }))
      , stats: function stats () {
        queries.push({ kind: 'dbstats', q: spec.dbstats === 'none' ? 'none' : 'loader' });
        if (spec.dbstats === 'none') return Promise.resolve(null);
        if (opts.dbstats !== undefined) return Promise.resolve(opts.dbstats);
        return Promise.resolve(ctx.store.db.stats()).catch(function statsFailed (err) {
          throw failed(err);
        });
      }
    };
    if (opts.keep != null) return keepOrLoad(name, now, opts.keep, sources, queries, errors, failed, done);
    loadFrom(now, sources, function loaded (err, ddata) {
      // The loader logs a failed read and carries on without it; a view that
      // did the same would compute from a partial window and look complete.
      const first = err || errors[0];
      if (first) return done(first);
      done(null, { name, now, ddata, queries });
    });
  }

  function loadFrom (now, sources, done) {
    const lctx = acquisition.createContext({
      settings: ctx.settings || env.settings
      , language: ctx.language
      , entries: { list: sources.entries }
      , treatments: { list: sources.treatments }
      , devicestatus: { list: sources.devicestatus }
      , activity: { list: sources.activity }
      , profile: { last: sources.profile }
      , food: { list: sources.food }
      , store: { db: { stats: sources.stats } }
    });
    acquisition.load(env, lctx, { lastUpdated: now, frame: false }, done);
  }

  // ---- Keeping the working set between evaluations (evaluator cost lane, B)
  //
  // A caller that evaluates the same input again and again (the evaluator's
  // time-only cycles) passes opts.keep: a token that is the same object for
  // as long as the input is the same. The view then:
  //
  //   1. asks the data loader which reads it would make at this instant, by
  //      running it once over empty answers (the reads are the loader's own,
  //      whatever its version: nothing here restates them);
  //   2. makes those reads, through the same rules as a load (route, gate);
  //   3. if the token, the view and every answer (each document's typed
  //      identity, in order; the profile; the statistics) are the same as
  //      when the working set was kept, and no document is within
  //      KEEP_MARGIN_MS of a clock rule the loader applies outside its reads
  //      (the cache's retention by Date.now(), lib/server/cache.js; the
  //      profile switch "before now", dataloader loadProfileSwitchTreatments),
  //      hands out a copy of the kept working set at this instant;
  //   4. otherwise loads from those answers (no second read) and keeps a
  //      frozen copy of the result for the next instant.
  //
  // So a kept working set is reused only while every window cut equals the
  // last one; a document leaving a window is a load. The kept set is never
  // handed out: each evaluation gets its own copy (lib/data/working-set.js).
  const KEEP_MARGIN_MS = 1000;
  const RETAINED = ['entries', 'treatments', 'devicestatus'];
  let kept = null;

  function requestsAt (now, done) {
    const requests = [];
    const recorder = collection => (q, cb) => { requests.push({ collection, q }); cb(null, []); };
    const dry = {
      entries: recorder('entries'), treatments: recorder('treatments'), devicestatus: recorder('devicestatus')
      , activity: recorder('activity')
      , profile: cb => { requests.push({ collection: 'profile' }); cb(null, []); }
      , food: cb => { requests.push({ collection: 'food' }); cb(null, []); }
      , stats: () => { requests.push({ collection: 'dbstats' }); return Promise.resolve(null); }
    };
    loadFrom(now, dry, err => done(err, requests));
  }

  function identityOf (doc) {
    const id = doc && doc._id;
    if (typeof id === 'string') return 's' + id;
    if (id && typeof id.toHexString === 'function') return 'o' + id.toHexString();
    return 'x' + JSON.stringify(id === undefined ? null : id);
  }

  function witnessOf (requests, answers) {
    return JSON.stringify(requests.map((r, i) => {
      const a = answers[i];
      if (r.collection === 'dbstats') return ['dbstats', a === undefined ? null : a];
      return [r.collection, Array.isArray(a) ? a.map(identityOf) : null];
    }));
  }

  // The instants at which a clock rule outside the reads would change its
  // answer for one of these documents: per retained datatype, each
  // document's cache age plus its retention; each profile switch's time.
  function clockEdges (requests, answers, retention) {
    const edges = [];
    const scratch = acquisition.createWorkingSet();
    requests.forEach((r, i) => {
      const docs = answers[i];
      if (!Array.isArray(docs) || !docs.length) return;
      const kind = r.q ? kindOf(r.collection, r.q) : null;
      if (RETAINED.indexOf(kind) >= 0 && kind === r.collection) {
        for (const doc of scratch.processRawDataForRuntime(docs)) {
          const age = createCache.objectAge(doc);
          if (Number.isFinite(age)) edges.push(age + retention[kind]);
        }
      }
      if (kind === 'profileSwitch') {
        for (const doc of docs) {
          const at = new Date(doc.created_at).getTime();
          if (Number.isFinite(at)) edges.push(at);
        }
      }
    });
    return edges;
  }

  function clockHolds (record, t) {
    const lo = Math.min(record.t, t) - KEEP_MARGIN_MS, hi = Math.max(record.t, t) + KEEP_MARGIN_MS;
    for (const edge of record.edges) if (edge >= lo && edge <= hi) return false;
    return true;
  }

  function keepOrLoad (name, now, token, sources, queries, errors, failed, done) {
    requestsAt(now, function requested (err, requests) {
      if (err) return done(err);
      const answers = new Array(requests.length);
      let pending = requests.length;
      function settle () { if (--pending === 0) decide(); }
      requests.forEach(function ask (r, i) {
        if (r.collection === 'dbstats') {
          Promise.resolve().then(() => sources.stats()).then(v => { answers[i] = v; }, () => { answers[i] = null; }).then(settle);
          return;
        }
        const reply = (e, docs) => { answers[i] = e ? null : docs; settle(); };
        if (r.collection === 'profile' || r.collection === 'food') sources[r.collection](reply);
        else sources[r.collection](r.q, reply);
      });

      function decide () {
        if (errors.length) return done(errors[0]);
        const witness = witnessOf(requests, answers);
        const t = Date.now();
        if (kept && kept.token === token && kept.name === name && kept.witness === witness && clockHolds(kept, t)) {
          const ddata = workingSet.copy(kept.data, acquisition.createWorkingSet);
          ddata.lastUpdated = now;
          return done(null, { name, now, ddata, queries, kept: true });
        }
        const edges = clockEdges(requests, answers, createCache.retentionPeriods(env));
        const used = requests.map(() => false);
        // Each loader read answered from step 2, in the order it is made.
        function answer (collection, q) {
          const key = q === undefined ? undefined : JSON.stringify(q);
          const i = requests.findIndex((r, j) => !used[j] && r.collection === collection &&
            (key === undefined || JSON.stringify(r.q) === key));
          if (i < 0) throw failed(new Error('views: the data loader made a read it did not announce: ' + collection));
          used[i] = true;
          return answers[i];
        }
        const later = (fn, cb) => Promise.resolve().then(fn).then(v => cb(null, v), e => cb(e));
        const replayed = {
          entries: (q, cb) => later(() => answer('entries', q), cb)
          , treatments: (q, cb) => later(() => answer('treatments', q), cb)
          , devicestatus: (q, cb) => later(() => answer('devicestatus', q), cb)
          , activity: (q, cb) => later(() => answer('activity', q), cb)
          , profile: cb => later(() => answer('profile'), cb)
          , food: cb => later(() => answer('food'), cb)
          , stats: () => Promise.resolve().then(() => answer('dbstats'))
        };
        kept = null;
        loadFrom(now, replayed, function loaded (err, ddata) {
          const first = err || errors[0];
          if (first) return done(first);
          const data = workingSet.keep(ddata);
          if (data) kept = { token, name, witness, data, edges, t };
          done(null, { name, now, ddata, queries, kept: false });
        });
      }
    });
  }

  /**
   * bootevent's 'data-loaded' cycle on a working set, with nothing shared.
   * @param {Object} set from materialise
   * @returns {{ sbx, emitted, requested }}
   */
  function run (set) {
    const now = set.now;
    const bus = new EventEmitter();
    const emitted = [];
    const requested = [];
    bus.on('notification', function emit (n) { emitted.push(n); });
    // notifications gates each emission on ddata.lastUpdated (the evaluation
    // instant), and keeps its alarms, acks and snoozes on this private service
    const notifications = createNotifications(env, { levels: ctx.levels, bus, ddata: set.ddata });
    const sctx = {
      ddata: set.ddata
      , runtimeState: 'loaded'
      , levels: ctx.levels
      , language: ctx.language
      , moment: ctx.moment
      , notifications: {
        requestNotify: function requestNotify (n) {
          requested.push(Object.assign({ kind: 'notify' }, n));
          return notifications.requestNotify(n);
        }
        , requestSnooze: function requestSnooze (s) {
          requested.push(Object.assign({ kind: 'snooze' }, s));
          return notifications.requestSnooze(s);
        }
      }
    };
    try {
      const sbx = sandbox().serverInit(env, sctx);
      sbx.time = now;
      plugins.setProperties(sbx);
      notifications.initRequests();
      plugins.checkNotifications(sbx);
      notifications.process(sbx);
      return { sbx, emitted, requested };
    } finally {
      bus.emit('teardown');
    }
  }

  /**
   * A view's output from a working set. Synchronous.
   * @param {Object} set from materialise
   * @returns alarms: { now, emitted, requested }; properties: { now, properties }
   */
  function evaluate (set) {
    const r = run(set);
    if (set.name === 'alarms') return { now: set.now, emitted: r.emitted, requested: r.requested };
    return { now: set.now, properties: r.sbx.properties };
  }

  /**
   * One cycle on a working set giving both outputs: the alarms (emitted,
   * requested) and the properties, from the same plugin pass on one
   * sandbox, in bootevent's 'data-loaded' order. For a caller that keeps the
   * properties of its last cycle, as single keeps ctx.sbx: a plugin that
   * keeps state between cycles (xdripjs's state-change notice) then sees one
   * cycle per evaluation, not one per view. Synchronous.
   * @param {Object} set from materialise('properties'), whose bound contains
   *   the alarm window
   * @returns {{ now, emitted, requested, properties }}
   */
  function evaluateCycle (set) {
    const r = run(set);
    return { now: set.now, emitted: r.emitted, requested: r.requested, properties: r.sbx.properties };
  }

  /**
   * materialise, then evaluate; the working set is not kept.
   * @param {string} name
   * @param {Object} opts as materialise
   * @param {Function} done (err, result)
   */
  function compute (name, opts, done) {
    if (typeof opts === 'function') { done = opts; opts = {}; }
    materialise(name, opts, function materialised (err, set) {
      if (err) return done(err);
      let result;
      try {
        result = evaluate(set);
      } catch (e) {
        return done(e);
      }
      done(null, result);
    });
  }

  return { names: VIEW_NAMES.slice(), materialise, evaluate, evaluateCycle, compute };
}

init.kindOf = kindOf;
init.bounds = bounds;
module.exports = init;
