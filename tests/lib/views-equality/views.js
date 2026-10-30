'use strict';

// The ST-VIEWS equality harness: each server-side view computed two ways.
//
//   resident   the shipping data loader (lib/data/dataloader.js) filling a
//              ddata the way the server's first load does, every query as the
//              loader writes it.
//   bounded    the SAME loader, with each of its queries replaced by the
//              view's bounded queries (newest n of a type within a time
//              bound), through the same storage interface (ctx.entries.list,
//              ctx.treatments.list, ...). Its ddata is materialised for one
//              evaluation and discarded.
//
// Using the shipping loader for both arms keeps every transform the loader
// applies (field mapping, id normalisation, processTreatments, the
// treatment-to-curve fit) identical, so a difference can only come from what
// was read. Each arm gets a fresh lib/server/cache.js and a private bus, so
// neither sees the other's documents nor the booted server's.

const { EventEmitter } = require('events');
const createDData = require('../../../lib/data/ddata');
const createCache = require('../../../lib/server/cache');
const createLoader = require('../../../lib/data/dataloader');
const createNotifications = require('../../../lib/notifications');
const sandbox = require('../../../lib/sandbox');
const { MIN, HOUR } = require('./fixtures');

function iso (ms) { return new Date(ms).toISOString(); }

// ------------------------------------------------------------ query kinds
//
// The loader's queries, by what they ask for. A spec maps a kind to 'pass'
// (run the loader's own query), 'none' (answer []) or a function
// (now, info) -> [query, ...] whose results are concatenated.

function treatmentKind (q) {
  const et = q && q.find && q.find.eventType;
  if (et === 'Profile Switch') return 'profileSwitch';
  if (et && et.$eq) return 'latest';
  return 'treatments';
}

const sgvNewest = (n) => () => [{ find: { type: 'sgv' }, sort: { date: -1 }, count: n }];
const treatmentsSince = (ms) => ({ find: { created_at: { $gte: iso(ms) } }, sort: { created_at: 1 } });

// The alarm and properties views are product code (lib/data/views): their
// bounded arm is that module, with its own bounds (lib/data/views/bounds.js).
// The summary view's bound below extends the product's properties bound, as
// its own spec did before. In the product bounds a rule is 'loader' where
// this harness says 'pass'; route() treats the two alike.
// VIEWS_COB_DIAS: the summary view's treatment window, in DIAs (the product
// properties view's is fixed at bounds.PROPERTIES_DIAS).
const productViews = require('../../../lib/data/views');
const COB_DIAS = Number(process.env.VIEWS_COB_DIAS) || productViews.bounds.PROPERTIES_DIAS;
const PROPERTIES_SPEC = productViews.bounds.properties;

// GET /api/v2/summary?hours=6: readings and treatments over the hours asked
// for (plus an hour for a temp basal that started before and runs into it),
// temp targets over the treatment cache's 60 h (the route returns every temp
// target ddata holds), and the properties above for `state`.
const SUMMARY_HOURS = 6;
const SUMMARY_SPEC = Object.assign({}, PROPERTIES_SPEC, {
  entries: (now, info) => PROPERTIES_SPEC.entries(now, info).concat([{ find: { type: 'sgv', date: { $gte: now - SUMMARY_HOURS * HOUR } }, sort: { date: -1 } }])
  , treatments: (now, info) => [
    treatmentsSince(now - Math.max(COB_DIAS * info.diaHours, SUMMARY_HOURS + 1) * HOUR)
    , { find: { eventType: 'Temporary Target', created_at: { $gte: iso(now - 60 * HOUR) } }, sort: { created_at: 1 } }
  ]
});

// GET /api/v1/entries' Last-Modified (ifModifiedSinceCTX): the newest reading.
const CURRENT_SPEC = {
  entries: sgvNewest(1)
  , treatments: 'none', profileSwitch: 'none', latest: 'none', devicestatus: 'none'
  , profile: 'none', food: 'none', activity: 'none', dbstats: 'none'
};

// The page's first dataUpdate (websocket.js, lastData.dataWithRecentStatuses):
// the display window, written as time bounds equal to the cache retention.
const PAGE_SPEC = {
  entries: (now) => [{ find: { date: { $gte: now - 48 * HOUR } }, sort: { date: 1 } }]
  , treatments: (now) => [treatmentsSince(now - 60 * HOUR)]
  , profileSwitch: 'pass'
  , latest: 'pass'
  , devicestatus: (now) => [{ find: { created_at: { $gte: iso(now - 24 * HOUR) } }, sort: { created_at: -1 } }]
  , profile: 'pass'
  , food: 'pass'
  , activity: 'pass'
  , dbstats: 'pass'
};

// The deliberately wrong bound for each view: one record short at the edge the
// view depends on. `edge` names which end of that query's answer loses a record.
const TAMPER = {
  alarms: { kind: 'treatments', edge: 'newest' }
  , properties: { kind: 'devicestatus', edge: 'newest' }
  // the oldest reading inside the hours the route returns; the union's oldest
  // reading overall belongs to the properties window and dropping it changes
  // nothing the route returns (a first version of this control did that and
  // stayed green), and dropping it from summary's own query alone does not
  // remove it from the union, which another query also answers
  , summary: { kind: 'entries', edge: 'oldest', match: { type: 'sgv' }, withinHours: SUMMARY_HOURS }
  , current: { kind: 'entries', edge: 'newest' }
  , page: { kind: 'entries', edge: 'oldest', match: { type: 'sgv' } }
};

// The answers of several bounded queries are a set: a record two of them
// return is kept once. The cache's merge (lib/server/cache.js) removes a
// duplicate only between the batch and what it already holds, not within one
// batch, so a loader that unions queries has to do this itself (the first
// run of PROPERTIES_SPEC without it put the newest reading in ddata twice:
// $.bgnow.sgvs.length 1 !== 2).
function unionById (docs) {
  const seen = new Set();
  return docs.filter(function (d) {
    const id = String(d._id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function timeOf (doc) {
  if (typeof doc.date === 'number') return doc.date;
  return Date.parse(doc.created_at || doc.dateString || 0) || 0;
}

function dropOne (docs, edge, match, notBefore) {
  const candidates = docs.filter(d => (!match || Object.keys(match).every(k => d[k] === match[k]))
    && (notBefore == null || timeOf(d) >= notBefore));
  if (!candidates.length) return docs;
  const sorted = candidates.sort((a, b) => timeOf(a) - timeOf(b));
  const victim = edge === 'newest' ? sorted[sorted.length - 1] : sorted[0];
  if (process.env.VIEWS_DEBUG) console.log('TAMPER drops', edge, victim.type || victim.eventType || 'record', new Date(timeOf(victim)).toISOString());
  return docs.filter(d => d !== victim);
}

// ---------------------------------------------------------------- the arm

// A ddata filled by the shipping loader, with the loader's queries routed by
// `spec` (null: every query as written). Calls back with { ddata, queries }.
function load (env, ctx, spec, now, info, tamper, done) {
  const actx = Object.assign({}, ctx);
  actx.bus = new EventEmitter();
  actx.ddata = createDData();
  actx.cache = createCache(env, actx);
  const queries = [];

  function route (collection, kind, q, cb) {
    const rule = spec ? spec[kind] : 'pass';
    const real = ctx[collection];
    function finish (err, docs) {
      if (!err && docs && tamper && tamper.kind === kind) docs = dropOne(docs, tamper.edge, tamper.match, tamper.withinHours ? now - tamper.withinHours * HOUR : null);
      cb(err, docs);
    }
    if (rule === 'none') { queries.push({ kind, q: 'none' }); return finish(null, []); }
    if (rule === undefined || rule === 'pass' || rule === 'loader') { queries.push({ kind, q }); return real.list(q, finish); }
    const list = rule(now, info);
    let all = [];
    let pending = list.length;
    let failed = null;
    if (!pending) return finish(null, []);
    list.forEach(function (bq) {
      queries.push({ kind, q: bq });
      real.list(bq, function (err, docs) {
        if (err) failed = err;
        if (docs) all = all.concat(docs);
        if (--pending === 0) finish(failed, unionById(all));
      });
    });
  }

  actx.entries = { list: (q, cb) => route('entries', 'entries', q, cb) };
  actx.treatments = { list: (q, cb) => route('treatments', treatmentKind(q), q, cb) };
  actx.devicestatus = { list: (q, cb) => route('devicestatus', 'devicestatus', q, cb) };
  actx.activity = { list: (q, cb) => route('activity', 'activity', q, cb) };
  const gate = (kind, fn) => function (cb) {
    const rule = spec ? spec[kind] : 'pass';
    queries.push({ kind, q: rule === 'none' ? 'none' : 'pass' });
    if (rule === 'none') return cb(null, []);
    return fn(cb);
  };
  actx.profile = { last: gate('profile', cb => ctx.profile.last(cb)) };
  actx.food = { list: gate('food', cb => ctx.food.list(cb)) };
  // Database statistics are a live sample, not a bounded read: both arms of
  // one fixture are given the same sample (info.dbstats), so the comparison
  // is of what each arm read, not of when MongoDB updated its counters.
  actx.store = Object.assign({}, ctx.store, {
    db: { stats: () => ((spec ? spec.dbstats : 'pass') === 'none' ? Promise.resolve(null) : Promise.resolve(info.dbstats)) }
  });

  const ddata = createDData();
  createLoader(env, actx).update(ddata, { lastUpdated: now, frame: false }, function (err) {
    done(err, { ddata, queries });
  });
}

// --------------------------------------------------------------- the views

// bootevent.js setupListeners 'data-loaded': serverInit, setProperties,
// initRequests, checkNotifications, process, with a fresh notifications
// service and bus so no ack or snooze carries between evaluations.
function evaluate (env, ctx, ddata, now) {
  const ectx = Object.assign({}, ctx, { ddata, bus: new EventEmitter(), runtimeState: 'loaded' });
  const emitted = [];
  const requested = [];
  ectx.bus.on('notification', n => emitted.push(n));
  ectx.notifications = createNotifications(env, ectx);
  const requestNotify = ectx.notifications.requestNotify;
  const requestSnooze = ectx.notifications.requestSnooze;
  ectx.notifications.requestNotify = function (n) { requested.push(Object.assign({ kind: 'notify' }, n)); return requestNotify(n); };
  ectx.notifications.requestSnooze = function (s) { requested.push(Object.assign({ kind: 'snooze' }, s)); return requestSnooze(s); };

  // The evaluation instant is `now` for the wall clock too: the iob plugin
  // dates a device-reported IOB that carries no timestamp with
  // moment(undefined), i.e. the wall clock (lib/plugins/iob.js
  // fromDeviceStatus), so without this two loads of the same corpus differ by
  // the milliseconds between them ($.iob.mills, corpus #2).
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const sbx = sandbox().serverInit(env, ectx);
    sbx.time = now;
    ctx.plugins.setProperties(sbx);
    ectx.notifications.initRequests();
    ctx.plugins.checkNotifications(sbx);
    ectx.notifications.process(sbx);
    ectx.bus.emit('teardown');
    return { sbx, emitted, requested };
  } finally {
    Date.now = realNow;
  }
}

function sig (list) {
  return list
    .map(n => [n.kind || '', n.level, n.group, n.plugin && n.plugin.name, n.eventName || '', n.title || '', n.message || ''].join('|'))
    .sort();
}

function normalise (value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

// view name -> { spec, compute(env, ctx, ddata, now) -> comparable output }
const VIEWS = {
  // product: the bounded arm is lib/data/views; `output` maps that module's
  // result to the same comparable form `compute` gives the resident arm
  alarms: {
    product: true
    , compute: (env, ctx, ddata, now) => {
      const r = evaluate(env, ctx, ddata, now);
      return { emitted: sig(r.emitted), requested: sig(r.requested) };
    }
    , output: r => ({ emitted: sig(r.emitted), requested: sig(r.requested) })
  }
  , properties: {
    product: true
    , compute: (env, ctx, ddata, now) => normalise(evaluate(env, ctx, ddata, now).sbx.properties)
    , output: r => normalise(r.properties)
  }
  , summary: {
    spec: SUMMARY_SPEC
    // the route reads ctx.ddata and ctx.sbx; it is called with a context that
    // holds this arm's
    , route: true
    , compute: null
  }
  , current: {
    spec: CURRENT_SPEC
    , compute: (env, ctx, ddata) => {
      // lib/api/entries/index.js ifModifiedSinceCTX
      const s = ddata.sgvs;
      return s.length > 0 ? new Date(s[s.length - 1].mills).toUTCString() : null;
    }
  }
  , page: {
    spec: PAGE_SPEC
    , compute: (env, ctx, ddata, now) => {
      // websocket.js: the payload a reading socket gets on authorize. The
      // server serialises it after the plugin pass ('data-processed' comes
      // before the socket's update), and that pass writes onto the shared
      // documents (sandbox.scaleEntry's `scaled`, the openaps state
      // selector's `openaps.iob.moment`), so the payload carries those writes; both arms
      // run the pass first, as the server does.
      evaluate(env, ctx, ddata, now);
      const realNow = Date.now;
      Date.now = () => now;
      try {
        // Records with the same `mills` reach ddata in the order the loader's
        // parallel queries complete, which differs from load to load on the
        // shipping server (the resident-vs-resident check reproduces it). The
        // payload is compared with such ties put in _id order; nothing else
        // is reordered.
        const out = normalise(ddata.dataWithRecentStatuses());
        Object.keys(out).forEach(function (k) {
          if (Array.isArray(out[k])) out[k] = tiesInIdOrder(out[k]);
        });
        return out;
      } finally {
        Date.now = realNow;
      }
    }
  }
};

// Each run of consecutive records with the same `mills` in _id order; the
// order between runs is left exactly as it was.
function tiesInIdOrder (list) {
  const out = [];
  let run = [];
  function flush () {
    run.sort((a, b) => String(a && a._id).localeCompare(String(b && b._id)));
    out.push.apply(out, run);
    run = [];
  }
  list.forEach(function (item) {
    if (run.length && !(item && run[0] && item.mills === run[0].mills && item.mills !== undefined)) flush();
    run.push(item);
  });
  flush();
  return out;
}

// The first path at which two JSON values differ, for the failure message.
function firstDifference (a, b, at) {
  at = at || '$';
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return at + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return at + ': array vs object';
  if (Array.isArray(a) && a.length !== b.length) return at + '.length: ' + a.length + ' !== ' + b.length;
  const keys = new Set(Object.keys(a).concat(Object.keys(b)));
  for (const k of keys) {
    const d = firstDifference(a[k], b[k], at + '.' + k);
    if (d) return d;
  }
  return null;
}

const diaHours = productViews.bounds.diaHours;

// ------------------------------------------------------ the product arm

// The context the product module is given: the booted server's, with the
// storage reads of a tampered view wrapped so that the view's bounded query of
// the tampered kind answers one record short (TAMPER). `dry` installs the same
// wrapper and drops nothing: the untampered control for the wrapper itself.
//
// VIEWS_SHRINK=<kind>:<hours>[,...]: the view's answer for that read kind
// (treatments or devicestatus, as productViews.kindOf names it) keeps only
// the records created within <hours> of the evaluation instant: the control
// that each window a view reads is needed, not only wide enough.
function shrinkRules () {
  return (process.env.VIEWS_SHRINK || '').split(',').filter(Boolean).map(function (r) {
    const [kind, hours] = r.split(':');
    if (['treatments', 'devicestatus'].indexOf(kind) < 0 || !(Number(hours) > 0)) throw new Error('VIEWS_SHRINK: not <treatments|devicestatus>:<hours>: ' + r);
    return { kind, ms: Number(hours) * HOUR };
  });
}

function productContext (ctx, tamper, now, dry) {
  const pctx = Object.create(ctx);
  shrinkRules().forEach(function (rule) {
    const real = pctx[rule.kind];
    pctx[rule.kind] = {
      list: function (q, cb) {
        real.list(q, function (err, docs) {
          if (!err && docs && productViews.kindOf(rule.kind, q) === rule.kind) {
            // the replay pins the wall clock to the evaluated minute
            const since = (now != null ? now : Date.now()) - rule.ms;
            docs = docs.filter(d => Date.parse(d.created_at) >= since);
          }
          cb(err, docs);
        });
      }
    };
  });
  if (!tamper) return pctx;
  ['entries', 'treatments', 'devicestatus'].forEach(function (collection) {
    const real = pctx[collection];
    pctx[collection] = {
      list: function (q, cb) {
        real.list(q, function (err, docs) {
          if (!err && docs && productViews.kindOf(collection, q) === tamper.kind && !dry) {
            docs = dropOne(docs, tamper.edge, tamper.match, tamper.withinHours ? now - tamper.withinHours * HOUR : null);
          }
          cb(err, docs);
        });
      }
    };
  });
  return pctx;
}

// The product view's working set (lib/data/views materialise), evaluated with
// the wall clock held at `now` as the resident arm's evaluate() does.
function product (env, ctx, name, now, info, tamper, dry, done) {
  const views = productViews(env, productContext(ctx, tamper, now, dry));
  views.materialise(name, { now, dbstats: info.dbstats }, function (err, set) {
    if (err) return done(err);
    const realNow = Date.now;
    Date.now = () => now;
    let result;
    try {
      result = views.evaluate(set);
    } finally {
      Date.now = realNow;
    }
    done(null, { ddata: set.ddata, queries: set.queries, result });
  });
}

module.exports = { VIEWS, TAMPER, load, product, productContext, evaluate, firstDifference, diaHours, sig, normalise, MIN };
