'use strict';

// Q2 bench for the views profile (research prototype, proto/views-nonresident):
// what one tenant costs under today's resident `single` and under the
// nonresident views profile, on the same dataset and machine, one arm per
// process.
//
//   node --expose-gc tests/lib/views-profile/bench.js --arm resident|profile
//        --dataset synthetic:<name>|corpus:<n> --at-hours <h> --busy <min>
//        --idle <min> --port <p> --db <db> --out <file.json> [--mongo-container <name>]
//
// The database is filled with every record uploaded before start + at-hours
// (inserted directly), then the replay runs `busy` minutes with the dataset's
// own uploads (through the arm's storage modules, so the profile's trigger
// fires) and `idle` minutes with none. Each minute is one heartbeat tick:
//   resident  ctx.dataloader.update, then the server's own 'data-loaded'
//             handler (bootevent setupListeners): what single runs per tick
//             or per data-received
//   profile   the minute's writes and tick coalesce into one evaluation
//             (flush): the alarms view and the hand-off to notifications
// Per evaluation: wall ms, this process's CPU (process.cpuUsage), storage
// reads, documents and BSON bytes (counted client-side, around the storage
// interface: the MongoDB profiler drops bulk reads), and mongod's CPU from
// the container's cgroup (--mongo-container; nothing else may use it).
// Then: resident heap (ddata and cache held vs dropped, after gc), the
// profile's transient working set, and the latest-glucose read.
//
// Output: counts and timings only.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function args () {
  const out = { busy: 120, idle: 120, atHours: 12, port: 27017 };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--arm') out.arm = a[++i];
    else if (k === '--dataset') out.dataset = a[++i];
    else if (k === '--at-hours') out.atHours = Number(a[++i]);
    else if (k === '--busy') out.busy = Number(a[++i]);
    else if (k === '--idle') out.idle = Number(a[++i]);
    else if (k === '--port') out.port = Number(a[++i]);
    else if (k === '--db') out.db = a[++i];
    else if (k === '--out') out.out = a[++i];
    else if (k === '--mongo-container') out.container = a[++i];
    else throw new Error('unknown argument ' + k);
  }
  if (!['resident', 'profile'].includes(out.arm) || !out.dataset || !out.db || !out.out) throw new Error('--arm, --dataset, --db and --out are required');
  return out;
}

const ALARM_ENV = {
  API_SECRET: 'this is my long pass phrase'
  , ENABLE: 'bgnow delta direction rawbg upbat ar2 simplealarms errorcodes iob cob careportal pump openaps xdripjs loop bwp cage sage iage bage treatmentnotify timeago basal dbsize runtimestate devicestatus profile bolus override'
  , ALARM_TYPES: 'simple predict'
  , ALARM_HIGH: 'on', ALARM_URGENT_HIGH: 'on', ALARM_LOW: 'on', ALARM_URGENT_LOW: 'on'
  , ALARM_TIMEAGO_WARN: 'on', ALARM_TIMEAGO_URGENT: 'on'
  , TIMEAGO_ENABLE_ALERTS: 'true', CAGE_ENABLE_ALERTS: 'true', SAGE_ENABLE_ALERTS: 'true'
  , IAGE_ENABLE_ALERTS: 'true', BAGE_ENABLE_ALERTS: 'true', UPBAT_ENABLE_ALERTS: 'true'
  , PUMP_ENABLE_ALERTS: 'true', OPENAPS_ENABLE_ALERTS: 'true', LOOP_ENABLE_ALERTS: 'true'
  , HOSTNAME: 'localhost', INSECURE_USE_HTTP: 'true', NODE_ENV: 'test', TZ: 'UTC'
};

function uploadTime (collection, d) {
  if (d._uploadAt != null) return Number(d._uploadAt);
  if (collection === 'entries') return Number(d.date) || Date.parse(d.dateString);
  if (collection === 'profile') return Date.parse(d.created_at) || Date.parse(d.startDate) || Number(d.mills);
  return Date.parse(d.created_at) || Number(d.mills);
}

function loadDataset (spec) {
  const [kind, name] = spec.split(':');
  if (kind === 'synthetic') {
    const t = require(path.join(ROOT, 'tests/lib/views-replay/timelines')).TIMELINES[name]();
    return { start: t.start, env: t.env || {}, records: t.records };
  }
  const dir = process.env.VIEWS_CORPUS_DIR;
  const { corpusNames } = require(path.join(ROOT, 'tests/lib/views-equality/fixtures'));
  const set = corpusNames(dir)[Number(name) - 1];
  const read = k => { const f = path.join(dir, set + '_' + k + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; };
  const strip = d => { const o = Object.assign({}, d); delete o._id; return o; };
  const records = { entries: read('entries').map(strip), treatments: read('treatments').map(strip), devicestatus: read('devicestatus').map(strip), profile: read('profile').map(strip) };
  let lo = Infinity;
  ['entries', 'treatments', 'devicestatus'].forEach(c => records[c].forEach(d => { const t = uploadTime(c, d); if (Number.isFinite(t)) lo = Math.min(lo, t); }));
  return { start: Math.floor(lo / MIN) * MIN, env: {}, records };
}

function stats (list) {
  if (!list.length) return null;
  const s = list.slice().sort((x, y) => x - y);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const sum = s.reduce((x, y) => x + y, 0);
  return { n: s.length, mean: +(sum / s.length).toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s[s.length - 1].toFixed(3) };
}

function mongodCpuUsec (container) {
  if (!container) return null;
  const out = execFileSync('docker', ['exec', container, 'cat', '/sys/fs/cgroup/cpu.stat'], { encoding: 'utf8' });
  const m = /usage_usec (\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

function gcHeap () {
  for (let i = 0; i < 3; i++) global.gc();
  return process.memoryUsage().heapUsed;
}

const quiet = Object.assign({}, console);

async function main () {
  const opt = args();
  if (typeof global.gc !== 'function') throw new Error('run with node --expose-gc');
  const dataset = loadDataset(opt.dataset);
  Object.assign(process.env, ALARM_ENV, dataset.env, { CUSTOMCONNSTR_mongo: 'mongodb://127.0.0.1:' + opt.port + '/' + opt.db });
  console.log = console.info = console.warn = console.debug = function () {};
  const errors = [];
  console.error = function () { if (errors.length < 20) errors.push(Array.from(arguments).map(String).join(' ').slice(0, 200)); };

  const clock = require(path.join(ROOT, 'tests/lib/views-replay/clock'));
  const BSON = require('bson');
  const env = require(path.join(ROOT, 'lib/server/env'))();
  env.settings.authDefaultRoles = 'readable';
  const language = require(path.join(ROOT, 'lib/language'))(fs);

  const T = dataset.start + opt.atHours * HOUR;
  clock.install();
  clock.pin(T);

  const cnt = { on: false, reads: 0, docs: 0, bytes: 0 };
  function countDocs (docs) { if (!docs) return; cnt.docs += docs.length; for (const d of docs) cnt.bytes += BSON.calculateObjectSize(d); }
  function counted (c) {
    const o = Object.create(c);
    ['entries', 'treatments', 'devicestatus', 'activity', 'food'].forEach(function (k) {
      const real = c[k];
      o[k] = Object.create(real);
      o[k].list = function () {
        const a = Array.from(arguments);
        const cb = a.pop();
        if (cnt.on) cnt.reads++;
        return real.list.apply(real, a.concat([function (err, docs) { if (cnt.on) countDocs(docs); cb(err, docs); }]));
      };
    });
    const realProfile = c.profile;
    const realLast = c.profile.last;
    o.profile = Object.create(realProfile);
    o.profile.last = function (cb) { if (cnt.on) cnt.reads++; return realLast.call(realProfile, function (err, docs) { if (cnt.on) countDocs(docs); cb(err, docs); }); };
    return o;
  }

  let ctx;
  if (opt.arm === 'resident') {
    ctx = await new Promise(resolve => require(path.join(ROOT, 'lib/server/bootevent'))(env, language).boot(resolve));
    ctx.bus.removeAllListeners('tick');
    ctx.bus.removeAllListeners('data-received');
  } else {
    ctx = await require(path.join(ROOT, 'lib/server/serve/views')).boot(env, language, { settleMs: Infinity, viewsCtx: counted });
  }
  if (ctx.bootErrors && ctx.bootErrors.length) throw new Error('did not boot: ' + JSON.stringify(ctx.bootErrors).slice(0, 300));
  const realStats = ctx.store.db.stats.bind(ctx.store.db);
  const serverVersion = (await ctx.store.db.admin().serverInfo()).version;
  const cols = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
  await Promise.all(cols.map(c => ctx.store.collection(env[c + '_collection']).deleteMany({})));

  // the resident arm's reads are counted on its own storage modules (the
  // data loader reads ctx.entries and the rest)
  const stores = {};
  ['entries', 'treatments', 'devicestatus', 'profile'].forEach(k => { stores[k] = ctx[k]; });
  if (opt.arm === 'resident') Object.assign(ctx, (({ entries, treatments, devicestatus, activity, food, profile }) => ({ entries, treatments, devicestatus, activity, food, profile }))(counted(ctx)));

  // queue, and the history before T inserted directly
  const queue = [];
  ['entries', 'treatments', 'devicestatus', 'profile'].forEach(function (c) {
    (dataset.records[c] || []).forEach(function (d) {
      let t = uploadTime(c, d);
      if (!Number.isFinite(t)) t = dataset.start;
      const doc = Object.assign({}, d);
      delete doc._uploadAt;
      queue.push({ c, t, doc });
    });
  });
  queue.sort((a, b) => a.t - b.t);
  let qi = 0;
  const pre = { entries: [], treatments: [], devicestatus: [], profile: [] };
  while (qi < queue.length && queue[qi].t <= T) { pre[queue[qi].c].push(queue[qi].doc); qi++; }
  for (const c of Object.keys(pre)) {
    if (!pre[c].length) continue;
    const rows = c === 'entries' ? pre[c] : require(path.join(ROOT, 'lib/data/ddata'))().processRawDataForRuntime(pre[c]).map(function (d) { const o = Object.assign({}, d); delete o.mills; delete o.endmills; return o; });
    for (let i = 0; i < rows.length; i += 2000) await ctx.store.collection(env[c + '_collection']).insertMany(rows.slice(i, i + 2000).map(d => Object.assign({}, d)));
  }
  const preloaded = {};
  Object.keys(pre).forEach(c => { preloaded[c] = pre[c].length; });

  function create (c, docs) {
    return new Promise(resolve => stores[c].create(docs, () => resolve()));
  }
  async function uploadUntil (t) {
    const batch = { entries: [], treatments: [], devicestatus: [], profile: [] };
    while (qi < queue.length && queue[qi].t <= t) { batch[queue[qi].c].push(queue[qi].doc); qi++; }
    let n = 0;
    for (const c of ['profile', 'entries', 'treatments', 'devicestatus']) {
      if (!batch[c].length) continue;
      n += batch[c].length;
      if (c === 'profile') { for (const p of batch.profile) await create('profile', [p]); continue; }
      await create(c, batch[c]);
    }
    return n;
  }

  let currentStats = null;
  ctx.store.db.stats = function () { if (cnt.on) cnt.reads++; return Promise.resolve(currentStats); };

  function evaluateResident () {
    return new Promise(function (resolve) {
      ctx.dataloader.update(ctx.ddata, function () {
        ctx.bus.emit('data-loaded');
        resolve();
      });
    });
  }
  function evaluateProfile () {
    ctx.bus.emit('tick', { now: new Date(), type: 'heartbeat' });
    return new Promise(resolve => ctx.evaluator.flush(resolve));
  }
  const evaluate = opt.arm === 'resident' ? evaluateResident : evaluateProfile;

  // warm-up: the first resident load fills the cache from the whole window
  await evaluate();
  const firstLoad = { reads: 0 };
  const samples = [];
  const mongodBefore = mongodCpuUsec(opt.container);
  for (let i = 0; i < opt.busy + opt.idle; i++) {
    const t = T + (i + 1) * MIN;
    clock.pin(t);
    const phase = i < opt.busy ? 'busy' : 'idle';
    const uploaded = phase === 'busy' ? await uploadUntil(t) : 0;
    currentStats = await realStats();
    const m0 = mongodCpuUsec(opt.container);
    cnt.reads = 0; cnt.docs = 0; cnt.bytes = 0; cnt.on = true;
    const c0 = process.cpuUsage();
    const h0 = process.hrtime.bigint();
    await evaluate();
    const ms = Number(process.hrtime.bigint() - h0) / 1e6;
    const cpu = process.cpuUsage(c0);
    cnt.on = false;
    const m1 = mongodCpuUsec(opt.container);
    samples.push({ phase, uploaded, ms, cpuMs: (cpu.user + cpu.system) / 1000, reads: cnt.reads, docs: cnt.docs, kb: cnt.bytes / 1024, mongodMs: m0 == null ? null : (m1 - m0) / 1000 });
  }
  const mongodAfter = mongodCpuUsec(opt.container);
  void firstLoad;

  function summary (filter) {
    const s = samples.filter(filter);
    const pick = k => stats(s.map(x => x[k]).filter(v => v != null));
    return { minutes: s.length, ms: pick('ms'), cpuMs: pick('cpuMs'), mongodMs: pick('mongodMs'), reads: pick('reads'), docs: pick('docs'), kb: pick('kb') };
  }

  // memory
  const memory = {};
  if (opt.arm === 'resident') {
    const held = gcHeap();
    memory.ddataJsonKB = +(Buffer.byteLength(JSON.stringify({ sgvs: ctx.ddata.sgvs, treatments: ctx.ddata.treatments, devicestatus: ctx.ddata.devicestatus, mbgs: ctx.ddata.mbgs, cals: ctx.ddata.cals, profiles: ctx.ddata.profiles })) / 1024).toFixed(1);
    memory.counts = { sgvs: ctx.ddata.sgvs.length, treatments: ctx.ddata.treatments.length, devicestatus: ctx.ddata.devicestatus.length, cacheEntries: ctx.cache.entries.length, cacheTreatments: ctx.cache.treatments.length, cacheDevicestatus: ctx.cache.devicestatus.length };
    // drop the resident state (ddata, cache contents, the last sbx)
    const fresh = require(path.join(ROOT, 'lib/data/ddata'))();
    Object.keys(ctx.ddata).forEach(k => { if (typeof ctx.ddata[k] !== 'function') ctx.ddata[k] = fresh[k]; });
    ['entries', 'treatments', 'devicestatus', 'profile', 'food'].forEach(k => { if (Array.isArray(ctx.cache[k])) ctx.cache[k].length = 0; });
    ctx.sbx = null;
    const dropped = gcHeap();
    memory.residentHeapKB = +((held - dropped) / 1024).toFixed(1);
    memory.heapHeldKB = +(held / 1024).toFixed(1);
  } else {
    const base = gcHeap();
    const views = require(path.join(ROOT, 'lib/data/views'))(env, ctx);
    // K working sets held at once, so one set's size stands above gc noise
    const K = 5;
    async function held (name) {
      const sets = [];
      for (let i = 0; i < K; i++) sets.push(await new Promise((resolve, reject) => views.materialise(name, { now: Date.now(), dbstats: currentStats }, (e, x) => e ? reject(e) : resolve(x))));
      const h = gcHeap();
      memory[name + 'WorkingSetDocs'] = ['sgvs', 'treatments', 'devicestatus', 'mbgs', 'cals', 'profiles'].reduce((n, k) => n + ((sets[0].ddata[k] || []).length), 0);
      sets.length = 0;
      return h;
    }
    const hA = await held('alarms');
    memory.alarmsWorkingSetHeapKB = +((hA - base) / K / 1024).toFixed(1);
    const base2 = gcHeap();
    const hP = await held('properties');
    memory.propertiesWorkingSetHeapKB = +((hP - base2) / K / 1024).toFixed(1);
    memory.heapBetweenEvaluationsKB = +(base / 1024).toFixed(1);
  }

  // latest glucose
  const latest = {};
  const REPS = 200;
  function lat (fn, reps) {
    return (async function () {
      const t = [];
      for (let i = 0; i < reps; i++) { const h = process.hrtime.bigint(); await fn(); t.push(Number(process.hrtime.bigint() - h) / 1e6); }
      return stats(t);
    })();
  }
  if (opt.arm === 'resident') {
    // reload the resident state dropped above, then read from it
    ctx.cache = require(path.join(ROOT, 'lib/server/cache'))(env, ctx);
    ctx.dataloader = require(path.join(ROOT, 'lib/data/dataloader'))(env, ctx);
    await evaluateResident();
    latest.inMemoryNewestSgv = await lat(() => ctx.ddata.sgvs[ctx.ddata.sgvs.length - 1], REPS);
    latest.inMemoryBgnowProperty = await lat(() => ctx.sbx.properties.bgnow, REPS);
    const app = require('express')();
    app.use('/properties', ctx.properties);
    const request = require('supertest');
    latest.httpPropertiesBgnow = await lat(() => request(app).get('/properties/bgnow'), 100);
  } else {
    latest.boundedNewestSgvQuery = await lat(() => new Promise(resolve => stores.entries.list({ find: { type: 'sgv' }, count: 1 }, resolve)), REPS);
    latest.propertiesViewCompute = await lat(() => new Promise(resolve => ctx.evaluator.properties(resolve)), 30);
    const app = require(path.join(ROOT, 'lib/server/serve/views')).createApp(env, ctx).app;
    const request = require('supertest');
    latest.httpPropertiesBgnow = await lat(() => request(app).get('/api/v2/properties/bgnow'), 30);
  }

  const res = {
    arm: opt.arm, dataset: opt.dataset, node: process.version, mongodb: serverVersion
    , atHours: opt.atHours, busyMinutes: opt.busy, idleMinutes: opt.idle, preloaded
    , busyWithWrites: summary(s => s.phase === 'busy' && s.uploaded > 0)
    , busyNoWrites: summary(s => s.phase === 'busy' && s.uploaded === 0)
    , idle: summary(s => s.phase === 'idle')
    , all: summary(() => true)
    , mongodCpuMsTotal: mongodBefore == null ? null : (mongodAfter - mongodBefore) / 1000
    , memory, latest, errors: errors.length, errorSample: errors.slice(0, 3)
    , evaluator: ctx.evaluator ? Object.assign({}, ctx.evaluator.stats) : null
  };
  clock.uninstall();
  Object.assign(console, quiet);
  fs.writeFileSync(opt.out, JSON.stringify(res, null, 1));
  console.log(opt.arm, opt.dataset, 'done', 'errors', errors.length);
  await ctx.store.db.dropDatabase();
  process.exit(0);
}

main().catch(function (err) { Object.assign(console, quiet); console.error(err && err.stack || err); process.exit(1); });
