'use strict';

// Write-contract Q1b (maintainer decision, 2026-10-26): a null sent on a
// write that merges into a stored record removes that field, as a JSON Merge
// Patch (RFC 7386) does, at any depth; an object merges into the stored
// object and an array replaces the stored one whole.
//
// It applies where a write merges into a record that is already stored:
//   - a v1 or in-process profile POST re-sent with a stored _id (#8845);
//   - a v1 or in-process entries POST re-sent for a stored reading (the same
//     sysTime and type), or for an earlier entry of the same batch;
//   - API v3 PATCH;
//   - the socket's dbUpdate, aligned with PATCH.
// It never applies to a create (an entries upsert that inserts included), a
// v1 PUT, a v3 PUT or a v3 POST that replaces a duplicate: those store a null
// as sent. dbUpdateUnset, the explicit clear the web chart uses, is unchanged.
// Treatments, food and activity replace on match on dev, so they have no
// merge for the rule to apply to; a v1 treatments re-send is a control here.
//
// Synthetic values only.

var should = require('should');
var request = require('supertest');
var io = require('socket.io-client');
var ObjectID = require('mongodb').ObjectId;

describe('Q1b: a null on a merge removes the field (RFC 7386)', function () {
  this.timeout(20000);
  var self = this;
  var instance = require('./fixtures/api3/instance');
  var authSubject = require('./fixtures/api3/authSubject');
  var utils = require('./fixtures/api3/utils');
  var opTools = require('../lib/api3/shared/operationTools');
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var DEVICE = 'q1b-null-removes-test';
  var n = 0;
  var base = Date.UTC(2021, 2, 5, 0, 0, 0);

  function nextHex () {
    n += 1;
    return '5f1c0000000000000000' + ('000' + n.toString(16)).slice(-4);
  }

  function nextDate () {
    n += 1;
    return base + n * 60000;
  }

  function col (name) {
    return self.ctx.store.collection(self.env[name + '_collection']);
  }

  function v1 () {
    return request(self.instance.app);
  }

  function emit (event, data) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  before(async function () {
    self.instance = await instance.create({ useHttps: false });
    self.ctx = self.instance.ctx;
    self.env = self.instance.env;
    self.instance.app.use('/api', require('../lib/api/')(self.env, self.ctx));
    var auth = await authSubject(self.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = auth.jwt;
    self.socket = io(self.instance.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true });
    await new Promise(function (resolve, reject) {
      self.socket.on('connect', function () {
        self.socket.emit('authorize', { client: 'test', secret: known }, function (granted) {
          if (!granted || !granted.write) return reject(new Error('socket not authorized to write'));
          resolve();
        });
      });
      self.socket.on('connect_error', reject);
    });
  });

  after(async function () {
    if (self.socket) self.socket.disconnect();
    await utils.storageClear(self.ctx);
    self.ctx.bus.teardown();
    await new Promise(function (resolve) { self.instance.server.close(function () { resolve(); }); });
  });

  describe('profile POST re-sent with its _id', function () {

    function profile (extra) {
      return Object.assign({
        defaultProfile: 'Default'
        , store: {
          Default: {
            dia: 5
            , basal: [{ time: '00:00', value: 0.1, timeAsSeconds: 0 }, { time: '12:00', value: 0.2, timeAsSeconds: 43200 }]
            , units: 'mg/dl'
          }
          , Alt: { dia: 4, basal: [{ time: '00:00', value: 0.3, timeAsSeconds: 0 }], units: 'mg/dl' }
        }
        , startDate: '2021-03-05T00:00:00.000Z'
        , units: 'mg/dl'
        , enteredBy: DEVICE
      }, extra || {});
    }

    function post (body) {
      return v1().post('/api/profile/').set('api-secret', known).send(body);
    }

    async function stored (hex) {
      var docs = await col('profile').find({ _id: new ObjectID(hex) }).toArray();
      docs.length.should.equal(1);
      return docs[0];
    }

    it('removes a top-level field sent as null', async function () {
      var hex = nextHex();
      await post(profile({ _id: hex, kept: 'value' })).expect(200);
      await post(profile({ _id: hex, kept: null })).expect(200);
      var doc = await stored(hex);
      doc.should.not.have.property('kept');
      doc.store.should.have.properties(['Default', 'Alt']);
    });

    it('removes a nested member sent as null (store.Alt: null) and keeps its siblings', async function () {
      var hex = nextHex();
      await post(profile({ _id: hex })).expect(200);
      await post({ _id: hex, store: { Alt: null } }).expect(200);
      var doc = await stored(hex);
      doc.store.should.not.have.property('Alt');
      doc.store.Default.dia.should.equal(5);
      doc.defaultProfile.should.equal('Default');
    });

    it('merges a nested object and replaces an array whole', async function () {
      var hex = nextHex();
      await post(profile({ _id: hex })).expect(200);
      await post({ _id: hex, store: { Default: { dia: 6, basal: [{ time: '00:00', value: 0.5, timeAsSeconds: 0 }] } } }).expect(200);
      var doc = await stored(hex);
      doc.store.Default.dia.should.equal(6);
      doc.store.Default.units.should.equal('mg/dl');
      doc.store.Default.basal.should.eql([{ time: '00:00', value: 0.5, timeAsSeconds: 0 }]);
      doc.store.Alt.dia.should.equal(4);
    });

    it('an in-process re-send removes a null field too', async function () {
      var hex = nextHex();
      await post(profile({ _id: hex, kept: 'value' })).expect(200);
      await new Promise(function (resolve, reject) {
        self.ctx.profile.create([profile({ _id: hex, kept: null })], function (err) { if (err) reject(err); else resolve(); });
      });
      (await stored(hex)).should.not.have.property('kept');
    });

    it('a re-send whose null names a field the profile does not have writes nothing', async function () {
      var hex = nextHex();
      await post(profile({ _id: hex })).expect(200);
      var before = await stored(hex);
      await post(profile({ _id: hex, absent: null })).expect(200);
      var after = await stored(hex);
      after.srvModified.should.equal(before.srvModified);
      after.should.not.have.property('absent');
    });

    it('the second of two uploads of one new _id in a batch removes the null field', async function () {
      var hex = nextHex();
      await post([profile({ _id: hex, kept: 'first' }), profile({ _id: hex, kept: null })]).expect(200);
      (await stored(hex)).should.not.have.property('kept');
    });

    it('control: a create stores a null as sent', async function () {
      var hex = nextHex();
      await post(profile({ _id: hex, kept: null, store: { Default: { dia: 5, gone: null } } })).expect(200);
      var doc = await stored(hex);
      doc.should.have.property('kept', null);
      doc.store.Default.should.have.property('gone', null);
    });

    it('control: a PUT replaces the profile and stores a null as sent', async function () {
      var hex = nextHex();
      await post(profile({ _id: hex, kept: 'value', other: 'value' })).expect(200);
      await v1().put('/api/profile/').set('api-secret', known)
        .send(profile({ _id: hex, kept: null })).expect(200);
      var doc = await stored(hex);
      doc.should.have.property('kept', null);
      doc.should.not.have.property('other');
    });
  });

  describe('entries POST re-sent for a stored reading', function () {

    function entry (date, extra) {
      return Object.assign({ type: 'sgv', sgv: 120, date: date, dateString: new Date(date).toISOString(), direction: 'Flat', device: DEVICE }, extra || {});
    }

    function post (body) {
      return v1().post('/api/entries/').set('api-secret', known).send(body);
    }

    async function stored (date) {
      var docs = await col('entries').find({ sysTime: new Date(date).toISOString(), type: 'sgv' }).toArray();
      docs.length.should.equal(1);
      return docs[0];
    }

    it('removes a field sent as null', async function () {
      var date = nextDate();
      await post([entry(date, { noise: 1 })]).expect(200);
      await post([entry(date, { noise: 1, direction: null })]).expect(200);
      var doc = await stored(date);
      doc.should.not.have.property('direction');
      doc.noise.should.equal(1);
    });

    it('removes a nested member sent as null and keeps its siblings', async function () {
      var date = nextDate();
      await post([entry(date, { q1bN: { x: 1, y: 2 } })]).expect(200);
      await post([entry(date, { q1bN: { x: null } })]).expect(200);
      (await stored(date)).q1bN.should.eql({ y: 2 });
    });

    it('an in-process re-send removes a null field too', async function () {
      var date = nextDate();
      await post([entry(date)]).expect(200);
      await new Promise(function (resolve, reject) {
        self.ctx.entries.create([entry(date, { direction: null })], function (err) { if (err) reject(err); else resolve(); });
      });
      (await stored(date)).should.not.have.property('direction');
    });

    it('the second of two entries for one new reading in a batch removes the null field', async function () {
      var date = nextDate();
      await post([entry(date), entry(date, { direction: null })]).expect(200);
      (await stored(date)).should.not.have.property('direction');
    });

    it('control: a create with direction: null stores the null, as before', async function () {
      var date = nextDate();
      await post([entry(date, { direction: null, q1bN: { x: null, y: 2 } })]).expect(200);
      var doc = await stored(date);
      doc.should.have.property('direction', null);
      doc.q1bN.should.eql({ x: null, y: 2 });
    });

    it('in a batch that creates one entry and re-sends another, only the re-send removes', async function () {
      var resent = nextDate();
      var fresh = nextDate();
      await post([entry(resent)]).expect(200);
      await post([entry(resent, { direction: null }), entry(fresh, { direction: null })]).expect(200);
      (await stored(resent)).should.not.have.property('direction');
      (await stored(fresh)).should.have.property('direction', null);
    });

    it('control: a re-send without a null updates the fields it sends, as before', async function () {
      var date = nextDate();
      await post([entry(date, { noise: 1 })]).expect(200);
      await post([entry(date, { sgv: 130 })]).expect(200);
      var doc = await stored(date);
      doc.sgv.should.equal(130);
      doc.noise.should.equal(1);
      doc.direction.should.equal('Flat');
    });
  });

  describe('API v3', function () {
    var url = '/api/v3/treatments';

    function treatment (extra) {
      var doc = Object.assign({
        date: nextDate()
        , utcOffset: 0
        , app: DEVICE
        , device: DEVICE
        , eventType: 'Note'
        , notes: 'a note'
        , q1bN: { x: 1, y: 2 }
        , q1bA: [1, 2]
      }, extra || {});
      doc.identifier = opTools.calculateIdentifier(doc);
      return doc;
    }

    async function storedFor (identifier) {
      var docs = await col('treatments').find({ identifier: identifier }).toArray();
      docs.length.should.equal(1);
      return docs[0];
    }

    async function create (doc) {
      await self.instance.post(url, self.jwt.all).send(doc).expect(201);
      return doc.identifier;
    }

    it('PATCH removes a field sent as null', async function () {
      var id = await create(treatment());
      await self.instance.patch(url + '/' + id, self.jwt.all).send({ notes: null }).expect(200);
      (await storedFor(id)).should.not.have.property('notes');
    });

    it('PATCH removes a nested member sent as null, merges the object and replaces an array', async function () {
      var id = await create(treatment());
      await self.instance.patch(url + '/' + id, self.jwt.all).send({ q1bN: { x: null, z: 3 }, q1bA: [9] }).expect(200);
      var doc = await storedFor(id);
      doc.q1bN.should.eql({ y: 2, z: 3 });
      doc.q1bA.should.eql([9]);
      doc.notes.should.equal('a note');
    });

    it('PATCH announces the merged document on the storage socket', async function () {
      var id = await create(treatment());
      var seen = new Promise(function (resolve) {
        self.ctx.bus.once('storage-socket-update', resolve);
      });
      await self.instance.patch(url + '/' + id, self.jwt.all).send({ notes: null, q1bN: { x: null } }).expect(200);
      var event = await seen;
      event.doc.should.not.have.property('notes');
      event.doc.q1bN.should.eql({ y: 2 });
    });

    it('control: PUT replaces the document and stores a null as sent', async function () {
      var doc = treatment();
      var id = await create(doc);
      var replacement = Object.assign({}, doc, { notes: null });
      delete replacement.q1bA;
      await self.instance.put(url + '/' + id, self.jwt.all).send(replacement).expect(200);
      var stored = await storedFor(id);
      stored.should.have.property('notes', null);
      stored.should.not.have.property('q1bA');
    });

    it('control: POST that creates stores a null as sent', async function () {
      var id = await create(treatment({ notes: null, q1bN: { x: null } }));
      var stored = await storedFor(id);
      stored.should.have.property('notes', null);
      stored.q1bN.should.eql({ x: null });
    });

    it('control: POST that replaces a duplicate stores a null as sent', async function () {
      var doc = treatment();
      var id = await create(doc);
      await self.instance.post(url, self.jwt.all).send(Object.assign({}, doc, { notes: null })).expect(200);
      (await storedFor(id)).should.have.property('notes', null);
    });
  });

  describe('socket dbUpdate', function () {

    async function add (extra) {
      var doc = Object.assign({ eventType: 'Note', created_at: new Date(nextDate()).toISOString(), notes: 'a note', enteredBy: DEVICE, q1bN: { x: 1, y: 2 }, q1bA: [1, 2] }, extra || {});
      var res = await col('treatments').insertOne(doc);
      return res.insertedId;
    }

    function stored (id) {
      return col('treatments').findOne({ _id: id });
    }

    it('removes a field sent as null', async function () {
      var id = await add();
      var reply = await emit('dbUpdate', { collection: 'treatments', _id: String(id), data: { notes: null } });
      reply.result.should.equal('success');
      (await stored(id)).should.not.have.property('notes');
    });

    it('removes a nested member sent as null, merges the object and replaces an array, as PATCH does', async function () {
      var id = await add();
      await emit('dbUpdate', { collection: 'treatments', _id: String(id), data: { q1bN: { x: null, z: 3 }, q1bA: [9] } });
      var doc = await stored(id);
      doc.q1bN.should.eql({ y: 2, z: 3 });
      doc.q1bA.should.eql([9]);
      doc.notes.should.equal('a note');
    });

    it('control: a dbUpdate without a null sets the fields it sends, as before', async function () {
      var id = await add();
      var when = new Date(nextDate()).toISOString();
      await emit('dbUpdate', { collection: 'treatments', _id: String(id), data: { created_at: when } });
      var doc = await stored(id);
      doc.created_at.should.equal(when);
      doc.notes.should.equal('a note');
    });

    it('control: dbUpdateUnset removes the fields it names, as before', async function () {
      var id = await add();
      var reply = await emit('dbUpdateUnset', { collection: 'treatments', _id: String(id), data: { notes: 1 } });
      reply.result.should.equal('success');
      var doc = await stored(id);
      doc.should.not.have.property('notes');
      doc.q1bN.should.eql({ x: 1, y: 2 });
    });

    it('control: a dbUpdate for an _id that is not stored writes nothing', async function () {
      var id = new ObjectID();
      var reply = await emit('dbUpdate', { collection: 'treatments', _id: String(id), data: { notes: null } });
      reply.result.should.equal('success');
      should.not.exist(await stored(id));
    });
  });

  describe('v1 treatments (replace on match: out of scope)', function () {

    it('control: a re-sent treatment replaces the stored one; nothing is merged', async function () {
      var created = new Date(nextDate()).toISOString();
      var body = { eventType: 'Note', created_at: created, notes: 'a note', enteredBy: DEVICE, q1bKept: 'value' };
      await v1().post('/api/treatments/').set('api-secret', known).send(body).expect(200);
      await v1().post('/api/treatments/').set('api-secret', known)
        .send({ eventType: 'Note', created_at: created, notes: null, enteredBy: DEVICE }).expect(200);
      var docs = await col('treatments').find({ created_at: created, enteredBy: DEVICE }).toArray();
      docs.length.should.equal(1);
      docs[0].should.not.have.property('q1bKept');
      // v1 prepareData removes an empty notes before storage, as it always
      // has; Q1b does not change what it does.
      docs[0].should.not.have.property('notes');
    });
  });
});
