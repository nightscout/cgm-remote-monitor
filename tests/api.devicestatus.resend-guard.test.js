'use strict';

// A devicestatus re-sent with the `_id` of a copy stored as a string is
// refused, as it was before devicestatus stored a 24-hex `_id` as an ObjectId.
//
// devicestatus create stores a 24-hex `_id` as the ObjectId it names. A record
// whose first copy was stored with the string `_id` (before that change, or by
// the websocket) was then stored again beside it when re-sent, as an ObjectId
// copy. Before the change the re-send collided with the stored record and was
// refused. create now looks, once per batch that carries 24-hex `_id`s, for
// those ids stored as strings and keeps the stored form, so the re-send
// collides again, as a re-sent profile does (BF-99).

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('devicestatus: a re-send of a string-stored _id is refused, not copied', function () {
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

  it('a re-send of a record stored with the string _id is refused, leaving the one string record', async function () {
    await collection().insertOne(status(1, { _id: HEX.string }));
    await post(status(1, { _id: HEX.string })).expect(500);
    var docs = await storedFor(HEX.string);
    docs.length.should.equal(1);
    docs[0]._id.should.equal(HEX.string);
  });

  it('a re-send of a record stored with an upper-case string _id, in upper case, is refused', async function () {
    await collection().insertOne(status(2, { _id: HEX.upperString }));
    await post(status(2, { _id: HEX.upperString })).expect(500);
    var docs = await storedFor(HEX.upperString);
    docs.length.should.equal(1);
    docs[0]._id.should.equal(HEX.upperString);
  });

  it('a re-send in upper case of a record stored with the lower-case string _id is refused', async function () {
    await collection().insertOne(status(7, { _id: HEX.lowerSentUpper }));
    await post(status(7, { _id: HEX.lowerSentUpper.toUpperCase() })).expect(500);
    var docs = await storedFor(HEX.lowerSentUpper);
    docs.length.should.equal(1);
    docs[0]._id.should.equal(HEX.lowerSentUpper);
  });

  it('an in-process create of a string-stored _id is refused too', async function () {
    await collection().insertOne(status(3, { _id: HEX.internal }));
    var failed = false;
    try {
      await self.ctx.devicestatus.create([status(3, { _id: HEX.internal })]);
    } catch (err) {
      failed = true;
    }
    failed.should.equal(true);
    (await storedFor(HEX.internal)).length.should.equal(1);
  });

  it('a re-send of a record stored with an ObjectId _id is still refused (control)', async function () {
    await collection().insertOne(status(4, { _id: new ObjectID(HEX.oid) }));
    await post(status(4, { _id: HEX.oid })).expect(500);
    (await storedFor(HEX.oid)).length.should.equal(1);
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

    it('one read for a batch carrying 24-hex _ids, asking for their string forms', async function () {
      var ids = [];
      var batch = [];
      for (var i = 0; i < 5; i++) {
        var hex = HEX.count.slice(0, 20) + ('000' + (i + 16).toString(16)).slice(-4);
        ids.push(hex);
        batch.push(status(10 + i, { _id: hex }));
      }
      await post(batch).expect(200);
      finds.length.should.equal(1);
      finds[0]._id.$in.should.eql(ids);
    });

    it('no read for a batch without _ids', async function () {
      await post([status(20), status(21)]).expect(200);
      finds.length.should.equal(0);
    });
  });
});
