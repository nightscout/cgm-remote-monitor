'use strict';

// A record sent without a usable `_id` (null, an empty string, or a value
// that is neither a string nor an ObjectId) is stored with an id the server
// assigns.
//
// entries and treatments are written with upserts, and an upsert stores the
// `_id` it is given, so such a record was stored with that value as its
// `_id`, and the code that loads records into memory expects every `_id` to
// be an id (BF-115). The loaders now also accept a stored record without
// one.

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('entries and treatments: an empty _id is replaced by a server id', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');
  var TAG = 'empty-id-test';

  function entry (minute, extra) {
    var date = Date.UTC(2021, 6, 1, 0, minute);
    return Object.assign({ type: 'sgv', sgv: 100 + minute, date: date, dateString: new Date(date).toISOString(), device: TAG }, extra || {});
  }

  function treatment (minute, extra) {
    return Object.assign({ eventType: 'Note', created_at: new Date(Date.UTC(2021, 6, 1, 0, minute)).toISOString(), notes: TAG, enteredBy: TAG }, extra || {});
  }

  function collection (name) {
    return self.ctx.store.collection(self.env[name + '_collection']);
  }

  function dropAll () {
    return Promise.all([
      collection('entries').deleteMany({ device: TAG })
      , collection('treatments').deleteMany({ enteredBy: TAG })
      , collection('entries').deleteMany({ _id: null })
      , collection('treatments').deleteMany({ _id: null })
    ]);
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
      self.app.use('/api', api(self.env, ctx));
      dropAll().then(function () { done(); }, done);
    });
  });

  after(function () {
    return dropAll();
  });

  async function expectServerIds (name, filter, count) {
    (await collection(name).countDocuments({ _id: null })).should.equal(0, name + ' stored with a null _id');
    (await collection(name).countDocuments({ _id: '' })).should.equal(0, name + ' stored with an empty _id');
    var docs = await collection(name).find(filter).toArray();
    docs.length.should.equal(count, name + ' stored');
    docs.forEach(function (doc) {
      (doc._id instanceof ObjectID).should.equal(true, name + ' _id is a ' + typeof doc._id);
    });
  }

  [null, ''].forEach(function (empty) {
    var label = JSON.stringify(empty);

    describe('_id: ' + label, function () {
      var minute = empty === null ? 1 : 20;

      it('POST /entries stores the entry with an ObjectId _id', async function () {
        await request(self.app).post('/api/entries/').set('api-secret', known)
          .send([entry(minute, { _id: empty })]).expect(200);
        await expectServerIds('entries', { device: TAG, date: entry(minute).date }, 1);
      });

      it('POST /treatments stores the treatment with an ObjectId _id', async function () {
        await request(self.app).post('/api/treatments/').set('api-secret', known)
          .send(treatment(minute, { _id: empty })).expect(200);
        await expectServerIds('treatments', { enteredBy: TAG, created_at: treatment(minute).created_at }, 1);
      });

      it('POST /treatments with an array stores each with an ObjectId _id', async function () {
        await request(self.app).post('/api/treatments/').set('api-secret', known)
          .send([treatment(minute + 1, { _id: empty }), treatment(minute + 2, { _id: empty })]).expect(200);
        await expectServerIds('treatments', { enteredBy: TAG, created_at: { $in: [treatment(minute + 1).created_at, treatment(minute + 2).created_at] } }, 2);
      });

      it('PUT /treatments stores the treatment with an ObjectId _id', async function () {
        await request(self.app).put('/api/treatments/').set('api-secret', known)
          .send(treatment(minute + 3, { _id: empty })).expect(200);
        await expectServerIds('treatments', { enteredBy: TAG, created_at: treatment(minute + 3).created_at }, 1);
      });
    });
  });

  describe('dropEmptyId', function () {
    var idForms = require('../lib/server/object-id-forms');

    it('drops null, empty, numeric, boolean and plain-object _ids', function () {
      [null, undefined, '', 0, 1, false, true, {}, { $ne: null }].forEach(function (value) {
        var doc = { _id: value };
        idForms.dropEmptyId(doc);
        doc.should.not.have.property('_id');
      });
    });

    it('reads an Extended JSON {$oid} as the ObjectId it names', function () {
      var doc = { _id: { $oid: '5f2500000000000000000d01' } };
      idForms.dropEmptyId(doc);
      (doc._id instanceof ObjectID).should.equal(true);
      doc._id.toHexString().should.equal('5f2500000000000000000d01');
      var other = { _id: { $oid: 'not-hex' } };
      idForms.dropEmptyId(other);
      other.should.not.have.property('_id');
    });

    it('keeps strings, ObjectIds and an ObjectId from another bson copy', function () {
      var foreign = { _bsontype: 'ObjectId', id: Buffer.alloc(12) };
      ['5f2500000000000000000c01', 'a-uuid-or-other-string', new ObjectID(), foreign].forEach(function (value) {
        var doc = { _id: value };
        idForms.dropEmptyId(doc);
        doc._id.should.equal(value);
      });
    });
  });

  it('POST /treatments with an Extended JSON {$oid} _id keeps that id, and a re-POST adds no copy', async function () {
    var hex = '5f2500000000000000000d02';
    await request(self.app).post('/api/treatments/').set('api-secret', known)
      .send(treatment(50, { _id: { $oid: hex } })).expect(200);
    await request(self.app).post('/api/treatments/').set('api-secret', known)
      .send(treatment(50, { _id: { $oid: hex } })).expect(200);
    var docs = await collection('treatments').find({ enteredBy: TAG, created_at: treatment(50).created_at }).toArray();
    docs.length.should.equal(1);
    docs[0]._id.toHexString().should.equal(hex);
  });

  describe('a record already stored with a null _id', function () {

    it('does not stop the in-memory data from loading', function () {
      var data = [{ _id: null, eventType: 'Note', created_at: treatment(40).created_at }, { _id: new ObjectID(), eventType: 'Note', created_at: treatment(41).created_at }];
      var loaded = self.ctx.ddata.processRawDataForRuntime(data);
      loaded.length.should.equal(2);
      (loaded[0]._id === null).should.equal(true);
      loaded[1]._id.should.be.a.String();
    });

    it('does not stop the change calculation', function () {
      var calcDelta = require('../lib/data/calcdelta');
      var older = { treatments: [{ _id: null, mills: 1 }], sgvs: [], mbgs: [], cals: [], devicestatus: [], food: [], activity: [], profiles: [], dbstats: {}, lastUpdated: 1 };
      var newer = { treatments: [{ _id: null, mills: 1 }, { _id: 'a', mills: 2 }], sgvs: [], mbgs: [], cals: [], devicestatus: [], food: [], activity: [], profiles: [], dbstats: {}, lastUpdated: 2 };
      (function () { calcDelta(older, newer); }).should.not.throw();
    });
  });
});
