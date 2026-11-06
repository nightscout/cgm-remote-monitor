'use strict';

// Research prototype: the single-tenant nonresident `views` profile
// (lib/server/serve/views.js and lib/server/nonresident.js) against resident single.
//
// Controls: VIEWS_PROFILE_NO_TICK, VIEWS_PROFILE_NO_WRITE,
// VIEWS_PROFILE_DS_NEWEST=10, VIEWS_PROFILE_ON_REQUEST. Run each against
// its named cohort and require failure, then restore and run this whole file.
// Database-size input is fixed only in the parity cohorts: this does not
// measure Mongo statistics freshness or an atomic cross-collection snapshot.

const assert = require('node:assert/strict');
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
    self.localOnly = require('./lib/views-profile/local-only')();
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
      , propertiesOnRequest: Boolean(process.env.VIEWS_PROFILE_ON_REQUEST)
      , viewsCtx: ctx => arms.viewsContext(ctx, process.env.VIEWS_TAMPER)
    }).then(function (ctx) {
      self.ctx = ctx;
      if (process.env.VIEWS_PROFILE_NO_WRITE) ctx.bus.removeAllListeners('storage-write-committed');
      if (ctx.bootErrors && ctx.bootErrors.length) return done(new Error('did not boot: ' + JSON.stringify(ctx.bootErrors).slice(0, 400)));
      done();
    }, done);
  });

  after(function () {
    const restore = () => {
      Object.keys(process.env).forEach(k => { if (!(k in self.savedEnv)) delete process.env[k]; });
      Object.assign(process.env, self.savedEnv);
      self.localOnly.restore();
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
    it('denies provider network connections before opening a socket', function () {
      const socket = new (require('node:net').Socket)();
      assert.throws(() => socket.connect({ host: 'provider.invalid', port: 443 }), /denies external socket/);
      socket.destroy();
      assert.equal(self.localOnly.blocked(), 1);
    });

    it('runs the identifier index prerequisite before profile listeners', function () {
      const stages = require('../lib/server/bootevent').PROFILES.views;
      assert(stages.indexOf('ensureIdentifierIndex') > stages.indexOf('ensureIndexes'));
      assert(stages.indexOf('ensureIdentifierIndex') < stages.indexOf('setupViewsListeners'));
      assert(self.ctx.identifierIndex);
    });
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
        'ensureIndexes', 'ensureIdentifierIndex', 'setupListeners', 'setupConnect', 'finishBoot'
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

  describe('D-EVENT characterization through real entry writes', function () {
    const { EventEmitter } = require('node:events');
    const intentEvent = require('../lib/storage/write-intent').INTENT_EVENT;
    const modes = ['replace', 'merge-except-treatments', 'acknowledge', 'refuse'];
    let candidate;
    let forward;
    let savedWrite;
    let physical = [];
    let logical = [];
    const onPhysical = event => physical.push(event);
    const onLogical = event => logical.push(event);
    const flush = evaluator => new Promise(resolve => evaluator.flush(resolve));
    const create = docs => new Promise((resolve, reject) => self.ctx.entries.create(docs, (err, result) => err ? reject(err) : resolve(result)));
    const entry = (date, identifier, sgv) => ({ type: 'sgv', sgv, date, dateString: new Date(date).toISOString(), identifier, device: 'synthetic-profile-events' });

    beforeEach(async function () {
      await flush(self.ctx.evaluator);
      await self.ctx.store.collection(self.env.entries_collection).deleteMany({});
      savedWrite = self.env.write;
      const context = Object.create(self.ctx);
      context.bus = new EventEmitter();
      context.notificationsClock = { lastUpdated: 0 };
      context.notifications = require('../lib/notifications')(self.env, { levels: context.levels, bus: context.bus, ddata: context.notificationsClock });
      candidate = require('../lib/server/nonresident')(self.env, context, { settleMs: Infinity, tick: false });
      // Harness-only candidate subscription. Product remains on the physical
      // event pending a policy decision about no-op evaluation/freshness.
      forward = event => context.bus.emit('storage-write-committed', event);
      self.ctx.bus.on(intentEvent, forward);
      self.ctx.bus.on(intentEvent, onLogical);
      self.ctx.bus.on('storage-write-committed', onPhysical);
    });
    afterEach(async function () {
      self.ctx.bus.removeListener(intentEvent, forward);
      self.ctx.bus.removeListener(intentEvent, onLogical);
      self.ctx.bus.removeListener('storage-write-committed', onPhysical);
      candidate.close();
      self.env.write = savedWrite;
      await flush(self.ctx.evaluator);
    });

    for (const mode of modes) {
      it(mode + ': one intent per batch; unchanged/refused writes differ from physical events', async function () {
        self.env.write = Object.freeze(Object.assign({}, savedWrite, { resend: mode }));
        const now = Date.now();
        const id = require('node:crypto').randomUUID();
        await create([entry(now, id, 120)]);
        await flush(self.ctx.evaluator);
        await flush(candidate);
        physical = []; logical = [];
        const before = self.ctx.evaluator.stats.evaluations;
        const cbefore = candidate.stats.evaluations;
        await create([entry(now, id, 150)]);
        await flush(self.ctx.evaluator);
        await flush(candidate);
        assert.equal(logical.length, 1, 'one logical event for the resend intent');
        assert.equal(candidate.stats.evaluations - cbefore, 1, 'logical candidate evaluates even without a physical write');
        const writes = mode === 'acknowledge' || mode === 'refuse' ? 0 : 1;
        assert.equal(physical.length, writes);
        assert.equal(self.ctx.evaluator.stats.evaluations - before, writes);
        assert.equal(logical[0].records[0].outcome, mode === 'acknowledge' ? 'unchanged' : mode === 'refuse' ? 'refused' : 'merged');
        const stored = await self.ctx.store.collection(self.env.entries_collection).findOne({ identifier: id });
        assert.equal(stored.sgv, writes ? 150 : 120);

        physical = []; logical = [];
        const next = self.ctx.evaluator.stats.evaluations;
        const cnext = candidate.stats.evaluations;
        await create([entry(now, id, 160), entry(now + MIN, require('node:crypto').randomUUID(), 130)]);
        await flush(self.ctx.evaluator);
        await flush(candidate);
        assert.equal(logical.length, 1, 'one event for a mixed two-record batch');
        assert.equal(logical[0].records.length, 2);
        assert(physical.length > 0, 'the new record changed storage');
        assert.equal(self.ctx.evaluator.stats.evaluations - next, 1, 'physical burst coalesces');
        assert.equal(candidate.stats.evaluations - cnext, 1, 'logical batch coalesces');
      });
    }
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
    let liveStats;
    let closeNotifications;

    function onNotification (n) { cur.emitted.push(n); }
    function onEvaluated () {
      evaluations++;
      last = { emitted: cur.emitted, requested: cur.requested };
      cur.emitted = [];
      cur.requested = [];
    }

    before(function () {
      clock.install();
      // Both arms get identical exogenous database-size input; Mongo index
      // statistics can change between reads even with no application writes.
      liveStats = self.ctx.store.db.stats;
      self.ctx.store.db.stats = () => Promise.resolve({ dataSize: 1024, indexSize: 1024 });
      self.ctx.bus.on('notification', onNotification);
      self.ctx.bus.on('views-evaluated', onEvaluated);
    });
    after(function () {
      self.ctx.bus.removeListener('notification', onNotification);
      self.ctx.bus.removeListener('views-evaluated', onEvaluated);
      if (closeNotifications) closeNotifications();
      self.ctx.store.db.stats = liveStats;
      clock.uninstall();
    });

    // fresh durable state for each case, on both arms
    function reset (now) {
      const ctx = self.ctx;
      clock.pin(now);
      return Promise.all(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'].map(k => ctx.store.collection(self.env[k + '_collection']).deleteMany({})))
        .then(() => new Promise(resolve => ctx.evaluator.idle(resolve)))
        .then(function () {
          if (closeNotifications) closeNotifications();
          const before = new Set(ctx.bus.rawListeners('teardown'));
          const notifications = require('../lib/notifications')(self.env, { levels: ctx.levels, bus: ctx.bus, ddata: ctx.notificationsClock });
          const owned = ctx.bus.rawListeners('teardown').filter(listener => !before.has(listener));
          closeNotifications = () => owned.forEach(listener => { listener(); ctx.bus.removeListener('teardown', listener); });
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
      assert.deepEqual(JSON.parse(JSON.stringify(self.ctx.evaluator.kept().properties)), JSON.parse(JSON.stringify(out.resident.properties)), 'cycle properties');
    }
    function has (list, kind, plugin, level) {
      return list.some(n => (kind ? n.kind === kind : true) && n.plugin && n.plugin.name === plugin && (level === undefined || n.level === level));
    }

    const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

    it('retains cycle properties as time advances until the next trigger', async function () {
      const out = await runCase('steady', NOW);
      arms.sig(out.profile.emitted).should.eql(arms.sig(out.resident.emitted));
      arms.sig(out.profile.requested).should.eql(arms.sig(out.resident.requested));
      const read = () => new Promise((resolve, reject) => self.ctx.evaluator.properties((err, props) => err ? reject(err) : resolve(props)));
      const before = JSON.parse(JSON.stringify(await read()));
      clock.pin(NOW + 40 * MIN);
      const retained = JSON.parse(JSON.stringify(await read()));
      assert.deepEqual(retained, before, 'a request must serve the previous cycle');
      const fresh = await resident.evaluate();
      assert.notDeepEqual(JSON.parse(JSON.stringify(fresh.properties)), retained, 'the time advance must affect derived properties');
      self.ctx.bus.emit('tick', { now: new Date(), type: 'heartbeat' });
      await settled();
      const updated = JSON.parse(JSON.stringify(await read()));
      assert.notDeepEqual(updated, before, 'the tick refreshes retained properties');
      assert.deepEqual(updated, JSON.parse(JSON.stringify(fresh.properties)));
    });

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

  describe('actual API v3 writers refresh the retained cycle', function () {
    const request = require('supertest');
    const intentEvent = require('../lib/storage/write-intent').INTENT_EVENT;
    const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
    const json = value => JSON.parse(JSON.stringify(value));
    const flush = () => new Promise(resolve => self.ctx.evaluator.flush(resolve));
    let app;
    let jwt;
    let liveStats;
    let physical = [];
    let logical = [];
    let requested = [];
    let requestNotify;
    let requestSnooze;
    const onPhysical = event => physical.push(event);
    const onLogical = event => logical.push(event);

    before(async function () {
      app = require('../lib/server/serve/views').createApp(self.env, self.ctx).app;
      const auth = await require('./fixtures/api3/authSubject')(self.ctx.authorization.storage, ['all'], app);
      jwt = auth.jwt.all;
      await flush();
      clock.install();
      liveStats = self.ctx.store.db.stats;
      self.ctx.store.db.stats = () => Promise.resolve({ dataSize: 1024, indexSize: 1024 });
      self.ctx.bus.on('storage-write-committed', onPhysical);
      self.ctx.bus.on(intentEvent, onLogical);
      requestNotify = self.ctx.notifications.requestNotify;
      requestSnooze = self.ctx.notifications.requestSnooze;
      self.ctx.notifications.requestNotify = function (notification) {
        requested.push(Object.assign({ kind: 'notify' }, notification));
        return requestNotify(notification);
      };
      self.ctx.notifications.requestSnooze = function (notification) {
        requested.push(Object.assign({ kind: 'snooze' }, notification));
        return requestSnooze(notification);
      };
    });

    after(function () {
      self.ctx.bus.removeListener('storage-write-committed', onPhysical);
      self.ctx.bus.removeListener(intentEvent, onLogical);
      self.ctx.notifications.requestNotify = requestNotify;
      self.ctx.notifications.requestSnooze = requestSnooze;
      self.ctx.store.db.stats = liveStats;
      clock.uninstall();
    });

    beforeEach(async function () {
      await flush();
      clock.pin(NOW);
      await Promise.all(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity']
        .map(k => self.ctx.store.collection(self.env[k + '_collection']).deleteMany({})));
      const fixture = SCENARIOS.steady(NOW);
      for (const profile of fixture.profile) {
        await new Promise((resolve, reject) => self.ctx.profile.create(profile, err => err ? reject(err) : resolve()));
      }
      for (const name of ['entries', 'treatments', 'devicestatus']) {
        await new Promise((resolve, reject) => self.ctx[name].create(fixture[name], err => err ? reject(err) : resolve()));
      }
      await flush();
      physical = []; logical = []; requested = [];
    });

    // Assert the writer's reply and durable effect before asking whether its
    // actual physical commit event refreshed the same evaluator the app uses.
    // No harness-forwarded logical event or timer is used to make this pass.
    async function changed (method, url, body, status, collection, observe) {
      const before = self.ctx.evaluator.stats.evaluations;
      physical = []; logical = []; requested = [];
      let operation = request(app)[method](url).set('Authorization', 'Bearer ' + jwt);
      if (body) operation = operation.send(body);
      const response = await operation.expect(status);
      await observe(response);
      await flush();
      assert(physical.some(event => event.collection === collection && event.source === 'v3'), 'actual API v3 commit event');
      assert.equal(self.ctx.evaluator.stats.evaluations - before, 1, method + ' refreshes one coalesced retained cycle');
      assert.equal(self.ctx.evaluator.stats.errors, 0, 'the evaluator remains live');
      const resident = arms.createResident(self.env, self.ctx);
      try {
        const expected = await resident.evaluate();
        assert.deepEqual(json(self.ctx.evaluator.kept().properties), json(expected.properties), method + ' retained properties match resident');
        assert.deepEqual(arms.sig(requested), arms.sig(expected.requested), method + ' alarm requests match resident');
      } finally {
        resident.ctx.bus.emit('teardown');
      }
      return response;
    }

    it('entries POST, PATCH and DELETE refresh properties from their committed values', async function () {
      const collection = self.ctx.store.collection(self.env.entries_collection);
      const document = { type: 'sgv', sgv: 90, date: NOW - MIN, utcOffset: 0, dateString: new Date(NOW - MIN).toISOString(), device: 'synthetic-profile-http', app: 'synthetic-profile-http' };
      const created = await changed('post', '/api/v3/entries', document, 201, 'entries', async response => {
        assert.equal((await collection.findOne({ identifier: response.body.identifier })).sgv, 90);
      });
      const identifier = created.body.identifier;
      const afterCreate = json(self.ctx.evaluator.kept().properties);
      await changed('patch', '/api/v3/entries/' + identifier, { sgv: 240 }, 200, 'entries', async () => {
        assert.equal((await collection.findOne({ identifier })).sgv, 240);
      });
      assert.notDeepEqual(json(self.ctx.evaluator.kept().properties), afterCreate, 'changed glucose must affect the retained properties');
      await changed('delete', '/api/v3/entries/' + identifier, null, 200, 'entries', async () => {
        assert.equal((await collection.findOne({ identifier })).isValid, false);
      });
      assert.equal(logical.length, 1, 'one logical delete intent is also observed without subscribing to it');
    });

    it('treatments POST, PATCH and DELETE refresh properties from their committed values', async function () {
      const collection = self.ctx.store.collection(self.env.treatments_collection);
      const document = { eventType: 'Carb Correction', carbs: 15, date: NOW - MIN, utcOffset: 0, created_at: new Date(NOW - MIN).toISOString(), enteredBy: 'synthetic-profile-http', app: 'synthetic-profile-http' };
      const created = await changed('post', '/api/v3/treatments', document, 201, 'treatments', async response => {
        assert.equal((await collection.findOne({ identifier: response.body.identifier })).carbs, 15);
      });
      const identifier = created.body.identifier;
      const afterCreate = json(self.ctx.evaluator.kept().properties);
      await changed('patch', '/api/v3/treatments/' + identifier, { carbs: 45 }, 200, 'treatments', async () => {
        assert.equal((await collection.findOne({ identifier })).carbs, 45);
      });
      assert.notDeepEqual(json(self.ctx.evaluator.kept().properties), afterCreate, 'changed carbs must affect the retained properties');
      await changed('delete', '/api/v3/treatments/' + identifier, null, 200, 'treatments', async () => {
        assert.equal((await collection.findOne({ identifier })).isValid, false);
      });
      assert.equal(logical.length, 1, 'one logical delete intent is also observed without subscribing to it');
    });

    for (const mode of ['replace', 'merge-except-treatments', 'acknowledge', 'refuse']) {
      it('API v3 ' + mode + ' resend preserves the measured physical versus logical cadence', async function () {
        const savedWrite = self.env.write;
        self.env.write = Object.freeze(Object.assign({}, savedWrite, { resend: mode }));
        try {
          const document = { type: 'sgv', sgv: 90, date: NOW - MIN, utcOffset: 0, device: 'synthetic-profile-http-resend', app: 'synthetic-profile-http' };
          const created = await changed('post', '/api/v3/entries', document, 201, 'entries', async response => {
            assert.equal((await self.ctx.store.collection(self.env.entries_collection).findOne({ identifier: response.body.identifier })).sgv, 90);
          });
          const identifier = created.body.identifier;
          const before = self.ctx.evaluator.stats.evaluations;
          const retained = json(self.ctx.evaluator.kept());
          physical = []; logical = []; requested = [];
          clock.pin(NOW + MIN);
          const response = await request(app).post('/api/v3/entries').set('Authorization', 'Bearer ' + jwt)
            .send(Object.assign({}, document, { identifier, sgv: 160 })).expect(mode === 'refuse' ? 409 : 200);
          await flush();
          const writes = mode === 'acknowledge' || mode === 'refuse' ? 0 : 1;
          assert.equal(physical.length, writes, 'physical events follow actual persistence');
          assert.equal(self.ctx.evaluator.stats.evaluations - before, writes, 'the unchanged physical subscriber preserves no-op cadence');
          assert.equal(logical.length, 1, 'one completed HTTP resend intent');
          assert.equal(logical[0].records[0].outcome, mode === 'acknowledge' ? 'unchanged' : mode === 'refuse' ? 'refused' : mode === 'replace' ? 'replaced' : 'merged');
          assert.equal((await self.ctx.store.collection(self.env.entries_collection).findOne({ identifier })).sgv, writes ? 160 : 90);
          if (!writes) {
            assert.deepEqual(json(self.ctx.evaluator.kept()), retained, 'a no-op HTTP resend does not refresh cycle time or properties');
            assert.equal(requested.length, 0, 'a no-op resend does not initiate alarm evaluation');
          } else {
            assert.equal(response.body.identifier, identifier);
            assert.equal(self.ctx.evaluator.kept().now, NOW + MIN);
          }
        } finally {
          self.env.write = savedWrite;
        }
      });
    }
  });

  describe('shutdown', function () {
    it('a read completing after teardown cannot reach the fake delivery boundary', async function () {
      const context = Object.create(self.ctx);
      context.bus = new (require('node:events').EventEmitter)();
      context.notificationsClock = { lastUpdated: 0 };
      context.notifications = require('../lib/notifications')(self.env, { levels: context.levels, bus: context.bus, ddata: context.notificationsClock });
      const provider = require('../lib/server/pushnotify')(self.env, context);
      context.bus.on('notification', provider.emitNotification);
      let release;
      let entered;
      const reading = new Promise(resolve => { entered = resolve; });
      context.entries = Object.create(self.ctx.entries);
      context.entries.list = function (query, callback) {
        if (!release) {
          release = () => self.ctx.entries.list(query, callback);
          entered();
        } else self.ctx.entries.list(query, callback);
      };
      const evaluator = require('../lib/server/nonresident')(self.env, context, { settleMs: Infinity });
      const before = self.localOnly.handoffs.length;
      context.bus.emit('tick', { now: new Date(), type: 'heartbeat' });
      const complete = new Promise(resolve => evaluator.flush(resolve));
      await reading;
      context.bus.emit('teardown');
      release();
      await complete;
      assert.equal(evaluator.stats.evaluations, 1, 'the outstanding read actually completed');
      assert.equal(evaluator.stats.errors, 0);
      assert.equal(self.localOnly.handoffs.length, before, 'no late delivery after teardown');
      assert.equal(context.bus.listenerCount('notification'), 0);
    });

    it('delivers only to the fake provider and teardown removes both triggers', async function () {
      assert(self.localOnly.handoffs.length > 0, 'an alarm reached the fake delivery boundary');
      assert.equal(self.localOnly.blocked(), 1, 'only the explicit egress control attempted an external socket');
      const ctx = self.ctx;
      await new Promise(resolve => ctx.evaluator.idle(resolve));
      const before = ctx.evaluator.stats.evaluations;
      ctx.bus.emit('tick', { now: new Date(), type: 'heartbeat' });
      ctx.bus.teardown();
      assert.equal(ctx.bus.listenerCount('storage-write-committed'), 0);
      assert.deepEqual(ctx.bus.listeners('tick'), [ctx.adminnotifies.clean], 'only the unrelated admin cleanup listener remains');
      ctx.bus.emit('storage-write-committed', { collection: 'entries' });
      ctx.bus.emit('tick', { now: new Date(), type: 'heartbeat' });
      await new Promise(resolve => ctx.evaluator.flush(resolve));
      assert.equal(ctx.evaluator.stats.evaluations, before);
    });
  });
});
