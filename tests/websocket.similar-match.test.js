'use strict';

// The socket dbAdd "similar" match: client identity and a missing amount
// (BF-209, BF-210).
//
// A treatment sent over dbAdd without an exact match is compared with the
// records stored within 2 s of it, by eventType and by its amounts, and a hit
// only moves the stored record's created_at. Two rules are added:
// - client identity, as the exact match has it (treatment-fallback-key): a
//   write carrying a client identity matches only a record with the same one,
//   and a write carrying none matches only a record with none. A write that
//   carries an `identifier` matches only a record with the same identifier
//   (BF-209);
// - insulin and carbs: a write that does not carry one, or carries it as '',
//   false or null, is treated as a zero (BF-09), so it matches a record with
//   none (0 or absent), never one with an amount (BF-210).
// The window, the exact match and the zero rules for percent, absolute and
// duration are not changed here.
//
// Synthetic values only; every record is dated in April 2019.

var should = require('should');
var language = require('../lib/language')();

describe('Socket similar match keeps client identity and amounts (BF-209, BF-210)', function () {
  this.timeout(15000);
  var self = this;
  var http = require('http');
  var io = require('socket.io-client');
  var hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var FROM = '2019-04-01T00:00:00.000Z';
  var TO = '2019-05-01T00:00:00.000Z';
  var T = '2019-04-10T07:40:00.000Z';
  var T1 = '2019-04-10T07:40:01.000Z';

  function col () {
    return self.ctx.store.collection(self.env.treatments_collection);
  }

  function stored () {
    return col().find({ created_at: { $gte: FROM, $lt: TO } }).sort({ created_at: 1 }).toArray();
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

  function treatment (at, fields) {
    return Object.assign({ eventType: 'Meal Bolus', created_at: at, enteredBy: 'ws-similar-match' }, fields);
  }

  async function sendAll (docs) {
    for (const doc of docs) await dbAdd(doc);
    return stored();
  }

  function kept (docs) {
    docs.length.should.equal(2, 'the second write should be stored as a second record, not taken for the first');
    docs[0].created_at.should.equal(T, 'the first record should keep its created_at');
  }

  function merged (docs) {
    docs.length.should.equal(1, 'the second write should be recognised as the first record');
    docs[0].created_at.should.equal(T1, 'the similar match should move created_at to the re-sent time');
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
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

  describe('client identity (BF-209)', function () {

    ['syncIdentifier', 'id', 'uuid'].forEach(function (field) {
      it('keeps an entry with another ' + field + ' sent 1 s after one with the same type and carbs', async function () {
        var a = {}; a[field] = 'bf209-a';
        var b = {}; b[field] = 'bf209-b';
        kept(await sendAll([treatment(T, Object.assign({ carbs: 20 }, a)), treatment(T1, Object.assign({ carbs: 20 }, b))]));
      });

      it('keeps an entry with no client identity sent 1 s after one with a ' + field, async function () {
        var a = {}; a[field] = 'bf209-a';
        kept(await sendAll([treatment(T, Object.assign({ carbs: 20 }, a)), treatment(T1, { carbs: 20 })]));
      });

      it('keeps an entry with a ' + field + ' sent 1 s after one with no client identity', async function () {
        var b = {}; b[field] = 'bf209-b';
        kept(await sendAll([treatment(T, { carbs: 20 }), treatment(T1, Object.assign({ carbs: 20 }, b))]));
      });
    });

    it('keeps an entry with no client identity sent 1 s after an API v3 record (it has an identifier)', async function () {
      await col().insertOne(treatment(T, { carbs: 20, identifier: 'bf209-v3' }));
      kept(await sendAll([treatment(T1, { carbs: 20 })]));
    });

    describe('a write that carries an identifier', function () {

      it('keeps an entry with another identifier sent 1 s after one with the same type and carbs', async function () {
        kept(await sendAll([treatment(T, { carbs: 20, identifier: 'bf209-a' }), treatment(T1, { carbs: 20, identifier: 'bf209-b' })]));
      });

      it('recognises a re-send with the same identifier 1 s later (control)', async function () {
        merged(await sendAll([treatment(T, { carbs: 20, identifier: 'bf209-a' }), treatment(T1, { carbs: 20, identifier: 'bf209-a' })]));
      });

      it('recognises a re-send with the same identifier at the same time (control)', async function () {
        var docs = await sendAll([treatment(T, { carbs: 20, identifier: 'bf209-a' }), treatment(T, { carbs: 20, identifier: 'bf209-a' })]);
        docs.length.should.equal(1, 'the second write should be recognised as the first record');
      });

      it('answers a re-send carrying the stored _id and identifier with the stored record (control)', async function () {
        var result = await col().insertOne(treatment(T, { carbs: 20, identifier: 'bf209-a' }));
        var reply = await dbAdd(treatment(T, { carbs: 20, identifier: 'bf209-a', _id: String(result.insertedId) }));
        reply.length.should.equal(1, 'the reply should hold the stored record');
        String(reply[0]._id).should.equal(String(result.insertedId));
        (await stored()).length.should.equal(1, 'the re-send should not be stored again');
      });
    });

    describe('controls (unchanged)', function () {

      ['syncIdentifier', 'id', 'uuid'].forEach(function (field) {
        it('recognises a re-send with the same ' + field + ' 1 s later', async function () {
          var a = {}; a[field] = 'bf209-a';
          merged(await sendAll([treatment(T, Object.assign({ carbs: 20 }, a)), treatment(T1, Object.assign({ carbs: 20 }, a))]));
        });
      });

      it('recognises a re-send with the same NSCLIENT_ID 1 s later (the exact match)', async function () {
        var docs = await sendAll([treatment(T, { carbs: 20, NSCLIENT_ID: 'bf209-a' }), treatment(T1, { carbs: 20, NSCLIENT_ID: 'bf209-a' })]);
        docs.length.should.equal(1, 'the second write should be recognised as the first record');
        docs[0].created_at.should.equal(T, 'the exact match should leave the stored record as it is');
      });

      it('recognises a re-send with no client identity 1 s later', async function () {
        merged(await sendAll([treatment(T, { carbs: 20 }), treatment(T1, { carbs: 20 })]));
      });

      it('keeps an entry with another NSCLIENT_ID sent 1 s after one with the same type and carbs', async function () {
        kept(await sendAll([treatment(T, { carbs: 20, NSCLIENT_ID: 'bf209-a' }), treatment(T1, { carbs: 20, NSCLIENT_ID: 'bf209-b' })]));
      });
    });
  });

  describe('a missing amount (BF-210)', function () {

    it('keeps a Correction Bolus without insulin sent 1 s after a 1 U bolus', async function () {
      kept(await sendAll([
        treatment(T, { eventType: 'Correction Bolus', insulin: 1 })
        , treatment(T1, { eventType: 'Correction Bolus' })
      ]));
    });

    it('keeps a Carb Correction without carbs sent 1 s after a 20 g entry', async function () {
      kept(await sendAll([
        treatment(T, { eventType: 'Carb Correction', carbs: 20 })
        , treatment(T1, { eventType: 'Carb Correction' })
      ]));
    });

    it('keeps a Meal Bolus with carbs and no insulin sent 1 s after one with the same carbs and 2 U', async function () {
      kept(await sendAll([treatment(T, { carbs: 20, insulin: 2 }), treatment(T1, { carbs: 20 })]));
    });

    ['', false, null].forEach(function (value) {
      it('keeps a Correction Bolus with insulin ' + JSON.stringify(value) + ' sent 1 s after a 1 U bolus', async function () {
        kept(await sendAll([
          treatment(T, { eventType: 'Correction Bolus', insulin: 1 })
          , treatment(T1, { eventType: 'Correction Bolus', insulin: value })
        ]));
      });

      it('keeps a Carb Correction with carbs ' + JSON.stringify(value) + ' sent 1 s after a 20 g entry', async function () {
        kept(await sendAll([
          treatment(T, { eventType: 'Carb Correction', carbs: 20 })
          , treatment(T1, { eventType: 'Carb Correction', carbs: value })
        ]));
      });

      it('recognises a Correction Bolus with insulin ' + JSON.stringify(value) + ' as a stored zero bolus (control)', async function () {
        merged(await sendAll([
          treatment(T, { eventType: 'Correction Bolus', insulin: 0 })
          , treatment(T1, { eventType: 'Correction Bolus', insulin: value })
        ]));
      });
    });

    describe('controls (unchanged)', function () {

      it('recognises a Correction Bolus without insulin re-sent 1 s later', async function () {
        merged(await sendAll([treatment(T, { eventType: 'Correction Bolus' }), treatment(T1, { eventType: 'Correction Bolus' })]));
      });

      it('recognises a Correction Bolus without insulin as a stored zero bolus', async function () {
        merged(await sendAll([treatment(T, { eventType: 'Correction Bolus', insulin: 0 }), treatment(T1, { eventType: 'Correction Bolus' })]));
      });

      it('recognises a Meal Bolus with carbs only as the same entry stored with carbs only', async function () {
        merged(await sendAll([treatment(T, { carbs: 20 }), treatment(T1, { carbs: 20 })]));
      });

      it('keeps a 1 U bolus sent 1 s after a Correction Bolus without insulin', async function () {
        kept(await sendAll([treatment(T, { eventType: 'Correction Bolus' }), treatment(T1, { eventType: 'Correction Bolus', insulin: 1 })]));
      });
    });
  });
});
