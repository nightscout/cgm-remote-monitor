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
function gate (name, method, count, waitMs, inOrder) {
  var real = Collection.prototype[method];
  var held = [];
  var state = { arrived: 0 };
  var timer = null;
  function releaseAll () {
    if (timer) clearTimeout(timer);
    var all = held.splice(0);
    if (!inOrder) return all.forEach(function (go) { go(); });
    all.reduce(function (previous, go) {
      return previous.then(function () { return go(); });
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

    function col (name) {
      return self.instance.ctx.store.collection(self.instance.env[name + '_collection']);
    }

    function post (name, doc, jwt) {
      return self.instance.post('/api/v3/' + name, jwt || self.jwt.all).send(doc);
    }

    before(async function () {
      self.instance = await instance.create({});
      var auth = await authSubject(self.instance.ctx.authorization.storage, ['create', 'all'], self.instance.app);
      self.jwt = auth.jwt;
    });

    afterEach(function () {
      opened.splice(0).forEach(function (g) { g.restore(); });
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

    it('device status: one 201, and the loser 200 isDeduplication with the stored lastModified; written once', async function () {
      var id = 'race-v3-status-0001';
      var doc = { identifier: id, date: T, utcOffset: 0, app: 'race-test', device: 'race-test', uploaderBattery: 50 };
      var g = gate(self.instance.env.devicestatus_collection, 'insertOne', 2);
      opened.push(g);
      var replies = await Promise.all([post('devicestatus', Object.assign({}, doc)), post('devicestatus', Object.assign({}, doc))]);
      g.arrived.should.equal(2);
      var r = winnerAndLoser(replies);
      r.loser.body.identifier.should.equal(id);
      var docs = await col('devicestatus').find({ identifier: id }).toArray();
      docs.length.should.equal(1);
      r.loser.body.lastModified.should.equal(docs[0].srvModified);
      r.winner.body.lastModified.should.equal(docs[0].srvModified);
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
