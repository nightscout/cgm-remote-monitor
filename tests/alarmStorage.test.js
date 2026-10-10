'use strict';
require('should');

describe('alarmStorage', function () {
  var alarmStorage;

  beforeEach(function () {
    delete require.cache[require.resolve('../lib/storage/alarmStorage')];
    alarmStorage = require('../lib/storage/alarmStorage');
  });

  it('exports a factory function', function () {
    alarmStorage.should.be.a.Function();
  });

  it('factory returns an object with getSnooze, setSnooze, ensureIndexes methods', function () {
    var storage = alarmStorage({});
    storage.getSnooze.should.be.a.Function();
    storage.setSnooze.should.be.a.Function();
    storage.ensureIndexes.should.be.a.Function();
  });

  describe('getSnooze', function () {
    it('resolves to null when store is unavailable', async function () {
      var storage = alarmStorage({ store: null });
      var doc = await storage.getSnooze(2, 'default');
      (doc === null).should.equal(true);
    });

    it('returns the unexpired doc for level+group with expiresAt filter', async function () {
      var future = Date.now() + 60000;
      var fakeDoc = {
        _id: '2-default', level: 2, group: 'default',
        lastAckTime: 1000, silenceTime: 30 * 60 * 1000,
        expiresAt: new Date(future)
      };
      var captured = null;
      var fakeCollection = {
        findOne: function (q) {
          captured = q;
          return Promise.resolve(fakeDoc);
        }
      };
      var storage = alarmStorage({ store: { collection: function () { return fakeCollection; } } });
      var doc = await storage.getSnooze(2, 'default');
      captured._id.should.equal('2-default');
      captured.expiresAt.$gt.should.be.an.instanceOf(Date);
      doc.should.deepEqual(fakeDoc);
    });

    it('normalizes undefined group to "default"', async function () {
      var captured = null;
      var fakeCollection = {
        findOne: function (q) { captured = q; return Promise.resolve(null); }
      };
      var storage = alarmStorage({ store: { collection: function () { return fakeCollection; } } });
      await storage.getSnooze(2, undefined);
      captured._id.should.equal('2-default');
    });
  });

  describe('setSnooze', function () {
    it('upserts with conditional aggregation pipeline (only-if-newer)', async function () {
      var captured = null;
      var fakeCollection = {
        updateOne: function (filter, update, opts) {
          captured = { filter: filter, update: update, opts: opts };
          return Promise.resolve({ matchedCount: 0, upsertedCount: 1 });
        }
      };
      var storage = alarmStorage({ store: { collection: function () { return fakeCollection; } } });
      var lastAckTime = 1000;
      var silenceTime = 30 * 60 * 1000;
      await storage.setSnooze(2, 'default', lastAckTime, silenceTime);

      captured.filter.should.deepEqual({ _id: '2-default' });
      captured.opts.should.deepEqual({ upsert: true });
      captured.update.should.be.an.Array();
      captured.update[0].should.have.property('$set');
      var setStage = captured.update[0].$set;
      setStage.expiresAt.$cond[0].$gt[0].getTime().should.equal(lastAckTime + silenceTime);
      setStage.lastAckTime.$cond[1].should.equal(lastAckTime);
      setStage.silenceTime.$cond[1].should.equal(silenceTime);
    });

    it('normalizes undefined group to "default"', async function () {
      var captured = null;
      var fakeCollection = {
        updateOne: function (f) { captured = f; return Promise.resolve({}); }
      };
      var storage = alarmStorage({ store: { collection: function () { return fakeCollection; } } });
      await storage.setSnooze(2, undefined, 1000, 60000);
      captured._id.should.equal('2-default');
    });

    it('is a no-op when store is unavailable', async function () {
      var storage = alarmStorage({ store: null });
      await storage.setSnooze(2, 'default', 1000, 60000);
    });

    it('rejects with an error when the driver rejects', async function () {
      var fakeCollection = {
        updateOne: function () { return Promise.reject(new Error('mongo blip')); }
      };
      var storage = alarmStorage({ store: { collection: function () { return fakeCollection; } } });
      var thrown = null;
      try { await storage.setSnooze(2, 'default', 1000, 60000); } catch (e) { thrown = e; }
      thrown.should.be.an.Error();
      thrown.message.should.equal('mongo blip');
    });
  });

  describe('ensureIndexes', function () {
    it('creates a TTL index on expiresAt', async function () {
      var captured = null;
      var fakeCollection = {
        createIndex: function (spec, opts) {
          captured = { spec: spec, opts: opts };
          return Promise.resolve('expiresAt_1');
        }
      };
      var storage = alarmStorage({ store: { collection: function () { return fakeCollection; } } });
      await storage.ensureIndexes();
      captured.spec.should.deepEqual({ expiresAt: 1 });
      captured.opts.expireAfterSeconds.should.equal(0);
    });

    it('is a no-op when store is unavailable', async function () {
      var storage = alarmStorage({ store: null });
      await storage.ensureIndexes();
    });
  });
});
