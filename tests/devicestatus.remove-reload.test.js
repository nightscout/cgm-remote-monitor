'use strict';

// A devicestatus delete asks for a reload, as entries and treatments deletes
// do (BF-214). Synthetic values only.
//
// The remove empties the devicestatus cache (cache.js invalidate). Without a
// 'data-received' the data is not reloaded until the next heartbeat tick, so
// ddata.devicestatus, and the loop and pump pills drawn from it, stay empty
// for up to a heartbeat. The reload refills only devicestatus: the entries
// and treatments caches keep their removal generations (BF-211).

var request = require('supertest');
require('should');
var language = require('../lib/language')();

describe('devicestatus: a delete asks for a reload', function () {
  this.timeout(15000);
  var self = this;
  var TAG = 'devicestatus-remove-reload-test';
  var api_secret_hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var TYPES = ['treatments', 'devicestatus', 'entries'];

  var HEX = {
    entry1: '5f7200000000000000000d01'
    , status1: '5f7200000000000000000d02'
    , status2: '5f7200000000000000000d03'
    , note1: '5f7200000000000000000d04'
  };

  // Recent times: the cache keeps only records inside its retention window.
  var base = Math.floor(Date.now() / 60000) * 60000 - 60 * 60000;
  function when (minute) { return base + minute * 60000; }

  function generations () {
    var out = {};
    TYPES.forEach(function (type) {
      out[type] = self.ctx.cache.getRemovalGeneration(type);
    });
    return out;
  }

  function dropAll () {
    var ids = Object.keys(HEX).map(function (k) { return HEX[k]; });
    return Promise.all(TYPES.map(function (name) {
      return self.ctx.store.collection(self.env[name + '_collection']).deleteMany({ $or: [{ _id: { $in: ids } }, { device: { $in: [TAG, TAG + '-kept'] } }, { enteredBy: TAG }] });
    }));
  }

  // Waits for a load that starts after this call.
  function nextLoad () {
    return new Promise(function (resolve) {
      self.ctx.bus.once('data-loaded', resolve);
    });
  }

  // Lets the reloads the seeding asked for finish, so a load seen later
  // belongs to the delete.
  function settle () {
    return new Promise(function (resolve) { setTimeout(resolve, 1500); }).then(function () {
      return new Promise(function (resolve) {
        var timer = setTimeout(resolve, 1500);
        self.ctx.bus.once('data-loaded', function () { clearTimeout(timer); resolve(); });
      });
    });
  }

  function deleteAndWatch (path) {
    var received = 0;
    function onReceived () { received += 1; }
    self.ctx.bus.on('data-received', onReceived);
    return request(self.app)
      .delete(path)
      .set('api-secret', api_secret_hash)
      .expect(200)
      .then(function () {
        self.ctx.bus.removeListener('data-received', onReceived);
        return received;
      }, function (err) {
        self.ctx.bus.removeListener('data-received', onReceived);
        throw err;
      });
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
    ]);
    await self.ctx.treatments.create([
      { _id: HEX.note1, eventType: 'Note', notes: TAG, created_at: new Date(when(3)).toISOString(), enteredBy: TAG }
    ]);
    await self.ctx.devicestatus.create([
      { _id: HEX.status1, device: TAG, created_at: new Date(when(2)).toISOString(), uploaderBattery: 50 }
      , { _id: HEX.status2, device: TAG + '-kept', created_at: new Date(when(7)).toISOString(), uploaderBattery: 49 }
    ]);
    await settle();
    TYPES.forEach(function (type) {
      self.ctx.cache[type].length.should.be.above(0, type + ' cached after create');
    });
  });

  after(function () {
    return dropAll();
  });

  it('a delete by query emits data-received', async function () {
    var received = await deleteAndWatch('/api/devicestatus/?find[device]=' + TAG);
    received.should.be.above(0, 'no data-received after a devicestatus delete: the devicestatus cache stays empty until the next heartbeat');
  });

  it('the reload refills devicestatus with the records left and keeps the other caches', async function () {
    var before = generations();
    var loaded = nextLoad();
    var timeout;
    var waited = new Promise(function (resolve, reject) {
      timeout = setTimeout(function () { reject(new Error('no reload within 5 s of a devicestatus delete')); }, 5000);
    });
    await deleteAndWatch('/api/devicestatus/?find[device]=' + TAG);
    var after = generations();
    after.devicestatus.should.equal(before.devicestatus + 1, 'devicestatus removal generation');
    after.entries.should.equal(before.entries, 'entries removal generation bumped by a devicestatus delete');
    after.treatments.should.equal(before.treatments, 'treatments removal generation bumped by a devicestatus delete');

    try {
      await Promise.race([loaded, waited]);
    } finally {
      clearTimeout(timeout);
    }

    var ids = self.ctx.cache.getData('devicestatus').map(function (o) { return String(o._id); });
    ids.should.containEql(HEX.status2);
    ids.should.not.containEql(HEX.status1);
    self.ctx.ddata.devicestatus.map(function (o) { return String(o._id); }).should.containEql(HEX.status2);
    self.ctx.cache.getData('entries').map(function (o) { return String(o._id); }).should.containEql(HEX.entry1);
    self.ctx.cache.getData('treatments').map(function (o) { return String(o._id); }).should.containEql(HEX.note1);
    var final = generations();
    final.entries.should.equal(before.entries, 'entries removal generation after the reload');
    final.treatments.should.equal(before.treatments, 'treatments removal generation after the reload');
  });
});
