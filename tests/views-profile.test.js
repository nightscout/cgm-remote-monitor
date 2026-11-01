'use strict';

// Research prototype (proto/views-nonresident): the single-tenant,
// nonresident `views` profile (lib/server/serve/views.js,
// lib/server/nonresident.js) against today's resident `single`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('should');
const arms = require('./lib/views-profile/arms');
const clock = require('./lib/views-replay/clock');
const { SCENARIOS } = require('./lib/views-equality/fixtures');

const ROOT = path.resolve(__dirname, '..');
const MIN = 60 * 1000;

// The alarm set and settings of tests/views-equality.test.js.
const ALARM_ENV = {
  ENABLE: 'bgnow delta direction rawbg upbat ar2 simplealarms errorcodes iob cob careportal pump openaps xdripjs loop bwp cage sage iage bage treatmentnotify timeago basal dbsize runtimestate devicestatus profile bolus override'
  , ALARM_TYPES: 'simple predict'
  , ALARM_HIGH: 'on', ALARM_URGENT_HIGH: 'on', ALARM_LOW: 'on', ALARM_URGENT_LOW: 'on'
  , ALARM_TIMEAGO_WARN: 'on', ALARM_TIMEAGO_URGENT: 'on'
  , TIMEAGO_ENABLE_ALERTS: 'true', CAGE_ENABLE_ALERTS: 'true', SAGE_ENABLE_ALERTS: 'true'
  , IAGE_ENABLE_ALERTS: 'true', BAGE_ENABLE_ALERTS: 'true', UPBAT_ENABLE_ALERTS: 'true'
  , PUMP_ENABLE_ALERTS: 'true', OPENAPS_ENABLE_ALERTS: 'true', LOOP_ENABLE_ALERTS: 'true'
};

describe('views profile: one tenant, nonresident (research prototype)', function () {
  this.timeout(60000);
  const self = this;

  before(function (done) {
    self.savedEnv = Object.assign({}, process.env);
    self.secret = process.env.API_SECRET || 'this is my long pass phrase';
    process.env.API_SECRET = self.secret;
    Object.assign(process.env, ALARM_ENV);
    const env = require('../lib/server/env')();
    env.settings.authDefaultRoles = 'readable';
    self.env = env;
    self.language = require('../lib/language')(fs);
    require('../lib/server/serve/views').boot(env, self.language, {
      settleMs: 400, maxWaitMs: 3000
      , tick: process.env.VIEWS_PROFILE_NO_TICK ? false : undefined
      , viewsCtx: ctx => arms.viewsContext(ctx, process.env.VIEWS_TAMPER)
    }).then(function (ctx) {
      self.ctx = ctx;
      if (ctx.bootErrors && ctx.bootErrors.length) return done(new Error('did not boot: ' + JSON.stringify(ctx.bootErrors).slice(0, 400)));
      done();
    }, done);
  });

  after(function () {
    const restore = () => {
      Object.keys(process.env).forEach(k => { if (!(k in self.savedEnv)) delete process.env[k]; });
      Object.assign(process.env, self.savedEnv);
    };
    if (!self.ctx) return restore();
    // Leave the database as found: the cases clear before each run, not after
    // the last, and the suite's production-safety check counts leftovers.
    const ctx = self.ctx;
    return Promise.all(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity']
      .map(k => ctx.store.collection(self.env[k + '_collection']).deleteMany({})))
      .then(() => {
        // Not stop(): it closes the MongoDB client, which mongo-storage shares
        // per URI with every later test file in the same process. Teardown
        // stops the evaluator's timer and listeners (nonresident.js).
        ctx.bus.teardown();
      }).then(restore);
  });

  describe('boot', function () {
    it('holds no resident state: no data loader, cache, plugin registry or sbx', function () {
      const ctx = self.ctx;
      ['dataloader', 'cache', 'plugins', 'sbx'].forEach(k => (ctx[k] === undefined).should.equal(true, 'ctx.' + k));
      ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'notifications', 'evaluator'].forEach(k => (ctx[k] !== undefined).should.equal(true, 'ctx.' + k));
    });

    it('ctx.ddata gives the write helper and throws on any resident read or write', function () {
      const ctx = self.ctx;
      ctx.ddata.processRawDataForRuntime.should.be.a.Function();
      (() => ctx.ddata.sgvs).should.throw(/no resident ddata/);
      (() => ctx.ddata.lastUpdated).should.throw(/no resident ddata/);
      (() => { ctx.ddata.sgvs = []; }).should.throw(/no resident ddata/);
    });

    it('leaves the single profile\'s stages as they were', function () {
      require('../lib/server/bootevent').PROFILES.single.should.eql([
        'checkNodeVersion', 'startBoot', 'checkEnv', 'augmentSettings', 'checkSettings',
        'setupStorage', 'restoreHistoryClock', 'setupAuthorization', 'setupInternals',
        'ensureIndexes', 'setupListeners', 'setupConnect', 'finishBoot'
      ]);
    });

    it('the launcher refuses without the opt-in', function () {
      const env = Object.assign({}, process.env);
      delete env.NIGHTSCOUT_EXECUTION;
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/views-profile-server.js')], { env, encoding: 'utf8' });
      r.status.should.equal(64);
      r.stderr.should.match(/NIGHTSCOUT_EXECUTION=nonresident/);
    });

    // control (d): the opt-in reaches nothing but the launcher
    it('single with the opt-in set stays resident', function (done) {
      process.env.NIGHTSCOUT_EXECUTION = 'nonresident';
      process.env.API_SECRET = self.secret;
      const env = require('../lib/server/env')();
      require('../lib/server/bootevent')(env, self.language).boot(function booted (ctx) {
        try {
          (ctx.bootErrors || []).should.have.length(0);
          ctx.dataloader.should.be.an.Object();
          ctx.cache.should.be.an.Object();
          (ctx.evaluator === undefined).should.equal(true);
          ctx.bus.listenerCount('data-loaded').should.be.above(0);
          ctx.bus.listenerCount('storage-write-committed').should.equal(0);
        } catch (e) {
          ctx.bus.teardown();
          return done(new Error(e.message + ' bootErrors=' + JSON.stringify(ctx.bootErrors).slice(0, 300)));
        }
        ctx.bus.once('data-processed', function () {
          let err = null;
          try {
            ctx.sbx.should.be.an.Object();
            Array.isArray(ctx.ddata.sgvs).should.equal(true);
          } catch (e) { err = e; }
          ctx.bus.teardown();
          delete process.env.NIGHTSCOUT_EXECUTION;
          // the MongoDB client is shared with the views profile's (mongo-storage
          // keeps one per URI); after() closes it
          done(err);
        });
      });
    });
  });

  describe('trigger', function () {
    function evaluated (ctx) {
      return new Promise(resolve => ctx.bus.once('views-evaluated', resolve));
    }
    function clear () {
      const ctx = self.ctx;
      return Promise.all(['entries', 'treatments', 'devicestatus', 'profile'].map(k => ctx.store.collection(self.env[k + '_collection']).deleteMany({})))
        .then(() => new Promise(resolve => ctx.evaluator.idle(resolve)));
    }
    function sgv (ms, v) { return { type: 'sgv', sgv: v, date: ms, dateString: new Date(ms).toISOString(), device: 'views-profile' }; }

    beforeEach(clear);

    it('a committed write of entries evaluates the alarms view, once per burst', async function () {
      const ctx = self.ctx;
      const before = Object.assign({}, ctx.evaluator.stats);
      const done = evaluated(ctx);
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve, reject) => ctx.entries.create([sgv(now - i * 5 * 60000, 120 + i)], e => e ? reject(e) : resolve()));
      }
      const ev = await done;
      ev.ok.should.equal(true);
      ev.why.write.should.be.above(0);
      await new Promise(resolve => ctx.evaluator.idle(resolve));
      (ctx.evaluator.stats.writes - before.writes).should.equal(5);
      (ctx.evaluator.stats.evaluations - before.evaluations).should.be.belowOrEqual(2);
    });

    it('a write to a collection the views do not read triggers nothing', async function () {
      const ctx = self.ctx;
      const before = Object.assign({}, ctx.evaluator.stats);
      ctx.bus.emit('storage-write-committed', Object.freeze({ collection: 'roles', source: 'internal', operation: 'insertOne', partial: false, counts: { inserted: 1 } }));
      await new Promise(resolve => setTimeout(resolve, 120));
      (ctx.evaluator.stats.ignoredWrites - before.ignoredWrites).should.equal(1);
      ctx.evaluator.stats.evaluations.should.equal(before.evaluations);
    });

    it('the heartbeat tick evaluates with no write', async function () {
      const ctx = self.ctx;
      const done = evaluated(ctx);
      ctx.bus.emit('tick', { now: new Date(), type: 'heartbeat' });
      const ev = await done;
      ev.why.tick.should.equal(1);
      (ev.why.write === undefined).should.equal(true);
    });
  });

  // The cases of the execution plan's section 7b, each uploaded through the
  // profile's own storage modules so the profile's trigger evaluates it; the
  // last evaluation is compared with a resident path on the same database at
  // the same instant, and checked for the alarm the case is about.
  describe('section 7b cases through the profile', function () {
    const cur = { emitted: [], requested: [] };
    let last = null;
    let evaluations = 0;
    let resident = null;

    function onNotification (n) { cur.emitted.push(n); }
    function onEvaluated () {
      evaluations++;
      last = { emitted: cur.emitted, requested: cur.requested };
      cur.emitted = [];
      cur.requested = [];
    }

    before(function () {
      clock.install();
      self.ctx.bus.on('notification', onNotification);
      self.ctx.bus.on('views-evaluated', onEvaluated);
    });
    after(function () {
      self.ctx.bus.removeListener('notification', onNotification);
      self.ctx.bus.removeListener('views-evaluated', onEvaluated);
      clock.uninstall();
    });

    // fresh durable state for each case, on both arms
    function reset (now) {
      const ctx = self.ctx;
      clock.pin(now);
      return Promise.all(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'].map(k => ctx.store.collection(self.env[k + '_collection']).deleteMany({})))
        .then(() => new Promise(resolve => ctx.evaluator.idle(resolve)))
        .then(function () {
          const notifications = require('../lib/notifications')(self.env, { levels: ctx.levels, bus: ctx.bus, ddata: ctx.notificationsClock });
          const rn = notifications.requestNotify;
          const rs = notifications.requestSnooze;
          notifications.requestNotify = function (n) { cur.requested.push(Object.assign({ kind: 'notify' }, n)); return rn(n); };
          notifications.requestSnooze = function (n) { cur.requested.push(Object.assign({ kind: 'snooze' }, n)); return rs(n); };
          ctx.notifications = notifications;
          cur.emitted = [];
          cur.requested = [];
          last = null;
          evaluations = 0;
          resident = arms.createResident(self.env, ctx);
        });
    }

    function create (store, docs) {
      return new Promise((resolve, reject) => store.create(docs, e => e ? reject(e) : resolve()));
    }

    // every collection at once, through the profile's storage modules
    async function upload (fx) {
      const ctx = self.ctx;
      for (const p of fx.profile || []) await create(ctx.profile, Object.assign({}, p));
      await Promise.all(['entries', 'treatments', 'devicestatus'].map(k => (fx[k] || []).length ? create(ctx[k], fx[k].map(d => Object.assign({}, d))) : null));
    }

    function settled () {
      return new Promise(resolve => self.ctx.evaluator.idle(resolve));
    }

    // warnHigh with enough device-reported IOB to cover the high
    const LOCAL = {
      highCoveredByIob: now => {
        const fx = SCENARIOS.warnHigh(now);
        fx.devicestatus.forEach(d => { d.openaps.iob.iob = 4; d.openaps.suggested.IOB = 4; d.openaps.enacted.IOB = 4; });
        return fx;
      }
    };

    async function runCase (name, now) {
      await reset(now);
      await upload((LOCAL[name] || SCENARIOS[name])(now));
      await new Promise(resolve => setTimeout(resolve, 20));
      await settled();
      const r = await resident.evaluate();
      if (process.env.VIEWS_PROFILE_VERBOSE) console.log('    ' + name + ': ' + evaluations + ' evaluation(s) from ' + JSON.stringify(self.ctx.evaluator.last.why));
      return { profile: last, resident: r, evaluations };
    }

    function same (out) {
      (out.profile !== null).should.equal(true, 'the profile evaluated');
      arms.sig(out.profile.emitted).should.eql(arms.sig(out.resident.emitted), 'emitted');
      arms.sig(out.profile.requested).should.eql(arms.sig(out.resident.requested), 'requested');
    }
    function has (list, kind, plugin, level) {
      return list.some(n => (kind ? n.kind === kind : true) && n.plugin && n.plugin.name === plugin && (level === undefined || n.level === level));
    }

    const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

    it('a treatment 4 minutes old snoozes the URGENT low for 10 minutes', async function () {
      const out = await runCase('recentTreatment', NOW);
      same(out);
      out.profile.requested.some(n => n.kind === 'snooze' && /recent treatment/.test(n.title) && n.level === 2 && n.lengthMills === 10 * MIN).should.equal(true, 'treatmentnotify URGENT snooze, 10 min');
      has(out.profile.requested, 'notify', 'ar2', 2).should.equal(true, 'the URGENT low it snoozes was requested');
      out.profile.emitted.some(n => n.level === 2).should.equal(false, 'no URGENT emitted');
    });

    it('the bwp high snooze, from the profile and IOB', async function () {
      const out = await runCase('highCoveredByIob', NOW);
      same(out);
      out.profile.requested.some(n => n.kind === 'snooze' && /enough IOB/.test(n.title) && n.level === 2).should.equal(true, 'bwp URGENT snooze requested');
      out.profile.emitted.some(n => n.level === 2).should.equal(false, 'the URGENT high is snoozed');
    });

    it('device-reported IOB is what the alarm message and the iob property carry', async function () {
      const out = await runCase('steady', NOW);
      same(out);
      out.resident.properties.iob.source.should.equal('OpenAPS');
      const app = require('../lib/server/serve/views').createApp(self.env, self.ctx).app;
      const res = await require('supertest')(app).get('/api/v2/properties/iob,cob,openaps,pump,upbat,bwp');
      res.status.should.equal(200);
      res.body.iob.source.should.equal('OpenAPS');
      const expected = JSON.parse(JSON.stringify({ iob: out.resident.properties.iob, cob: out.resident.properties.cob, openaps: out.resident.properties.openaps, pump: out.resident.properties.pump, upbat: out.resident.properties.upbat, bwp: out.resident.properties.bwp }));
      res.body.should.eql(expected);
    });

    it('a second uploader flooding device statuses: the loop and pump alarms still fire', async function () {
      for (const name of ['crowdedStatus', 'crowdedSeparateKinds']) {
        const out = await runCase(name, NOW);
        same(out);
        has(out.profile.requested, 'notify', 'openaps', 2).should.equal(true, name + ': OpenAPS URGENT requested');
        has(out.profile.requested, 'notify', 'pump').should.equal(true, name + ': pump alarm requested');
      }
    });

    it('Loop and AAPS "not looping" while uploads continue', async function () {
      const loop = await runCase('loopFailing', NOW);
      same(loop);
      has(loop.profile.requested, 'notify', 'loop', 2).should.equal(true, 'Loop URGENT requested');
      for (const name of ['aapsLoopStopped', 'aapsNoRecentEnact', 'openapsEnactedOnly']) {
        const out = await runCase(name, NOW);
        same(out);
        has(out.profile.requested, 'notify', 'openaps', 2).should.equal(true, name + ': OpenAPS URGENT requested');
      }
    });

    it('the pump status with the newest clock within twice urgentClock', async function () {
      const out = await runCase('pumpRepost', NOW);
      same(out);
      has(out.profile.requested, 'notify', 'pump', 1).should.equal(true, 'pump WARN requested');
      has(out.profile.requested, 'notify', 'pump', 2).should.equal(false, 'no pump URGENT');
    });

    it('stale data with no writes: the heartbeat tick raises the stale-data alarm', async function () {
      const ctx = self.ctx;
      const out = await runCase('steady', NOW);
      same(out);
      has(out.profile.emitted, undefined, 'timeago').should.equal(false, 'not stale at upload');
      const later = NOW + 40 * MIN;
      clock.pin(later);
      const before = evaluations;
      ctx.bus.emit('tick', { now: new Date(), type: 'heartbeat' });
      await new Promise(resolve => setTimeout(resolve, 500));
      await settled();
      const r = await resident.evaluate();
      (evaluations - before).should.equal(1, 'one evaluation from the tick');
      has(last.emitted, undefined, 'timeago', 2).should.equal(true, 'stale-data URGENT emitted');
      arms.sig(last.emitted).should.eql(arms.sig(r.emitted));
      arms.sig(last.requested).should.eql(arms.sig(r.requested));
    });
  });
});
