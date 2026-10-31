'use strict';

// API v1 batch replies keep one slot per sent item (ID-BATCH (iv), decided
// 2026-10-30).
//
// BF-219: a treatments batch with a preBolus item answered with one more
// item than was sent, because the carb record the server derives from the
// preBolus was in the reply. A client that requires as many items back as it
// sent (Loop) failed the reply and sent the batch again, without end; one that
// takes its bookmark from the newest record in the reply (nightscout-connect)
// moved it past records it had not sent yet. The derived record is still
// stored; it is no longer in the reply.
//
// Every test goes through HTTP against the booted server. Synthetic values only.

var request = require('supertest');
var should = require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('API v1 batch replies: one slot per sent item (BF-219)', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');
  var DEVICE = 'v1-batch-replies-test';

  var HEX = {
    storedEntry: '5f3200000000000000000e01'
    , batchEntry: '5f3200000000000000000e02'
    , loneEntry: '5f3200000000000000000e03'
    , treatment: '5f3200000000000000000c01'
    , food: '5f3200000000000000000f01'
    , activity: '5f3200000000000000000a01'
    , profile: '5f3200000000000000000b01'
    , devicestatus: '5f3200000000000000000d01'
  };

  function at (minute) {
    return Date.UTC(2021, 6, 7, 8, minute);
  }

  function iso (minute) {
    return new Date(at(minute)).toISOString();
  }

  function entry (minute, extra) {
    return Object.assign({
      type: 'sgv', sgv: 100 + minute, date: at(minute), dateString: iso(minute), device: DEVICE
    }, extra || {});
  }

  function collection (name) {
    return self.ctx.store.collection(self.env[name + '_collection'] || name);
  }

  function post (path, body) {
    return request(self.app).post('/api' + path).set('api-secret', known).send(body);
  }

  async function dropAll () {
    await collection('entries').deleteMany({ device: DEVICE });
    await collection('treatments').deleteMany({ enteredBy: DEVICE });
    await collection('treatments').deleteMany({ notes: DEVICE });
    await collection('food').deleteMany({ name: DEVICE });
    await collection('activity').deleteMany({ notes: DEVICE });
    await collection('profile').deleteMany({ defaultProfile: DEVICE });
    await collection('devicestatus').deleteMany({ device: DEVICE });
    await collection('entries').deleteMany({ _id: { $in: [HEX.storedEntry, HEX.batchEntry, HEX.loneEntry].map(function (h) { return new ObjectID(h); }) } });
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api', 'food'];
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', api(self.env, ctx));
      dropAll().then(function () { done(); }, done);
    });
  });

  beforeEach(dropAll);
  after(dropAll);

  describe('BF-219: a preBolus item gets one slot, its derived record none', function () {

    function treatment (minute, extra) {
      return Object.assign({
        eventType: 'Meal Bolus', created_at: iso(minute), carbs: 20 + minute, insulin: 1, enteredBy: DEVICE, notes: DEVICE
      }, extra || {});
    }

    it('a batch [preBolus item, item] answers two slots, and three records are stored', async function () {
      var res = await post('/treatments/', [treatment(1, { preBolus: 15 }), treatment(2)]).expect(200);
      res.body.should.be.an.Array();
      res.body.length.should.equal(2, 'one slot per sent item');
      res.body[0].created_at.should.equal(iso(1));
      res.body[1].created_at.should.equal(iso(2));
      should(res.body[0]._id).be.ok();
      should(res.body[1]._id).be.ok();

      var stored = await collection('treatments').find({ notes: DEVICE }).sort({ created_at: 1 }).toArray();
      stored.map(function (t) { return t.created_at; }).should.eql([iso(1), iso(2), iso(16)]
        , 'the derived record (15 minutes after its item) is still stored');
      String(stored[0]._id).should.equal(String(res.body[0]._id));
      String(stored[1]._id).should.equal(String(res.body[1]._id));
    });

    it('a single preBolus item answers one slot', async function () {
      var res = await post('/treatments/', treatment(3, { preBolus: 15 })).expect(200);
      res.body.length.should.equal(1);
      res.body[0].created_at.should.equal(iso(3));
      (await collection('treatments').countDocuments({ notes: DEVICE })).should.equal(2);
    });

    it('a preBolus item re-sent with its _id answers one slot with that _id (control: no second record)', async function () {
      var first = await post('/treatments/', [treatment(4, { preBolus: 10 })]).expect(200);
      var id = String(first.body[0]._id);
      var again = await post('/treatments/', [treatment(4, { preBolus: 10, _id: id }), treatment(5)]).expect(200);
      again.body.length.should.equal(2);
      String(again.body[0]._id).should.equal(id);
      (await collection('treatments').countDocuments({ notes: DEVICE })).should.equal(3);
    });
  });
});
