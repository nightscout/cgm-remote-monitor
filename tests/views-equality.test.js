'use strict';

// ST-VIEWS: every server-side view computed from a resident ddata and from
// bounded queries must agree, on every fixture. See tests/lib/views-equality/.
//
// VIEWS_CORPUS_DIR=<dir>   also run each corpus set found there (never copied)
// VIEWS_TAMPER=<view>      make that view's bound one record short; only that
//                          view's checks may fail (the non-vacuity control)
// VIEWS_ONLY=<a,b>         run only these views
// VIEWS_MEASURE=1          log each arm's ddata size in serialised bytes
// VIEWS_COB_DIAS=<n>       the properties view's treatment window in DIAs (3)

const fs = require('fs');
const express = require('express');
const request = require('supertest');
require('should');

const { SCENARIOS, corpusNames, loadCorpus } = require('./lib/views-equality/fixtures');
const { VIEWS, TAMPER, load, firstDifference, diaHours } = require('./lib/views-equality/views');

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
    Object.assign(process.env, {
      ENABLE: ALARM_PLUGINS.join(' ')
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
      // the views are computed on demand below; the server's own reload loop
      // must not run on the same database while fixtures are swapped
      ctx.bus.removeAllListeners('tick');
      ctx.bus.removeAllListeners('data-received');
      done();
    });
  });

  after(function () {
    if (self.ctx && self.ctx.bus) self.ctx.bus.emit('teardown');
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
        state.info = { diaHours: diaHours(fx.profile) };
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
            , loadArm(VIEWS[name].spec, now, state.info, tamper)
          ]).then(function (arms) {
            if (process.env.VIEWS_MEASURE) {
              // serialised bytes of each arm's ddata (data fields only), the
              // measure EXP-MT-060 used
              const bytes = d => Buffer.byteLength(JSON.stringify(Object.keys(d).filter(k => typeof d[k] !== 'function').reduce((o, k) => { o[k] = d[k]; return o; }, {})));
              console.log('MEASURE', fixture.label, name, 'resident', bytes(arms[0].ddata), 'bounded', bytes(arms[1].ddata));
            }
            return Promise.all([
              computeView(name, arms[0].ddata, now)
              , computeView(name, arms[1].ddata, now)
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
});
