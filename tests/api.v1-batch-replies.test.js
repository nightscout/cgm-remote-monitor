'use strict';

// API v1 batch replies keep one slot per sent item (ID-BATCH (iv) and (v),
// decided 2026-10-30).
//
// BF-219: a treatments batch with a preBolus item answered with one more
// item than was sent, because the carb record the server derives from the
// preBolus was in the reply. A client that requires as many items back as it
// sent (Loop) failed the reply and sent the batch again, without end; one that
// takes its bookmark from the newest record in the reply (nightscout-connect)
// moved it past records it had not sent yet. The derived record is still
// stored; it is no longer in the reply.
//
// BF-220: an entry sent with an _id that another entry is already stored
// under (or that an earlier entry of the same batch took) made MongoDB refuse
// the insert with a duplicate-key error. The batch is written in order, so
// the entries before it were stored, the ones after it were not, and the
// request answered 500; clients sent the whole batch again and the entries
// after it were never stored. That entry is now refused in its own slot,
// with a 409, and the others are stored.
//
// The other v1 batch routes cannot reach a duplicate-key error on _id: v1
// treatments, food and activity write by _id (a sent _id replaces the record
// stored under it), profile merges a re-sent _id into the stored profile, and
// devicestatus treats a stored _id as already stored. The last block checks
// that each of them stores the item after such a duplicate.
//
// Every test goes through HTTP against the booted server. Synthetic values only.

var request = require('supertest');
var should = require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('API v1 batch replies: one slot per sent item (BF-219, BF-220)', function () {
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

  describe('BF-220: an entry whose _id is taken is refused with 409 in its slot', function () {

    function storedAt (minute) {
      return collection('entries').find({ sysTime: iso(minute), type: 'sgv', device: DEVICE }).toArray();
    }

    function expectRefused (slot, sent) {
      should.not.exist(slot._id);
      slot.refused.status.should.equal(409);
      slot.refused.message.should.be.a.String();
      slot.refused.rules.should.eql([{ rule: 'duplicate-id', field: '_id' }]);
      slot.sgv.should.equal(sent.sgv);
      slot.date.should.equal(sent.date);
    }

    it('an _id stored under another entry: 200, 409 in that slot, the other entries stored', async function () {
      await collection('entries').insertOne(Object.assign(entry(0), { _id: new ObjectID(HEX.storedEntry), sysTime: iso(0) }));
      var batch = [entry(10), entry(11, { _id: HEX.storedEntry }), entry(12)];
      var res = await post('/entries/', batch).expect(200);
      res.body.length.should.equal(3, 'one slot per sent item');
      should(res.body[0]._id).be.ok();
      expectRefused(res.body[1], batch[1]);
      should(res.body[2]._id).be.ok();

      (await storedAt(10)).length.should.equal(1);
      (await storedAt(11)).length.should.equal(0, 'the refused entry is not stored');
      (await storedAt(12)).length.should.equal(1, 'the entry after the refused one is stored');
      String((await storedAt(12))[0]._id).should.equal(String(res.body[2]._id));
      var holder = await collection('entries').findOne({ _id: new ObjectID(HEX.storedEntry) });
      holder.sysTime.should.equal(iso(0), 'the entry stored under that _id is unchanged');
      holder.sgv.should.equal(100);
    });

    it('an _id an earlier entry of the same batch took: 200, 409 in the later slot', async function () {
      var batch = [entry(20, { _id: HEX.batchEntry }), entry(21, { _id: HEX.batchEntry }), entry(22)];
      var res = await post('/entries/', batch).expect(200);
      res.body.length.should.equal(3);
      String(res.body[0]._id).should.equal(HEX.batchEntry);
      expectRefused(res.body[1], batch[1]);
      should(res.body[2]._id).be.ok();
      (await storedAt(20)).length.should.equal(1);
      (await storedAt(21)).length.should.equal(0);
      (await storedAt(22)).length.should.equal(1);
    });

    it('two taken _ids in one batch: each refused, every other entry stored', async function () {
      await collection('entries').insertOne(Object.assign(entry(0), { _id: new ObjectID(HEX.storedEntry), sysTime: iso(0) }));
      var batch = [entry(30, { _id: HEX.storedEntry }), entry(31), entry(32, { _id: HEX.storedEntry }), entry(33)];
      var res = await post('/entries/', batch).expect(200);
      res.body.length.should.equal(4);
      expectRefused(res.body[0], batch[0]);
      expectRefused(res.body[2], batch[2]);
      (await storedAt(31)).length.should.equal(1);
      (await storedAt(33)).length.should.equal(1);
    });

    it('a batch whose every entry is refused: 400, with the slots', async function () {
      await collection('entries').insertOne(Object.assign(entry(0), { _id: new ObjectID(HEX.loneEntry), sysTime: iso(0) }));
      var batch = [entry(40, { _id: HEX.loneEntry })];
      var res = await post('/entries/', batch).expect(400);
      res.body.length.should.equal(1);
      expectRefused(res.body[0], batch[0]);
      (await storedAt(40)).length.should.equal(0);
    });

    it('the same _id at the stored entry\'s own time updates it (control)', async function () {
      await collection('entries').insertOne(Object.assign(entry(0), { _id: new ObjectID(HEX.storedEntry), sysTime: iso(0) }));
      var res = await post('/entries/', [entry(0, { _id: HEX.storedEntry, sgv: 180 }), entry(1)]).expect(200);
      res.body.length.should.equal(2);
      String(res.body[0]._id).should.equal(HEX.storedEntry);
      (await storedAt(0))[0].sgv.should.equal(180);
    });
  });

  describe('BF-220: the other v1 batch routes store the item after a re-sent _id', function () {

    it('treatments: a sent _id replaces the record stored under it', async function () {
      await collection('treatments').insertOne({ _id: new ObjectID(HEX.treatment), eventType: 'Note', created_at: iso(0), notes: DEVICE });
      var res = await post('/treatments/', [
        { eventType: 'Note', created_at: iso(50), notes: DEVICE }
        , { _id: HEX.treatment, eventType: 'Note', created_at: iso(51), notes: DEVICE }
        , { eventType: 'Note', created_at: iso(52), notes: DEVICE }
      ]).expect(200);
      res.body.length.should.equal(3);
      (await collection('treatments').countDocuments({ notes: DEVICE, created_at: iso(52) })).should.equal(1);
    });

    it('devicestatus: a stored _id is not stored again, the next item is', async function () {
      await collection('devicestatus').insertOne({ _id: new ObjectID(HEX.devicestatus), device: DEVICE, created_at: iso(0) });
      var res = await post('/devicestatus/', [
        { device: DEVICE, created_at: iso(50) }
        , { _id: HEX.devicestatus, device: DEVICE, created_at: iso(51) }
        , { device: DEVICE, created_at: iso(52) }
      ]).expect(200);
      res.body.length.should.equal(3);
      (await collection('devicestatus').countDocuments({ device: DEVICE, created_at: iso(52) })).should.equal(1);
    });

    it('food: a sent _id replaces the record stored under it', async function () {
      await collection('food').insertOne({ _id: new ObjectID(HEX.food), name: DEVICE, carbs: 1 });
      var res = await post('/food/', [
        { name: DEVICE, carbs: 50 }, { _id: HEX.food, name: DEVICE, carbs: 51 }, { name: DEVICE, carbs: 52 }
      ]).expect(200);
      res.body.length.should.equal(3);
      (await collection('food').countDocuments({ name: DEVICE, carbs: 52 })).should.equal(1);
    });

    it('activity: a sent _id replaces the record stored under it', async function () {
      await collection('activity').insertOne({ _id: new ObjectID(HEX.activity), notes: DEVICE, created_at: iso(0) });
      var res = await post('/activity/', [
        { notes: DEVICE, created_at: iso(50) }, { _id: HEX.activity, notes: DEVICE, created_at: iso(51) }
        , { notes: DEVICE, created_at: iso(52) }
      ]).expect(200);
      res.body.length.should.equal(3);
      (await collection('activity').countDocuments({ notes: DEVICE, created_at: iso(52) })).should.equal(1);
    });

    it('profile: a re-sent _id merges into the stored profile', async function () {
      function profile (minute, extra) {
        return Object.assign({ defaultProfile: DEVICE, startDate: iso(minute), created_at: iso(minute)
          , store: { [DEVICE]: { dia: 3, units: 'mg/dl' } } }, extra || {});
      }
      await collection('profile').insertOne(Object.assign(profile(0), { _id: new ObjectID(HEX.profile) }));
      var res = await post('/profile/', [profile(50), profile(0, { _id: HEX.profile }), profile(52)]).expect(200);
      res.body.length.should.equal(3);
      (await collection('profile').countDocuments({ defaultProfile: DEVICE, startDate: iso(52) })).should.equal(1);
    });
  });
});
