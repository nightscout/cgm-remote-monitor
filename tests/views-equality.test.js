'use strict';

// ST-VIEWS: every server-side view computed from a resident ddata and from
// bounded queries must agree, on every fixture. See tests/lib/views-equality/.
//
// VIEWS_CORPUS_DIR=<dir>   also run each corpus set found there (never copied)
// VIEWS_TAMPER=<view>      make that view's bound one record short; only that
//                          view's checks may fail (the non-vacuity control)
// VIEWS_TAMPER_DRY=1       install the tamper wrapper on the product views but
//                          drop nothing (the untampered control for it)
// VIEWS_DROP_KIND=<kind>   the alarm view's newest-of-kind device-status query
//                          for that kind answers nothing (per-kind control)
// VIEWS_ONLY=<a,b>         run only these views
// VIEWS_MEASURE=1          log each arm's ddata size in serialised bytes
// VIEWS_COB_DIAS=<n>       the properties view's treatment window in DIAs (3)

const fs = require('fs');
const express = require('express');
const request = require('supertest');
require('should');

const { SCENARIOS, corpusNames, loadCorpus } = require('./lib/views-equality/fixtures');
const { VIEWS, TAMPER, load, product, firstDifference, diaHours } = require('./lib/views-equality/views');

// The shipped alarm set, enabled by plugin name (not file name), as in the
// alignment repo's tools/qc/alarm-critical-slice.js.
const ALARM_PLUGINS = [
  'bgnow', 'delta', 'direction', 'rawbg', 'upbat', 'ar2', 'simplealarms',
  'errorcodes', 'iob', 'cob', 'careportal', 'pump', 'openaps', 'xdripjs',
  'loop', 'bwp', 'cage', 'sage', 'iage', 'bage', 'treatmentnotify', 'timeago',
  'basal', 'dbsize', 'runtimestate', 'devicestatus', 'profile', 'bolus', 'override'
];

const TAMPERED = process.env.VIEWS_TAMPER || '';
const ONLY = (process.env.VIEWS_ONLY || '').split(',').filter(Boolean);
const VIEW_NAMES = Object.keys(VIEWS).filter(v => !ONLY.length || ONLY.includes(v));

describe('ST-VIEWS equality: resident ddata vs bounded queries', function () {
  this.timeout(60000);
  const self = this;

  before(function (done) {
    if (TAMPERED && !TAMPER[TAMPERED]) return done(new Error('VIEWS_TAMPER names no view: ' + TAMPERED));
    // In the full suite an earlier file can leave API_SECRET unset, and the
    // server then refuses to boot; the settings below are this file's own and
    // are put back in after().
    self.savedEnv = Object.assign({}, process.env);
    Object.assign(process.env, {
      API_SECRET: process.env.API_SECRET || 'this is my long pass phrase'
      , ENABLE: ALARM_PLUGINS.join(' ')
      , ALARM_TYPES: 'simple predict'
      , ALARM_HIGH: 'on', ALARM_URGENT_HIGH: 'on', ALARM_LOW: 'on', ALARM_URGENT_LOW: 'on'
      , ALARM_TIMEAGO_WARN: 'on', ALARM_TIMEAGO_URGENT: 'on'
      , TIMEAGO_ENABLE_ALERTS: 'true', CAGE_ENABLE_ALERTS: 'true', SAGE_ENABLE_ALERTS: 'true'
      , IAGE_ENABLE_ALERTS: 'true', BAGE_ENABLE_ALERTS: 'true', UPBAT_ENABLE_ALERTS: 'true'
      , PUMP_ENABLE_ALERTS: 'true', OPENAPS_ENABLE_ALERTS: 'true'
    });
    const env = require('../lib/server/env')();
    env.settings.authDefaultRoles = 'readable';
    self.env = env;
    const language = require('../lib/language')(fs);
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      if (ctx.bootErrors && ctx.bootErrors.length) {
        return done(new Error('the server did not boot: ' + JSON.stringify(ctx.bootErrors).slice(0, 600)));
      }
      // the views are computed on demand below; the server's own reload loop
      // must not run on the same database while fixtures are swapped
      ctx.bus.removeAllListeners('tick');
      ctx.bus.removeAllListeners('data-received');
      done();
    });
  });

  after(function (done) {
    function restore () {
      if (self.ctx && self.ctx.bus) self.ctx.bus.emit('teardown');
      if (self.savedEnv) {
        Object.keys(process.env).forEach(k => { if (!(k in self.savedEnv)) delete process.env[k]; });
        Object.assign(process.env, self.savedEnv);
      }
      done();
    }
    // leave the test database as empty as it was found, for the next file and
    // for the suite's own production-data check on the next run
    if (!self.ctx || !self.ctx.store) return restore();
    seed({}, function () { restore(); });
  });

  function seed (fx, done) {
    const ctx = self.ctx;
    const env = self.env;
    const cols = {
      entries: env.entries_collection, treatments: env.treatments_collection
      , devicestatus: env.devicestatus_collection, profile: env.profile_collection
      , food: env.food_collection, activity: env.activity_collection
    };
    Promise.all(Object.values(cols).map(c => ctx.store.collection(c).deleteMany({})))
      .then(() => Promise.all(Object.keys(cols).map(function (k) {
        const docs = fx[k] || [];
        return docs.length ? ctx.store.collection(cols[k]).insertMany(docs.map(d => Object.assign({}, d))) : null;
      })))
      .then(() => done(), done);
  }

  function loadArm (spec, now, info, tamper) {
    return new Promise(function (resolve, reject) {
      load(self.env, self.ctx, spec, now, info, tamper, function (err, r) {
        if (err) return reject(err);
        resolve(r);
      });
    });
  }

  // The bounded arm of a product view: lib/data/views, given the booted
  // server's context (its storage reads) and nothing else of the harness's.
  function productArm (name, now, info, tamper) {
    const dry = Boolean(process.env.VIEWS_TAMPER_DRY);
    return new Promise(function (resolve, reject) {
      product(self.env, self.ctx, name, now, info, tamper || (dry ? TAMPER[name] : null), dry, function (err, r) {
        if (err) return reject(err);
        resolve(r);
      });
    });
  }

  function summaryOf (ddata, now) {
    // the shipping route, given a context whose ddata and sbx are this arm's
    const { evaluate } = require('./lib/views-equality/views');
    const sbx = evaluate(self.env, self.ctx, ddata, now).sbx;
    const rctx = Object.assign({}, self.ctx, { ddata, sbx });
    const app = express();
    app.use('/summary', require('../lib/api2/summary')(self.env, rctx));
    return request(app).get('/summary?hours=6').then(res => {
      res.status.should.equal(200);
      return res.body;
    });
  }

  function computeView (name, ddata, now) {
    if (name === 'summary') return summaryOf(ddata, now);
    return Promise.resolve(VIEWS[name].compute(self.env, self.ctx, ddata, now));
  }

  const now = Date.now();
  const fixtures = Object.keys(SCENARIOS).map(name => ({ label: 'scenario ' + name, build: () => SCENARIOS[name](now) }));
  corpusNames(process.env.VIEWS_CORPUS_DIR).forEach(function (name, i) {
    fixtures.push({ label: 'corpus #' + (i + 1), build: () => loadCorpus(process.env.VIEWS_CORPUS_DIR, name, now) });
  });

  fixtures.forEach(function (fixture) {
    describe(fixture.label, function () {
      const state = {};

      before(function (done) {
        const fx = fixture.build();
        state.info = { diaHours: diaHours(fx.profile), devicestatusMs: require('../lib/data/views').bounds.devicestatusLookback(self.env) };
        seed(fx, function (err) {
          if (err) return done(err);
          self.ctx.store.db.stats().then(function (stats) {
            state.info.dbstats = stats;
            return loadArm(null, now, state.info, null);
          }).then(function (r) {
            state.resident = r.ddata;
            done();
          }, done);
        });
      });

      VIEW_NAMES.forEach(function (name) {
        it(name + ': bounded queries give the resident output', function () {
          const tamper = TAMPERED === name ? TAMPER[name] : null;
          // A fresh resident load per view: the plugin pass writes onto the
          // documents it reads, so a ddata one view was computed from is not
          // the ddata the next view would see on the server.
          return Promise.all([
            loadArm(null, now, state.info, null)
            , VIEWS[name].product ? productArm(name, now, state.info, tamper) : loadArm(VIEWS[name].spec, now, state.info, tamper)
          ]).then(function (arms) {
            if (process.env.VIEWS_MEASURE) {
              // serialised bytes of each arm's ddata (data fields only), the
              // measure EXP-MT-060 used
              const bytes = d => Buffer.byteLength(JSON.stringify(Object.keys(d).filter(k => typeof d[k] !== 'function').reduce((o, k) => { o[k] = d[k]; return o; }, {})));
              console.log('MEASURE', fixture.label, name, 'resident', bytes(arms[0].ddata), 'bounded', bytes(arms[1].ddata));
            }
            return Promise.all([
              computeView(name, arms[0].ddata, now)
              , VIEWS[name].product ? VIEWS[name].output(arms[1].result) : computeView(name, arms[1].ddata, now)
            ]).then(function (outs) {
              const diff = firstDifference(outs[0], outs[1]);
              if (diff && process.env.VIEWS_DEBUG && /treatments\.(\d+)/.test(diff)) {
                const i = Number(/treatments\.(\d+)/.exec(diff)[1]);
                const show = t => t && [t.mills, t.created_at, t.eventType, t._id].join(' ');
                console.log('DEBUG', fixture.label, name, i, '\n  a', [i - 1, i, i + 1].map(k => show(outs[0].treatments[k])).join('\n    '), '\n  b', [i - 1, i, i + 1].map(k => show(outs[1].treatments[k])).join('\n    '));
              }
              if (diff) {
                throw new Error(name + ' differs (' + fixture.label + '): ' + diff.slice(0, 600));
              }
            });
          });
        });
      });

      // VIEWS_MEASURE: bytes and time per evaluation of the alarm view, the
      // product module (materialise, then evaluate) against a full resident
      // load (the loader's first load, every query as written, into a fresh
      // cache) and the same plugin pass. Bytes are the working set's data fields,
      // serialised, before the plugin pass. Sequential, VIEWS_MEASURE_REPS each.
      if (process.env.VIEWS_MEASURE) {
        it('alarms: bytes and time per evaluation (measure only)', function () {
          this.timeout(300000);
          const reps = Number(process.env.VIEWS_MEASURE_REPS) || 15;
          const { evaluate } = require('./lib/views-equality/views');
          const createViews = require('../lib/data/views');
          const views = createViews(self.env, self.ctx);
          const bytes = d => Buffer.byteLength(JSON.stringify(Object.keys(d).filter(k => typeof d[k] !== 'function').reduce((o, k) => { o[k] = d[k]; return o; }, {})));
          const p50 = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
          const ms = t => Number(process.hrtime.bigint() - t) / 1e6;
          const r = { resident: { load: [], eval: [] }, bounded: { load: [], eval: [] } };
          let rb = 0;
          let bb = 0;
          let chain = Promise.resolve();
          for (let i = 0; i < reps; i++) {
            chain = chain.then(function () {
              const t0 = process.hrtime.bigint();
              return loadArm(null, now, state.info, null).then(function (arm) {
                r.resident.load.push(ms(t0));
                rb = bytes(arm.ddata);
                const t1 = process.hrtime.bigint();
                evaluate(self.env, self.ctx, arm.ddata, now);
                r.resident.eval.push(ms(t1));
              });
            }).then(function () {
              const t0 = process.hrtime.bigint();
              return new Promise(function (resolve, reject) {
                views.materialise('alarms', { now, dbstats: state.info.dbstats }, function (err, set) {
                  if (err) return reject(err);
                  r.bounded.load.push(ms(t0));
                  bb = bytes(set.ddata);
                  const t1 = process.hrtime.bigint();
                  views.evaluate(set);
                  r.bounded.eval.push(ms(t1));
                  resolve();
                });
              });
            });
          }
          return chain.then(function () {
            console.log('MEASURE-ALARMS', fixture.label, JSON.stringify({
              node: process.version, reps
              , residentBytes: rb, boundedBytes: bb
              , residentLoadP50: +p50(r.resident.load).toFixed(2), residentEvalP50: +p50(r.resident.eval).toFixed(2)
              , boundedLoadP50: +p50(r.bounded.load).toFixed(2), boundedEvalP50: +p50(r.bounded.eval).toFixed(2)
            }));
          });
        });
      }

      // Positive control for the comparison itself: two resident loads of the
      // same fixture, compared view by view. A difference here is the server's
      // own nondeterminism, not a bound.
      it('two resident loads agree on every view', function () {
        const diffs = [];
        return VIEW_NAMES.reduce(function (p, name) {
          return p.then(function () {
            return Promise.all([loadArm(null, now, state.info, null), loadArm(null, now, state.info, null)])
              .then(arms => Promise.all([computeView(name, arms[0].ddata, now), computeView(name, arms[1].ddata, now)]))
              .then(function (outs) {
                const d = firstDifference(outs[0], outs[1]);
                if (d) diffs.push(name + ': ' + d.slice(0, 300));
              });
          });
        }, Promise.resolve()).then(function () {
          if (diffs.length) throw new Error('resident vs resident (' + fixture.label + '): ' + diffs.join(' ; '));
        });
      });

      it('the fixture exercises the views (resident ddata is not empty)', function () {
        state.resident.sgvs.length.should.be.above(0);
      });
    });
  });

  // lib/data/views on its own: it keeps to its own state. The server's
  // resident state is filled first (its loader, its cache), so there is
  // something to touch.
  describe('lib/data/views keeps to its own state', function () {
    const createViews = require('../lib/data/views');
    // what a view must not read or write: the resident data and everything
    // that holds or acts on it
    const SHARED = ['ddata', 'sbx', 'cache', 'bus', 'notifications', 'dataloader', 'plugins'];

    function compute (views, name) {
      return new Promise(function (resolve, reject) {
        views.compute(name, { now }, function (err, r) { return err ? reject(err) : resolve(r); });
      });
    }
    function materialise (views, name) {
      return new Promise(function (resolve, reject) {
        views.materialise(name, { now }, function (err, set) { return err ? reject(err) : resolve(set); });
      });
    }
    function residentSnapshot () {
      const c = self.ctx.cache;
      const d = self.ctx.ddata;
      return JSON.stringify({
        cache: ['entries', 'treatments', 'devicestatus'].map(t => c.getDataRef(t))
        , ddata: { sgvs: d.sgvs, treatments: d.treatments, devicestatus: d.devicestatus, lastUpdated: d.lastUpdated }
      });
    }

    before(function (done) {
      seed(SCENARIOS.steady(now), function (err) {
        if (err) return done(err);
        // the server's own load; its plugin pass is not run, so a `scaled` or
        // `moment` on one of its documents can only have come from a view
        self.ctx.dataloader.update(self.ctx.ddata, { lastUpdated: now, frame: false }, function () { done(); });
      });
    });

    it('the server holds resident state for a view to leak into', function () {
      self.ctx.cache.getDataRef('entries').length.should.be.above(0);
      self.ctx.cache.getDataRef('devicestatus').length.should.be.above(0);
      self.ctx.ddata.sgvs.length.should.be.above(0);
    });

    it('reads none of ctx.' + SHARED.join(', ctx.'), function () {
      const touched = [];
      const guarded = Object.create(self.ctx);
      SHARED.forEach(function (k) {
        Object.defineProperty(guarded, k, { get: function () { touched.push(k); return self.ctx[k]; } });
      });
      const views = createViews(self.env, guarded);
      return compute(views, 'alarms')
        .then(() => compute(views, 'properties'))
        .then(function () {
          if (touched.length) throw new Error('lib/data/views read shared state: ctx.' + [...new Set(touched)].join(', ctx.'));
        });
    });

    it('computes on documents of its own: the plugin pass writes onto them and onto nothing the server holds', function () {
      const before = residentSnapshot();
      const views = createViews(self.env, self.ctx);
      return Promise.all([materialise(views, 'properties'), materialise(views, 'properties')]).then(function (sets) {
        views.evaluate(sets[0]);
        const own = sets[0].ddata;
        self.ctx.ddata.sgvs.some(s => s.scaled !== undefined).should.equal(false, 'a reading the server holds carries `scaled`');
        self.ctx.ddata.devicestatus.some(s => s.openaps && s.openaps.iob && s.openaps.iob.moment !== undefined)
          .should.equal(false, 'a device status the server holds carries `openaps.iob.moment`');
        // the pass did write: this is what would leak if the documents were shared
        own.sgvs.some(s => s.scaled !== undefined).should.equal(true, 'the plugin pass wrote `scaled` on no reading of the view');
        own.devicestatus.some(s => s.openaps && s.openaps.iob && s.openaps.iob.moment !== undefined)
          .should.equal(true, 'the plugin pass wrote `openaps.iob.moment` on no device status of the view');
        // no document of the view is one the server holds, or one another working set holds
        const held = new Set();
        ['entries', 'treatments', 'devicestatus'].forEach(t => self.ctx.cache.getDataRef(t).forEach(d => held.add(d)));
        ['sgvs', 'mbgs', 'cals', 'treatments', 'devicestatus'].forEach(k => (self.ctx.ddata[k] || []).forEach(d => held.add(d)));
        const other = new Set();
        ['sgvs', 'treatments', 'devicestatus'].forEach(k => sets[1].ddata[k].forEach(d => other.add(d)));
        ['sgvs', 'mbgs', 'cals', 'treatments', 'devicestatus'].forEach(function (k) {
          own[k].forEach(function (d) {
            if (held.has(d)) throw new Error('a ' + k + ' document of the view is held by the server');
            if (other.has(d)) throw new Error('a ' + k + ' document of the view is held by another working set');
          });
        });
        sets[1].ddata.sgvs.some(s => s.scaled !== undefined).should.equal(false, 'evaluating one working set wrote onto another');
        const after = residentSnapshot();
        if (after !== before) throw new Error('the server\'s resident state changed while a view was computed');
      });
    });

    it('answers every read the data loader makes, by kind', function () {
      return materialise(createViews(self.env, self.ctx), 'alarms').then(function (set) {
        const kinds = [...new Set(set.queries.map(q => q.kind))].sort();
        kinds.should.eql(['activity', 'dbstats', 'devicestatus', 'entries', 'food', 'latest', 'profile', 'profileSwitch', 'treatments']);
      });
    });

    it('refuses a loader read it has no bound for, rather than answer it with another kind\'s', function () {
      const kindOf = createViews.kindOf;
      (kindOf('treatments', { find: { eventType: 'Note', created_at: { $gte: 'x' } } }) === null).should.equal(true);
      (kindOf('entries', { find: { type: 'sgv', date: { $gte: 1 } } }) === null).should.equal(true);
      kindOf('treatments', { find: { created_at: { $gte: 'x' } } }).should.equal('treatments');
    });

    it('fails, rather than computing from a partial window, when a read fails', function () {
      const failing = Object.create(self.ctx);
      failing.devicestatus = { list: (q, cb) => cb(new Error('devicestatus read failed')) };
      return compute(createViews(self.env, failing), 'alarms').then(
        () => { throw new Error('the view computed although a read failed'); }
        , err => err.message.should.equal('devicestatus read failed'));
    });
  });
});
