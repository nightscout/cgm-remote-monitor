'use strict';

// ID-UNIQUE-INDEX, item level (decision 2026-10-30: "re-reads by identifier,
// applies the item ... and retries once"): when one item of an API v1 batch
// loses an identifier race, only that item is applied again, as its re-send.
// The items the write had already stored keep their outcome, are written
// once (srvModified as inserted) and are announced once.
//
// Device status: deterministic. The other upload's status is stored straight
// to MongoDB at the batch's first insertMany, after the batch's identifier
// match, so the raced status's insert is refused by identifier_unique. The
// insert is unordered, so slot 0 is stored by the same call.
//
// Treatments: a treatment's target is its identifier, so a record stored
// before the write would simply be matched. The race needs two upserts at
// once: two batches, each a new treatment of its own in slot 0 and the same
// treatment in slot 1 (so their slot-1 upserts line up), are held at their
// bulk write until both arrive, then run together, ROUNDS times. MongoDB
// settles some of these itself; the test counts the rounds that reached the
// write step's race handling and fails if none did, so it cannot pass
// without the race. In each such round, the batch whose slot 1 lost keeps
// slot 0 as inserted, written once.
//
// Synthetic values only; records dated 2021.

var request = require('supertest');
var should = require('should');
var { Collection } = require('mongodb');
var language = require('../lib/language')();
var writeIntent = require('../lib/storage/write-intent');

describe('ID-UNIQUE-INDEX: a batch item that loses an identifier race is applied alone', function () {
  this.timeout(60000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var DEVICE = 'batch-race-item-level-test';
  var realInsertMany = Collection.prototype.insertMany;
  var realBulkWrite = Collection.prototype.bulkWrite;
  var realForCollection = writeIntent.forCollection;
  var updates = [];
  var results = [];
  var warned = [];
  var realWarn = console.warn;

  function col (name) { return self.ctx.store.collection(self.env[name + '_collection']); }
  function iso (minute) { return new Date(Date.UTC(2021, 8, 9, 7, minute)).toISOString(); }
  async function dropAll () {
    await col('devicestatus').deleteMany({ device: DEVICE });
    await col('treatments').deleteMany({ enteredBy: DEVICE });
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
      self.app.use('/api', require('../lib/api/')(self.env, ctx));
      ctx.bus.on('data-update', function (ev) { updates.push(ev); });
      dropAll().then(function () { done(); }, done);
    });
  });

  beforeEach(function () {
    updates = [];
    results = [];
    warned = [];
    console.warn = function () { warned.push(Array.prototype.join.call(arguments, ' ')); return realWarn.apply(console, arguments); };
    // Each result the write step answers, by collection.
    writeIntent.forCollection = function forCollection (storage, name) {
      var step = realForCollection.apply(this, arguments);
      var write = step.write;
      step.write = async function (intent) {
        var result = await write.call(step, intent);
        results.push({ name: name, result: result });
        return result;
      };
      return step;
    };
    return dropAll();
  });

  afterEach(function () {
    console.warn = realWarn;
    Collection.prototype.insertMany = realInsertMany;
    Collection.prototype.bulkWrite = realBulkWrite;
    writeIntent.forCollection = realForCollection;
  });

  after(dropAll);

  function raceLines () {
    return warned.filter(function (w) { return /applying this one as its re-send/.test(w); }).length;
  }

  it('device status: slot 0 stored once and announced once; slot 1 merged into the other upload\'s status', async function () {
    self.ctx.identifierIndex.mode.should.equal('try');
    var RACE = 'batch-race-status-1';
    var other = null;
    var statusName = col('devicestatus').collectionName;
    Collection.prototype.insertMany = async function insertMany () {
      if (this.collectionName === statusName && other === null) {
        other = (await col('devicestatus').insertOne({ identifier: RACE, device: DEVICE, created_at: iso(1)
          , uploaderBattery: 50, pump: { reservoir: 10 }, srvCreated: 1, srvModified: 1 })).insertedId;
      }
      return realInsertMany.apply(this, arguments);
    };
    var batch = [
      { identifier: 'batch-race-status-0', device: DEVICE, created_at: iso(0), uploaderBattery: 70 }
      , { identifier: RACE, device: DEVICE, created_at: iso(1), uploaderBattery: 40 }
    ];
    var res = await request(self.app).post('/api/devicestatus/').set('api-secret', known).send(batch).expect(200);
    Collection.prototype.insertMany = realInsertMany;
    should.exist(other, 'the other upload was stored at the first insertMany');

    var written = results.filter(function (r) { return r.name === 'devicestatus'; });
    written.length.should.equal(1);
    written[0].result.items.map(function (i) { return i.outcome; }).should.eql(['inserted', 'merged']);
    raceLines().should.equal(1, 'one race handled');

    var s0 = await col('devicestatus').find({ identifier: 'batch-race-status-0' }).toArray();
    s0.length.should.equal(1);
    s0[0].srvModified.should.equal(s0[0].srvCreated, 'slot 0 written once');
    var s1 = await col('devicestatus').find({ identifier: RACE }).toArray();
    s1.length.should.equal(1, 'one status holds the identifier');
    s1[0].uploaderBattery.should.equal(40, 'slot 1 merged');
    s1[0].pump.should.eql({ reservoir: 10 }, 'a merge keeps what slot 1 leaves out');

    res.body.length.should.equal(2);
    String(res.body[0]._id).should.equal(String(s0[0]._id));
    String(res.body[1]._id).should.equal(String(other));
    var announced = updates.filter(function (u) { return u.type === 'devicestatus'; });
    announced.length.should.equal(1, 'one data-update for device status');
    announced[0].changes.map(function (s) { return s.uploaderBattery; }).sort().should.eql([40, 70]);
  });

  it('treatments: in the rounds where slot 1 lost the race, slot 0 keeps its outcome and is written once', async function () {
    self.ctx.identifierIndex.mode.should.equal('try');
    var ROUNDS = 60;
    var raced = 0;
    var treatmentsName = col('treatments').collectionName;
    for (var round = 0; round < ROUNDS; round++) {
      var stamp = Date.now() + '-' + round;
      var t0 = { identifier: 'batch-race-t0-' + stamp, eventType: 'Note', notes: 'zero', created_at: iso(10 + round), enteredBy: DEVICE };
      var p0 = { identifier: 'batch-race-p0-' + stamp, eventType: 'Note', notes: 'pad', created_at: iso(10 + round), enteredBy: DEVICE };
      var t1 = { identifier: 'batch-race-t1-' + stamp, eventType: 'Note', notes: 'one', created_at: iso(10 + round), enteredBy: DEVICE };
      // Hold the first two bulk writes on treatments until both arrive.
      var held = [];
      Collection.prototype.bulkWrite = function bulkWrite () {
        var that = this;
        var args = arguments;
        if (that.collectionName !== treatmentsName || held.length >= 2 && held.released) return realBulkWrite.apply(that, args);
        return new Promise(function (resolve) {
          held.push(resolve);
          if (held.length === 2) { held.released = true; held.forEach(function (go) { go(); }); }
        }).then(function () { return realBulkWrite.apply(that, args); });
      };
      results = [];
      var before = raceLines();
      var replies = await Promise.all([
        request(self.app).post('/api/treatments/').set('api-secret', known).send([t0, Object.assign({}, t1, { notes: 'one again' })])
        , request(self.app).post('/api/treatments/').set('api-secret', known).send([p0, t1])
      ]);
      Collection.prototype.bulkWrite = realBulkWrite;
      replies.map(function (r) { return r.status; }).should.eql([200, 200], 'round ' + round);
      var stored1 = await col('treatments').find({ identifier: t1.identifier }).toArray();
      stored1.length.should.equal(1, 'round ' + round + ': one record holds slot 1\'s identifier');
      if (raceLines() === before) continue;
      raced += 1;
      var batches = results.filter(function (r) { return r.name === 'treatments' && r.result.items.length === 2; });
      batches.length.should.equal(2, 'round ' + round + ': one write result per batch');
      var losers = batches.filter(function (r) { return r.result.items[1].outcome !== 'inserted'; });
      losers.length.should.equal(1, 'round ' + round + ': one batch lost slot 1');
      var loser = losers[0].result;
      loser.items[0].outcome.should.equal('inserted', 'round ' + round + ': the loser\'s slot 0 keeps its outcome');
      loser.items[1].outcome.should.equal('replaced', 'round ' + round + ': slot 1 applied as its re-send');
      var slot0 = await col('treatments').find({ identifier: loser.items[0].identifier }).toArray();
      slot0.length.should.equal(1);
      slot0[0].srvModified.should.equal(slot0[0].srvCreated, 'round ' + round + ': the loser\'s slot 0 written once');
    }
    console.log('    (treatments rounds that reached the race handling: ' + raced + ' of ' + ROUNDS + ')');
    raced.should.be.above(0, 'the race was reached in at least one round');
  });
});
