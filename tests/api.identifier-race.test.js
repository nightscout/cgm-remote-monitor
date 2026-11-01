'use strict';

// ID-UNIQUE-INDEX, the race (maintainer, 2026-10-30): with the unique index on
// identifier, two uploads of one record that race both miss the identifier
// match, and the second insert gets a duplicate key. The write step re-reads
// by identifier and applies that upload as its path applies a re-send, once
// (lib/storage/write-intent.js, DUPLICATE_IDENTIFIER). So both callers are
// answered without a 5xx, and one record is stored.
//
// The race is forced, not hoped for: the MongoDB driver's write method for
// the collection is held until both requests have reached it, so both have
// run their identifier match against an empty collection. A test whose gate
// did not see two calls fails, so a race that did not happen cannot pass.
//
// Synthetic values only; records dated May 2019.

var request = require('supertest');
var should = require('should');
var { Collection } = require('mongodb');
var language = require('../lib/language')();
var identifierIndex = require('../lib/storage/identifier-index');

// Hold the first `count` calls of `method` on the collection named `name`
// until all have arrived (or `waitMs` passed), then let them run together;
// with `inOrder`, one at a time in arrival order, each after the one before
// has finished (so the later one has still matched before the earlier wrote).
function gate (name, method, count, waitMs, inOrder, between) {
  var real = Collection.prototype[method];
  var held = [];
  var state = { arrived: 0 };
  var timer = null;
  function releaseAll () {
    if (timer) clearTimeout(timer);
    var all = held.splice(0);
    if (!inOrder) return all.forEach(function (go) { go(); });
    all.reduce(function (previous, go, index) {
      return previous.then(function () {
        return index > 0 && between ? between() : undefined;
      }).then(function () { return go(); });
    }, Promise.resolve());
  }
  Collection.prototype[method] = function gated () {
    var self = this;
    var args = arguments;
    if (self.collectionName !== name || state.arrived >= count) return real.apply(self, args);
    state.arrived += 1;
    var done;
    var finished = new Promise(function (resolve) { done = resolve; });
    return new Promise(function (resolve) {
      held.push(function go () { resolve(); return finished; });
      if (held.length === count) releaseAll();
      else if (!timer) timer = setTimeout(releaseAll, waitMs || 3000);
    }).then(function () { return real.apply(self, args); })
      .then(function (value) { done(); return value; }, function (err) { done(); throw err; });
  };
  state.restore = function restore () { Collection.prototype[method] = real; };
  return state;
}

var T = Date.parse('2019-05-11T07:40:00.000Z');
function iso (t) { return new Date(t).toISOString(); }

describe('ID-UNIQUE-INDEX: two uploads of one record that race', function () {
  this.timeout(20000);

  describe('API v1', function () {
    var self = this;
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    var opened = [];

    function col (name) {
      return self.ctx.store.collection(self.env[name + '_collection']);
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
        done();
      });
    });

    afterEach(async function () {
      opened.splice(0).forEach(function (g) { g.restore(); });
      await col('treatments').deleteMany({ raceTest: true });
      await col('entries').deleteMany({ raceTest: true });
      await col('devicestatus').deleteMany({ raceTest: true });
    });

    // Two upserts that race are sometimes settled inside MongoDB (a write
    // conflict, retried there, then matches) and sometimes end in the
    // duplicate key; each case races ROUNDS times, so the duplicate key is
    // reached in practice (the retry-off control shows it is).
    var ROUNDS = 30;

    async function race (name, method, url, makeBody) {
      for (var round = 0; round < ROUNDS; round++) {
        var id = 'race-v1-' + name + '-' + round + '-' + Date.now();
        var body = makeBody(id, round);
        var g = gate(self.env[name + '_collection'], method, 2);
        opened.push(g);
        var replies = await Promise.all([
          request(self.app).post(url).set('api-secret', known).send(body)
          , request(self.app).post(url).set('api-secret', known).send(body)
        ]);
        g.restore();
        g.arrived.should.equal(2, 'both uploads reached the write before either was stored');
        replies.map(function (r) { return r.status; }).should.eql([200, 200], 'round ' + round);
        var docs = await col(name).find({ identifier: id }).toArray();
        docs.length.should.equal(1, 'round ' + round);
        replies.forEach(function (r) { String(r.body[0]._id).should.equal(String(docs[0]._id)); });
      }
    }

    it('the index is in place on the collections raced here', async function () {
      self.ctx.identifierIndex.mode.should.equal('try');
      for (var name of ['treatments', 'entries', 'devicestatus']) {
        should.exist(await identifierIndex.existingIndex(col(name)), name);
      }
    });

    it('treatments: both answered 200 with the one stored _id, one record', async function () {
      await race('treatments', 'bulkWrite', '/api/treatments/', function (id, round) {
        return [{ identifier: id, eventType: 'Carb Correction', carbs: 12, created_at: iso(T + round * 60000), raceTest: true }];
      });
    });

    it('entries: both answered 200 with the one stored _id, one record', async function () {
      await race('entries', 'bulkWrite', '/api/entries/', function (id, round) {
        return [{ identifier: id, type: 'sgv', sgv: 101, date: T + round * 60000, dateString: iso(T + round * 60000), raceTest: true }];
      });
    });

    it('device status: both answered 200 with the one stored _id, one record', async function () {
      await race('devicestatus', 'insertMany', '/api/devicestatus/', function (id, round) {
        return [{ identifier: id, device: 'race-test', created_at: iso(T + round * 60000), uploaderBattery: 70, raceTest: true }];
      });
    });
  });

  describe('API v3', function () {
    var self = this;
    var instance = require('./fixtures/api3/instance');
    var authSubject = require('./fixtures/api3/authSubject');
    var utils = require('./fixtures/api3/utils');
    var opened = [];
    var defaultWrite;

    function col (name) {
      return self.instance.ctx.store.collection(self.instance.env[name + '_collection']);
    }

    function post (name, doc, jwt) {
      return self.instance.post('/api/v3/' + name, jwt || self.jwt.all).send(doc);
    }

    before(async function () {
      self.instance = await instance.create({});
      defaultWrite = self.instance.env.write;
      var auth = await authSubject(self.instance.ctx.authorization.storage, ['create', 'all'], self.instance.app);
      self.jwt = auth.jwt;
    });

    afterEach(function () {
      opened.splice(0).forEach(function (g) { g.restore(); });
      self.instance.env.write = defaultWrite;
    });

    after(async function () {
      await utils.storageClear(self.instance.ctx);
      self.instance.ctx.bus.teardown();
    });

    function treatment (id, extra) {
      return Object.assign({ identifier: id, date: T, utcOffset: 0, app: 'race-test', device: 'race-test'
        , eventType: 'Carb Correction', carbs: 12 }, extra || {});
    }

    // The upload that loses the race is answered as a deduplicated POST is:
    // 200, isDeduplication, the identifier (the step returns the match's
    // outcome and create/insert.js maps it).
    function winnerAndLoser (replies) {
      replies.map(function (r) { return r.status; }).sort().should.eql([200, 201]);
      var loser = replies.find(function (r) { return r.status === 200; });
      var winner = replies.find(function (r) { return r.status === 201; });
      loser.body.isDeduplication.should.equal(true);
      return { winner: winner, loser: loser };
    }

    it('treatments: one 201, and the loser 200 isDeduplication as a re-send; one record', async function () {
      var id = 'race-v3-treatment-0001';
      var g = gate(self.instance.env.treatments_collection, 'insertOne', 2);
      opened.push(g);
      var replies = await Promise.all([post('treatments', treatment(id)), post('treatments', treatment(id))]);
      g.arrived.should.equal(2);
      var r = winnerAndLoser(replies);
      r.winner.body.identifier.should.equal(id);
      r.loser.body.identifier.should.equal(id);
      r.loser.headers.location.should.endWith('/treatments/' + id);
      var docs = await col('treatments').find({ identifier: id }).toArray();
      docs.length.should.equal(1);
      r.loser.body.lastModified.should.equal(docs[0].srvModified);
    });

    // Slice 4 (merge on match): the loser is applied as a serial re-send is,
    // merged into the stored record (a device status too, ID-Q2), and for
    // treatments replaced. The first upload is stored first and the second,
    // which has matched nothing, is released after it (deterministic).
    async function inOrder (name, firstDoc, secondDoc) {
      var g = gate(self.instance.env[name + '_collection'], 'insertOne', 2, 3000, true);
      opened.push(g);
      var announced = [];
      function onUpdate (event) { if (event.colName === name) announced.push(event.doc); }
      self.instance.ctx.bus.on('storage-socket-update', onUpdate);
      // A supertest request is sent when it is awaited or then-ed.
      var first = post(name, firstDoc).then(function (r) { return r; });
      while (g.arrived < 1) await new Promise(function (resolve) { setTimeout(resolve, 5); });
      var second = post(name, secondDoc).then(function (r) { return r; });
      var replies = await Promise.all([first, second]);
      self.instance.ctx.bus.removeListener('storage-socket-update', onUpdate);
      g.arrived.should.equal(2);
      replies[0].status.should.equal(201);
      replies[1].status.should.equal(200);
      replies[1].body.isDeduplication.should.equal(true);
      var docs = await col(name).find({ identifier: firstDoc.identifier }).toArray();
      docs.length.should.equal(1);
      replies[1].body.lastModified.should.equal(docs[0].srvModified);
      docs[0].srvModified.should.be.above(replies[0].body.lastModified);
      announced.length.should.equal(1);
      return { replies: replies, stored: docs[0], announced: announced[0] };
    }

    async function modeRace (name, mode, firstDoc, secondDoc) {
      self.instance.env.write = Object.freeze(Object.assign({ }, defaultWrite, { resend: mode }));
      var g = gate(self.instance.env[name + '_collection'], 'insertOne', 2, 3000, true);
      opened.push(g);
      var first = post(name, firstDoc).then(function (r) { return r; });
      while (g.arrived < 1) await new Promise(function (resolve) { setTimeout(resolve, 5); });
      var second = post(name, secondDoc).then(function (r) { return r; });
      var replies = await Promise.all([first, second]);
      g.arrived.should.equal(2);
      var docs = await col(name).find({ identifier: firstDoc.identifier }).toArray();
      docs.length.should.equal(1);
      return { replies: replies, stored: docs[0] };
    }

    it('API v3 race honors WRITE_RESEND=acknowledge without writing', async function () {
      var id = 'race-v3-ack-' + Date.now();
      var r = await modeRace('treatments', 'acknowledge', treatment(id, { carbs: 12 }), treatment(id, { carbs: 30 }));
      r.replies[0].status.should.equal(201);
      r.replies[1].status.should.equal(200);
      r.replies[1].body.isDeduplication.should.equal(true);
      r.stored.carbs.should.equal(12);
    });

    it('API v3 race honors WRITE_RESEND=refuse with the normal 409 response', async function () {
      var id = 'race-v3-refuse-' + Date.now();
      var r = await modeRace('treatments', 'refuse', treatment(id, { carbs: 12 }), treatment(id, { carbs: 30 }));
      r.replies[0].status.should.equal(201);
      r.replies[1].status.should.equal(409, JSON.stringify(r.replies[1].body));
      r.stored.carbs.should.equal(12);
    });

    it('API v3 merge-except-treatments merges device status but still replaces treatments', async function () {
      var statusId = 'race-v3-merge-status-' + Date.now();
      var status = { identifier: statusId, date: T, utcOffset: 0, app: 'race-test', device: 'race-test'
        , uploaderBattery: 50, pump: { reservoir: 10 } };
      var s = await modeRace('devicestatus', 'merge-except-treatments', status, Object.assign({ }, status, { uploaderBattery: 60 }));
      s.replies[0].status.should.equal(201);
      s.replies[1].status.should.equal(200, JSON.stringify(s.replies[1].body));
      s.replies[1].body.lastModified.should.be.above(s.replies[0].body.lastModified);
      s.stored.uploaderBattery.should.equal(60);
      s.stored.pump.reservoir.should.equal(10);

      var treatmentId = 'race-v3-merge-treatment-' + Date.now();
      var base = { identifier: treatmentId, date: T + 60000, utcOffset: 0, app: 'race-test', device: 'race-test'
        , eventType: 'Temporary Override' };
      var t = await modeRace('treatments', 'merge-except-treatments'
        , Object.assign({ durationType: 'indefinite', reason: 'race' }, base)
        , Object.assign({ duration: 30, reason: 'race' }, base));
      t.replies[0].status.should.equal(201);
      t.replies[1].status.should.equal(200);
      t.stored.duration.should.equal(30);
      should.not.exist(t.stored.durationType);
    });

    // CHANGED EXPECTATION (compat card B, maintainer 2026-10-31): an API v3
    // re-send replaces on every collection, as on 15.0.9, and the loser of a
    // race is applied as that re-send, so a field it leaves out is gone. Was:
    // merged (ID-Q2), keeping it.
    it('device status: the loser replaces the stored status, as a serial re-send does (card B); one record', async function () {
      var id = 'race-v3-status-0001';
      var base = { identifier: id, date: T, utcOffset: 0, app: 'race-test', device: 'race-test' };
      var r = await inOrder('devicestatus', Object.assign({ uploaderBattery: 50, pump: { reservoir: 10 } }, base)
        , Object.assign({ uploaderBattery: 40 }, base));
      r.replies[1].body.identifier.should.equal(id);
      r.stored.uploaderBattery.should.equal(40);
      r.stored.should.not.have.property('pump');
      r.announced.should.not.have.property('pump');
    });

    // CHANGED EXPECTATION (compat card B): replaced, as above. Was: merged
    // (merge on match), keeping noise.
    it('entries: the loser replaces the stored entry (card B); a field it leaves out is gone', async function () {
      var id = 'race-v3-entry-0001';
      var base = { identifier: id, date: T, utcOffset: 0, app: 'race-test', device: 'race-test', type: 'sgv' };
      var r = await inOrder('entries', Object.assign({ sgv: 101, noise: 1 }, base), Object.assign({ sgv: 102 }, base));
      r.stored.sgv.should.equal(102);
      r.stored.should.not.have.property('noise');
    });

    it('treatments: the loser replaces the stored treatment, as a serial re-send does (slice 4 keeps the replace);'
      + ' an override ended by a re-send without durationType is no longer indefinite', async function () {
      var id = 'race-v3-treatment-0005';
      var base = { identifier: id, date: T, utcOffset: 0, app: 'race-test', device: 'race-test', eventType: 'Temporary Override' };
      var r = await inOrder('treatments', Object.assign({ durationType: 'indefinite', reason: 'race' }, base)
        , Object.assign({ duration: 30, reason: 'race' }, base));
      should.not.exist(r.stored.durationType);
      r.stored.duration.should.equal(30);
    });

    it('a racing upload without the update permission is not applied as a re-send: it gets a 500, the record stays', async function () {
      var id = 'race-v3-treatment-0002';
      // The upload with every permission reaches the insert first and is
      // stored first; the create-only upload has matched nothing before that.
      var g = gate(self.instance.env.treatments_collection, 'insertOne', 2, 3000, true);
      opened.push(g);
      var first = post('treatments', treatment(id)).then(function (r) { return r; });
      while (g.arrived < 1) await new Promise(function (resolve) { setTimeout(resolve, 5); });
      var second = post('treatments', treatment(id, { carbs: 13 }), self.jwt.create).then(function (r) { return r; });
      var replies = await Promise.all([first, second]);
      g.arrived.should.equal(2);
      replies[0].status.should.equal(201);
      replies[1].status.should.equal(500);
      var docs = await col('treatments').find({ identifier: id }).toArray();
      docs.length.should.equal(1);
      docs[0].carbs.should.equal(12);
    });

    it('a record deleted after the other upload stored it stays deleted: the loser is acknowledged (on-deleted)', async function () {
      var id = 'race-v3-treatment-0004';
      var raw = col('treatments');
      var g = gate(self.instance.env.treatments_collection, 'insertOne', 2, 3000, true, function softDelete () {
        return raw.updateOne({ identifier: id }, { $set: { isValid: false } });
      });
      opened.push(g);
      // A supertest request is sent when it is awaited or then-ed.
      var first = post('treatments', treatment(id)).then(function (r) { return r; });
      while (g.arrived < 1) await new Promise(function (resolve) { setTimeout(resolve, 5); });
      var second = post('treatments', treatment(id, { carbs: 30 })).then(function (r) { return r; });
      var replies = await Promise.all([first, second]);
      g.arrived.should.equal(2);
      replies[0].status.should.equal(201);
      replies[1].status.should.equal(200);
      replies[1].body.isDeduplication.should.equal(true);
      var docs = await raw.find({ identifier: id }).toArray();
      docs.length.should.equal(1);
      docs[0].isValid.should.equal(false);
      docs[0].carbs.should.equal(12);
    });

    it('a treatment matched by its computed identifier and deleted after the other upload stored it is revived'
      + ' by the loser, as a serial re-send is (V3_COMPUTED_IDENTIFIER: treatments revive)', async function () {
      // No identifier is sent: API v3 computes one from device, date and
      // eventType, so both uploads carry the same computed identifier.
      var marker = 'race-v3-computed-' + Date.now();
      var raw = col('treatments');
      var body = function (carbs) {
        return { date: T + 3 * 60000, utcOffset: 0, app: 'race-test', device: marker, eventType: 'Carb Correction', carbs: carbs };
      };
      var g = gate(self.instance.env.treatments_collection, 'insertOne', 2, 3000, true, function softDelete () {
        return raw.updateOne({ device: marker }, { $set: { isValid: false } });
      });
      opened.push(g);
      // A supertest request is sent when it is awaited or then-ed.
      var first = post('treatments', body(12)).then(function (r) { return r; });
      while (g.arrived < 1) await new Promise(function (resolve) { setTimeout(resolve, 5); });
      var second = post('treatments', body(30)).then(function (r) { return r; });
      var replies = await Promise.all([first, second]);
      g.arrived.should.equal(2);
      replies[0].status.should.equal(201);
      replies[1].status.should.equal(200);
      replies[1].body.isDeduplication.should.equal(true);
      replies[1].body.identifier.should.equal(replies[0].body.identifier);
      var docs = await raw.find({ device: marker }).toArray();
      docs.length.should.equal(1);
      docs[0].identifier.should.equal(replies[0].body.identifier);
      should(docs[0].isValid).not.equal(false);
      docs[0].carbs.should.equal(30);
    });

    it('two different records racing on one identifier (another date): one 201, one 500, the first kept', async function () {
      var id = 'race-v3-treatment-0003';
      var g = gate(self.instance.env.treatments_collection, 'insertOne', 2);
      opened.push(g);
      var replies = await Promise.all([post('treatments', treatment(id)), post('treatments', treatment(id, { date: T + 60000 }))]);
      g.arrived.should.equal(2);
      replies.map(function (r) { return r.status; }).sort().should.eql([201, 500]);
      (await col('treatments').find({ identifier: id }).toArray()).length.should.equal(1);
    });
  });
});
