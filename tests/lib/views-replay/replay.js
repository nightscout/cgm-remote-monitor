'use strict';

// ST-VIEWS replay lab: minute by minute over days of uploads, does the alarm
// view (lib/data/views, PR #8875) raise exactly what today's resident path
// raises?
//
//   node tests/lib/views-replay/replay.js --dataset synthetic:<name>|corpus:<n>
//        --mode main|shrink:<kind>:<hours>|tamper
//        --db <database> --out <summary.json> [--details <diffs.jsonl>]
//        [--tail-hours 26] [--no-r2] [--port 27017] [--profiles-at-start]
//
// --profiles-at-start: a profile document dated after the replay's last minute
// (an export's profiles are often its current ones, months newer than its
// readings) is uploaded before the first minute instead of never.
//
// One process replays one dataset in one mode, on its own database. Three
// arms run on every minute, on the same database, in this order:
//
//   server  the booted server's own resident path: ctx.dataloader.update on
//           ctx.ddata with the server's cache, then the server's own
//           'data-loaded' handler (lib/server/bootevent.js), which runs the
//           plugins and ctx.notifications. Nothing of it is re-implemented.
//   r2      a second resident path, built the way bootevent builds the
//           server's (its own bus, ddata, cache, loader, plugin set and
//           notification service; the data-update events the storage layer
//           emits are forwarded to its bus). server vs r2 is the noise floor.
//   view    lib/data/views compute('alarms') (materialise, then evaluate),
//           whose requested notifies and snoozes are then handed to a durable
//           notification service of the view arm's own, as lib/data/views
//           describes the server's step: initRequests, each requested notify
//           or snooze in order, process. Acks reach that service as they
//           reach the server's.
//
// The clock is pinned to the replayed minute (./clock.js). Records are
// uploaded through the server's storage interface (ctx.entries.create,
// ctx.treatments.create, ctx.devicestatus.create, ctx.profile.create), so
// deduplication and the data-update events are the shipping ones, at their
// own time (or _uploadAt): the database at minute t holds what was uploaded
// by t.
//
// Compared on every minute: the notifications each arm's notification
// service emitted (level, group, plugin, eventName, title, message, clear),
// and the notifies and snoozes the plugins requested.
//
// Controls (the view arm only is changed; through the equality harness's own
// wrapper, tests/lib/views-equality/views.js productContext):
//   shrink:<kind>:<hours>
//                    VIEWS_SHRINK=<kind>:<hours>: the view's treatments or
//                    devicestatus answer keeps only the records created within
//                    <hours> of the minute (each window is needed)
//   tamper           VIEWS_TAMPER=alarms: the view's treatments read is one
//                    record short at its newest edge
//
// The summary written to --out carries counts, minutes and plugin names
// only. --details gets every differing minute with the notification text, which
// for a corpus set contains its values: keep it out of any repository.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '../../..');

function args () {
  const out = { mode: 'main', tailHours: 26, r2: true, port: 27017 };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--dataset') out.dataset = a[++i];
    else if (k === '--mode') out.mode = a[++i];
    else if (k === '--db') out.db = a[++i];
    else if (k === '--out') out.out = a[++i];
    else if (k === '--details') out.details = a[++i];
    else if (k === '--tail-hours') out.tailHours = Number(a[++i]);
    else if (k === '--no-r2') out.r2 = false;
    else if (k === '--profiles-at-start') out.profilesAtStart = true;
    else if (k === '--port') out.port = Number(a[++i]);
    else if (k === '--max-steps') out.maxSteps = Number(a[++i]);
    else throw new Error('unknown argument ' + k);
  }
  if (!out.dataset || !out.db || !out.out) throw new Error('--dataset, --db and --out are required');
  return out;
}

// The alarm set and alarm settings of tests/views-equality.test.js.
const ALARM_PLUGINS = [
  'bgnow', 'delta', 'direction', 'rawbg', 'upbat', 'ar2', 'simplealarms',
  'errorcodes', 'iob', 'cob', 'careportal', 'pump', 'openaps', 'xdripjs',
  'loop', 'bwp', 'cage', 'sage', 'iage', 'bage', 'treatmentnotify', 'timeago',
  'basal', 'dbsize', 'runtimestate', 'devicestatus', 'profile', 'bolus', 'override'
];
const ALARM_ENV = {
  API_SECRET: 'this is my long pass phrase'
  , ENABLE: ALARM_PLUGINS.join(' ')
  , ALARM_TYPES: 'simple predict'
  , ALARM_HIGH: 'on', ALARM_URGENT_HIGH: 'on', ALARM_LOW: 'on', ALARM_URGENT_LOW: 'on'
  , ALARM_TIMEAGO_WARN: 'on', ALARM_TIMEAGO_URGENT: 'on'
  , TIMEAGO_ENABLE_ALERTS: 'true', CAGE_ENABLE_ALERTS: 'true', SAGE_ENABLE_ALERTS: 'true'
  , IAGE_ENABLE_ALERTS: 'true', BAGE_ENABLE_ALERTS: 'true', UPBAT_ENABLE_ALERTS: 'true'
  , PUMP_ENABLE_ALERTS: 'true', OPENAPS_ENABLE_ALERTS: 'true', LOOP_ENABLE_ALERTS: 'true'
  , HOSTNAME: 'localhost', INSECURE_USE_HTTP: 'true', NODE_ENV: 'test', TZ: 'UTC'
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// ------------------------------------------------------------ datasets

function uploadTime (collection, d) {
  let t;
  if (d._uploadAt != null) return Number(d._uploadAt);
  if (collection === 'entries') t = Number(d.date) || Date.parse(d.dateString);
  else if (collection === 'profile') t = Date.parse(d.created_at) || Date.parse(d.startDate) || Number(d.mills);
  else t = Date.parse(d.created_at) || Number(d.mills);
  return t;
}

function loadDataset (spec, tailHours) {
  const [kind, name] = spec.split(':');
  if (kind === 'synthetic') {
    const tl = require('./timelines').TIMELINES[name];
    if (!tl) throw new Error('no synthetic timeline ' + name);
    const t = tl();
    return { label: 'synthetic ' + t.name, about: t.about, start: t.start, end: t.end, env: t.env, records: t.records, acks: t.acks, T0: require('./timelines').T0 };
  }
  if (kind === 'corpus') {
    const dir = process.env.VIEWS_CORPUS_DIR;
    const { corpusNames } = require(path.join(ROOT, 'tests/lib/views-equality/fixtures'));
    const names = corpusNames(dir);
    const set = names[Number(name) - 1];
    if (!set) throw new Error('no corpus set at position ' + name + ' in VIEWS_CORPUS_DIR');
    const read = k => { const f = path.join(dir, set + '_' + k + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; };
    const strip = d => { const o = Object.assign({}, d); delete o._id; return o; };
    const records = { entries: read('entries').map(strip), treatments: read('treatments').map(strip), devicestatus: read('devicestatus').map(strip), profile: read('profile').map(strip) };
    let lo = Infinity;
    let hi = -Infinity;
    ['entries', 'treatments', 'devicestatus'].forEach(function (c) {
      records[c].forEach(function (d) {
        const t = uploadTime(c, d);
        if (Number.isFinite(t)) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
      });
    });
    const start = Math.floor(lo / MIN) * MIN;
    const end = Math.ceil(hi / MIN) * MIN + tailHours * HOUR;
    // acks at fixed fractions of the span, so each set gets some at varied times
    const span = end - start;
    const acks = [0.07, 0.15, 0.23, 0.31, 0.38, 0.46, 0.55, 0.63, 0.71, 0.8, 0.88].map((f, i) => ({ at: start + Math.round(span * f / MIN) * MIN, mode: 'active', mins: [15, 30, 60, 120, 5, 45][i % 6] }))
      .concat([{ at: start + Math.round(span * 0.5 / MIN) * MIN, mode: 'blind', level: 2, group: 'default', mins: 30 }]);
    return { label: 'corpus #' + name, about: 'corpus set at position ' + name + ', read in place, uploaded at its own times', start, end, env: {}, records, acks, T0: start };
  }
  throw new Error('dataset must be synthetic:<name> or corpus:<n>');
}

// ------------------------------------------------------------ comparison

function sigNotify (n) {
  return [n.level, n.group || 'default', n.plugin && n.plugin.name, n.eventName || '', n.title || '', n.message || '', n.clear ? 'clear' : ''].join('|');
}
function sigRequest (r) {
  return [r.kind, r.level, r.group || 'default', r.plugin && r.plugin.name, r.eventName || '', r.title || '', r.message || '', r.lengthMills || ''].join('|');
}
// multiset difference both ways
function diff (a, b) {
  const count = new Map();
  a.forEach(s => count.set(s, (count.get(s) || 0) + 1));
  const onlyB = [];
  b.forEach(function (s) {
    const c = count.get(s) || 0;
    if (c > 0) count.set(s, c - 1); else onlyB.push(s);
  });
  const onlyA = [];
  count.forEach((c, s) => { for (let i = 0; i < c; i++) onlyA.push(s); });
  return { onlyA, onlyB, equal: !onlyA.length && !onlyB.length };
}
function pluginOf (sig) { const p = sig.split('|'); return p[0] === 'notify' || p[0] === 'snooze' ? p[3] : (p[6] === 'clear' ? 'clear:' + p[1] : p[2]); }
function levelOf (sig) { const p = sig.split('|'); return p[0] === 'notify' || p[0] === 'snooze' ? p[0] + ':' + p[1] : p[0]; }

// ------------------------------------------------------------ cost

function stats (list) {
  if (!list.length) return null;
  const s = list.slice().sort((x, y) => x - y);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const sum = s.reduce((x, y) => x + y, 0);
  return { mean: +(sum / s.length).toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s[s.length - 1].toFixed(3), total: +sum.toFixed(1) };
}

// ------------------------------------------------------------ main

function main () {
  const opt = args();
  const dataset = loadDataset(opt.dataset, opt.tailHours);

  Object.assign(process.env, ALARM_ENV, dataset.env, {
    CUSTOMCONNSTR_mongo: 'mongodb://127.0.0.1:' + opt.port + '/' + opt.db
  });
  if (opt.mode.startsWith('shrink:')) process.env.VIEWS_SHRINK = opt.mode.slice(7);

  const clock = require('./clock');
  const createDData = require(path.join(ROOT, 'lib/data/ddata'));
  const createCache = require(path.join(ROOT, 'lib/server/cache'));
  const createLoader = require(path.join(ROOT, 'lib/data/dataloader'));
  const createNotifications = require(path.join(ROOT, 'lib/notifications'));
  const sandbox = require(path.join(ROOT, 'lib/sandbox'));
  const createViews = require(path.join(ROOT, 'lib/data/views'));
  const harness = require(path.join(ROOT, 'tests/lib/views-equality/views'));
  const BSON = require('bson');

  const env = require(path.join(ROOT, 'lib/server/env'))();
  env.settings.authDefaultRoles = 'readable';
  const language = require(path.join(ROOT, 'lib/language'))(fs);

  const quiet = { log: console.log, info: console.info, warn: console.warn, debug: console.debug, error: console.error };
  const errors = [];
  function silence () {
    console.log = console.info = console.warn = console.debug = function () {};
    console.error = function () { if (errors.length < 50) errors.push(Array.from(arguments).map(String).join(' ').slice(0, 300)); };
  }
  function unsilence () { Object.assign(console, quiet); }

  const t0Boot = Date.now();
  silence();
  require(path.join(ROOT, 'lib/server/bootevent'))(env, language).boot(function booted (ctx) {
    if (ctx.bootErrors && ctx.bootErrors.length) {
      unsilence();
      console.error('the server did not boot', JSON.stringify(ctx.bootErrors).slice(0, 600));
      process.exit(2);
    }
    ctx.bus.removeAllListeners('tick');
    ctx.bus.removeAllListeners('data-received');
    run(ctx).then(function () {
      process.exit(0);
    }, function (err) {
      unsilence();
      console.error(err && err.stack || err);
      process.exit(1);
    });
  });

  async function run (ctx) {
    const cols = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'].map(k => env[k + '_collection']);
    await Promise.all(cols.map(c => ctx.store.collection(c).deleteMany({})));
    const serverVersion = (await ctx.store.db.admin().serverInfo()).version;
    const realStats = ctx.store.db.stats.bind(ctx.store.db);

    // ---- counting reads, per arm
    function counter () { return { on: false, reads: 0, docs: 0, bytes: 0, countMs: 0 }; }
    function countDocs (cnt, docs) {
      if (!docs) return;
      const h = process.hrtime.bigint();
      cnt.docs += docs.length;
      for (const d of docs) cnt.bytes += BSON.calculateObjectSize(d);
      cnt.countMs += Number(process.hrtime.bigint() - h) / 1e6;
    }
    const REAL = {};
    ['entries', 'treatments', 'devicestatus', 'activity', 'food'].forEach(k => { REAL[k] = { obj: ctx[k], list: ctx[k].list }; });
    REAL.profile = { obj: ctx.profile, last: ctx.profile.last };
    function countingStores (cnt) {
      const s = {};
      ['entries', 'treatments', 'devicestatus', 'activity'].forEach(function (k) {
        s[k] = Object.create(REAL[k].obj);
        s[k].list = function (q, cb) {
          if (!cnt.on) return REAL[k].list.call(REAL[k].obj, q, cb);
          cnt.reads++;
          return REAL[k].list.call(REAL[k].obj, q, function (err, docs) { countDocs(cnt, docs); cb(err, docs); });
        };
      });
      s.food = Object.create(REAL.food.obj);
      s.food.list = function () {
        const a = Array.from(arguments);
        const cb = a.pop();
        if (cnt.on) cnt.reads++;
        return REAL.food.list.apply(REAL.food.obj, a.concat([function (err, docs) { if (cnt.on) countDocs(cnt, docs); cb(err, docs); }]));
      };
      s.profile = Object.create(REAL.profile.obj);
      s.profile.last = function (cb) {
        if (cnt.on) cnt.reads++;
        return REAL.profile.last.call(REAL.profile.obj, function (err, docs) { if (cnt.on) countDocs(cnt, docs); cb(err, docs); });
      };
      return s;
    }

    let currentStats = null;
    const cost = { server: [], r2: [], view: [] };
    const cnt = { server: counter(), r2: counter(), view: counter() };

    // ---- the server arm: the booted context, its reads counted
    Object.assign(ctx, countingStores(cnt.server));
    ctx.store.db.stats = function () { if (cnt.server.on) cnt.server.reads++; return Promise.resolve(currentStats); };
    ctx.runtimeState = 'loaded';
    const cur = { server: [], r2: [], view: [] };
    const req = { server: [], r2: [] };
    ctx.bus.on('notification', n => cur.server.push(n));
    function wrapRequests (notifications, into) {
      const rn = notifications.requestNotify;
      const rs = notifications.requestSnooze;
      notifications.requestNotify = function (n) { const r = rn(n); into().push(Object.assign({ kind: 'notify' }, n)); return r; };
      notifications.requestSnooze = function (s) { const r = rs(s); into().push(Object.assign({ kind: 'snooze' }, s)); return r; };
    }
    wrapRequests(ctx.notifications, () => req.server);

    // ---- the r2 arm: a second resident path, built as bootevent builds one
    let r2 = null;
    if (opt.r2) {
      const rctx = Object.create(ctx);
      Object.assign(rctx, countingStores(cnt.r2));
      rctx.bus = new EventEmitter();
      rctx.bus.setMaxListeners(0);
      rctx.store = { db: { stats: function () { if (cnt.r2.on) cnt.r2.reads++; return Promise.resolve(currentStats); } } };
      rctx.ddata = createDData();
      rctx.cache = createCache(env, rctx);
      rctx.dataloader = createLoader(env, rctx);
      rctx.plugins = require(path.join(ROOT, 'lib/plugins'))({ settings: env.settings, webhook: env.webhook, language: ctx.language, levels: ctx.levels, moment: ctx.moment }).registerServerDefaults();
      rctx.notifications = createNotifications(env, rctx);
      rctx.runtimeState = 'loaded';
      ctx.bus.on('data-update', op => rctx.bus.emit('data-update', op));
      rctx.bus.on('notification', n => cur.r2.push(n));
      wrapRequests(rctx.notifications, () => req.r2);
      r2 = rctx;
    }

    // ---- the view arm
    const vbase = Object.create(ctx);
    Object.assign(vbase, countingStores(cnt.view));
    const tamper = opt.mode === 'tamper' ? harness.TAMPER.alarms : null;
    const views = createViews(env, harness.productContext(vbase, tamper, null, false));
    const vBus = new EventEmitter();
    const vDdata = { lastUpdated: 0 };
    const vNotif = createNotifications(env, { levels: ctx.levels, bus: vBus, ddata: vDdata });
    vBus.on('notification', n => cur.view.push(n));
    let viewRequested = [];

    // ---- uploads
    const queue = [];
    let profilesMoved = 0;
    ['entries', 'treatments', 'devicestatus', 'profile'].forEach(function (c) {
      (dataset.records[c] || []).forEach(function (d) {
        let t = uploadTime(c, d);
        if (c === 'profile' && opt.profilesAtStart && t > dataset.end) { t = dataset.start; profilesMoved++; }
        const undated = !Number.isFinite(t);
        if (undated) t = dataset.start;
        const doc = Object.assign({}, d);
        delete doc._uploadAt;
        queue.push({ c, t, doc, undated });
      });
    });
    queue.sort((a, b) => a.t - b.t);
    const uploaded = { entries: 0, treatments: 0, devicestatus: 0, profile: 0 };
    const refused = { entries: 0, treatments: 0, devicestatus: 0, profile: 0 };
    const undated = queue.filter(q => q.undated).length;
    let qi = 0;
    function create (c, docs) {
      return new Promise(function (resolve) {
        if (!docs.length) return resolve();
        const store = REAL[c].obj;
        store.create(docs, function (err, res) {
          if (err) refused[c] += docs.length;
          else {
            uploaded[c] += docs.length;
            if (Array.isArray(res)) refused[c] += res.filter(r => r && r.refused).length;
          }
          resolve();
        });
      });
    }
    async function uploadUntil (t) {
      const batch = { entries: [], treatments: [], devicestatus: [], profile: [] };
      while (qi < queue.length && queue[qi].t <= t) { batch[queue[qi].c].push(queue[qi].doc); qi++; }
      for (const c of ['profile', 'entries', 'treatments', 'devicestatus']) {
        if (c === 'profile') { for (const p of batch.profile) await create('profile', [p]); continue; }
        for (let i = 0; i < batch[c].length; i += 1000) await create(c, batch[c].slice(i, i + 1000));
      }
    }

    // ---- one minute of each arm
    function update (dl, dd) { return new Promise(resolve => dl.update(dd, function () { resolve(); })); }
    function timed (name, fn) {
      const c = cnt[name];
      c.reads = 0; c.docs = 0; c.bytes = 0; c.countMs = 0; c.on = true;
      const h = process.hrtime.bigint();
      return Promise.resolve(fn()).then(function () {
        c.on = false;
        cost[name].push({ ms: Number(process.hrtime.bigint() - h) / 1e6 - c.countMs, reads: c.reads, docs: c.docs, bytes: c.bytes });
      });
    }
    async function serverMinute () {
      await update(ctx.dataloader, ctx.ddata);
      ctx.bus.emit('data-loaded');
    }
    async function r2Minute () {
      await update(r2.dataloader, r2.ddata);
      // lib/server/bootevent.js 'data-loaded', on r2's own state
      const sbx = sandbox().serverInit(env, r2);
      r2.plugins.setProperties(sbx);
      r2.notifications.initRequests();
      r2.plugins.checkNotifications(sbx);
      r2.notifications.process(sbx);
      r2.sbx = sbx;
      r2.runtimeState = 'loaded';
    }
    // minutes on which the view's working set held a status of each kind a
    // device-status alarm plugin selects by (a top-level field); counted after
    // the arm's timing, below
    const STATUS_KINDS = ['loop', 'openaps', 'pump', 'uploader', 'uploaderBattery', 'xdripjs'];
    const viewKindMinutes = {};
    let lastViewSet = null;
    function countKinds (set) {
      STATUS_KINDS.forEach(function (k) {
        if ((set.ddata.devicestatus || []).some(st => st && k in st)) viewKindMinutes[k] = (viewKindMinutes[k] || 0) + 1;
      });
    }
    function viewMinute (t) {
      return new Promise(function (resolve, reject) {
        // compute() is materialise() then evaluate(); split here only to keep
        // the working set for countKinds
        views.materialise('alarms', { now: t, dbstats: currentStats }, function (err, set) {
          if (err) return reject(err);
          lastViewSet = set;
          let result;
          try { result = views.evaluate(set); } catch (e) { return reject(e); }
          viewRequested = result.requested;
          // the server's step (lib/data/views): hand the requests to durable state
          vDdata.lastUpdated = t;
          vNotif.initRequests();
          result.requested.forEach(function (r) {
            const n = Object.assign({}, r);
            delete n.kind;
            if (r.kind === 'snooze') vNotif.requestSnooze(n); else vNotif.requestNotify(n);
          });
          vNotif.process();
          resolve();
        });
      });
    }

    // ---- VIEWS_REPLAY_PROBE=<step,...>: on those minutes, record what each
    // arm's IOB was computed from (counts and sources, no values)
    const PROBE = new Set((process.env.VIEWS_REPLAY_PROBE || '').split(',').filter(Boolean).map(Number));
    const probes = [];
    function shape (dd, props, t, dia) {
      const sbxIob = props && props.iob;
      const cob = props && props.cob;
      const recent = (dd.devicestatus || []).filter(s => s.mills >= t - 30 * MIN && s.mills <= t + 5 * MIN);
      const withIob = recent.filter(s => (s.openaps && s.openaps.iob) || (s.loop && s.loop.iob) || (s.pump && s.pump.iob));
      const tr = dd.treatments || [];
      return {
        treatments: tr.length
        , treatmentsWithInsulin: tr.filter(x => Number(x.insulin) > 0).length
        , insulinWithinDia: tr.filter(x => Number(x.insulin) > 0 && x.mills <= t && x.mills > t - dia * HOUR).length
        , insulinOlderThanDia: tr.filter(x => Number(x.insulin) > 0 && x.mills <= t - dia * HOUR).length
        , tempBasalsWithinDiaPlusDay: tr.filter(x => x.eventType === 'Temp Basal' && x.mills > t - (dia + 24) * HOUR).length
        , statusesLast30: recent.length, statusesLast30WithIob: withIob.length
        , carbsWithinDia: tr.filter(x => Number(x.carbs) > 0 && x.mills <= t && x.mills > t - dia * HOUR).length
        , carbsDiaTo3Dia: tr.filter(x => Number(x.carbs) > 0 && x.mills <= t - dia * HOUR && x.mills > t - 3 * dia * HOUR).length
        , carbsOlder: tr.filter(x => Number(x.carbs) > 0 && x.mills <= t - 3 * dia * HOUR).length
        , cobProperty: cob ? { present: cob.cob !== undefined, source: cob.source || null, positive: Number(cob.cob) > 0, hasDisplayLine: Boolean(cob.displayLine) } : null
        , iobProperty: sbxIob ? { present: sbxIob.iob !== undefined, source: sbxIob.source || null, hasDisplayLine: Boolean(sbxIob.displayLine) } : null
      };
    }
    async function probe (step, t) {
      const set = await new Promise((resolve, reject) => views.materialise('alarms', { now: t, dbstats: currentStats }, (e, s) => e ? reject(e) : resolve(s)));
      const dia = createViews.bounds.diaHours(set.ddata.profiles || []);
      const ev = views.evaluate(set);
      void ev;
      const vs = sandbox().serverInit(env, Object.assign(Object.create(ctx), { ddata: set.ddata, runtimeState: 'loaded', notifications: null }));
      // a plugin set of the probe's own, so no arm's plugin state is touched
      require(path.join(ROOT, 'lib/plugins'))({ settings: env.settings, webhook: env.webhook, language: ctx.language, levels: ctx.levels, moment: ctx.moment }).registerServerDefaults().setProperties(vs);
      probes.push({ step, diaHours: dia, server: shape(ctx.ddata, ctx.sbx && ctx.sbx.properties, t, dia), view: shape(set.ddata, vs.properties, t, dia) });
    }

    // ---- acknowledgements
    const acks = (dataset.acks || []).map(a => Object.assign({ at: a.at != null ? a.at : dataset.T0 + Math.round(a.h * HOUR / MIN) * MIN, done: false }, a)).sort((x, y) => x.at - y.at);
    const ackLog = [];
    let prevServer = [];
    function applyAcks (t) {
      acks.forEach(function (a) {
        if (a.done || t < a.at) return;
        let level = a.level;
        let group = a.group;
        if (a.mode === 'active') {
          const raised = prevServer.filter(n => !n.clear && n.level >= ctx.levels.WARN).sort((x, y) => y.level - x.level)[0];
          if (!raised) {
            if (t - a.at > HOUR) { a.done = true; ackLog.push({ minute: (a.at - dataset.start) / MIN, applied: false, why: 'nothing raised within 60 min' }); }
            return;
          }
          level = raised.level;
          group = raised.group || 'default';
        }
        a.done = true;
        const ms = a.mins * MIN;
        ctx.notifications.ack(level, group, ms, true);
        if (r2) r2.notifications.ack(level, group, ms, true);
        vNotif.ack(level, group, ms, true);
        ackLog.push({ minute: (t - dataset.start) / MIN, mode: a.mode, level, group, mins: a.mins, applied: true });
      });
    }

    // ---- the replay
    const details = opt.details ? fs.openSync(opt.details, 'w') : null;
    const res = {
      dataset: dataset.label, about: dataset.about, mode: opt.mode, env: dataset.env
      , node: process.version, mongodb: serverVersion
      , spanHours: (dataset.end - dataset.start) / HOUR, steps: 0
      , view: { emitted: 0, requested: 0, any: 0, plugins: {}, episodes: [] }
      , r2: opt.r2 ? { emitted: 0, requested: 0, any: 0, plugins: {}, episodes: [] } : null
      , activity: { stepsWithAlarm: 0, emittedByPluginLevel: {}, requestedByPluginLevel: {}, transitions: 0, snoozes: 0, clears: 0 }
    };
    function episode (bucket, step, plugins) {
      const eps = bucket.episodes;
      const last = eps[eps.length - 1];
      if (last && last.to === step - 1) { last.to = step; plugins.forEach(p => { last.plugins[p] = (last.plugins[p] || 0) + 1; }); return; }
      const ep = { from: step, to: step, plugins: {} };
      plugins.forEach(p => { ep.plugins[p] = (ep.plugins[p] || 0) + 1; });
      eps.push(ep);
    }
    function compare (bucket, label, step, t, sA, sB, rA, rB) {
      const e = diff(sA, sB);
      const r = diff(rA, rB);
      if (e.equal && r.equal) return;
      if (!e.equal) bucket.emitted++;
      if (!r.equal) bucket.requested++;
      bucket.any++;
      const plugins = [...new Set(e.onlyA.concat(e.onlyB).map(s => 'emit:' + pluginOf(s) + '@' + levelOf(s)).concat(r.onlyA.concat(r.onlyB).map(s => 'req:' + pluginOf(s) + '@' + levelOf(s))))];
      plugins.forEach(p => { bucket.plugins[p] = (bucket.plugins[p] || 0) + 1; });
      episode(bucket, step, plugins);
      if (details) fs.writeSync(details, JSON.stringify({ pair: label, step, minute: (t - dataset.start) / MIN, emitted: { onlyServer: e.onlyA, onlyOther: e.onlyB }, requested: { onlyServer: r.onlyA, onlyOther: r.onlyB } }) + '\n');
    }

    clock.install();
    clock.pin(dataset.start);
    await uploadUntil(dataset.start);
    const preloaded = Object.assign({}, uploaded);
    let lastLevel = {};
    let step = 0;
    for (let t = dataset.start; t <= dataset.end; t += MIN, step++) {
      if (opt.maxSteps && step >= opt.maxSteps) break;
      clock.pin(t);
      cur.server = []; cur.r2 = []; cur.view = [];
      req.server = []; req.r2 = [];
      await uploadUntil(t);
      applyAcks(t);
      currentStats = await realStats();
      await timed('server', serverMinute);
      if (r2) await timed('r2', r2Minute);
      await timed('view', () => viewMinute(t));
      countKinds(lastViewSet);
      lastViewSet = null;
      if (PROBE.has(step)) await probe(step, t);

      const sS = cur.server.map(sigNotify);
      const rS = req.server.map(sigRequest);
      compare(res.view, 'server-view', step, t, sS, cur.view.map(sigNotify), rS, viewRequested.map(sigRequest));
      if (r2) compare(res.r2, 'server-r2', step, t, sS, cur.r2.map(sigNotify), rS, req.r2.map(sigRequest));

      // what the resident path did on this minute, for the non-vacuity of the timeline
      const act = res.activity;
      if (cur.server.some(n => !n.clear && n.level >= ctx.levels.WARN)) act.stepsWithAlarm++;
      cur.server.forEach(function (n) {
        if (n.clear) { act.clears++; return; }
        const k = (n.plugin && n.plugin.name) + '@' + n.level;
        act.emittedByPluginLevel[k] = (act.emittedByPluginLevel[k] || 0) + 1;
      });
      const levelNow = {};
      req.server.forEach(function (r) {
        if (r.kind === 'snooze') { act.snoozes++; return; }
        const k = (r.plugin && r.plugin.name) + '@' + r.level;
        act.requestedByPluginLevel[k] = (act.requestedByPluginLevel[k] || 0) + 1;
        const g = r.plugin && r.plugin.name;
        levelNow[g] = Math.max(levelNow[g] == null ? -9 : levelNow[g], r.level);
      });
      Object.keys(Object.assign({}, levelNow, lastLevel)).forEach(g => { if (levelNow[g] !== lastLevel[g]) act.transitions++; });
      lastLevel = levelNow;
      prevServer = cur.server;
    }
    clock.uninstall();
    if (details) fs.closeSync(details);

    res.steps = step;
    res.uploads = { preloaded, total: uploaded, refused, undated, profilesMovedToStart: profilesMoved };
    res.acks = ackLog;
    res.viewKindMinutes = viewKindMinutes;
    if (probes.length) res.probes = probes;
    res.errors = errors.length;
    res.errorSample = errors.slice(0, 5).map(e => e.replace(/\d{2,}/g, '#'));
    res.cost = {};
    Object.keys(cost).forEach(function (k) {
      if (!cost[k].length) return;
      res.cost[k] = { ms: stats(cost[k].map(c => c.ms)), reads: stats(cost[k].map(c => c.reads)), docs: stats(cost[k].map(c => c.docs)), bytes: stats(cost[k].map(c => c.bytes)) };
    });
    res.wallSeconds = Math.round((clock.RealDate.now() - t0Boot) / 1000);
    unsilence();
    fs.writeFileSync(opt.out, JSON.stringify(res, null, 1));
    console.log(opt.dataset, opt.mode, 'steps', res.steps, 'view-diff', res.view.any, 'r2-diff', res.r2 ? res.r2.any : '-', 'wall', res.wallSeconds + 's');
    await ctx.store.db.dropDatabase();
  }
}

main();
