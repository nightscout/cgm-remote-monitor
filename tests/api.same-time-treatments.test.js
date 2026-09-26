'use strict';

// Two treatments recorded at the same time are two records (BF-121, #8185).
//
// A write with no `identifier` and no `_id` is matched by created_at +
// eventType. That alone let a second carb entry at the same time replace the
// first (API v1) or be dropped (socket dbAdd). Now:
// - a client identity (syncIdentifier, id, uuid, NSCLIENT_ID) must be equal,
//   and a write without one matches only a record without one (v1 and socket);
// - an API v1 write without a client identity must also have equal carbs and
//   insulin;
// - the socket's "similar" match (within 2 s, same amounts) also requires the
//   same eventType.
// Re-sends of the same record still update it or are recognised, as before.
// API v3 is not changed here, and neither is the socket's exact match for a
// write without identity (see the last describe).
//
// Synthetic values only; every record is dated in February 2019.

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('Same-time treatments are kept apart (BF-121)', function () {
  this.timeout(15000);
  var self = this;
  var http = require('http');
  var io = require('socket.io-client');
  var hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var FROM = '2019-02-01T00:00:00.000Z';
  var TO = '2019-03-01T00:00:00.000Z';
  var T = '2019-02-10T07:40:00.000Z';
  var T1 = '2019-02-10T07:40:01.000Z';
  var T5 = '2019-02-10T07:40:05.000Z';

  function col () {
    return self.ctx.store.collection(self.env.treatments_collection);
  }

  function stored () {
    return col().find({ created_at: { $gte: FROM, $lt: TO } }).sort({ carbs: -1, insulin: -1 }).toArray();
  }

  function post (body) {
    return request(self.app).post('/api/treatments/').set('api-secret', hash).send(body).expect(200);
  }

  function put (body) {
    return request(self.app).put('/api/treatments/').set('api-secret', hash).send(body).expect(200);
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

  function loopCarb (carbs, syncIdentifier) {
    return { eventType: 'Carb Correction', created_at: T, carbs: carbs, absorptionTime: 180,
      enteredBy: 'loop://iPhone', syncIdentifier: syncIdentifier };
  }

  function careportal (carbs, extra) {
    return Object.assign({ eventType: 'Meal Bolus', created_at: T, carbs: carbs, enteredBy: 'careportal' }, extra || {});
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

  describe('API v1', function () {

    it('keeps two Loop carb entries at the same time with different syncIdentifiers (#8185)', async function () {
      await post(loopCarb(16, 'sync-a'));
      await post(loopCarb(4, 'sync-b'));
      var docs = await stored();
      docs.map(function (d) { return d.carbs; }).should.eql([16, 4]);
    });

    it('keeps both items of one array POST at the same time', async function () {
      await post([loopCarb(16, 'sync-a'), loopCarb(4, 'sync-b')]);
      var docs = await stored();
      docs.map(function (d) { return d.carbs; }).should.eql([16, 4]);
    });

    it('keeps two careportal entries at the same minute with different carbs', async function () {
      await post(careportal(20));
      await post(careportal(15));
      var docs = await stored();
      docs.map(function (d) { return d.carbs; }).should.eql([20, 15]);
    });

    it('keeps a bolus and an extended bolus sent in the same second without an id', async function () {
      await post({ eventType: 'Combo Bolus', created_at: T, insulin: 2, enteredBy: 'pump-sync' });
      await post({ eventType: 'Combo Bolus', created_at: T, insulin: 1, duration: 60, enteredBy: 'pump-sync' });
      var docs = await stored();
      docs.map(function (d) { return d.insulin; }).should.eql([2, 1]);
    });

    it('does not replace an API v3 record (it has an identifier) with a same-time write', async function () {
      await col().insertOne({ identifier: 'v3-record', eventType: 'Meal Bolus', created_at: T, date: Date.parse(T),
        carbs: 20, srvModified: 1549784400000, srvCreated: 1549784400000 });
      await post(careportal(20));
      var docs = await stored();
      docs.length.should.equal(2);
      var v3 = docs.filter(function (d) { return d.identifier === 'v3-record'; });
      v3.length.should.equal(1);
      v3[0].srvModified.should.equal(1549784400000);
    });

    it('does not let an entry without an identity replace a Loop entry, or the reverse', async function () {
      await post(careportal(20, { eventType: 'Carb Correction' }));
      await post(loopCarb(20, 'sync-a'));
      var docs = await stored();
      docs.length.should.equal(2);
    });

    // The re-sends every client depends on: unchanged.

    it('updates a Loop entry re-sent with the same syncIdentifier and a new amount', async function () {
      var first = { eventType: 'Temp Basal', created_at: T, insulin: 0.3, duration: 30, rate: 1, syncIdentifier: 'dose-1' };
      await post(first);
      await post(Object.assign({}, first, { insulin: 0.5 }));
      var docs = await stored();
      docs.length.should.equal(1);
      docs[0].insulin.should.equal(0.5);
    });

    it('updates a Trio pump event re-sent with the same id and a new amount', async function () {
      var first = { eventType: 'Correction Bolus', created_at: T, insulin: 1.2, id: 'trio-event-1', enteredBy: 'Trio' };
      await post(first);
      await post(Object.assign({}, first, { insulin: 1.5 }));
      var docs = await stored();
      docs.length.should.equal(1);
      docs[0].insulin.should.equal(1.5);
    });

    it('recognises identical re-sends (Loop batch, careportal double-submit)', async function () {
      var batch = [loopCarb(16, 'sync-a'), Object.assign(loopCarb(4, 'sync-b'), { created_at: T5 })];
      await post(batch);
      await post(JSON.parse(JSON.stringify(batch)));
      await post(careportal(30, { created_at: T1 }));
      await post(careportal(30, { created_at: T1 }));
      var docs = await stored();
      docs.map(function (d) { return d.carbs; }).should.eql([30, 16, 4]);
    });

    it('updates an entry without an id re-sent with the same amounts and other notes (oref0)', async function () {
      var first = { eventType: 'Correction Bolus', created_at: T, insulin: 0.4, enteredBy: 'openaps://medtronic', notes: 'a' };
      await post(first);
      await post(Object.assign({}, first, { notes: 'b' }));
      var docs = await stored();
      docs.length.should.equal(1);
      docs[0].notes.should.equal('b');
    });

    it('matches records stored before this change when they are re-sent', async function () {
      // As API v1 stored them: carbs a number, no identity for careportal.
      await col().insertMany([
        { eventType: 'Meal Bolus', created_at: T, carbs: 20, enteredBy: 'careportal', utcOffset: 0 }
        , { eventType: 'Carb Correction', created_at: T1, carbs: 16, syncIdentifier: 'sync-a', utcOffset: 0 }
      ]);
      await post(careportal('20'));
      await post(Object.assign(loopCarb(16, 'sync-a'), { created_at: T1 }));
      var docs = await stored();
      docs.length.should.equal(2);
    });

    it('updates by PUT a record matched by time and type when the amounts are equal', async function () {
      await post(careportal(20));
      await put(careportal(20, { notes: 'edited' }));
      var docs = await stored();
      docs.length.should.equal(1);
      docs[0].notes.should.equal('edited');
    });

    it('still stores two identical careportal entries at the same minute as one', async function () {
      // Nothing tells them apart: the same time, type and amounts is a re-send.
      await post(careportal(20));
      await post(careportal(20));
      var docs = await stored();
      docs.length.should.equal(1);
    });
  });

  describe('websocket dbAdd', function () {

    it('keeps a second entry with the same carbs and another eventType one second later', async function () {
      await dbAdd({ eventType: 'Carb Correction', created_at: T, carbs: 20 });
      await dbAdd({ eventType: 'Meal Bolus', created_at: T1, carbs: 20 });
      var docs = await stored();
      docs.map(function (d) { return d.eventType; }).sort().should.eql(['Carb Correction', 'Meal Bolus']);
    });

    it('keeps two same-time entries with different client ids', async function () {
      await dbAdd({ eventType: 'Carb Correction', created_at: T, carbs: 16, id: 'client-a' });
      await dbAdd({ eventType: 'Carb Correction', created_at: T, carbs: 4, id: 'client-b' });
      var docs = await stored();
      docs.map(function (d) { return d.carbs; }).should.eql([16, 4]);
    });

    it('does not answer a write without an identity with an API v3 record', async function () {
      await col().insertOne({ identifier: 'v3-record', eventType: 'Carb Correction', created_at: T, carbs: 20 });
      await dbAdd({ eventType: 'Carb Correction', created_at: T, carbs: 15 });
      var docs = await stored();
      docs.map(function (d) { return d.carbs; }).should.eql([20, 15]);
    });

    it('recognises a re-send with the same NSCLIENT_ID and a similar entry of the same type', async function () {
      await dbAdd({ eventType: 'Carb Correction', created_at: T, carbs: 20, NSCLIENT_ID: 'ns-1' });
      await dbAdd({ eventType: 'Carb Correction', created_at: T, carbs: 20, NSCLIENT_ID: 'ns-1' });
      await dbAdd({ eventType: 'Carb Correction', created_at: T1, carbs: 20 });
      var docs = await stored();
      docs.length.should.equal(1);
    });

    it('keeps the first of two same-time entries without an identity (amounts are not in the socket key)', async function () {
      // Known limit, unchanged: a socket re-send after a lost reply may carry
      // an edited amount, so the socket does not add amounts to its key.
      await dbAdd({ eventType: 'Carb Correction', created_at: T, carbs: 20 });
      await dbAdd({ eventType: 'Carb Correction', created_at: T, carbs: 15 });
      var docs = await stored();
      docs.map(function (d) { return d.carbs; }).should.eql([20]);
    });
  });

  // An empty identity field is no identity (BF-141). A client that sends
  // `identifier: ""` (or an empty syncIdentifier, id, uuid or NSCLIENT_ID)
  // has not told its records apart: its re-send is the same record, as a
  // re-send with the field null or absent is, whichever of the three forms
  // is stored. A real identity still has to match exactly.
  describe('an empty identity is no identity (BF-141)', function () {
    var EMPTY_FORMS = [
      { name: '""', set: function (o, f) { o[f] = ''; } }
      , { name: 'null', set: function (o, f) { o[f] = null; } }
      , { name: 'absent', set: function (o, f) { delete o[f]; } }
    ];

    function carb (field, form) {
      var o = careportal(20, { eventType: 'Carb Correction' });
      form.set(o, field);
      return o;
    }

    it('stores the same v1 treatment POSTed twice with identifier "" once', async function () {
      await post(careportal(20, { identifier: '' }));
      await post(careportal(20, { identifier: '' }));
      var docs = await stored();
      docs.length.should.equal(1, 'identifier "" re-sent: expected 1 record, got ' + docs.length);
    });

    ['identifier', 'syncIdentifier', 'id', 'uuid', 'NSCLIENT_ID'].forEach(function (field) {
      EMPTY_FORMS.forEach(function (storedForm) {
        EMPTY_FORMS.forEach(function (sentForm) {
          it('API v1: a re-send with ' + field + ' ' + sentForm.name + ' matches a record stored with it ' + storedForm.name, async function () {
            await post(carb(field, storedForm));
            await post(carb(field, sentForm));
            var docs = await stored();
            docs.length.should.equal(1, field + ' stored ' + storedForm.name + ', re-sent ' + sentForm.name + ': expected 1 record, got ' + docs.length);
          });
        });
      });

      it('API v1: a record stored with ' + field + ' "" before this change is matched by a re-send', async function () {
        var o = carb(field, EMPTY_FORMS[0]);
        o.utcOffset = 0;
        await col().insertOne(o);
        await post(carb(field, EMPTY_FORMS[0]));
        var docs = await stored();
        docs.length.should.equal(1);
      });
    });

    ['syncIdentifier', 'id', 'uuid', 'NSCLIENT_ID'].forEach(function (field) {
      it('API v1: a real ' + field + ' is not matched by a record with it "", or the reverse', async function () {
        var real = careportal(20, { eventType: 'Carb Correction' });
        real[field] = 'client-1';
        await post(carb(field, EMPTY_FORMS[0]));
        await post(real);
        await post(carb(field, EMPTY_FORMS[0]));
        var docs = await stored();
        docs.length.should.equal(2);
        docs.filter(function (d) { return d[field] === 'client-1'; }).length.should.equal(1);
      });
    });

    it('API v1: an entry with identifier "" does not replace an API v3 record', async function () {
      await col().insertOne({ identifier: 'v3-record', eventType: 'Meal Bolus', created_at: T, date: Date.parse(T),
        carbs: 20, srvModified: 1549784400000, srvCreated: 1549784400000 });
      await post(careportal(20, { identifier: '' }));
      var docs = await stored();
      docs.length.should.equal(2);
    });

    it('API v1: two same-time entries with identifier "" and different carbs are still two', async function () {
      await post(careportal(20, { identifier: '' }));
      await post(careportal(15, { identifier: '' }));
      var docs = await stored();
      docs.map(function (d) { return d.carbs; }).should.eql([20, 15]);
    });

    // The socket's exact match: another amount at the same time and type is
    // answered with the stored record when neither has an identity (the known
    // limit above), so it must be for an empty identity too. The amounts
    // differ so that the "similar" match cannot answer instead.
    ['identifier', 'syncIdentifier', 'id', 'uuid'].forEach(function (field) {
      EMPTY_FORMS.forEach(function (storedForm) {
        it('websocket dbAdd: an exact match with ' + field + ' "" finds a record stored with it ' + storedForm.name, async function () {
          var first = { eventType: 'Carb Correction', created_at: T, carbs: 20 };
          storedForm.set(first, field);
          await col().insertOne(first);
          var again = { eventType: 'Carb Correction', created_at: T, carbs: 15 };
          again[field] = '';
          await dbAdd(again);
          var docs = await stored();
          docs.map(function (d) { return d.carbs; }).should.eql([20], field + ' stored ' + storedForm.name + ', dbAdd ""');
        });
      });
    });

    it('websocket dbAdd: a real client id is not answered with a record whose id is ""', async function () {
      await col().insertOne({ eventType: 'Carb Correction', created_at: T, carbs: 20, id: '' });
      await dbAdd({ eventType: 'Carb Correction', created_at: T, carbs: 15, id: 'client-a' });
      var docs = await stored();
      docs.map(function (d) { return d.carbs; }).should.eql([20, 15]);
    });

    it('websocket dbAdd: a write with identifier "" is not answered with an API v3 record', async function () {
      await col().insertOne({ identifier: 'v3-record', eventType: 'Carb Correction', created_at: T, carbs: 20 });
      await dbAdd({ eventType: 'Carb Correction', created_at: T, carbs: 15, identifier: '' });
      var docs = await stored();
      docs.map(function (d) { return d.carbs; }).should.eql([20, 15]);
    });
  });
});
