'use strict';

// Research prototype (proto/views-nonresident): the single-tenant,
// nonresident `views` profile (lib/server/serve/views.js,
// lib/server/nonresident.js) against today's resident `single`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('should');

const ROOT = path.resolve(__dirname, '..');

describe('views profile: one tenant, nonresident (research prototype)', function () {
  this.timeout(60000);
  const self = this;

  before(function (done) {
    self.savedEnv = Object.assign({}, process.env);
    self.secret = process.env.API_SECRET || 'this is my long pass phrase';
    process.env.API_SECRET = self.secret;
    const env = require('../lib/server/env')();
    env.settings.authDefaultRoles = 'readable';
    self.env = env;
    self.language = require('../lib/language')(fs);
    require('../lib/server/serve/views').boot(env, self.language, { settleMs: 50, maxWaitMs: 200 }).then(function (ctx) {
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
    return require('../lib/server/serve/views').stop(self.ctx).then(restore);
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
});
