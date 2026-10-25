'use strict';

// A record deleted by its _id leaves the in-memory cache too. Synthetic
// values only.
//
// entries, treatments and devicestatus remove() reported opts.find._id to the
// cache as the id removed, but query_for had already rewritten it into a
// filter ({$in: [ObjectId, hex]}), which no cached record equals. The deleted
// record stayed in the cache: unfiltered reads and newly opened pages kept
// showing it until the server restarted (found by the 15.0.9 soak, BF-131).
// A delete that removes both copies of an id stored twice must not leave one
// in the cache either, and the cache removes only the first match.

require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();
var idForms = require('../lib/server/object-id-forms');

describe('cache: a record deleted by _id is removed from the in-memory cache', function () {
  this.timeout(15000);
  var self = this;
  var TAG = 'cache-remove-test';

  var HEX = {
    entry: '5f7100000000000000000a01'
    , treatment: '5f7100000000000000000a02'
    , status: '5f7100000000000000000a03'
    , upper: '5F7100000000000000000A04'
    , twin: '5f7100000000000000000b05'
    , other: '5f7100000000000000000a06'
  };

  // Recent times: the cache keeps only records inside its retention window.
  var base = Math.floor(Date.now() / 60000) * 60000 - 60 * 60000;
  function when (minute) { return base + minute * 60000; }

  function cached (type, hex) {
    return self.ctx.cache.getData(type).filter(function (o) { return String(o._id).toLowerCase() === hex.toLowerCase(); });
  }

  function dropAll () {
    var ids = [];
    Object.keys(HEX).forEach(function (k) { ids.push(new ObjectID(HEX[k]), HEX[k], HEX[k].toLowerCase()); });
    return Promise.all(['entries', 'treatments', 'devicestatus'].map(function (name) {
      return self.ctx.store.collection(self.env[name + '_collection']).deleteMany({ _id: { $in: ids } });
    }));
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      dropAll().then(function () { done(); }, done);
    });
  });

  after(function () {
    return dropAll();
  });

  describe('cacheRemoval', function () {
    it('names the one record removed, lower-case hex or any other string', function () {
      idForms.cacheRemoval(HEX.entry, 1).should.equal(HEX.entry);
      idForms.cacheRemoval('a-uuid', 1).should.equal('a-uuid');
      idForms.cacheRemoval(new ObjectID(HEX.entry), 1).should.equal(HEX.entry);
    });

    it('asks the cache to reload for more than one record, an upper-case hex or a non-string', function () {
      (idForms.cacheRemoval(HEX.twin, 2) === undefined).should.equal(true);
      (idForms.cacheRemoval(HEX.upper, 1) === undefined).should.equal(true);
      (idForms.cacheRemoval({ $in: [HEX.entry] }, 1) === undefined).should.equal(true);
      (idForms.cacheRemoval(undefined, 1) === undefined).should.equal(true);
    });

    it('leaves the cache alone when nothing was removed', function () {
      idForms.cacheRemoval(HEX.entry, 0).should.equal(HEX.entry);
    });
  });

  it('entries.remove by _id removes the entry from the cache', async function () {
    await self.ctx.entries.create([{ _id: HEX.entry, type: 'sgv', sgv: 120, date: when(1), dateString: new Date(when(1)).toISOString(), device: TAG }]);
    cached('entries', HEX.entry).length.should.equal(1, 'cached after create');
    await self.ctx.entries.remove({ find: { _id: HEX.entry } });
    cached('entries', HEX.entry).length.should.equal(0, 'cached after remove');
  });

  it('treatments.remove by _id removes the treatment from the cache, and keeps another', async function () {
    await self.ctx.treatments.create([
      { _id: HEX.treatment, eventType: 'Carb Correction', carbs: 20, created_at: new Date(when(2)).toISOString(), enteredBy: TAG }
      , { _id: HEX.other, eventType: 'Note', created_at: new Date(when(3)).toISOString(), enteredBy: TAG }
    ]);
    cached('treatments', HEX.treatment).length.should.equal(1, 'cached after create');
    await self.ctx.treatments.remove({ find: { _id: HEX.treatment } });
    cached('treatments', HEX.treatment).length.should.equal(0, 'cached after remove');
    cached('treatments', HEX.other).length.should.equal(1, 'the other treatment');
  });

  it('devicestatus.remove by _id removes the status from the cache', async function () {
    await self.ctx.devicestatus.create([{ _id: HEX.status, device: TAG, created_at: new Date(when(4)).toISOString(), uploaderBattery: 50 }]);
    cached('devicestatus', HEX.status).length.should.equal(1, 'cached after create');
    await self.ctx.devicestatus.remove({ find: { _id: HEX.status } });
    cached('devicestatus', HEX.status).length.should.equal(0, 'cached after remove');
  });

  it('a delete asked in upper case removes the record from the cache', async function () {
    await self.ctx.treatments.create([{ _id: HEX.upper.toLowerCase(), eventType: 'Note', created_at: new Date(when(5)).toISOString(), enteredBy: TAG }]);
    cached('treatments', HEX.upper).length.should.equal(1, 'cached after create');
    await self.ctx.treatments.remove({ find: { _id: HEX.upper } });
    cached('treatments', HEX.upper).length.should.equal(0, 'cached after remove');
  });

  it('a delete of both copies of an id stored twice leaves neither in the cache', async function () {
    var col = self.ctx.store.collection(self.env.treatments_collection);
    var docs = [
      { _id: HEX.twin, eventType: 'Note', created_at: new Date(when(6)).toISOString(), enteredBy: TAG, notes: 'string copy' }
      , { _id: new ObjectID(HEX.twin), eventType: 'Note', created_at: new Date(when(6)).toISOString(), enteredBy: TAG, notes: 'edited copy' }
    ];
    await col.insertMany(docs);
    self.ctx.bus.emit('data-update', { type: 'treatments', op: 'update', changes: self.ctx.ddata.processRawDataForRuntime(docs) });
    cached('treatments', HEX.twin).length.should.equal(2, 'both copies cached');
    await self.ctx.treatments.remove({ find: { _id: HEX.twin } });
    (await col.countDocuments({ _id: { $in: [HEX.twin, new ObjectID(HEX.twin)] } })).should.equal(0);
    cached('treatments', HEX.twin).length.should.equal(0, 'copies cached after remove');
  });
});
