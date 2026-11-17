'use strict';

// What a zero means in the socket dbAdd "similar" match (BF-09).
//
// A treatment sent over dbAdd without an exact match is compared with the
// records stored within 2 s of it, by eventType and by each amount it carries.
// A zero used to be left out of that comparison, so a zero temp basal, a 100 %
// temp, a cancel, a zero bolus or a zero carb entry was taken for the record
// before it and dropped. Now:
// - percent, absolute and duration: 0 is a value and must be equal;
// - insulin and carbs: 0 means none, and matches a record with none (0 or
//   absent) but not one with an amount, so a filler zero still matches.
//
// Synthetic values only; every record is dated in March 2019.

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('Socket dedup treats a zero by field (BF-09)', function () {
  this.timeout(15000);
  var self = this;
  var http = require('http');
  var io = require('socket.io-client');
  var hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var FROM = '2019-03-01T00:00:00.000Z';
  var TO = '2019-04-01T00:00:00.000Z';
  var T = '2019-03-10T07:40:00.000Z';
  var T1 = '2019-03-10T07:40:01.000Z';
  var T3 = '2019-03-10T07:40:03.000Z';

  function col () {
    return self.ctx.store.collection(self.env.treatments_collection);
  }

  function stored () {
    return col().find({ created_at: { $gte: FROM, $lt: TO } }).sort({ created_at: 1 }).toArray();
  }

  function post (body) {
    return request(self.app).post('/api/treatments/').set('api-secret', hash).send(body).expect(200);
  }

  function dbAdd (data) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no reply to dbAdd')); }, 5000);
      self.socket.emit('dbAdd', { collection: 'treatments', data: data }, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  // The AndroidAPS NSClient (v1) temp basal shape: duration in whole minutes,
  // durationInMilliseconds, and either absolute or percent (rate - 100).
  function temp (at, fields) {
    return Object.assign({ eventType: 'Temp Basal', created_at: at, enteredBy: 'openaps://AndroidAPS' }, fields);
  }

  function target (at, duration) {
    var doc = { eventType: 'Temporary Target', created_at: at, enteredBy: 'AndroidAPS', duration: duration };
    if (duration > 0) Object.assign(doc, { targetTop: 140, targetBottom: 140, units: 'mg/dl' });
    return doc;
  }

  // xDrip+ NSClientChat sends insulin and carbs on every record.
  function xdrip (at, eventType, insulin, carbs) {
    return { eventType: eventType, created_at: at, insulin: insulin, carbs: carbs };
  }

  async function sendAll (docs) {
    for (const doc of docs) await dbAdd(doc);
    return stored();
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
      var server = http.createServer(require('express')());
      require('../lib/server/websocket')(self.env, ctx, server);
      server.listen(0, function () {
        self.server = server;
        self.socket = io('http://localhost:' + server.address().port, { transports: ['websocket'], reconnection: false });
        self.socket.on('connect', function () {
          self.socket.emit('authorize', { client: 'test', secret: hash }, function (auth) {
            if (!auth || !auth.write_treatment) return done(new Error('not authorized to write treatments'));
            done();
          });
        });
        self.socket.on('connect_error', done);
      });
    });
  });

  beforeEach(function () {
    return col().deleteMany({ created_at: { $gte: FROM, $lt: TO } });
  });

  after(function (done) {
    if (self.socket) self.socket.disconnect();
    col().deleteMany({ created_at: { $gte: FROM, $lt: TO } }).then(function () {
      if (self.server) return self.server.close(function () { done(); });
      done();
    }, done);
  });

  describe('a zero is a value', function () {

    it('keeps a zero temp sent 1 s after a 1.2 U/h temp of the same duration', async function () {
      var docs = await sendAll([temp(T, { absolute: 1.2, duration: 30 }), temp(T1, { absolute: 0, duration: 30 })]);
      docs.map(function (d) { return d.absolute; }).should.eql([1.2, 0]);
    });

    it('keeps a cancel (duration 0) sent 1 s after a zero temp', async function () {
      var docs = await sendAll([temp(T, { absolute: 0, duration: 30 }), temp(T1, { duration: 0 })]);
      docs.map(function (d) { return d.duration; }).should.eql([30, 0]);
    });

    it('keeps a 100 % temp (percent 0) sent 1 s after a 150 % temp', async function () {
      var docs = await sendAll([temp(T, { percent: 50, duration: 30 }), temp(T1, { percent: 0, duration: 30 })]);
      docs.map(function (d) { return d.percent; }).should.eql([50, 0]);
    });

    it('keeps a 100 % temp (percent 0) sent 1 s after an absolute temp, which has no percent', async function () {
      var docs = await sendAll([temp(T, { absolute: 1.2, duration: 30 }), temp(T1, { percent: 0, duration: 30 })]);
      docs.length.should.equal(2);
      docs[1].percent.should.equal(0);
    });

    it('keeps a zero temp sent 1 s after a percent temp, which has no absolute', async function () {
      var docs = await sendAll([temp(T, { percent: 50, duration: 30 }), temp(T1, { absolute: 0, duration: 30 })]);
      docs.length.should.equal(2);
      docs[1].absolute.should.equal(0);
    });

    it('keeps a temporary target cancel (duration 0) sent 1 s after a target', async function () {
      var docs = await sendAll([target(T, 30), target(T1, 0)]);
      docs.map(function (d) { return d.duration; }).should.eql([30, 0]);
    });

    it('keeps a zero bolus sent 1 s after a 1 U bolus', async function () {
      var docs = await sendAll([
        { eventType: 'Correction Bolus', created_at: T, insulin: 1 }
        , { eventType: 'Correction Bolus', created_at: T1, insulin: 0 }
      ]);
      docs.map(function (d) { return d.insulin; }).should.eql([1, 0]);
    });

    it('keeps a zero carb entry sent 1 s after a 20 g entry', async function () {
      var docs = await sendAll([
        { eventType: 'Carb Correction', created_at: T, carbs: 20 }
        , { eventType: 'Carb Correction', created_at: T1, carbs: 0 }
      ]);
      docs.map(function (d) { return d.carbs; }).should.eql([20, 0]);
    });
  });

  describe('a re-send is still recognised', function () {

    it('merges a zero temp re-sent 1 s later', async function () {
      var docs = await sendAll([temp(T, { absolute: 0, duration: 30 }), temp(T1, { absolute: 0, duration: 30 })]);
      docs.length.should.equal(1);
      docs[0].created_at.should.equal(T1);
    });

    it('merges a zero bolus re-sent 1 s later', async function () {
      var docs = await sendAll([
        { eventType: 'Correction Bolus', created_at: T, insulin: 0 }
        , { eventType: 'Correction Bolus', created_at: T1, insulin: 0 }
      ]);
      docs.length.should.equal(1);
    });

    it('merges an xDrip+ carb entry (insulin 0) with the same entry stored by API v1 without insulin', async function () {
      await post(xdrip(T, 'Carb Correction', 0, 20));
      var before = await stored();
      should.not.exist(before[0].insulin);
      var docs = await sendAll([xdrip(T1, 'Carb Correction', 0, 20)]);
      docs.length.should.equal(1);
      docs[0].carbs.should.equal(20);
    });

    it('merges an xDrip+ bolus (carbs 0) with the same bolus sent without carbs', async function () {
      var docs = await sendAll([
        { eventType: 'Correction Bolus', created_at: T, insulin: 1 }
        , xdrip(T1, 'Correction Bolus', 1, 0)
      ]);
      docs.length.should.equal(1);
    });

    it('merges an xDrip+ note (insulin 0, carbs 0) re-sent 1 s later', async function () {
      var note = function (at) { return Object.assign(xdrip(at, 'Note', 0, 0), { notes: 'synthetic note' }); };
      var docs = await sendAll([note(T), note(T1)]);
      docs.length.should.equal(1);
    });

    it('does not merge a carb entry with insulin 0 into one with insulin', async function () {
      var docs = await sendAll([xdrip(T, 'Meal Bolus', 2, 20), xdrip(T1, 'Meal Bolus', 0, 20)]);
      docs.map(function (d) { return d.insulin; }).should.eql([2, 0]);
    });
  });

  describe('controls (unchanged)', function () {

    it('keeps two zero temps with different NSCLIENT_IDs', async function () {
      var docs = await sendAll([
        temp(T, { absolute: 0, duration: 30, NSCLIENT_ID: 'bf09-a' })
        , temp(T1, { absolute: 0, duration: 30, NSCLIENT_ID: 'bf09-b' })
      ]);
      docs.length.should.equal(2);
    });

    it('keeps a zero temp sent 3 s after a 1.2 U/h temp (outside the window)', async function () {
      var docs = await sendAll([temp(T, { absolute: 1.2, duration: 30 }), temp(T3, { absolute: 0, duration: 30 })]);
      docs.length.should.equal(2);
    });

    it('keeps a 1.2 U/h temp sent 1 s after a percent -100 zero temp', async function () {
      var docs = await sendAll([temp(T, { percent: -100, duration: 30 }), temp(T1, { absolute: 1.2, duration: 30 })]);
      docs.length.should.equal(2);
    });

    it('keeps a 1.2 U/h temp sent 1 s after a zero temp, and a zero temp of another duration', async function () {
      (await sendAll([temp(T, { absolute: 0, duration: 30 }), temp(T1, { absolute: 1.2, duration: 30 })])).length.should.equal(2);
      await col().deleteMany({ created_at: { $gte: FROM, $lt: TO } });
      (await sendAll([temp(T, { absolute: 0, duration: 30 }), temp(T1, { absolute: 0, duration: 60 })])).length.should.equal(2);
    });

    ['', false, null].forEach(function (value) {
      it('keeps a 1.2 U/h temp sent 1 s after one with absolute ' + JSON.stringify(value), async function () {
        var docs = await sendAll([temp(T, { absolute: value, duration: 30 }), temp(T1, { absolute: 1.2, duration: 30 })]);
        docs.length.should.equal(2);
      });
    });

    it('keeps a 1 U bolus sent 1 s after a zero bolus, and 20 g after 0 g', async function () {
      (await sendAll([
        { eventType: 'Correction Bolus', created_at: T, insulin: 0 }
        , { eventType: 'Correction Bolus', created_at: T1, insulin: 1 }
      ])).length.should.equal(2);
      await col().deleteMany({ created_at: { $gte: FROM, $lt: TO } });
      (await sendAll([
        { eventType: 'Carb Correction', created_at: T, carbs: 0 }
        , { eventType: 'Carb Correction', created_at: T1, carbs: 20 }
      ])).length.should.equal(2);
    });
  });
});
