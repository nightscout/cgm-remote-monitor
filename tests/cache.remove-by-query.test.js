'use strict';

// A delete by query reloads only the cache of the type it deleted from.
// Synthetic values only.
//
// A v1 delete that does not name exactly one removed record (a delete by
// query, including one that matches nothing) reaches the cache as a 'remove'
// without `changes` (object-id-forms.js cacheRemoval). The cache emptied all
// three of its arrays for it and bumped all three removal generations, so a
// treatments delete also made the next reload a long load of entries (48 h)
// and devicestatus (24 h). Only the deleted type's cache can hold a deleted
// record; the others keep their contents and generations.
//
// Since WC-STEP-PATCH release 2 (write-contract Q-A) the write step names the
// records a delete by query removed, so even the deleted type's cache removes
// only those (here every cached record of the type, apart from the delete
// that matches nothing).

var request = require('supertest');
require('should');
var language = require('../lib/language')();

describe('cache: a delete by query reloads only the deleted type', function () {
  this.timeout(15000);
  var self = this;
  var TAG = 'cache-remove-by-query-test';
  var api_secret_hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var TYPES = ['treatments', 'devicestatus', 'entries'];

  var HEX = {
    entry1: '5f7200000000000000000c01'
    , entry2: '5f7200000000000000000c02'
    , status1: '5f7200000000000000000c03'
    , status2: '5f7200000000000000000c04'
    , note1: '5f7200000000000000000c05'
    , note2: '5f7200000000000000000c06'
  };

  // Recent times: the cache keeps only records inside its retention window.
  var base = Math.floor(Date.now() / 60000) * 60000 - 60 * 60000;
  function when (minute) { return base + minute * 60000; }

  function cachedIds (type) {
    return self.ctx.cache.getData(type).map(function (o) { return String(o._id); });
  }

  function state () {
    var out = {};
    TYPES.forEach(function (type) {
      out[type] = { length: self.ctx.cache[type].length, generation: self.ctx.cache.getRemovalGeneration(type)
        , ids: self.ctx.cache[type].map(function (o) { return String(o._id); }) };
    });
    return out;
  }

  function dropAll () {
    var ids = Object.keys(HEX).map(function (k) { return HEX[k]; });
    return Promise.all(TYPES.map(function (name) {
      return self.ctx.store.collection(self.env[name + '_collection']).deleteMany({ $or: [{ _id: { $in: ids } }, { device: TAG }, { enteredBy: TAG }] });
    }));
  }

  // The caches as the 'remove' left them, read in the same tick: the delete
  // also asks for a reload, which may refill an emptied cache from MongoDB
  // before the HTTP response arrives.
  function deleteAndWatch (path, type) {
    var seen = null;
    function onUpdate (op) {
      if (op && op.type === type && op.op === 'remove') seen = state();
    }
    self.ctx.bus.on('data-update', onUpdate);
    return request(self.app)
      .delete(path)
      .set('api-secret', api_secret_hash)
      .expect(200)
      .then(function () {
        self.ctx.bus.removeListener('data-update', onUpdate);
        (seen !== null).should.equal(true, 'no ' + type + ' remove reached the cache');
        return seen;
      }, function (err) {
        self.ctx.bus.removeListener('data-update', onUpdate);
        throw err;
      });
  }

  function expectKept (type, deletedType, before, after, kind) {
    after[type].length.should.equal(before[type].length
      , type + ' cache emptied by ' + kind + ' of ' + deletedType + ': before ' + before[type].length + ', after ' + after[type].length);
    after[type].generation.should.equal(before[type].generation
      , type + ' removal generation bumped by ' + kind + ' of ' + deletedType);
  }

  // CHANGED EXPECTATION (WC-STEP-PATCH release 2, write-contract Q-A): the
  // deleted type's cache drops exactly the records the delete removed, and
  // keeps any other it holds; it was emptied and reloaded.
  function expectRemoved (type, removed, before, after) {
    removed.forEach(function (id) {
      after[type].ids.should.not.containEql(id, type + ' cache still holds ' + id + ' after a delete by query of ' + type);
    });
    after[type].length.should.equal(before[type].length - removed.length, type + ' cache keeps what was not removed');
    after[type].generation.should.equal(before[type].generation + 1, type + ' removal generation');
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.app = require('express')();
    require('../lib/middleware/configure-request')(self.app);
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', require('../lib/api/')(self.env, ctx));
      done();
    });
  });

  beforeEach(async function () {
    await dropAll();
    await self.ctx.entries.create([
      { _id: HEX.entry1, type: 'sgv', sgv: 120, date: when(1), dateString: new Date(when(1)).toISOString(), device: TAG }
      , { _id: HEX.entry2, type: 'sgv', sgv: 125, date: when(6), dateString: new Date(when(6)).toISOString(), device: TAG }
    ]);
    await self.ctx.devicestatus.create([
      { _id: HEX.status1, device: TAG, created_at: new Date(when(2)).toISOString(), uploaderBattery: 50 }
      , { _id: HEX.status2, device: TAG, created_at: new Date(when(7)).toISOString(), uploaderBattery: 49 }
    ]);
    await self.ctx.treatments.create([
      { _id: HEX.note1, eventType: 'Note', notes: TAG, created_at: new Date(when(3)).toISOString(), enteredBy: TAG }
      , { _id: HEX.note2, eventType: 'Note', notes: TAG, created_at: new Date(when(8)).toISOString(), enteredBy: TAG }
    ]);
    TYPES.forEach(function (type) {
      self.ctx.cache[type].length.should.be.above(0, type + ' cached after create');
    });
  });

  after(function () {
    return dropAll();
  });

  it('a treatments delete by query keeps the entries and devicestatus caches', async function () {
    var before = state();
    var after = await deleteAndWatch('/api/treatments/?find[enteredBy]=' + TAG, 'treatments');
    expectKept('entries', 'treatments', before, after, 'a delete by query');
    expectKept('devicestatus', 'treatments', before, after, 'a delete by query');
    expectRemoved('treatments', [HEX.note1, HEX.note2], before, after);
    cachedIds('entries').should.containEql(HEX.entry1);
    cachedIds('devicestatus').should.containEql(HEX.status1);
  });

  it('a treatments delete by query that matches nothing keeps the entries and devicestatus caches', async function () {
    var before = state();
    var after = await deleteAndWatch('/api/treatments/?find[enteredBy]=' + TAG + '-none', 'treatments');
    expectKept('entries', 'treatments', before, after, 'a delete by query matching 0 records');
    expectKept('devicestatus', 'treatments', before, after, 'a delete by query matching 0 records');
    // CHANGED EXPECTATION (WC-STEP-PATCH release 2, write-contract Q-A): the
    // write step names the records it removed, here none, so the treatments
    // cache keeps what it holds; it was flushed and reloaded.
    after.treatments.length.should.equal(before.treatments.length, 'treatments cache kept: nothing was removed');
    after.treatments.generation.should.equal(before.treatments.generation + 1, 'treatments removal generation');
  });

  it('a treatments delete by query that matches one of two drops only that one (Q-A)', async function () {
    var before = state();
    before.treatments.ids.should.containEql(HEX.note2);
    var after = await deleteAndWatch('/api/treatments/?find[_id]=' + HEX.note1, 'treatments');
    expectRemoved('treatments', [HEX.note1], before, after);
    after.treatments.ids.should.containEql(HEX.note2);
  });

  it('an entries delete by query keeps the treatments and devicestatus caches', async function () {
    var before = state();
    var after = await deleteAndWatch('/api/entries/?find[device]=' + TAG, 'entries');
    expectKept('treatments', 'entries', before, after, 'a delete by query');
    expectKept('devicestatus', 'entries', before, after, 'a delete by query');
    expectRemoved('entries', [HEX.entry1, HEX.entry2], before, after);
    cachedIds('treatments').should.containEql(HEX.note1);
  });
});
