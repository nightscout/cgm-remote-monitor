'use strict';

// identifier-format on the wire (ID-FIRST-MATCH slice 2; ID-Q6,
// ID-PLACEHOLDER-LIST, BF-215, BF-216): API v1, the socket and API v3.
//
// An `identifier` that is a placeholder (undefined, null, invalid, NaN,
// unknown, in any case), empty or whitespace-only, over 256 characters, JSON
// null or not a string is treated as absent: not matched on, not stored, and
// logged. So two apps that both send a placeholder store two records instead
// of one landing in the other's (BF-216), and a numeric identifier on API v1
// treatments is stored without it instead of answering 500 (BF-215).
// WRITE_IDENTIFIER=strict refuses such a document on the socket and API v3,
// and on API v1 with ID-BATCH's per-item replies (ID-STRICT-V1, maintainer
// 2026-10-30): the item is refused in its slot, the rest of the batch stored.
// In-process callers still treat the value as absent under strict.
//
// Synthetic values only; every record is dated in May 2019.

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
var TAG = 'identifier-format-test';
var T_MS = Date.parse('2019-05-12T07:40:00.000Z');

function at (minutes) {
  return new Date(T_MS + minutes * 60000).toISOString();
}

function quiet (work) {
  var warn = console.warn;
  console.warn = function () { };
  return Promise.resolve().then(work).finally(function () { console.warn = warn; });
}

describe('identifier-format: API v1 and the socket', function () {
  this.timeout(15000);
  var self = this;
  var http = require('http');
  var io = require('socket.io-client');

  function col (name) {
    return self.ctx.store.collection(self.env[name + '_collection']);
  }

  function stored (name) {
    return col(name).find({ enteredBy: TAG }).sort({ created_at: 1, _id: 1 }).toArray();
  }

  function dropAll () {
    return Promise.all(['treatments', 'devicestatus', 'entries'].map(function (name) {
      return col(name).deleteMany({ enteredBy: TAG });
    }));
  }

  function post (path, body) {
    return quiet(function () {
      return request(self.app).post('/api/' + path).set('api-secret', known).send(body);
    });
  }

  function emit (event, data) {
    return quiet(function () {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
        self.socket.emit(event, data, function (reply) {
          clearTimeout(timer);
          resolve(reply);
        });
      });
    });
  }

  function treatment (minutes, fields) {
    return Object.assign({ eventType: 'Meal Bolus', carbs: 10, created_at: at(minutes), enteredBy: TAG }, fields);
  }

  function setMode (identifier) {
    self.env.write = Object.freeze({ validation: self.env.write.validation, identifier: identifier });
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    delete process.env.WRITE_IDENTIFIER;
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.app = require('express')();
    self.app.enable('api');
    self.app.enable('careportal');
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
          self.socket.emit('authorize', { client: 'test', secret: known }, function (auth) {
            if (!auth || !auth.write || !auth.write_treatment) return done(new Error('not authorized to write'));
            dropAll().then(function () { done(); }, done);
          });
        });
        self.socket.on('connect_error', done);
      });
    });
  });

  beforeEach(function () {
    setMode('lenient');
    return dropAll();
  });

  after(function (done) {
    setMode('lenient');
    if (self.socket) self.socket.disconnect();
    dropAll().then(function () {
      if (self.server) return self.server.close(function () { done(); });
      done();
    }, done);
  });

  describe('API v1, lenient (the default)', function () {

    it('BF-215: a numeric identifier on a treatment is stored without it, not answered 500', async function () {
      var res = await post('treatments/', treatment(0, { identifier: 1557646800000 }));
      res.status.should.equal(200);
      var docs = await stored('treatments');
      docs.length.should.equal(1);
      docs[0].should.not.have.property('identifier');
      docs[0].carbs.should.equal(10);
    });

    it('BF-216: two apps sharing the placeholder "undefined", in different case, store two records', async function () {
      (await post('treatments/', treatment(0, { identifier: 'undefined', carbs: 10, device: 'app-a' }))).status.should.equal(200);
      (await post('treatments/', treatment(3, { identifier: 'Undefined', carbs: 25, device: 'app-b' }))).status.should.equal(200);
      var docs = await stored('treatments');
      docs.map(function (d) { return d.carbs; }).should.eql([10, 25]);
      docs.forEach(function (d) { d.should.not.have.property('identifier'); });
    });

    it('a stored record carrying a placeholder is never matched by it', async function () {
      await col('treatments').insertOne(treatment(0, { identifier: 'unknown', carbs: 10 }));
      (await post('treatments/', treatment(5, { identifier: 'UNKNOWN', carbs: 30 }))).status.should.equal(200);
      var docs = await stored('treatments');
      docs.length.should.equal(2);
      docs[0].identifier.should.equal('unknown');
      docs[0].carbs.should.equal(10);
      docs[1].should.not.have.property('identifier');
      docs[1].carbs.should.equal(30);
    });

    it('a valid identifier still matches (control)', async function () {
      var ID = 'f1d2c3b4-0000-4000-8000-00000000d001';
      await post('treatments/', treatment(0, { identifier: ID, carbs: 10 }));
      await post('treatments/', treatment(5, { identifier: ID, carbs: 30 }));
      var docs = await stored('treatments');
      docs.length.should.equal(1);
      docs[0].identifier.should.equal(ID);
    });

    it('device status: a re-sent placeholder identifier is not acknowledged as the stored status', async function () {
      var status = function (minutes) {
        return { created_at: at(minutes), device: 'app-a', enteredBy: TAG, identifier: 'invalid' };
      };
      await col('devicestatus').insertOne(status(0));
      (await post('devicestatus/', status(5))).status.should.equal(200);
      var docs = await stored('devicestatus');
      docs.length.should.equal(2);
      docs[1].should.not.have.property('identifier');
    });

    it('entries: an over-length identifier is not stored', async function () {
      var date = T_MS + 10 * 60000;
      (await post('entries/', { type: 'sgv', sgv: 110, date: date, dateString: new Date(date).toISOString()
        , enteredBy: TAG, identifier: 'x'.repeat(257) })).status.should.equal(200);
      var docs = await col('entries').find({ enteredBy: TAG }).toArray();
      docs.length.should.equal(1);
      docs[0].should.not.have.property('identifier');
    });

    it('strict on API v1 (ID-STRICT-V1): a lone treatment with a placeholder is refused 400, nothing stored', async function () {
      setMode('strict');
      var res = await post('treatments/', treatment(0, { identifier: 'null' }));
      res.status.should.equal(400);
      res.body.message.should.equal('identifier: identifier is a placeholder');
      (await stored('treatments')).length.should.equal(0);
    });

    it('strict on API v1: in a treatments batch only the invalid item is refused, in its slot, with a Warning', async function () {
      setMode('strict');
      var res = await post('treatments/', [treatment(0, { carbs: 11 }), treatment(1, { identifier: 'x'.repeat(257), carbs: 12 })
        , treatment(2, { carbs: 13 })]);
      res.status.should.equal(200);
      res.body.length.should.equal(3);
      should.exist(res.body[0]._id);
      res.body[1].should.not.have.property('_id');
      res.body[1].carbs.should.equal(12, 'the refused slot is the item as sent');
      res.body[1].refused.should.eql({ status: 400, message: 'identifier: identifier is longer than 256 characters'
        , rules: [{ rule: 'identifier-format', field: 'identifier' }] });
      should.exist(res.body[2]._id);
      res.headers.warning.should.equal('299 - "1 of 3 treatments refused; see the refused member of each"');
      (await stored('treatments')).map(function (d) { return d.carbs; }).should.eql([11, 13]);
    });

    it('strict on API v1: entries and device status refuse per item the same way', async function () {
      setMode('strict');
      var d0 = T_MS + 20 * 60000;
      var res = await post('entries/', [
        { type: 'sgv', sgv: 101, date: d0, dateString: new Date(d0).toISOString(), enteredBy: TAG, identifier: 'id-format-e0' }
        , { type: 'sgv', sgv: 102, date: d0 + 60000, dateString: new Date(d0 + 60000).toISOString(), enteredBy: TAG, identifier: 'Unknown' }
      ]);
      res.status.should.equal(200);
      should.exist(res.body[0]._id);
      res.body[1].refused.message.should.equal('identifier: identifier is a placeholder');
      res.headers.warning.should.equal('299 - "1 of 2 entries refused; see the refused member of each"');
      (await col('entries').countDocuments({ enteredBy: TAG })).should.equal(1);

      res = await post('devicestatus/', [{ created_at: at(0), device: 'app-a', enteredBy: TAG, identifier: 42 }
        , { created_at: at(1), device: 'app-a', enteredBy: TAG }]);
      res.status.should.equal(200);
      res.body[0].refused.message.should.equal('identifier: identifier is not a string');
      should.exist(res.body[1]._id);
      (await stored('devicestatus')).length.should.equal(1);
    });

    it('strict on API v1: the refused member is the socket\'s, word for word', async function () {
      setMode('strict');
      var v1 = (await post('treatments/', [treatment(0, { identifier: '   ' }), treatment(1)])).body[0].refused;
      var ws = (await emit('dbAdd', { collection: 'treatments', data: treatment(2, { identifier: '   ' }) }))[0].refused;
      v1.should.eql(ws);
    });

    it('lenient on API v1 keeps the reply: the invalid identifier is dropped, no slot refused, no Warning', async function () {
      var res = await post('treatments/', [treatment(0, { identifier: 'undefined' }), treatment(1)]);
      res.status.should.equal(200);
      res.body.forEach(function (slot) { should.exist(slot._id); should.not.exist(slot.refused); });
      should.not.exist(res.headers.warning);
      (await stored('treatments')).length.should.equal(2);
    });

    // WRITE_IDENTIFIER unset parses to whatever the settings module calls it
    // (`lenient` today; compat card A names it `default`, where only API v3
    // refuses whitespace and numeric identifiers). API v1 stays lenient either
    // way: nothing refused, the invalid identifier dropped.
    it('WRITE_IDENTIFIER unset on API v1: whitespace and numeric identifiers are dropped, not refused', async function () {
      setMode(require('../lib/server/write-settings').parseIdentifierMode(undefined).mode);
      var res = await post('treatments/', [treatment(0, { identifier: '   ', carbs: 11 }), treatment(1, { identifier: 42, carbs: 12 })
        , treatment(2, { identifier: 'undefined', carbs: 13 })]);
      res.status.should.equal(200);
      res.body.forEach(function (slot) { should.exist(slot._id); should.not.exist(slot.refused); });
      should.not.exist(res.headers.warning);
      var docs = await stored('treatments');
      docs.map(function (d) { return d.carbs; }).should.eql([11, 12, 13]);
      docs.forEach(function (d) { d.should.not.have.property('identifier'); });
      var entries = await post('entries/', [{ type: 'sgv', sgv: 120, date: Date.parse(at(0)), dateString: at(0), identifier: 7 }]);
      entries.status.should.equal(200);
      should.not.exist(entries.body[0].refused);
    });
  });

  describe('the socket', function () {

    it('lenient: dbAdd of a treatment with a placeholder stores it without the identifier', async function () {
      var reply = await emit('dbAdd', { collection: 'treatments', data: treatment(0, { identifier: 'NaN' }) });
      reply.length.should.equal(1);
      reply[0].should.not.have.property('identifier');
      var docs = await stored('treatments');
      docs.length.should.equal(1);
      docs[0].should.not.have.property('identifier');
    });

    it('lenient: two apps sharing a whitespace identifier store two records', async function () {
      await emit('dbAdd', { collection: 'treatments', data: treatment(0, { identifier: '   ', carbs: 10, device: 'app-a' }) });
      await emit('dbAdd', { collection: 'treatments', data: treatment(3, { identifier: '   ', carbs: 25, device: 'app-b' }) });
      (await stored('treatments')).map(function (d) { return d.carbs; }).should.eql([10, 25]);
    });

    it('strict: dbAdd of a treatment with a placeholder is refused in its slot and nothing is written', async function () {
      setMode('strict');
      var sent = treatment(0, { identifier: 'undefined' });
      var reply = await emit('dbAdd', { collection: 'treatments', data: sent });
      reply.length.should.equal(1);
      reply[0].should.not.have.property('_id');
      reply[0].refused.should.eql({ status: 400, message: 'identifier: identifier is a placeholder'
        , rules: [{ rule: 'identifier-format', field: 'identifier' }] });
      (await stored('treatments')).length.should.equal(0);
    });

    it('strict: in a batch, only the document with the invalid identifier is refused', async function () {
      setMode('strict');
      var reply = await emit('dbAdd', { collection: 'treatments', data: [
        treatment(0, { carbs: 11 }), treatment(1, { identifier: 'x'.repeat(257), carbs: 12 }), treatment(2, { carbs: 13 })
      ] });
      reply.length.should.equal(3);
      should.exist(reply[0]._id);
      reply[1].refused.message.should.equal('identifier: identifier is longer than 256 characters');
      should.exist(reply[2]._id);
      (await stored('treatments')).map(function (d) { return d.carbs; }).should.eql([11, 13]);
    });

    it('strict: another collection (device status) is refused the same way', async function () {
      setMode('strict');
      var reply = await emit('dbAdd', { collection: 'devicestatus'
        , data: { created_at: at(0), device: 'app-a', enteredBy: TAG, identifier: 42 } });
      reply.length.should.equal(1);
      reply[0].refused.message.should.equal('identifier: identifier is not a string');
      (await stored('devicestatus')).length.should.equal(0);
    });
  });
});

describe('identifier-format: API v3 create', function () {
  this.timeout(15000);
  var self = this;
  var instance = require('./fixtures/api3/instance');
  var authSubject = require('./fixtures/api3/authSubject');
  var utils = require('./fixtures/api3/utils');

  function doc (minutes, fields) {
    var created = at(minutes);
    return Object.assign({ eventType: 'Correction Bolus', insulin: 1, created_at: created, date: Date.parse(created)
      , utcOffset: 0, device: 'app-a', app: TAG, enteredBy: TAG }, fields);
  }

  function post (body) {
    return quiet(function () {
      return request(self.app).post('/api/v3/treatments').set('Authorization', 'Bearer ' + self.jwt).send(body);
    });
  }

  function stored () {
    return self.instance.ctx.store.collection(self.env.treatments_collection).find({ app: TAG }).sort({ date: 1 }).toArray();
  }

  function setMode (identifier) {
    self.env.write = Object.freeze({ validation: self.env.write.validation, identifier: identifier });
  }

  before(async function () {
    self.instance = await instance.create({});
    self.app = self.instance.app;
    self.env = self.instance.env;
    self.jwt = (await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app)).jwt.all;
  });

  beforeEach(function () {
    setMode('lenient');
    return self.instance.ctx.store.collection(self.env.treatments_collection).deleteMany({ app: TAG });
  });

  after(async function () {
    setMode('lenient');
    await self.instance.ctx.store.collection(self.env.treatments_collection).deleteMany({ app: TAG });
    await utils.storageClear(self.instance.ctx);
    self.instance.ctx.bus.teardown();
  });

  // CHANGED EXPECTATION against slice 1: "   " and a number were answered 400
  // "Bad or missing identifier field"; under lenient they are treated as
  // absent, so the server computes the identifier as for a document without one.
  [['whitespace', '   '], ['a number', 1557646800000], ['a placeholder', 'Unknown']].forEach(function ([label, value]) {
    it('lenient: ' + label + ' is treated as absent and an identifier is computed', async function () {
      var res = await post(doc(0, { identifier: value }));
      res.status.should.equal(201);
      var docs = await stored();
      docs.length.should.equal(1);
      docs[0].identifier.should.be.a.String();
      docs[0].identifier.should.not.equal(value);
      docs[0].identifier.length.should.be.above(10);
    });
  });

  it('BF-216: two apps sharing a placeholder store two records', async function () {
    (await post(doc(0, { identifier: 'undefined', device: 'app-a', insulin: 1 }))).status.should.equal(201);
    (await post(doc(3, { identifier: 'undefined', device: 'app-b', insulin: 2 }))).status.should.equal(201);
    var docs = await stored();
    docs.map(function (d) { return d.insulin; }).should.eql([1, 2]);
    docs[0].identifier.should.not.equal(docs[1].identifier);
  });

  ['   ', 'undefined', null, 7].forEach(function (value) {
    it('strict: ' + JSON.stringify(value) + ' is refused with 400 and nothing is stored', async function () {
      setMode('strict');
      var res = await post(doc(0, { identifier: value }));
      res.status.should.equal(400);
      res.body.message.should.equal('Bad or missing identifier field');
      (await stored()).length.should.equal(0);
    });
  });

  it('strict: a valid identifier is stored as sent (control)', async function () {
    setMode('strict');
    var res = await post(doc(0, { identifier: 'f1d2c3b4-0000-4000-8000-00000000d002' }));
    res.status.should.equal(201);
    (await stored())[0].identifier.should.equal('f1d2c3b4-0000-4000-8000-00000000d002');
  });
});
