'use strict';

// A devicestatus re-sent with the `_id` it is already stored under is
// answered with that record and not stored again, and the rest of the batch
// is stored.
//
// devicestatus create stores a 24-hex `_id` as the ObjectId it names. Before
// that, a re-send of a record stored with the ObjectId was stored a second
// time as a string copy; a re-send of a string-stored record collided and
// failed the whole POST with 500, losing every new status after it in the
// batch (BF-116). An uploader re-sends when it retries, so create now looks,
// once per batch that carries 24-hex `_id`s, for those ids in either stored
// form, answers a re-sent status with the stored `_id`, and inserts the rest.
//
// CHANGED EXPECTATIONS (BF-116): the re-send tests below asserted HTTP 500
// ("refused"). They now assert 200 with the one stored record kept as it was.

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('devicestatus: a re-send of a stored _id is acknowledged, not copied or refused', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');

  var HEX = {
    string: '5f61abcdef0000000000b001'
    , upperString: '5F61ABCDEF0000000000B002'
    , oid: '5f61abcdef0000000000b003'
    , fresh1: '5f61abcdef0000000000a004'
    , fresh2: '5f61abcdef0000000000a005'
    , internal: '5f61abcdef0000000000b006'
    , count: '5f61abcdef0000000000b007'
    , lowerSentUpper: '5f61abcdef0000000000b008'
    , batchResent: '5f61abcdef0000000000b009'
    , batchNew: '5f61abcdef0000000000a00a'
    , sameTwice: '5f61abcdef0000000000a00b'
    , twin: '5f61abcdef0000000000b00c'
    , race: '5f61abcdef0000000000b00d'
    , raceNew: '5f61abcdef0000000000a00e'
    , raceOther: '5f61abcdef0000000000a00f'
  };

  // Synthetic values only.
  function status (minute, extra) {
    return Object.assign({
      device: 'resend-guard-test'
      , created_at: new Date(Date.UTC(2021, 4, 8, 1, minute)).toISOString()
      , uploaderBattery: 50
    }, extra || {});
  }

  function collection () {
    return self.ctx.store.collection(self.env.devicestatus_collection);
  }

  function storedFor (hex) {
    return collection().find({ _id: { $in: [new ObjectID(hex), hex, hex.toLowerCase()] } }).toArray();
  }

  function post (body) {
    return request(self.app).post('/api/devicestatus/').set('api-secret', known).send(body);
  }

  function dropAll () {
    return collection().deleteMany({ device: 'resend-guard-test' });
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', api(self.env, ctx));
      dropAll().then(function () { done(); }, done);
    });
  });

  after(function () {
    return dropAll();
  });

  it('a re-send of a record stored with the string _id is acknowledged, leaving the one string record', async function () {
    await collection().insertOne(status(1, { _id: HEX.string }));
    var res = await post(status(1, { _id: HEX.string, uploaderBattery: 49 })).expect(200);
    String(res.body[0]._id).should.equal(HEX.string);
    var docs = await storedFor(HEX.string);
    docs.length.should.equal(1);
    docs[0]._id.should.equal(HEX.string);
    docs[0].uploaderBattery.should.equal(50, 'the stored record is not rewritten');
  });

  it('a re-send of a record stored with an upper-case string _id, in upper case, is acknowledged', async function () {
    await collection().insertOne(status(2, { _id: HEX.upperString }));
    await post(status(2, { _id: HEX.upperString })).expect(200);
    var docs = await storedFor(HEX.upperString);
    docs.length.should.equal(1);
    docs[0]._id.should.equal(HEX.upperString);
  });

  it('a re-send in upper case of a record stored with the lower-case string _id is acknowledged', async function () {
    await collection().insertOne(status(7, { _id: HEX.lowerSentUpper }));
    await post(status(7, { _id: HEX.lowerSentUpper.toUpperCase() })).expect(200);
    var docs = await storedFor(HEX.lowerSentUpper);
    docs.length.should.equal(1);
    docs[0]._id.should.equal(HEX.lowerSentUpper);
  });

  it('an in-process create of a string-stored _id is acknowledged too', async function () {
    await collection().insertOne(status(3, { _id: HEX.internal }));
    var result = await self.ctx.devicestatus.create([status(3, { _id: HEX.internal })]);
    result[0]._id.should.equal(HEX.internal);
    (await storedFor(HEX.internal)).length.should.equal(1);
  });

  it('a re-send of a record stored with an ObjectId _id is acknowledged, not stored as a string copy', async function () {
    await collection().insertOne(status(4, { _id: new ObjectID(HEX.oid) }));
    await post(status(4, { _id: HEX.oid })).expect(200);
    var docs = await storedFor(HEX.oid);
    docs.length.should.equal(1);
    (docs[0]._id instanceof ObjectID).should.equal(true);
  });

  it('a batch that starts with a re-sent status stores the new statuses after it', async function () {
    var first = await post(status(8)).expect(200);
    var storedId = String(first.body[0]._id);
    await post([status(8, { _id: storedId }), status(9, { _id: HEX.batchNew }), status(10)]).expect(200);
    (await storedFor(storedId)).length.should.equal(1, 'copies of the re-sent status');
    (await storedFor(HEX.batchNew)).length.should.equal(1, 'the new status with an _id');
    (await collection().countDocuments({ device: 'resend-guard-test', created_at: status(10).created_at })).should.equal(1, 'the new status without an _id');
  });

  it('the same new _id twice in one batch is stored once', async function () {
    await post([status(11, { _id: HEX.sameTwice }), status(11, { _id: HEX.sameTwice })]).expect(200);
    (await storedFor(HEX.sameTwice)).length.should.equal(1);
  });

  it('a re-send of a record stored twice is answered with the ObjectId copy and adds none', async function () {
    await collection().insertOne(status(12, { _id: HEX.twin }));
    await collection().insertOne(status(12, { _id: new ObjectID(HEX.twin) }));
    var res = await post(status(12, { _id: HEX.twin })).expect(200);
    String(res.body[0]._id).should.equal(HEX.twin);
    (await storedFor(HEX.twin)).length.should.equal(2);
  });

  it('a batch of new records with 24-hex _ids is stored with ObjectIds (control)', async function () {
    await post([status(5, { _id: HEX.fresh1 }), status(6, { _id: HEX.fresh2 })]).expect(200);
    var one = await storedFor(HEX.fresh1);
    var two = await storedFor(HEX.fresh2);
    one.length.should.equal(1);
    two.length.should.equal(1);
    (one[0]._id instanceof ObjectID).should.equal(true);
    (two[0]._id instanceof ObjectID).should.equal(true);
  });

  describe('a re-send stored by another request after the read', function () {
    var original;

    // The read that looks for stored ids runs before the insert. Hide the
    // stored record from it, as a concurrent POST of the same status would.
    beforeEach(function () {
      original = self.ctx.store.collection;
      var name = self.env.devicestatus_collection;
      self.ctx.store.collection = function (asked) {
        var col = original.apply(this, arguments);
        if (asked !== name) return col;
        return new Proxy(col, {
          get: function (target, prop) {
            if (prop === 'find') {
              return function () { return { toArray: function () { return Promise.resolve([]); } }; };
            }
            var value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      };
    });

    afterEach(function () {
      self.ctx.store.collection = original;
    });

    it('is acknowledged, and the new statuses in the batch are stored', async function () {
      await collection().insertOne(status(30, { _id: new ObjectID(HEX.race) }));
      await post([status(30, { _id: HEX.race }), status(31, { _id: HEX.raceNew })]).expect(200);
      self.ctx.store.collection = original;
      (await storedFor(HEX.race)).length.should.equal(1, 'copies of the re-sent status');
      (await storedFor(HEX.raceNew)).length.should.equal(1, 'the new status');
    });

    it('any other insert error still fails the POST (control)', async function () {
      var insertMany = self.ctx.store.collection;
      var name = self.env.devicestatus_collection;
      self.ctx.store.collection = function (asked) {
        var col = insertMany.apply(this, arguments);
        if (asked !== name) return col;
        return new Proxy(col, {
          get: function (target, prop) {
            if (prop === 'insertMany') {
              return function () {
                var err = new Error('synthetic write error');
                err.writeErrors = [{ code: 2, index: 0 }];
                return Promise.reject(err);
              };
            }
            var value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      };
      await post([status(32, { _id: HEX.raceOther })]).expect(500);
    });
  });

  describe('reads', function () {
    var finds;
    var original;

    beforeEach(function () {
      finds = [];
      original = self.ctx.store.collection;
      var name = self.env.devicestatus_collection;
      self.ctx.store.collection = function (asked) {
        var col = original.apply(this, arguments);
        if (asked !== name) return col;
        return new Proxy(col, {
          get: function (target, prop) {
            if (prop === 'find') {
              return function (filter) { finds.push(filter); return target.find.apply(target, arguments); };
            }
            var value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      };
    });

    afterEach(function () {
      self.ctx.store.collection = original;
    });

    // CHANGED EXPECTATION (BF-116): the read asked for the string forms
    // only; it now asks for every form, ObjectId first, so a re-send of an
    // ObjectId-stored status is found too.
    it('one read for a batch carrying 24-hex _ids, asking for every form of each', async function () {
      var ids = [];
      var batch = [];
      for (var i = 0; i < 5; i++) {
        var hex = HEX.count.slice(0, 20) + ('000' + (i + 16).toString(16)).slice(-4);
        ids.push(hex);
        batch.push(status(10 + i, { _id: hex }));
      }
      await post(batch).expect(200);
      finds.length.should.equal(1);
      var expected = [];
      ids.forEach(function (hex) { expected.push(new ObjectID(hex), hex); });
      finds[0]._id.$in.map(String).should.eql(expected.map(String));
      finds[0]._id.$in.filter(function (f) { return f instanceof ObjectID; }).length.should.equal(ids.length);
    });

    it('no read for a batch without _ids', async function () {
      await post([status(20), status(21)]).expect(200);
      finds.length.should.equal(0);
    });
  });
});
